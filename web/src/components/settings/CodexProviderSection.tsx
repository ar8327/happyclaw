import { useCallback, useEffect, useState } from 'react';
import {
  Edit3,
  Loader2,
  Plus,
  RefreshCw,
  Rocket,
  Trash2,
  X,
} from 'lucide-react';

import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { api } from '../../api/client';
import { useCodexModels } from '../../hooks/useCodexModels';
import { apiFetch } from '../../api/client';
import type {
  CodexConfigPublic,
  CodexProfileItem,
  CodexProfilesResp,
  CodexActivateResult,
  LocalCodexCliStatus,
  EnvRow,
  SettingsNotification,
  CodexRateLimitsResponse,
  CodexRateLimitWindow,
} from './types';
import { getErrorMessage } from './types';

type CodexMode = 'cli' | 'api_key';
type ProfileEditorMode = 'create' | 'edit';

const RESERVED_ENV_KEYS = new Set([
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'HAPPYCLAW_CODEX_MODEL',
]);

function formatDateTime(value: string | null): string {
  if (!value) return '未记录';
  return new Date(value).toLocaleString('zh-CN');
}

function buildCustomEnv(rows: EnvRow[]): { customEnv: Record<string, string>; error: string | null } {
  const customEnv: Record<string, string> = {};
  for (const [idx, row] of rows.entries()) {
    const key = row.key.trim();
    const value = row.value;
    if (!key && !value.trim()) continue;
    if (!key) return { customEnv: {}, error: `第 ${idx + 1} 行环境变量 Key 不能为空` };
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      return { customEnv: {}, error: `环境变量 Key "${key}" 格式无效` };
    }
    if (RESERVED_ENV_KEYS.has(key)) {
      return { customEnv: {}, error: `${key} 属于系统保留字段，请在配置表单中填写` };
    }
    if (customEnv[key] !== undefined) {
      return { customEnv: {}, error: `环境变量 Key "${key}" 重复` };
    }
    customEnv[key] = value;
  }
  return { customEnv, error: null };
}

// ─── Rate Limit Helpers ─────────────────────────────────────

function windowLabel(mins: number): string {
  if (mins === 300) return '5小时窗口';
  if (mins === 10080) return '每周窗口';
  if (mins >= 1440) return `${Math.round(mins / 1440)}天窗口`;
  return `${Math.round(mins / 60)}小时窗口`;
}

function formatResetTime(resetsAt: number): string {
  const d = new Date(resetsAt * 1000);
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth()
    && d.getDate() === now.getDate();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (sameDay) return hh + ':' + mm;
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
}

function barColor(remaining: number): string {
  if (remaining > 50) return 'bg-emerald-500';
  if (remaining >= 20) return 'bg-amber-500';
  return 'bg-red-500';
}

function planBadgeClass(plan: string | null): string {
  switch (plan) {
    case 'plus': return 'bg-purple-100 text-purple-700';
    case 'pro': return 'bg-amber-100 text-amber-700';
    case 'team': case 'business': case 'enterprise': return 'bg-blue-100 text-blue-700';
    default: return 'bg-slate-100 text-slate-700';
  }
}

function RateLimitBar({ window: w }: { window: CodexRateLimitWindow }) {
  const remaining = 100 - w.usedPercent;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs text-slate-600">
        <span>{windowLabel(w.windowDurationMins)}</span>
        <span>{remaining}% 剩余 · 重置于 {formatResetTime(w.resetsAt)}</span>
      </div>
      <div className="h-2 bg-slate-200 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${barColor(remaining)}`}
          style={{ width: `${remaining}%` }}
        />
      </div>
    </div>
  );
}

function CodexRateLimitCard({
  data,
  loading,
  onRefresh,
}: {
  data: { limitId: string | null; planType: string | null; primary: CodexRateLimitWindow | null; secondary: CodexRateLimitWindow | null; credits: { hasCredits: boolean; unlimited: boolean; balance: string } | null };
  loading: boolean;
  onRefresh: () => void;
}) {
  const hasCredits = data.credits && (data.credits.hasCredits || parseFloat(data.credits.balance) > 0);
  return (
    <div className="rounded-lg border border-blue-200 bg-blue-50/50 p-4 space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="inline-block w-2 h-2 rounded-full bg-blue-500" />
          <span className="text-sm font-medium text-blue-800">订阅用量</span>
          {data.planType && (
            <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${planBadgeClass(data.planType)}`}>
              {data.planType.charAt(0).toUpperCase() + data.planType.slice(1)}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="text-blue-600 hover:text-blue-800 disabled:opacity-50 p-1"
          title="刷新用量"
        >
          <RefreshCw className={`size-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Progress bars */}
      {data.primary && <RateLimitBar window={data.primary} />}
      {data.secondary && <RateLimitBar window={data.secondary} />}

      {/* Credits */}
      {hasCredits && data.credits && (
        <p className="text-xs text-slate-500">
          额度余额：{data.credits.unlimited ? '无限' : `$${data.credits.balance}`}
        </p>
      )}
    </div>
  );
}

export function CodexProviderSection({ setNotice, setError }: SettingsNotification) {
  // Config & mode
  const [config, setConfig] = useState<CodexConfigPublic | null>(null);
  const [mode, setMode] = useState<CodexMode>('cli');
  const [cliStatus, setCliStatus] = useState<LocalCodexCliStatus | null>(null);
  const [cliDetecting, setCliDetecting] = useState(false);

  // Profile state
  const [profilesState, setProfilesState] = useState<CodexProfilesResp | null>(null);

  // Editor state
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [editorMode, setEditorMode] = useState<ProfileEditorMode>('create');
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);
  const [profileName, setProfileName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [apiKeyDirty, setApiKeyDirty] = useState(false);
  const [clearKeyOnSave, setClearKeyOnSave] = useState(false);
  const [baseUrl, setBaseUrl] = useState('');
  const [defaultModel, setDefaultModel] = useState('');
  const [customEnvRows, setCustomEnvRows] = useState<EnvRow[]>([]);

  // UI state
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [applying, setApplying] = useState(false);
  const [activatingProfileId, setActivatingProfileId] = useState<string | null>(null);
  const [deletingProfileId, setDeletingProfileId] = useState<string | null>(null);
  const [showApplyConfirm, setShowApplyConfirm] = useState(false);
  const [pendingDeleteProfile, setPendingDeleteProfile] = useState<CodexProfileItem | null>(null);

  // Rate limits (CLI mode only)
  const [rateLimits, setRateLimits] = useState<CodexRateLimitsResponse | null>(null);
  const [rateLimitsLoading, setRateLimitsLoading] = useState(false);

  // Models
  const { models: codexModels, loading: modelsLoading } = useCodexModels(mode === 'api_key');

  const busy = loading || saving || applying;

  // ─── Data loading ─────────────────────────────────────────────

  const loadConfig = useCallback(async () => {
    try {
      const [configData, profilesData] = await Promise.all([
        api.get<CodexConfigPublic>('/api/config/codex'),
        api.get<CodexProfilesResp>('/api/config/codex/profiles'),
      ]);
      setConfig(configData);
      setMode(configData.mode);
      setProfilesState(profilesData);
    } catch (err) {
      setError(getErrorMessage(err, '加载 Codex 配置失败'));
    } finally {
      setLoading(false);
    }
  }, [setError]);

  useEffect(() => { loadConfig(); }, [loadConfig]);

  const detectCli = useCallback(async () => {
    setCliDetecting(true);
    try {
      const status = await api.get<LocalCodexCliStatus>('/api/config/codex/detect-local');
      setCliStatus(status);
    } catch {
      // ignore
    } finally {
      setCliDetecting(false);
    }
  }, []);

  useEffect(() => { detectCli(); }, [detectCli]);

  const loadRateLimits = useCallback(async (refresh = false) => {
    setRateLimitsLoading(true);
    try {
      const path = refresh ? '/api/config/codex/rate-limits?refresh=1' : '/api/config/codex/rate-limits';
      const data = await apiFetch<CodexRateLimitsResponse>(path, { timeoutMs: 20_000 });
      setRateLimits(data);
    } catch {
      // Supplementary info — silently ignore errors
    } finally {
      setRateLimitsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (mode === 'cli' && cliStatus?.hasAuth) {
      loadRateLimits();
    } else {
      setRateLimits(null);
    }
  }, [mode, cliStatus?.hasAuth, loadRateLimits]);

  // ─── Mode switch ──────────────────────────────────────────────

  const handleModeSwitch = async (newMode: CodexMode) => {
    if (newMode === mode) return;
    setSaving(true);
    setNotice(null);
    setError(null);
    try {
      await api.post('/api/config/codex/mode', { mode: newMode });
      setMode(newMode);
      setNotice(`已切换到${newMode === 'cli' ? 'CLI 登录' : 'API Key'}模式`);
    } catch (err) {
      setError(getErrorMessage(err, '切换模式失败'));
    } finally {
      setSaving(false);
    }
  };

  // ─── Profile editor helpers ───────────────────────────────────

  const resetEditorForCreate = useCallback(() => {
    setEditorMode('create');
    setEditingProfileId(null);
    setProfileName('');
    setApiKey('');
    setApiKeyDirty(false);
    setClearKeyOnSave(false);
    setBaseUrl('');
    setDefaultModel('');
    setCustomEnvRows([]);
    setIsEditorOpen(true);
  }, []);

  const fillEditorFromProfile = useCallback((profile: CodexProfileItem) => {
    setEditorMode('edit');
    setEditingProfileId(profile.id);
    setProfileName(profile.name);
    setApiKey('');
    setApiKeyDirty(false);
    setClearKeyOnSave(false);
    setBaseUrl(profile.baseUrl);
    setDefaultModel(profile.defaultModel);
    const rows = Object.entries(profile.customEnv || {}).map(([key, value]) => ({ key, value }));
    setCustomEnvRows(rows.length > 0 ? rows : []);
    setIsEditorOpen(true);
  }, []);

  // ─── Profile CRUD ─────────────────────────────────────────────

  const handleSaveProfile = async () => {
    const trimmedName = profileName.trim();
    if (!trimmedName) { setError('请填写配置名称'); return; }

    const envResult = buildCustomEnv(customEnvRows);
    if (envResult.error) { setError(envResult.error); return; }

    setSaving(true);
    setNotice(null);
    setError(null);

    try {
      if (editorMode === 'create') {
        if (!apiKey.trim()) { setError('请填写 API Key'); setSaving(false); return; }
        await api.post<CodexProfileItem>('/api/config/codex/profiles', {
          name: trimmedName,
          openaiApiKey: apiKey.trim(),
          baseUrl: baseUrl.trim(),
          defaultModel: defaultModel === '__default__' ? '' : defaultModel,
          customEnv: envResult.customEnv,
        });
        setNotice('Codex 配置已创建');
      } else {
        await api.patch<CodexProfileItem>(`/api/config/codex/profiles/${editingProfileId}`, {
          name: trimmedName,
          baseUrl: baseUrl.trim(),
          defaultModel: defaultModel === '__default__' ? '' : defaultModel,
          customEnv: envResult.customEnv,
        });
        // Update secret if changed
        if (clearKeyOnSave) {
          await api.put(`/api/config/codex/profiles/${editingProfileId}/secrets`, {
            clearOpenaiApiKey: true,
          });
        } else if (apiKeyDirty && apiKey.trim()) {
          await api.put(`/api/config/codex/profiles/${editingProfileId}/secrets`, {
            openaiApiKey: apiKey.trim(),
          });
        }
        setNotice('Codex 配置已保存');
      }
      setIsEditorOpen(false);
      await loadConfig();
    } catch (err) {
      setError(getErrorMessage(err, editorMode === 'create' ? '创建配置失败' : '保存配置失败'));
    } finally {
      setSaving(false);
    }
  };

  const handleActivateProfile = async (id: string) => {
    setActivatingProfileId(id);
    setNotice(null);
    setError(null);
    try {
      const result = await api.post<CodexActivateResult>(`/api/config/codex/profiles/${id}/activate`);
      if (result.alreadyActive) {
        setNotice('该配置已处于活跃状态');
      } else {
        setNotice(`已切换配置，停止了 ${result.stoppedCount} 个工作区`);
      }
      await loadConfig();
    } catch (err) {
      setError(getErrorMessage(err, '切换配置失败'));
    } finally {
      setActivatingProfileId(null);
    }
  };

  const handleDeleteProfile = async (profile: CodexProfileItem) => {
    setDeletingProfileId(profile.id);
    setNotice(null);
    setError(null);
    try {
      await api.delete(`/api/config/codex/profiles/${profile.id}`);
      setNotice(`已删除配置「${profile.name}」`);
      if (editingProfileId === profile.id) setIsEditorOpen(false);
      await loadConfig();
    } catch (err) {
      setError(getErrorMessage(err, '删除配置失败'));
    } finally {
      setDeletingProfileId(null);
      setPendingDeleteProfile(null);
    }
  };

  // ─── Apply ────────────────────────────────────────────────────

  const doApply = async () => {
    setShowApplyConfirm(false);
    setApplying(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.post<{ success: boolean; stoppedCount: number; failedCount: number }>('/api/config/codex/apply');
      if (result.success) {
        setNotice(`已应用配置并停止 ${result.stoppedCount} 个活动工作区`);
      } else {
        setError(`应用配置部分失败（失败 ${result.failedCount} 个）`);
      }
    } catch (err) {
      setError(getErrorMessage(err, '应用配置失败'));
    } finally {
      setApplying(false);
    }
  };

  // ─── Custom env rows ──────────────────────────────────────────

  const addRow = () => setCustomEnvRows((prev) => [...prev, { key: '', value: '' }]);
  const removeRow = (index: number) =>
    setCustomEnvRows((prev) => prev.filter((_, i) => i !== index));
  const updateRow = (index: number, field: keyof EnvRow, value: string) =>
    setCustomEnvRows((prev) =>
      prev.map((row, i) => (i === index ? { ...row, [field]: value } : row)),
    );

  // ─── Render ───────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-5 animate-spin text-slate-400" />
      </div>
    );
  }

  const profiles = profilesState?.profiles || [];
  const activeProfileId = profilesState?.activeProfileId || '';

  return (
    <div className="space-y-6">
      {/* Mode toggle */}
      <div className="inline-flex rounded-lg border border-slate-200 p-1 bg-slate-50">
        <button
          onClick={() => handleModeSwitch('cli')}
          disabled={busy}
          className={`px-3 py-1.5 text-sm rounded-md transition-colors cursor-pointer ${
            mode === 'cli'
              ? 'bg-background text-primary shadow-sm'
              : 'text-slate-500 hover:text-slate-700'
          }`}
        >
          CLI 登录
        </button>
        <button
          onClick={() => handleModeSwitch('api_key')}
          disabled={busy}
          className={`px-3 py-1.5 text-sm rounded-md transition-colors cursor-pointer ${
            mode === 'api_key'
              ? 'bg-background text-primary shadow-sm'
              : 'text-slate-500 hover:text-slate-700'
          }`}
        >
          API Key
        </button>
      </div>

      {/* CLI login mode */}
      {mode === 'cli' && (
        <div className="space-y-4">
          {cliStatus?.hasAuth ? (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50/50 p-4 space-y-2">
              <div className="flex items-center gap-2">
                <span className="inline-block w-2 h-2 rounded-full bg-emerald-500" />
                <span className="text-sm font-medium text-emerald-800">Codex CLI 已登录</span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs text-slate-600">
                {cliStatus.authMode && (
                  <div>
                    <span className="text-slate-400">认证方式：</span>
                    <span className="font-mono">{cliStatus.authMode}</span>
                  </div>
                )}
                {cliStatus.accountId && (
                  <div>
                    <span className="text-slate-400">账户：</span>
                    <span className="font-mono">{cliStatus.accountId}</span>
                  </div>
                )}
                {cliStatus.lastRefresh && (
                  <div>
                    <span className="text-slate-400">最近刷新：</span>
                    <span>{formatDateTime(cliStatus.lastRefresh)}</span>
                  </div>
                )}
              </div>
              <p className="text-xs text-slate-500">
                容器启动时将自动同步登录凭据，无需额外操作。
              </p>
            </div>
          ) : (
            <div className="rounded-lg border border-slate-200 bg-slate-50/50 p-4 space-y-2">
              <div className="flex items-center gap-2">
                <span className="inline-block w-2 h-2 rounded-full bg-slate-300" />
                <span className="text-sm font-medium text-slate-600">
                  {cliStatus?.detected ? '未检测到有效的 CLI 登录' : '未检测到 Codex CLI'}
                </span>
              </div>
              <p className="text-xs text-slate-500">
                请在宿主机终端运行 <code className="bg-slate-100 px-1.5 py-0.5 rounded text-slate-700">codex login</code> 登录，系统将自动使用。
              </p>
            </div>
          )}

          {/* Rate limits card (CLI mode + authenticated) */}
          {rateLimits && rateLimits.available && (
            <CodexRateLimitCard
              data={rateLimits.rateLimits}
              loading={rateLimitsLoading}
              onRefresh={() => loadRateLimits(true)}
            />
          )}
          {rateLimitsLoading && !rateLimits && (
            <div className="rounded-lg border border-blue-200 bg-blue-50/50 p-4">
              <div className="flex items-center gap-2 text-sm text-blue-700">
                <Loader2 className="size-4 animate-spin" />
                <span>加载用量信息...</span>
              </div>
            </div>
          )}

          <Button
            variant="outline"
            size="sm"
            onClick={detectCli}
            disabled={cliDetecting}
          >
            {cliDetecting && <Loader2 className="size-4 animate-spin" />}
            <RefreshCw className="w-4 h-4" />
            刷新检测
          </Button>
        </div>
      )}

      {/* API Key mode */}
      {mode === 'api_key' && (
        <div className="space-y-4">
          {/* Profile list */}
          {profiles.length > 0 && (
            <div className="rounded-xl border border-slate-200 divide-y divide-slate-100">
              {profiles.map((profile) => {
                const isActive = profile.id === activeProfileId;
                const isEditing = editingProfileId === profile.id && isEditorOpen;
                return (
                  <div key={profile.id} className="p-3 space-y-2">
                    <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        <span className="text-sm font-medium text-slate-800 truncate">
                          {profile.name}
                        </span>
                        {isActive && (
                          <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-700 font-medium">
                            活跃
                          </span>
                        )}
                        {isEditing && (
                          <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-700 font-medium">
                            编辑中
                          </span>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-1 sm:shrink-0">
                        {!isActive && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleActivateProfile(profile.id)}
                            disabled={busy || activatingProfileId === profile.id}
                          >
                            {activatingProfileId === profile.id && (
                              <Loader2 className="size-4 animate-spin" />
                            )}
                            切换
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => fillEditorFromProfile(profile)}
                          disabled={busy}
                        >
                          <Edit3 className="w-3.5 h-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setPendingDeleteProfile(profile)}
                          disabled={busy || profiles.length <= 1 || deletingProfileId === profile.id}
                        >
                          {deletingProfileId === profile.id ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <Trash2 className="w-3.5 h-3.5 text-red-500" />
                          )}
                        </Button>
                      </div>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-2 text-xs text-slate-500">
                      <div>
                        <span className="text-slate-400">Base URL：</span>
                        <span className="break-all">{profile.baseUrl || 'OpenAI 官方'}</span>
                      </div>
                      <div>
                        <span className="text-slate-400">模型：</span>
                        <span>{profile.defaultModel || '默认'}</span>
                      </div>
                      <div>
                        <span className="text-slate-400">API Key：</span>
                        <span className="font-mono">{profile.openaiApiKeyMasked || '未设置'}</span>
                      </div>
                      <div>
                        <span className="text-slate-400">更新：</span>
                        <span>{formatDateTime(profile.updatedAt)}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* New profile button */}
          <Button variant="outline" size="sm" onClick={resetEditorForCreate} disabled={busy}>
            <Plus className="w-4 h-4" />
            新建配置
          </Button>

          {/* Profile editor */}
          {isEditorOpen && (
            <div className="rounded-xl border border-slate-200 p-4 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium text-slate-700">
                  {editorMode === 'create' ? '新建 Codex 配置' : '编辑 Codex 配置'}
                </h3>
                <button
                  onClick={() => setIsEditorOpen(false)}
                  className="p-1 rounded-md hover:bg-slate-100 transition-colors"
                >
                  <X className="w-4 h-4 text-slate-400" />
                </button>
              </div>

              {/* Name */}
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">配置名称</label>
                <Input
                  type="text"
                  value={profileName}
                  onChange={(e) => setProfileName(e.target.value)}
                  placeholder="例如：OpenAI 直连"
                  className="text-sm"
                  maxLength={64}
                />
              </div>

              {/* API Key */}
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">
                  OpenAI API Key
                  {editorMode === 'edit' && (
                    <span className="text-slate-400 font-normal ml-1">（留空保持不变）</span>
                  )}
                </label>
                <Input
                  type="password"
                  value={apiKey}
                  onChange={(e) => { setApiKey(e.target.value); setApiKeyDirty(true); setClearKeyOnSave(false); }}
                  placeholder={editorMode === 'create' ? 'sk-...' : '留空保持不变'}
                  className="text-sm font-mono"
                  maxLength={2000}
                />
                {editorMode === 'edit' && (
                  <div className="mt-1 flex items-center gap-2">
                    <label className="flex items-center gap-1.5 text-xs text-slate-500 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={clearKeyOnSave}
                        onChange={(e) => {
                          setClearKeyOnSave(e.target.checked);
                          if (e.target.checked) { setApiKey(''); setApiKeyDirty(false); }
                        }}
                        className="rounded border-slate-300"
                      />
                      清除 API Key
                    </label>
                  </div>
                )}
              </div>

              {/* Base URL */}
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">
                  Base URL <span className="text-slate-400 font-normal">（可选，留空使用 OpenAI 官方）</span>
                </label>
                <Input
                  type="text"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="https://api.openai.com"
                  className="text-sm font-mono"
                  maxLength={2000}
                />
              </div>

              {/* Model */}
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">
                  默认模型 <span className="text-slate-400 font-normal">（可选）</span>
                </label>
                <select
                  value={defaultModel || '__default__'}
                  onChange={(e) => setDefaultModel(e.target.value)}
                  disabled={modelsLoading}
                  className="w-full rounded-md border border-slate-200 bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  {codexModels.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>

              {/* Custom env */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs font-medium text-slate-600">
                    自定义环境变量 <span className="text-slate-400 font-normal">（可选）</span>
                  </label>
                  <button
                    onClick={addRow}
                    className="text-xs text-blue-600 hover:text-blue-700 cursor-pointer"
                  >
                    + 添加
                  </button>
                </div>
                {customEnvRows.length > 0 && (
                  <div className="space-y-2">
                    {customEnvRows.map((row, idx) => (
                      <div key={idx} className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                        <Input
                          type="text"
                          value={row.key}
                          onChange={(e) => updateRow(idx, 'key', e.target.value)}
                          placeholder="KEY"
                          className="w-full sm:w-[38%] px-2.5 py-1.5 text-xs font-mono h-auto"
                        />
                        <Input
                          type="text"
                          value={row.value}
                          onChange={(e) => updateRow(idx, 'value', e.target.value)}
                          placeholder="value"
                          className="flex-1 px-2.5 py-1.5 text-xs font-mono h-auto"
                        />
                        <button
                          onClick={() => removeRow(idx)}
                          className="w-8 h-8 rounded-md hover:bg-slate-100 flex items-center justify-center shrink-0 cursor-pointer"
                        >
                          <X className="w-4 h-4 text-slate-400" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Save / Cancel */}
              <div className="flex items-center gap-2 pt-2">
                <Button onClick={handleSaveProfile} disabled={saving} size="sm">
                  {saving && <Loader2 className="size-4 animate-spin" />}
                  {editorMode === 'create' ? '创建' : '保存'}
                </Button>
                <Button variant="outline" size="sm" onClick={() => setIsEditorOpen(false)}>
                  取消
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Env fallback notice */}
      {config?.hasEnvApiKey && !config?.hasCliAuth && profiles.length === 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-3 text-xs text-amber-700">
          当前使用环境变量 <code className="bg-amber-100 px-1 py-0.5 rounded">OPENAI_API_KEY</code>。
          {mode === 'api_key' ? '创建配置后可通过 Web 管理。' : ''}
        </div>
      )}

      {/* Apply button */}
      <div className="flex items-center gap-3 pt-2">
        <Button
          variant="destructive"
          size="sm"
          onClick={() => setShowApplyConfirm(true)}
          disabled={busy}
        >
          {applying && <Loader2 className="size-4 animate-spin" />}
          <Rocket className="w-4 h-4" />
          应用到所有工作区
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={loadConfig}
          disabled={busy}
        >
          <RefreshCw className="w-4 h-4" />
          刷新
        </Button>
      </div>

      {/* Confirm dialogs */}
      <ConfirmDialog
        open={showApplyConfirm}
        onClose={() => setShowApplyConfirm(false)}
        onConfirm={doApply}
        title="应用 Codex 配置到所有工作区"
        message="这会停止所有活动工作区并清空其待处理队列，是否继续？"
        confirmText="确认应用"
        confirmVariant="danger"
        loading={applying}
      />
      <ConfirmDialog
        open={!!pendingDeleteProfile}
        onClose={() => setPendingDeleteProfile(null)}
        onConfirm={() => pendingDeleteProfile && handleDeleteProfile(pendingDeleteProfile)}
        title="删除 Codex 配置"
        message={`确定要删除配置「${pendingDeleteProfile?.name}」吗？`}
        confirmText="确认删除"
        confirmVariant="danger"
        loading={!!deletingProfileId}
      />
    </div>
  );
}
