import { useEffect, useState, useRef, useCallback } from 'react';
import { Loader2, Save, Plus, X, RefreshCw, Trash2 } from 'lucide-react';
import { useContainerEnvStore } from '../../stores/container-env';
import { useGroupsStore } from '../../stores/groups';
import { api } from '../../api/client';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

interface ContainerEnvPanelProps {
  groupJid: string;
  onClose?: () => void;
}

const MODEL_ENV_KEY = 'ANTHROPIC_MODEL';
const MODEL_PRESETS = ['opus', 'sonnet', 'haiku'] as const;
const OPENAI_MODEL_ENV_KEY = 'OPENAI_MODEL';
const OPENAI_MODEL_PRESETS = ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5.3-codex-spark'] as const;
const OPENAI_REASONING_EFFORT_KEY = 'OPENAI_REASONING_EFFORT';
const OPENAI_REASONING_SUMMARY_KEY = 'OPENAI_REASONING_SUMMARY';
const REASONING_EFFORT_OPTIONS = ['', 'low', 'medium', 'high'] as const;
const REASONING_SUMMARY_OPTIONS = ['', 'auto', 'concise', 'detailed', 'none'] as const;

export function ContainerEnvPanel({ groupJid, onClose }: ContainerEnvPanelProps) {
  const { configs, loading, saving, loadConfig, saveConfig } = useContainerEnvStore();
  const config = configs[groupJid];
  const { groups, loadGroups } = useGroupsStore();
  const group = groups[groupJid];

  // LLM Provider state
  const [llmProvider, setLlmProvider] = useState<'claude' | 'openai'>(group?.llm_provider || 'claude');
  const [providerSaving, setProviderSaving] = useState(false);

  // Sync llmProvider when group data changes (always sync, including 'claude' default)
  useEffect(() => {
    setLlmProvider(group?.llm_provider || 'claude');
  }, [group?.llm_provider]);

  const handleProviderChange = useCallback(async (provider: 'claude' | 'openai') => {
    setLlmProvider(provider);
    setProviderSaving(true);
    try {
      await api.patch(`/api/groups/${encodeURIComponent(groupJid)}`, { llm_provider: provider });
      await loadGroups();
    } catch { /* ignore */ }
    setProviderSaving(false);
  }, [groupJid, loadGroups]);

  // Draft state for form fields
  const [baseUrl, setBaseUrl] = useState('');
  const [authToken, setAuthToken] = useState('');
  const [authTokenDirty, setAuthTokenDirty] = useState(false);
  const [model, setModel] = useState('');
  const [reasoningEffort, setReasoningEffort] = useState('');
  const [reasoningSummary, setReasoningSummary] = useState('');
  const [customEnv, setCustomEnv] = useState<{ key: string; value: string }[]>([]);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [clearing, setClearing] = useState(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (groupJid) {
      loadConfig(groupJid);
      loadGroups(); // Refresh group data to get latest llm_provider
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupJid]);

  // Cleanup save-success timer on unmount
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  // Sync config to draft when loaded
  useEffect(() => {
    if (!config) return;
    setBaseUrl(config.anthropicBaseUrl || '');
    setAuthToken('');
    setAuthTokenDirty(false);
    const entries = Object.entries(config.customEnv || {}).map(([key, value]) => ({ key, value }));
    const modelFromConfig =
      (config.customEnv && (config.customEnv[MODEL_ENV_KEY] || config.customEnv[OPENAI_MODEL_ENV_KEY])) || '';
    setModel(modelFromConfig);
    setReasoningEffort((config.customEnv && config.customEnv[OPENAI_REASONING_EFFORT_KEY]) || '');
    setReasoningSummary((config.customEnv && config.customEnv[OPENAI_REASONING_SUMMARY_KEY]) || '');
    setCustomEnv(entries.filter(({ key }) => key !== MODEL_ENV_KEY && key !== OPENAI_MODEL_ENV_KEY && key !== OPENAI_REASONING_EFFORT_KEY && key !== OPENAI_REASONING_SUMMARY_KEY));
  }, [config]);

  const handleSave = async () => {
    const data: Record<string, unknown> = {};

    // Always send baseUrl
    data.anthropicBaseUrl = baseUrl;

    // Only update secret when field has been edited.
    // If edited to empty string, backend will clear override and fall back to global.
    if (authTokenDirty) data.anthropicAuthToken = authToken;

    // Build custom env (filter empty keys)
    const envMap: Record<string, string> = {};
    const activeModelKey = llmProvider === 'openai' ? OPENAI_MODEL_ENV_KEY : MODEL_ENV_KEY;
    for (const { key, value } of customEnv) {
      const k = key.trim();
      if (!k || k === MODEL_ENV_KEY || k === OPENAI_MODEL_ENV_KEY || k === OPENAI_REASONING_EFFORT_KEY || k === OPENAI_REASONING_SUMMARY_KEY) continue;
      envMap[k] = value;
    }
    if (reasoningEffort) envMap[OPENAI_REASONING_EFFORT_KEY] = reasoningEffort;
    if (reasoningSummary) envMap[OPENAI_REASONING_SUMMARY_KEY] = reasoningSummary;
    const normalizedModel = model.trim();
    if (normalizedModel) {
      envMap[activeModelKey] = normalizedModel;
    }
    data.customEnv = envMap;

    const ok = await saveConfig(groupJid, data as {
      anthropicBaseUrl?: string;
      anthropicAuthToken?: string;
      customEnv?: Record<string, string>;
    });
    if (ok) {
      setSaveSuccess(true);
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => setSaveSuccess(false), 2000);
      setAuthToken('');
      setAuthTokenDirty(false);
    }
  };

  const handleClear = async () => {
    if (!window.confirm('确定要清空所有覆盖配置并重建工作区吗？')) return;
    setClearing(true);
    const ok = await saveConfig(groupJid, {
      anthropicBaseUrl: '',
      anthropicAuthToken: '',
      anthropicApiKey: '',
      claudeCodeOauthToken: '',
      customEnv: {},
    });
    setClearing(false);
    if (ok) {
      setSaveSuccess(true);
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => setSaveSuccess(false), 2000);
    }
  };

  const addCustomEnv = () => {
    setCustomEnv((prev) => [...prev, { key: '', value: '' }]);
  };

  const removeCustomEnv = (index: number) => {
    setCustomEnv((prev) => prev.filter((_, i) => i !== index));
  };

  const updateCustomEnv = (index: number, field: 'key' | 'value', val: string) => {
    setCustomEnv((prev) =>
      prev.map((item, i) => (i === index ? { ...item, [field]: val } : item))
    );
  };

  if (loading && !config) {
    return (
      <div className="p-4 text-sm text-slate-400 text-center">加载中...</div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
        <h3 className="font-semibold text-slate-900 text-sm">工作区环境变量</h3>
        <div className="flex items-center gap-1">
          <button
            onClick={() => loadConfig(groupJid)}
            className="text-slate-400 hover:text-slate-600 p-2 rounded-md hover:bg-slate-100 cursor-pointer"
            title="刷新"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          {onClose && (
            <button
              onClick={onClose}
              className="text-slate-400 hover:text-slate-600 p-2 rounded-md hover:bg-slate-100 cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-4">
        {/* LLM Provider Selector */}
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1.5">LLM 提供商</label>
          <div className="flex gap-2">
            {(['claude', 'openai'] as const).map((p) => (
              <button
                key={p}
                onClick={() => handleProviderChange(p)}
                disabled={providerSaving}
                className={`flex-1 px-3 py-1.5 rounded-md text-xs font-medium border transition-colors cursor-pointer ${
                  llmProvider === p
                    ? 'border-primary bg-primary/5 text-primary'
                    : 'border-slate-200 text-slate-500 hover:border-slate-300 hover:text-slate-700'
                }`}
              >
                {p === 'claude' ? 'Claude' : 'OpenAI'}
              </button>
            ))}
          </div>
          <p className="text-[10px] text-slate-400 mt-1">选择此工作区使用的 AI 模型提供商。切换后需重建工作区。</p>
        </div>

        <div className="border-t border-slate-100" />

        <p className="text-[11px] text-slate-400 leading-relaxed">
          覆盖全局配置，仅对当前工作区生效。留空则使用全局配置。保存后工作区将自动重建。
        </p>

        {/* Provider-specific Fields */}
        {llmProvider === 'claude' ? (
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">
                ANTHROPIC_BASE_URL
              </label>
              <Input
                type="text"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="留空使用全局配置"
                className="px-2.5 py-1.5 text-xs h-auto"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">
                ANTHROPIC_AUTH_TOKEN
                {config?.hasAnthropicAuthToken && (
                  <span className="ml-1.5 text-[10px] text-slate-400 font-normal">
                    ({config.anthropicAuthTokenMasked})
                  </span>
                )}
              </label>
              <Input
                type="password"
                value={authToken}
                onChange={(e) => {
                  setAuthToken(e.target.value);
                  setAuthTokenDirty(true);
                }}
                placeholder={config?.hasAnthropicAuthToken ? '已设置，输入新值覆盖；留空可清除覆盖' : '留空使用全局配置'}
                className="px-2.5 py-1.5 text-xs h-auto"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">
                模型（ANTHROPIC_MODEL）
              </label>
              <div className="space-y-1.5">
                <Input
                  type="text"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="opus / sonnet / haiku 或完整模型 ID"
                  className="px-2.5 py-1.5 text-xs h-auto font-mono"
                  list="anthropic-model-presets"
                />
                <datalist id="anthropic-model-presets">
                  {MODEL_PRESETS.map((preset) => (
                    <option key={preset} value={preset} />
                  ))}
                </datalist>
                <p className="text-[11px] text-slate-400">
                  留空则回退到全局配置（默认值通常为 <code className="bg-slate-100 px-1 rounded">opus</code>）。
                </p>
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">
                模型（OPENAI_MODEL）
              </label>
              <div className="space-y-1.5">
                <Input
                  type="text"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="gpt-5.4 / gpt-5.3-codex 或完整模型 ID"
                  className="px-2.5 py-1.5 text-xs h-auto font-mono"
                  list="openai-model-presets"
                />
                <datalist id="openai-model-presets">
                  {OPENAI_MODEL_PRESETS.map((preset) => (
                    <option key={preset} value={preset} />
                  ))}
                </datalist>
                <p className="text-[11px] text-slate-400">
                  留空则使用全局设置页配置的模型。认证信息在「设置 → OpenAI 提供商」中配置。
                </p>
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">
                Reasoning Effort
              </label>
              <div className="flex gap-1.5">
                {REASONING_EFFORT_OPTIONS.map((opt) => (
                  <button
                    key={opt || '_none'}
                    onClick={() => setReasoningEffort(opt)}
                    className={`flex-1 px-2 py-1.5 rounded-md text-[11px] font-medium border transition-colors cursor-pointer ${
                      reasoningEffort === opt
                        ? 'border-primary bg-primary/5 text-primary'
                        : 'border-slate-200 text-slate-500 hover:border-slate-300'
                    }`}
                  >
                    {opt || '默认'}
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-slate-400 mt-1">控制模型的推理深度。默认由模型自行决定。</p>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">
                Reasoning Summary
              </label>
              <div className="flex gap-1.5 flex-wrap">
                {REASONING_SUMMARY_OPTIONS.map((opt) => (
                  <button
                    key={opt || '_none'}
                    onClick={() => setReasoningSummary(opt)}
                    className={`px-2 py-1.5 rounded-md text-[11px] font-medium border transition-colors cursor-pointer ${
                      reasoningSummary === opt
                        ? 'border-primary bg-primary/5 text-primary'
                        : 'border-slate-200 text-slate-500 hover:border-slate-300'
                    }`}
                  >
                    {opt || '默认'}
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-slate-400 mt-1">是否在响应中包含推理过程摘要。</p>
            </div>
          </div>
        )}

        {/* Separator */}
        <div className="border-t border-slate-100" />

        {/* Custom Env Vars */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-xs font-medium text-slate-600">自定义环境变量</label>
            <button
              onClick={addCustomEnv}
              className="flex-shrink-0 flex items-center gap-1 text-[11px] text-primary hover:text-primary cursor-pointer"
            >
              <Plus className="w-3 h-3" />
              添加
            </button>
          </div>

          {customEnv.length === 0 ? (
            <p className="text-[11px] text-slate-400">暂无自定义变量</p>
          ) : (
            <div className="space-y-1.5">
              {customEnv.map((item, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <Input
                    type="text"
                    value={item.key}
                    onChange={(e) => updateCustomEnv(i, 'key', e.target.value)}
                    placeholder="KEY"
                    className="w-[40%] px-2 py-1 text-[11px] font-mono h-auto"
                  />
                  <span className="text-slate-300 text-xs">=</span>
                  <Input
                    type="text"
                    value={item.value}
                    onChange={(e) => updateCustomEnv(i, 'value', e.target.value)}
                    placeholder="value"
                    className="flex-1 px-2 py-1 text-[11px] font-mono h-auto"
                  />
                  <button
                    onClick={() => removeCustomEnv(i)}
                    className="flex-shrink-0 p-1 text-slate-400 hover:text-red-500 cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="flex-shrink-0 p-3 border-t border-slate-200 space-y-2">
        <div className="flex gap-2">
          <Button onClick={handleSave} disabled={saving || clearing} className="flex-1" size="sm">
            {saving && <Loader2 className="size-4 animate-spin" />}
            <Save className="w-4 h-4" />
            {saveSuccess ? '已保存' : '保存并重建工作区'}
          </Button>
          <Button
            onClick={handleClear}
            disabled={saving || clearing}
            variant="outline"
            size="sm"
            title="清空所有覆盖配置"
          >
            {clearing && <Loader2 className="size-4 animate-spin" />}
            <Trash2 className="w-4 h-4" />
          </Button>
        </div>
        {saveSuccess && (
          <p className="text-[11px] text-primary text-center">
            配置已保存，工作区已重建
          </p>
        )}
      </div>
    </div>
  );
}
