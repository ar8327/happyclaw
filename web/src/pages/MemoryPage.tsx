import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, BookOpen, ChevronDown, ChevronRight, Loader2, Moon, Play, RefreshCw, Save, Settings } from 'lucide-react';
import { api } from '../api/client';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { RuntimeEnvPanel } from '../components/chat/RuntimeEnvPanel';

interface MemorySource {
  path: string;
  label: string;
  scope: 'user-global' | 'agent-memory' | 'main' | 'flow' | 'session';
  kind: 'claude' | 'note' | 'session';
  writable: boolean;
  exists: boolean;
  updatedAt: string | null;
  size: number;
  ownerName?: string;
}

interface MemoryFile {
  path: string;
  content: string;
  updatedAt: string | null;
  size: number;
  writable: boolean;
}

interface MemorySearchHit {
  path: string;
  hits: number;
  snippet: string;
}

interface MemoryRunnerOption {
  id: string;
  label: string;
  can_serve_memory: boolean;
  degradation_reasons: string[];
}

interface MemorySessionConfig {
  id: string;
  name: string;
  runner_id: string;
  runner_profile_id: string | null;
  model: string | null;
  thinking_effort: 'low' | 'medium' | 'high' | null;
  context_compression: 'off' | 'auto' | 'manual';
  owner_key: string | null;
  cwd: string;
  primary_session_folder: string | null;
  owned_session_folders: string[];
  owned_session_count: number;
}

interface RunnerProfileOption {
  id: string;
  runner_id: string;
  name: string;
  is_default: boolean;
}

function getErrorMessage(err: unknown, fallback: string): string {
  if (typeof err === 'object' && err !== null && 'message' in err) {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === 'string' && msg.trim()) return msg;
  }
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

function scopeLabel(scope: MemorySource['scope']): string {
  switch (scope) {
    case 'agent-memory':
      return 'AI 记忆系统';
    case 'user-global':
      return '我的全局记忆';
    case 'main':
      return '主会话';
    case 'flow':
      return '会话流';
    case 'session':
      return '自动记忆';
    default:
      return '其他';
  }
}

export function MemoryPage() {
  const [sources, setSources] = useState<MemorySource[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [initialContent, setInitialContent] = useState('');
  const [fileMeta, setFileMeta] = useState<MemoryFile | null>(null);
  const [keyword, setKeyword] = useState('');
  const [searchHits, setSearchHits] = useState<Record<string, MemorySearchHit>>({});

  const [loadingSources, setLoadingSources] = useState(true);
  const [loadingFile, setLoadingFile] = useState(false);
  const [saving, setSaving] = useState(false);
  const [searchingContent, setSearchingContent] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [memoryStatus, setMemoryStatus] = useState<{
    enabled: boolean;
    lastGlobalSleep: string | null;
    lastSessionWrapupAt: string | null;
    pendingWrapupsCount: number;
    canTriggerWrapup: boolean;
    canTriggerGlobalSleep: boolean;
    hasActiveSession: boolean;
    wrapupInProgress: boolean;
    globalSleepInProgress: boolean;
    ownedSessionFolders: string[];
  } | null>(null);
  const [triggeringWrapup, setTriggeringWrapup] = useState(false);
  const [triggeringGlobalSleep, setTriggeringGlobalSleep] = useState(false);
  const [memoryConfig, setMemoryConfig] = useState<MemorySessionConfig | null>(null);
  const [memoryRunners, setMemoryRunners] = useState<MemoryRunnerOption[]>([]);
  const [runnerProfiles, setRunnerProfiles] = useState<RunnerProfileOption[]>([]);
  const [loadingMemoryConfig, setLoadingMemoryConfig] = useState(false);
  const [savingMemoryConfig, setSavingMemoryConfig] = useState(false);

  const [showTimeouts, setShowTimeouts] = useState(false);
  const [timeoutValues, setTimeoutValues] = useState<{
    memoryQueryTimeout: number;
    memoryGlobalSleepTimeout: number;
    memorySendTimeout: number;
  } | null>(null);
  const [timeoutLoading, setTimeoutLoading] = useState(false);
  const [timeoutSaving, setTimeoutSaving] = useState(false);

  const isMobile = useMediaQuery('(max-width: 1023px)');
  const [showContent, setShowContent] = useState(false);

  const dirty = useMemo(() => content !== initialContent, [content, initialContent]);
  const memoryRuntimeSession = useMemo(
    () =>
      memoryConfig
        ? {
            id: memoryConfig.id,
            name: memoryConfig.name,
            runner_id: memoryConfig.runner_id,
            runner_profile_id: memoryConfig.runner_profile_id,
            model: memoryConfig.model,
            thinking_effort: memoryConfig.thinking_effort,
            cwd: memoryConfig.cwd,
            context_compression: memoryConfig.context_compression,
          }
        : null,
    [memoryConfig],
  );

  const filteredSources = useMemo(() => {
    const text = keyword.trim().toLowerCase();
    if (!text) return sources;
    return sources.filter((s) =>
      `${s.label} ${s.path}`.toLowerCase().includes(text) || Boolean(searchHits[s.path]),
    );
  }, [sources, keyword, searchHits]);

  const groupedSources = useMemo(() => {
    const groups: Record<MemorySource['scope'], MemorySource[]> = {
      'agent-memory': [],
      'user-global': [],
      main: [],
      flow: [],
      session: [],
    };
    for (const source of filteredSources) {
      groups[source.scope].push(source);
    }
    return groups;
  }, [filteredSources]);

  const loadFile = useCallback(async (path: string) => {
    setLoadingFile(true);
    setError(null);
    setNotice(null);
    try {
      const data = await api.get<MemoryFile>(
        `/api/memory/file?${new URLSearchParams({ path })}`,
      );
      setSelectedPath(path);
      setContent(data.content);
      setInitialContent(data.content);
      setFileMeta(data);
    } catch (err) {
      setError(getErrorMessage(err, '加载记忆文件失败'));
    } finally {
      setLoadingFile(false);
    }
  }, []);

  const loadSources = useCallback(async () => {
    setLoadingSources(true);
    setError(null);
    try {
      const data = await api.get<{ sources: MemorySource[] }>('/api/memory/sources');
      setSources(data.sources);

      const available = new Set(data.sources.map((s) => s.path));
      let nextSelected = selectedPath && available.has(selectedPath) ? selectedPath : null;

      if (!nextSelected) {
        // Default: first user-global CLAUDE.md, then main, then first available
        nextSelected =
          data.sources.find((s) => s.scope === 'user-global' && s.kind === 'claude')?.path ||
          data.sources.find((s) => s.scope === 'main' && s.kind === 'claude')?.path ||
          data.sources[0]?.path ||
          null;
      }

      if (nextSelected) {
        await loadFile(nextSelected);
      } else {
        setSelectedPath(null);
        setContent('');
        setInitialContent('');
        setFileMeta(null);
      }
    } catch (err) {
      setError(getErrorMessage(err, '加载记忆源失败'));
    } finally {
      setLoadingSources(false);
    }
  }, [loadFile, selectedPath]);

  const loadMemoryStatus = useCallback(async () => {
    try {
      const data = await api.get<{
        enabled: boolean;
        lastGlobalSleep: string | null;
        lastSessionWrapupAt: string | null;
        pendingWrapupsCount: number;
        canTriggerWrapup: boolean;
        canTriggerGlobalSleep: boolean;
        hasActiveSession: boolean;
        wrapupInProgress: boolean;
        globalSleepInProgress: boolean;
        ownedSessionFolders: string[];
      }>('/api/memory/status');
      setMemoryStatus(data);
    } catch {
      setMemoryStatus(null);
    }
  }, []);

  const loadMemoryConfig = useCallback(async () => {
    setLoadingMemoryConfig(true);
    try {
      const data = await api.get<{
        session: MemorySessionConfig | null;
        runners: MemoryRunnerOption[];
      }>('/api/memory/config');
      setMemoryConfig(data.session);
      setMemoryRunners(data.runners);
    } catch {
      setMemoryConfig(null);
      setMemoryRunners([]);
    } finally {
      setLoadingMemoryConfig(false);
    }
  }, []);

  const handleTriggerWrapup = async () => {
    setTriggeringWrapup(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.post<{ success: boolean; message: string }>('/api/memory/trigger-wrapup');
      setNotice(result.message);
      await loadMemoryStatus();
    } catch (err) {
      setError(getErrorMessage(err, '触发会话整理失败'));
    } finally {
      setTriggeringWrapup(false);
    }
  };

  const handleTriggerGlobalSleep = async () => {
    if (!confirm('深度整理可能需要几分钟，确定要执行吗？')) return;
    setTriggeringGlobalSleep(true);
    setError(null);
    setNotice(null);
    try {
      await api.post<{ success: boolean; message: string }>('/api/memory/trigger-global-sleep', undefined, 360000);
      setNotice('深度整理已完成');
      await loadMemoryStatus();
    } catch (err) {
      setError(getErrorMessage(err, '深度整理失败'));
    } finally {
      setTriggeringGlobalSleep(false);
    }
  };

  const handleStopActiveSessions = async () => {
    if (!confirm('这将停止所有活跃的 Agent 会话，确定吗？')) return;
    setError(null);
    setNotice(null);
    try {
      const result = await api.post<{ stopped: number; message: string }>('/api/memory/stop-active-sessions');
      setNotice(result.message);
      await loadMemoryStatus();
    } catch (err) {
      setError(getErrorMessage(err, '停止会话失败'));
    }
  };

  const handleSaveMemoryConfig = async () => {
    if (!memoryConfig) return;
    setSavingMemoryConfig(true);
    setError(null);
    setNotice(null);
    try {
      const data = await api.put<{
        session: MemorySessionConfig | null;
        runners: MemoryRunnerOption[];
      }>('/api/memory/config', {
        name: memoryConfig.name,
        runner_id: memoryConfig.runner_id,
        runner_profile_id: memoryConfig.runner_profile_id,
        model: memoryConfig.model,
        thinking_effort: memoryConfig.thinking_effort,
        context_compression: memoryConfig.context_compression,
      });
      setMemoryConfig(data.session);
      setMemoryRunners(data.runners);
      setNotice('Memory Runner 配置已保存');
    } catch (err) {
      setError(getErrorMessage(err, '保存 Memory Runner 配置失败'));
    } finally {
      setSavingMemoryConfig(false);
    }
  };

  const loadTimeoutSettings = useCallback(async () => {
    setTimeoutLoading(true);
    try {
      const data = await api.get<{
        memoryQueryTimeout: number;
        memoryGlobalSleepTimeout: number;
        memorySendTimeout: number;
      }>('/api/config/system');
      setTimeoutValues({
        memoryQueryTimeout: data.memoryQueryTimeout,
        memoryGlobalSleepTimeout: data.memoryGlobalSleepTimeout,
        memorySendTimeout: data.memorySendTimeout,
      });
    } catch {
      // ignore
    } finally {
      setTimeoutLoading(false);
    }
  }, []);

  const handleSaveTimeouts = async () => {
    if (!timeoutValues) return;
    setTimeoutSaving(true);
    setError(null);
    setNotice(null);
    try {
      const data = await api.put<{
        memoryQueryTimeout: number;
        memoryGlobalSleepTimeout: number;
        memorySendTimeout: number;
      }>('/api/config/system', timeoutValues);
      setTimeoutValues({
        memoryQueryTimeout: data.memoryQueryTimeout,
        memoryGlobalSleepTimeout: data.memoryGlobalSleepTimeout,
        memorySendTimeout: data.memorySendTimeout,
      });
      setNotice('超时设置已保存');
    } catch (err) {
      setError(getErrorMessage(err, '保存超时设置失败'));
    } finally {
      setTimeoutSaving(false);
    }
  };

  useEffect(() => {
    loadSources();
    loadMemoryStatus();
    loadMemoryConfig();
  }, [loadSources, loadMemoryStatus, loadMemoryConfig]);

  useEffect(() => {
    if (!memoryConfig) {
      setRunnerProfiles([]);
      return;
    }
    let cancelled = false;
    api
      .get<{ profiles: RunnerProfileOption[] }>(
        `/api/sessions/runner-profiles?${new URLSearchParams({ runner_id: memoryConfig.runner_id })}`,
      )
      .then((data) => {
        if (!cancelled) setRunnerProfiles(data.profiles);
      })
      .catch(() => {
        if (!cancelled) setRunnerProfiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [memoryConfig?.runner_id]);

  useEffect(() => {
    const q = keyword.trim();
    if (!q) {
      setSearchHits({});
      setSearchingContent(false);
      return;
    }

    const timer = window.setTimeout(async () => {
      setSearchingContent(true);
      try {
        const data = await api.get<{ hits: MemorySearchHit[] }>(
          `/api/memory/search?${new URLSearchParams({ q, limit: '120' })}`,
        );
        const next: Record<string, MemorySearchHit> = {};
        for (const hit of data.hits) {
          next[hit.path] = hit;
        }
        setSearchHits(next);
      } catch {
        setSearchHits({});
      } finally {
        setSearchingContent(false);
      }
    }, 280);

    return () => {
      window.clearTimeout(timer);
    };
  }, [keyword]);

  const handleSelectSource = async (path: string) => {
    if (path === selectedPath && isMobile) {
      // Mobile: re-tap selected item to show content panel
      setShowContent(true);
      return;
    }
    if (path === selectedPath) return;
    if (dirty && !confirm('当前有未保存修改，切换会丢失。是否继续？')) {
      return;
    }
    await loadFile(path);
    if (isMobile) setShowContent(true);
  };

  const handleSave = async () => {
    if (!selectedPath || !fileMeta?.writable) return;

    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const data = await api.put<MemoryFile>('/api/memory/file', {
        path: selectedPath,
        content,
      });
      setContent(data.content);
      setInitialContent(data.content);
      setFileMeta(data);
      setNotice('已保存');
      await loadSources();
    } catch (err) {
      setError(getErrorMessage(err, '保存记忆文件失败'));
    } finally {
      setSaving(false);
    }
  };

  const handleReloadFile = async () => {
    if (!selectedPath) return;
    if (dirty && !confirm('当前有未保存修改，重新加载会覆盖。是否继续？')) {
      return;
    }
    await loadFile(selectedPath);
  };

  const updatedText = fileMeta?.updatedAt
    ? new Date(fileMeta.updatedAt).toLocaleString('zh-CN')
    : '未记录';
  const selectedRunner = memoryRunners.find((runner) => runner.id === memoryConfig?.runner_id) || null;

  return (
    <div className="min-h-full bg-background p-4 lg:p-8">
      <div className="max-w-7xl mx-auto space-y-4">
        <div className="bg-card rounded-xl border border-border p-6">
          <div className="flex items-center gap-3 mb-3">
            <div className="p-2 bg-brand-100 rounded-lg">
              <BookOpen className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-foreground">记忆管理</h1>
              <p className="text-sm text-slate-500 mt-0.5">
                管理个人全局记忆、主会话记忆、各会话流记忆，以及可读取的自动记忆文件。
              </p>
            </div>
          </div>

          <div className="mt-3 pt-3 border-t border-border space-y-3">
              <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-3">
                <div>
                  <div className="text-sm font-medium text-foreground">Memory Session</div>
                  <div className="text-xs text-slate-500 mt-0.5">
                    这里控制记忆整理使用的 runner、模型和推理强度。
                  </div>
                </div>

                {loadingMemoryConfig ? (
                  <div className="flex items-center justify-center py-4 text-slate-500">
                    <Loader2 className="w-4 h-4 animate-spin mr-2" />
                    加载配置中...
                  </div>
                ) : memoryConfig ? (
                  <div className="space-y-3">
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs font-medium text-slate-600 mb-1">
                          Runner
                        </label>
                        <select
                          value={memoryConfig.runner_id}
                          onChange={(e) => setMemoryConfig((prev) => prev ? {
                            ...prev,
                            runner_id: e.target.value,
                          } : prev)}
                          className="w-full h-9 rounded-md border border-border bg-background px-3 text-sm"
                        >
                          {memoryRunners.map((runner) => (
                            <option
                              key={runner.id}
                              value={runner.id}
                              disabled={!runner.can_serve_memory}
                            >
                              {runner.label}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-600 mb-1">
                          Thinking
                        </label>
                        <select
                          value={memoryConfig.thinking_effort || ''}
                          onChange={(e) => setMemoryConfig((prev) => prev ? {
                            ...prev,
                            thinking_effort: e.target.value ? e.target.value as 'low' | 'medium' | 'high' : null,
                          } : prev)}
                          className="w-full h-9 rounded-md border border-border bg-background px-3 text-sm"
                        >
                          <option value="">默认</option>
                          <option value="low">low</option>
                          <option value="medium">medium</option>
                          <option value="high">high</option>
                        </select>
                      </div>
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-slate-600 mb-1">
                        Runner Profile
                      </label>
                      <select
                        value={memoryConfig.runner_profile_id || ''}
                        onChange={(e) => setMemoryConfig((prev) => prev ? {
                          ...prev,
                          runner_profile_id: e.target.value || null,
                        } : prev)}
                        className="w-full h-9 rounded-md border border-border bg-background px-3 text-sm"
                      >
                        <option value="">默认</option>
                        {memoryConfig.runner_profile_id &&
                          !runnerProfiles.some((profile) => profile.id === memoryConfig.runner_profile_id) && (
                            <option value={memoryConfig.runner_profile_id}>
                              当前配置 {memoryConfig.runner_profile_id}
                            </option>
                          )}
                        {runnerProfiles.map((profile) => (
                          <option key={profile.id} value={profile.id}>
                            {profile.name}{profile.is_default ? ' · 默认' : ''}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs font-medium text-slate-600 mb-1">
                          模型
                        </label>
                        <Input
                          value={memoryConfig.model || ''}
                          onChange={(e) => setMemoryConfig((prev) => prev ? {
                            ...prev,
                            model: e.target.value.trim() || null,
                          } : prev)}
                          placeholder="留空表示使用 runner 默认模型"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-600 mb-1">
                          上下文压缩
                        </label>
                        <select
                          value={memoryConfig.context_compression}
                          onChange={(e) => setMemoryConfig((prev) => prev ? {
                            ...prev,
                            context_compression: e.target.value as 'off' | 'auto' | 'manual',
                          } : prev)}
                          className="w-full h-9 rounded-md border border-border bg-background px-3 text-sm"
                        >
                          <option value="off">off</option>
                          <option value="manual">manual</option>
                          <option value="auto">auto</option>
                        </select>
                      </div>
                    </div>

                    <div className="text-xs text-slate-500 space-y-1">
                      <div>会话 ID: {memoryConfig.id}</div>
                      <div>工作目录: {memoryConfig.cwd}</div>
                      <div>主会话目录: {memoryConfig.primary_session_folder || '未解析'}</div>
                      <div>
                        管理范围: {memoryConfig.owned_session_count} 个会话
                        {memoryConfig.owned_session_folders.length > 0
                          ? ` · ${memoryConfig.owned_session_folders.join('、')}`
                          : ''}
                      </div>
                    </div>

                    {selectedRunner && selectedRunner.degradation_reasons.length > 0 && (
                      <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 space-y-1">
                        <div className="text-xs font-medium text-amber-700">兼容性提示</div>
                        {selectedRunner.degradation_reasons.map((reason) => (
                          <div key={reason} className="text-xs text-amber-700">
                            {reason}
                          </div>
                        ))}
                      </div>
                    )}

                    <div className="flex items-center gap-2">
                      <Button size="sm" onClick={handleSaveMemoryConfig} disabled={savingMemoryConfig}>
                        {savingMemoryConfig && <Loader2 className="size-3.5 animate-spin" />}
                        保存 Memory 配置
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="text-xs text-red-600">未找到记忆会话配置</div>
                )}
              </div>

              {memoryConfig && (
                <div className="rounded-lg border border-border overflow-hidden">
                  <RuntimeEnvPanel
                    sessionId={memoryConfig.id}
                    session={memoryRuntimeSession}
                    onSessionReload={loadMemoryConfig}
                    title="Memory 会话运行环境"
                    hideSessionFields
                  />
                </div>
              )}

              <div className="text-sm font-medium text-foreground">AI 记忆系统</div>
              <div className="text-xs text-slate-500 mt-0.5">
                使用 Memory Agent 自动整理和检索记忆
              </div>

              {memoryStatus && (
                <div className="space-y-3">
                  <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-2.5">
                      <div className="text-xs font-medium text-foreground">记忆系统状态</div>
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs text-slate-500">
                        <div>
                          <span className="text-slate-400">上次会话整理：</span>
                          {memoryStatus.lastSessionWrapupAt
                            ? new Date(memoryStatus.lastSessionWrapupAt).toLocaleString('zh-CN')
                            : '从未执行'}
                        </div>
                        <div>
                          <span className="text-slate-400">上次深度整理：</span>
                          {memoryStatus.lastGlobalSleep
                            ? new Date(memoryStatus.lastGlobalSleep).toLocaleString('zh-CN')
                            : '从未执行'}
                        </div>
                        <div>
                          <span className="text-slate-400">待整理记录：</span>
                          {memoryStatus.pendingWrapupsCount} 个
                        </div>
                      </div>
                      {memoryStatus.ownedSessionFolders.length > 0 && (
                        <div className="text-[11px] text-slate-500">
                          当前会检查这些会话: {memoryStatus.ownedSessionFolders.join('、')}
                        </div>
                      )}
                      <div className="flex items-center gap-2 pt-0.5">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={handleTriggerWrapup}
                          disabled={triggeringWrapup || !memoryStatus.canTriggerWrapup}
                        >
                          {(triggeringWrapup || memoryStatus.wrapupInProgress) ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <Play className="w-3.5 h-3.5" />
                          )}
                          {memoryStatus.wrapupInProgress && !triggeringWrapup ? '会话整理中…' : '会话整理'}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={handleTriggerGlobalSleep}
                          disabled={triggeringGlobalSleep || !memoryStatus.canTriggerGlobalSleep}
                        >
                          {(triggeringGlobalSleep || memoryStatus.globalSleepInProgress) ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <Moon className="w-3.5 h-3.5" />
                          )}
                          {memoryStatus.globalSleepInProgress && !triggeringGlobalSleep ? '深度整理中…' : '深度整理'}
                        </Button>
                        {memoryStatus.hasActiveSession && (
                          <button
                            onClick={handleStopActiveSessions}
                            className="text-[11px] text-amber-500 hover:text-amber-600 underline underline-offset-2 cursor-pointer"
                            title="点击停止活跃会话以进行深度整理"
                          >
                            有活跃会话（点击停止）
                          </button>
                        )}
                        {triggeringGlobalSleep && (
                          <span className="text-[11px] text-slate-400">深度整理中，可能需要几分钟……</span>
                        )}
                      </div>
                    </div>

                  {/* Timeout settings */}
                  <div className="rounded-lg border border-border overflow-hidden">
                    <button
                      onClick={() => {
                        const next = !showTimeouts;
                        setShowTimeouts(next);
                        if (next && !timeoutValues) loadTimeoutSettings();
                      }}
                      className="w-full flex items-center gap-2 px-3 py-2 bg-muted/30 hover:bg-muted text-xs font-medium text-foreground transition-colors"
                    >
                      {showTimeouts ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      <Settings className="w-3.5 h-3.5" />
                      超时设置
                    </button>
                    {showTimeouts && (
                      <div className="px-3 py-3 space-y-3">
                        {timeoutLoading ? (
                          <div className="flex items-center justify-center py-2">
                            <Loader2 className="w-4 h-4 animate-spin text-slate-400" />
                          </div>
                        ) : timeoutValues ? (
                          <>
                            <div>
                              <label className="block text-xs font-medium text-slate-600 mb-1">
                                记忆查询超时
                              </label>
                              <div className="flex items-center gap-2">
                                <Input
                                  type="number"
                                  value={Math.round(timeoutValues.memoryQueryTimeout / 1000)}
                                  onChange={(e) => {
                                    const v = parseInt(e.target.value, 10);
                                    if (Number.isFinite(v)) {
                                      setTimeoutValues((prev) => prev ? { ...prev, memoryQueryTimeout: v * 1000 } : prev);
                                    }
                                  }}
                                  min={10}
                                  max={600}
                                  step={5}
                                  className="max-w-24 text-xs"
                                />
                                <span className="text-xs text-slate-400">秒（10-600）</span>
                              </div>
                            </div>
                            <div>
                              <label className="block text-xs font-medium text-slate-600 mb-1">
                                会话整理超时
                              </label>
                              <div className="flex items-center gap-2">
                                <Input
                                  type="number"
                                  value={Math.round(timeoutValues.memorySendTimeout / 1000)}
                                  onChange={(e) => {
                                    const v = parseInt(e.target.value, 10);
                                    if (Number.isFinite(v)) {
                                      setTimeoutValues((prev) => prev ? { ...prev, memorySendTimeout: v * 1000 } : prev);
                                    }
                                  }}
                                  min={30}
                                  max={3600}
                                  step={10}
                                  className="max-w-24 text-xs"
                                />
                                <span className="text-xs text-slate-400">秒（30-3600）</span>
                              </div>
                            </div>
                            <div>
                              <label className="block text-xs font-medium text-slate-600 mb-1">
                                深度整理超时
                              </label>
                              <div className="flex items-center gap-2">
                                <Input
                                  type="number"
                                  value={Math.round(timeoutValues.memoryGlobalSleepTimeout / 1000)}
                                  onChange={(e) => {
                                    const v = parseInt(e.target.value, 10);
                                    if (Number.isFinite(v)) {
                                      setTimeoutValues((prev) => prev ? { ...prev, memoryGlobalSleepTimeout: v * 1000 } : prev);
                                    }
                                  }}
                                  min={60}
                                  max={3600}
                                  step={30}
                                  className="max-w-24 text-xs"
                                />
                                <span className="text-xs text-slate-400">秒（60-3600）</span>
                              </div>
                            </div>
                            <Button
                              size="sm"
                              onClick={handleSaveTimeouts}
                              disabled={timeoutSaving}
                            >
                              {timeoutSaving && <Loader2 className="size-3.5 animate-spin" />}
                              保存超时设置
                            </Button>
                          </>
                        ) : null}
                      </div>
                    )}
                  </div>
                </div>
              )}
          </div>

          <div className="text-xs text-slate-500 mt-3">
            已加载记忆源: {sources.length}
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-4">
          {(!isMobile || !showContent) && (
          <div className="bg-card rounded-xl border border-border p-4">
            <div className="mb-3">
              <Input
                type="text"
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                placeholder="搜索记忆源（路径 + 全文）"
              />
              <div className="mt-1 text-[11px] text-slate-500">
                {keyword.trim()
                  ? searchingContent
                    ? '正在做全文检索...'
                    : `全文命中：${Object.keys(searchHits).length} 个文件`
                  : '可按文件名、路径或内容关键词检索'}
              </div>
            </div>

            <div className="space-y-4 max-h-[calc(100dvh-280px)] lg:max-h-[560px] overflow-auto pr-1">
              {(['agent-memory', 'user-global', 'main', 'flow', 'session'] as const).map((scope) => {
                const items = groupedSources[scope];
                if (items.length === 0) return null;
                return (
                  <div key={scope}>
                    <div className="text-xs font-semibold text-slate-500 mb-2">
                      {scopeLabel(scope)} ({items.length})
                    </div>
                    <div className="space-y-1">
                      {items.map((source) => {
                        const active = source.path === selectedPath;
                        const hit = searchHits[source.path];
                        return (
                          <button
                            key={source.path}
                            onClick={() => handleSelectSource(source.path)}
                            className={`w-full text-left rounded-lg border px-3 py-2 transition-colors ${
                              active
                                ? 'border-primary bg-brand-50'
                                : 'border-border hover:bg-muted/50'
                            }`}
                          >
                            <div className="text-sm font-medium text-foreground truncate">
                              {source.label}
                            </div>
                            <div className="text-[11px] text-slate-500 truncate mt-0.5">
                              {source.path}
                            </div>
                            <div className="text-[11px] mt-1 text-slate-500">
                              {source.writable ? '可编辑' : '只读'} · {source.exists ? `${source.size} B` : '文件不存在'}
                            </div>
                            {hit && (
                              <div className="text-[11px] mt-1 text-primary truncate">
                                命中 {hit.hits} 次 · {hit.snippet}
                              </div>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}

              {!loadingSources && filteredSources.length === 0 && (
                <div className="text-sm text-slate-500">没有匹配的记忆源</div>
              )}
            </div>
          </div>
          )}

          {(!isMobile || showContent) && (
          <div className="bg-card rounded-xl border border-border p-4 lg:p-6">
            {selectedPath ? (
              <>
                {isMobile && (
                  <button
                    onClick={() => setShowContent(false)}
                    className="flex items-center gap-1 text-sm text-primary mb-3 hover:underline"
                  >
                    <ArrowLeft className="w-4 h-4" />
                    返回列表
                  </button>
                )}
                <div className="mb-3">
                  <div className="text-sm font-semibold text-foreground break-all">{selectedPath}</div>
                  <div className="text-xs text-slate-500 mt-1">
                    最近更新时间: {updatedText} · 字节数: {new TextEncoder().encode(content).length} · {fileMeta?.writable ? '可编辑' : '只读'}
                  </div>
                </div>

                <Textarea
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  className="min-h-[calc(100dvh-380px)] lg:min-h-[460px] resize-y p-4 font-mono text-sm leading-6 disabled:bg-muted"
                  placeholder={loadingFile ? '正在加载...' : '此记忆源暂无内容'}
                  disabled={loadingFile || saving || !fileMeta?.writable}
                />

                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <Button
                    onClick={handleSave}
                    disabled={loadingFile || saving || !fileMeta?.writable || !dirty}
                  >
                    {saving && <Loader2 className="size-4 animate-spin" />}
                    <Save className="w-4 h-4" />
                    保存
                  </Button>

                  <Button
                    variant="outline"
                    onClick={handleReloadFile}
                    disabled={loadingFile || saving}
                  >
                    <RefreshCw className="w-4 h-4" />
                    重新加载当前
                  </Button>

                  <Button
                    variant="outline"
                    onClick={loadSources}
                    disabled={loadingSources || loadingFile || saving}
                  >
                    <RefreshCw className="w-4 h-4" />
                    刷新记忆源
                  </Button>

                  {dirty && <span className="text-sm text-amber-600">有未保存修改</span>}
                  {notice && <span className="text-sm text-green-600">{notice}</span>}
                  {error && <span className="text-sm text-red-600">{error}</span>}
                </div>
              </>
            ) : (
              <div className="text-sm text-slate-500">暂无可用记忆源</div>
            )}
          </div>
          )}
        </div>
      </div>
    </div>
  );
}
