import { useEffect, useState, useRef, useCallback } from 'react';
import { Loader2, Save, Plus, X, RefreshCw, Trash2, AlertTriangle } from 'lucide-react';
import { useRuntimeEnvStore } from '../../stores/runtime-env';
import { useChatStore } from '../../stores/chat';
import { api } from '../../api/client';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useCodexModels } from '@/hooks/useCodexModels';
import type { SessionInfo } from '../../types';

interface RuntimeEnvPanelProps {
  sessionId: string;
  session?: RuntimeEnvSession | null;
  onSessionReload?: () => Promise<void> | void;
  onClose?: () => void;
  title?: string;
  hideSessionFields?: boolean;
}

type RuntimeEnvSession = {
  id?: string;
  name: string;
  runner_id?: SessionInfo['runner_id'] | null;
  runner_profile_id?: string | null;
  model?: string | null;
  thinking_effort?: SessionInfo['thinking_effort'] | null;
  cwd?: string | null;
  custom_cwd?: string | null;
  context_compression?: SessionInfo['context_compression'] | null;
  knowledge_extraction?: boolean | null;
};

interface RunnerProfileOption {
  id: string;
  runner_id: 'claude' | 'codex';
  name: string;
  is_default: boolean;
}

const CLAUDE_MODEL_OPTIONS = [
  { value: '__default__', label: '默认（跟随全局配置）' },
  { value: 'opus', label: 'Opus（最强）' },
  { value: 'sonnet', label: 'Sonnet（均衡）' },
  { value: 'haiku', label: 'Haiku（快速/低成本）' },
];

const THINKING_EFFORT_OPTIONS = [
  { value: '__default__', label: '默认' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
];

const CONTEXT_COMPRESSION_OPTIONS = [
  { value: 'off', label: '关闭' },
  { value: 'manual', label: '手动压缩' },
  { value: 'auto', label: '自动压缩' },
];

export function RuntimeEnvPanel({
  sessionId,
  session: sessionProp,
  onSessionReload,
  onClose,
  title = '会话运行环境',
  hideSessionFields = false,
}: RuntimeEnvPanelProps) {
  const { configs, loading, saving, loadConfig, saveConfig } = useRuntimeEnvStore();
  const config = configs[sessionId];
  const sessionFromChat = useChatStore((s) => s.groups[sessionId]);
  const reloadChatSessions = useChatStore((s) => s.loadGroups);
  const session = sessionProp ?? sessionFromChat;

  const currentRunnerId = session?.runner_id || 'claude';
  const isCodex = currentRunnerId === 'codex';
  const { models: codexModelOptions, loading: codexModelsLoading } = useCodexModels(isCodex);

  // Runner/session state updates via PATCH
  const [model, setModel] = useState(session?.model || '__default__');
  const [thinkingEffort, setThinkingEffort] = useState(session?.thinking_effort || '__default__');
  const [runnerProfileId, setRunnerProfileId] = useState(session?.runner_profile_id || '__default__');
  const [runnerProfiles, setRunnerProfiles] = useState<RunnerProfileOption[]>([]);
  const [cwd, setCwd] = useState(session?.cwd || session?.custom_cwd || '');
  const [contextCompression, setContextCompression] = useState<'off' | 'manual' | 'auto'>(
    session?.context_compression || 'off',
  );
  const [knowledgeExtraction, setKnowledgeExtraction] = useState(
    session?.knowledge_extraction ?? false,
  );

  // Runner connection config state (batch save)
  const [baseUrl, setBaseUrl] = useState('');
  const [defaultModelOverride, setDefaultModelOverride] = useState('');
  const [authToken, setAuthToken] = useState('');
  const [authTokenDirty, setAuthTokenDirty] = useState(false);
  const [customEnv, setCustomEnv] = useState<{ key: string; value: string }[]>([]);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [clearing, setClearing] = useState(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (sessionId) {
      loadConfig(sessionId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  // Sync session-level state when session changes
  useEffect(() => {
    setModel(session?.model || '__default__');
    setThinkingEffort(session?.thinking_effort || '__default__');
    setRunnerProfileId(session?.runner_profile_id || '__default__');
    setCwd(session?.cwd || session?.custom_cwd || '');
    setContextCompression(session?.context_compression || 'off');
    setKnowledgeExtraction(session?.knowledge_extraction ?? false);
  }, [
    session?.context_compression,
    session?.cwd,
    session?.custom_cwd,
    session?.knowledge_extraction,
    session?.model,
    session?.runner_id,
    session?.runner_profile_id,
    session?.thinking_effort,
  ]);

  useEffect(() => {
    let cancelled = false;
    api
      .get<{ profiles: RunnerProfileOption[] }>(
        `/api/sessions/runner-profiles?${new URLSearchParams({ runner_id: currentRunnerId })}`,
      )
      .then((res) => {
        if (!cancelled) setRunnerProfiles(res.profiles);
      })
      .catch(() => {
        if (!cancelled) setRunnerProfiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [currentRunnerId]);

  // Sync config to draft when loaded
  useEffect(() => {
    if (!config) return;
    setBaseUrl(isCodex ? (config.codexBaseUrl || '') : (config.anthropicBaseUrl || ''));
    setDefaultModelOverride(isCodex ? (config.codexDefaultModel || '') : '');
    setAuthToken('');
    setAuthTokenDirty(false);
    const sourceEnv = isCodex ? (config.codexCustomEnv || {}) : (config.customEnv || {});
    const entries = Object.entries(sourceEnv).map(([key, value]) => ({ key, value }));
    setCustomEnv(entries.filter(({ key }) => key !== 'ANTHROPIC_MODEL'));
  }, [config, isCodex]);

  const patchSession = useCallback(async (updates: Record<string, unknown>) => {
    try {
      await api.patch(`/api/sessions/${encodeURIComponent(sessionId)}`, updates);
      await Promise.allSettled([
        reloadChatSessions(),
        Promise.resolve(onSessionReload?.()),
      ]);
    } catch { /* ignore */ }
  }, [onSessionReload, reloadChatSessions, sessionId]);

  const handleProviderChange = useCallback(async (value: string) => {
    if (value === currentRunnerId) return;
    if (!window.confirm(
      '切换 Runner 将开始新对话，当前上下文不会继承。\n确定要切换吗？'
    )) return;
    await patchSession({ runner_id: value, model: null, thinking_effort: null });
  }, [currentRunnerId, patchSession]);

  const handleModelChange = useCallback(async (value: string) => {
    setModel(value);
    await patchSession({ model: value === '__default__' ? null : value });
  }, [patchSession]);

  const handleThinkingEffortChange = useCallback(async (value: string) => {
    setThinkingEffort(value);
    await patchSession({ thinking_effort: value === '__default__' ? null : value });
  }, [patchSession]);

  const handleRunnerProfileChange = useCallback(async (value: string) => {
    setRunnerProfileId(value);
    await patchSession({
      runner_profile_id: value === '__default__' ? null : value,
    });
  }, [patchSession]);

  const handleContextCompressionChange = useCallback(async (value: 'off' | 'manual' | 'auto') => {
    setContextCompression(value);
    if (value === 'off' && knowledgeExtraction) {
      setKnowledgeExtraction(false);
      await patchSession({
        context_compression: value,
        knowledge_extraction: false,
      });
      return;
    }
    await patchSession({ context_compression: value });
  }, [knowledgeExtraction, patchSession]);

  const handleKnowledgeExtractionChange = useCallback(async (checked: boolean) => {
    setKnowledgeExtraction(checked);
    await patchSession({ knowledge_extraction: checked });
  }, [patchSession]);

  const handleCwdBlur = useCallback(async () => {
    const nextCwd = cwd.trim();
    const currentCwd = (session?.cwd || session?.custom_cwd || '').trim();
    if (!nextCwd || nextCwd === currentCwd) return;
    await patchSession({ cwd: nextCwd });
  }, [cwd, patchSession, session?.cwd, session?.custom_cwd]);

  const handleSave = async () => {
    const data: Record<string, unknown> = {};
    const envMap: Record<string, string> = {};
    for (const { key, value } of customEnv) {
      const k = key.trim();
      if (!k || k === 'ANTHROPIC_MODEL') continue;
      envMap[k] = value;
    }

    if (isCodex) {
      data.codexBaseUrl = baseUrl;
      data.codexDefaultModel = defaultModelOverride;
      data.codexCustomEnv = envMap;
    } else {
      data.anthropicBaseUrl = baseUrl;
      if (authTokenDirty) data.anthropicAuthToken = authToken;
      data.customEnv = envMap;
    }

    const ok = await saveConfig(sessionId, data as {
      anthropicBaseUrl?: string;
      anthropicAuthToken?: string;
      customEnv?: Record<string, string>;
      codexBaseUrl?: string;
      codexDefaultModel?: string;
      codexCustomEnv?: Record<string, string>;
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
    if (!window.confirm(
      hideSessionFields
        ? '确定要清空当前 Memory Runtime 的所有覆盖配置吗？'
        : '确定要清空当前会话的所有覆盖配置并重建运行环境吗？',
    )) return;
    setClearing(true);
    const ok = await saveConfig(sessionId, {
      anthropicBaseUrl: '',
      anthropicAuthToken: '',
      anthropicApiKey: '',
      claudeCodeOauthToken: '',
      customEnv: {},
      codexBaseUrl: '',
      codexDefaultModel: '',
      codexCustomEnv: {},
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

  const modelOptions = isCodex ? codexModelOptions : CLAUDE_MODEL_OPTIONS;

  if (loading && !config) {
    return (
      <div className="p-4 text-sm text-slate-400 text-center">加载中...</div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
        <h3 className="font-semibold text-slate-900 text-sm">{title}</h3>
        <div className="flex items-center gap-1">
          <button
            onClick={() => loadConfig(sessionId)}
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

        {/* ── Section 1: Runner 配置 ── */}
        {!hideSessionFields && (
          <div className="space-y-3">
          <div className="text-xs font-medium text-slate-500 uppercase tracking-wide">Runner</div>

          {/* Runner Selector */}
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              Runner
            </label>
            <Select value={currentRunnerId} onValueChange={handleProviderChange}>
              <SelectTrigger className="text-xs h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="claude">Claude (Anthropic)</SelectItem>
                <SelectItem value="codex">OpenAI (Codex)</SelectItem>
              </SelectContent>
            </Select>
            {/* Context warning */}
            <div className="flex items-start gap-1.5 mt-1.5 px-2 py-1.5 rounded bg-amber-50 border border-amber-200">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-500 flex-shrink-0 mt-0.5" />
              <p className="text-[11px] text-amber-700 leading-relaxed">
                切换 Runner 会开始新对话，当前上下文不会继承。
              </p>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              Runner Profile
            </label>
            <Select value={runnerProfileId} onValueChange={handleRunnerProfileChange}>
              <SelectTrigger className="text-xs h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__default__">默认</SelectItem>
                {session?.runner_profile_id &&
                  session.runner_profile_id !== '__default__' &&
                  !runnerProfiles.some((profile) => profile.id === session.runner_profile_id) && (
                    <SelectItem value={session.runner_profile_id}>
                      当前配置 {session.runner_profile_id}
                    </SelectItem>
                  )}
                {runnerProfiles.map((profile) => (
                  <SelectItem key={profile.id} value={profile.id}>
                    {profile.name}
                    {profile.is_default ? ' · 默认' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Model Selector */}
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              模型
            </label>
            <Select
              value={model}
              onValueChange={handleModelChange}
              disabled={isCodex && codexModelsLoading}
            >
              <SelectTrigger className="text-xs h-8">
                <SelectValue placeholder={codexModelsLoading ? '加载模型列表...' : '默认'} />
              </SelectTrigger>
              <SelectContent>
                {modelOptions.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-slate-400 mt-1">
              选择后立即生效，下次对话将使用新模型。
            </p>
          </div>

          {/* Thinking Effort */}
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              Thinking Effort
            </label>
            <Select value={thinkingEffort} onValueChange={handleThinkingEffortChange}>
              <SelectTrigger className="text-xs h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {THINKING_EFFORT_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-slate-400 mt-1">
              控制模型的推理深度。低=快速响应，高=深度思考。
            </p>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              工作目录
            </label>
            <Input
              type="text"
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              onBlur={handleCwdBlur}
              placeholder="输入绝对路径"
              className="px-2.5 py-1.5 text-xs h-auto font-mono"
            />
            <p className="text-[11px] text-slate-400 mt-1">
              离开输入框后保存。下次启动 Runtime 时使用新的 cwd。
            </p>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              上下文压缩
            </label>
            <Select value={contextCompression} onValueChange={handleContextCompressionChange}>
              <SelectTrigger className="text-xs h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CONTEXT_COMPRESSION_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <label className="flex items-center gap-2 rounded border border-slate-200 px-3 py-2">
            <input
              type="checkbox"
              checked={knowledgeExtraction}
              disabled={contextCompression === 'off'}
              onChange={(e) => void handleKnowledgeExtractionChange(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-slate-300"
            />
            <div>
              <div className="text-xs font-medium text-slate-700">知识萃取</div>
              <div className="text-[11px] text-slate-400">
                压缩时把关键信息写入记忆系统。
              </div>
            </div>
          </label>
          </div>
        )}

        {/* ── Section 2: Runner 连接配置 ── */}
        {!hideSessionFields && <div className="border-t border-slate-100" />}
        <div className="space-y-3">
          <div className="text-xs font-medium text-slate-500 uppercase tracking-wide">连接配置</div>

          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              {isCodex ? 'OPENAI_BASE_URL' : 'ANTHROPIC_BASE_URL'}
            </label>
            <Input
              type="text"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="留空使用全局配置"
              className="px-2.5 py-1.5 text-xs h-auto"
            />
          </div>

          {isCodex ? (
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">
                CODEX 默认模型
              </label>
              <Input
                type="text"
                value={defaultModelOverride}
                onChange={(e) => setDefaultModelOverride(e.target.value)}
                placeholder="仅在当前会话模型留空时生效"
                className="px-2.5 py-1.5 text-xs h-auto"
              />
            </div>
          ) : (
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
          )}
        </div>

        {/* ── Section 3: 自定义环境变量 ── */}
        <div className="border-t border-slate-100" />
        <div>
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs font-medium text-slate-500 uppercase tracking-wide">
              {isCodex ? 'Codex 自定义环境变量' : '自定义环境变量'}
            </div>
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

          <p className="text-[11px] text-slate-400 mt-2 leading-relaxed">
            {hideSessionFields
              ? '覆盖全局配置，仅对当前 Memory 会话生效。'
              : '覆盖全局配置，仅对当前会话生效。保存后会重建该会话的运行环境。'}
          </p>
        </div>
      </div>

      {/* Footer */}
      <div className="flex-shrink-0 p-3 border-t border-slate-200 space-y-2">
        <div className="flex gap-2">
          <Button onClick={handleSave} disabled={saving || clearing} className="flex-1" size="sm">
            {saving && <Loader2 className="size-4 animate-spin" />}
            <Save className="w-4 h-4" />
            {saveSuccess ? '已保存' : hideSessionFields ? '保存配置' : '保存并重建运行环境'}
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
            {hideSessionFields ? '配置已保存' : '配置已保存，运行环境已重建'}
          </p>
        )}
      </div>
    </div>
  );
}
