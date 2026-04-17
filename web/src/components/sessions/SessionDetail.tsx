import { useState, useEffect, useCallback, useRef } from 'react';
import { Check, Loader2, Archive } from 'lucide-react';
import type { SessionInfo } from '../../types';
import { useSessionsStore } from '../../stores/sessions';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { api, type ApiError } from '@/api/client';
import { Input } from '@/components/ui/input';

const COMPRESSION_OPTIONS = [
  { value: 'off', label: '关闭' },
  { value: 'manual', label: '手动压缩' },
  { value: 'auto', label: '自动压缩' },
];

function resolveRunnerValue(
  runnerId: string | null | undefined,
  options: RunnerOption[] = [],
): string {
  const normalized = typeof runnerId === 'string' ? runnerId.trim() : '';
  if (normalized) return normalized;
  return options[0]?.value || '';
}

function withCurrentRunnerOption(
  options: RunnerOption[],
  runnerId: string | null | undefined,
  runnerLabel?: string | null,
): RunnerOption[] {
  const normalized = typeof runnerId === 'string' ? runnerId.trim() : '';
  if (!normalized) return options;
  if (options.some((option) => option.value === normalized)) return options;
  return [
    {
      value: normalized,
      label:
        typeof runnerLabel === 'string' && runnerLabel.trim()
          ? runnerLabel.trim()
          : normalized,
    },
    ...options,
  ];
}

const THINKING_OPTIONS = [
  { value: '__default__', label: '默认' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
];

interface ContextSummary {
  session_folder: string;
  channel_jid: string;
  summary: string;
  message_count: number;
  created_at: string;
  model_used: string | null;
}

interface RunnerProfileOption {
  id: string;
  runner_id: string;
  name: string;
  is_default: boolean;
}

interface RunnerOption {
  value: string;
  label: string;
  canServeMemory?: boolean;
  compatibility?: {
    chat: string;
    im: string;
    observability: string;
  };
  capabilities?: {
    sessionResume: string;
    interrupt: string;
    toolStreaming: string;
    midQueryPush: boolean;
    backgroundTasks: boolean;
  };
  lifecycle?: {
    archivalTrigger: string[];
    contextShrinkTrigger: string;
    hookStreaming: string;
    postCompactRepair: string;
  };
  degradationReasons?: string[];
}

function RunnerCapabilitySummary({ runner }: { runner: RunnerOption | null }) {
  if (!runner?.compatibility || !runner.capabilities || !runner.lifecycle) {
    return null;
  }
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-3 space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-medium text-foreground">{runner.label}</div>
          <div className="text-[11px] text-slate-500 font-mono">{runner.value}</div>
        </div>
        <div className="text-[11px] text-slate-500 text-right">
          <div>chat: {runner.compatibility.chat}</div>
          <div>IM: {runner.compatibility.im}</div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 text-[11px]">
        <div className="rounded border border-border bg-background px-2 py-1.5">
          恢复: <span className="font-medium text-foreground">{runner.capabilities.sessionResume}</span>
        </div>
        <div className="rounded border border-border bg-background px-2 py-1.5">
          中断: <span className="font-medium text-foreground">{runner.capabilities.interrupt}</span>
        </div>
        <div className="rounded border border-border bg-background px-2 py-1.5">
          工具流: <span className="font-medium text-foreground">{runner.capabilities.toolStreaming}</span>
        </div>
        <div className="rounded border border-border bg-background px-2 py-1.5">
          后台任务: <span className="font-medium text-foreground">{runner.capabilities.backgroundTasks ? '支持' : '不支持'}</span>
        </div>
      </div>
      <div className="text-[11px] text-slate-500 space-y-1">
        <div>归档触发: {runner.lifecycle.archivalTrigger.join(' / ') || 'none'}</div>
        <div>上下文收缩: {runner.lifecycle.contextShrinkTrigger}</div>
        <div>Hook 观测: {runner.lifecycle.hookStreaming}</div>
        <div>Post-compact 修复: {runner.lifecycle.postCompactRepair}</div>
        <div>中途注入: {runner.capabilities.midQueryPush ? '支持' : '不支持'}</div>
      </div>
      {runner.degradationReasons && runner.degradationReasons.length > 0 && (
        <div className="rounded border border-amber-200 bg-amber-50 px-2 py-2 space-y-1">
          <div className="text-[11px] font-medium text-amber-700">退化说明</div>
          {runner.degradationReasons.map((reason) => (
            <div key={reason} className="text-[11px] text-amber-700">
              {reason}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface SessionDetailProps {
  session: SessionInfo & { jid: string };
}

export function SessionDetail({ session }: SessionDetailProps) {
  const { updateSession } = useSessionsStore();
  const isSessionView =
    session.kind === 'main' ||
    session.kind === 'workspace' ||
    session.kind === 'worker' ||
    session.kind === 'memory';
  const backingJid = session.backing_jid || session.jid;
  const runnerTouchedRef = useRef(false);
  const [runnerId, setRunnerId] = useState<string>(
    resolveRunnerValue(session.runner_id),
  );
  const [runnerProfileId, setRunnerProfileId] = useState<string>(
    session.runner_profile_id || '',
  );
  const [runnerOptions, setRunnerOptions] = useState<RunnerOption[]>([]);
  const [runnerProfiles, setRunnerProfiles] = useState<RunnerProfileOption[]>([]);
  const [model, setModel] = useState(session.model || '');
  const [thinkingEffort, setThinkingEffort] = useState<string>(
    session.thinking_effort || '',
  );
  const [cwd, setCwd] = useState(session.cwd || session.folder);
  const [compression, setCompression] = useState<string>(session.context_compression || 'off');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [compressing, setCompressing] = useState(false);
  const [compressResult, setCompressResult] = useState<string | null>(null);
  const [summaryInfo, setSummaryInfo] = useState<ContextSummary | null>(null);

  // Sync local state when session prop changes
  useEffect(() => {
    runnerTouchedRef.current = false;
    setRunnerId(
      resolveRunnerValue(session.runner_id, runnerOptions),
    );
    setRunnerProfileId(session.runner_profile_id || '');
    setModel(session.model || '');
    setThinkingEffort(session.thinking_effort || '');
    setCwd(session.cwd || session.folder);
    setCompression(session.context_compression || 'off');
    setCompressResult(null);
    setSummaryInfo(null);
  }, [
    session.jid,
    session.runner_id,
    session.runner_profile_id,
    session.model,
    session.thinking_effort,
    session.cwd,
    session.folder,
    session.context_compression,
  ]);

  const runnerDirty =
    runnerId !==
    resolveRunnerValue(session.runner_id, runnerOptions);
  const runnerProfileDirty = runnerProfileId !== (session.runner_profile_id || '');
  const modelDirty = model !== (session.model || '');
  const thinkingDirty = thinkingEffort !== (session.thinking_effort || '');
  const cwdDirty = cwd !== (session.cwd || session.folder);
  const compressionDirty = compression !== (session.context_compression || 'off');
  const dirty =
    runnerDirty ||
    runnerProfileDirty ||
    modelDirty ||
    thinkingDirty ||
    cwdDirty ||
    compressionDirty;
  const runnerSelectOptions = withCurrentRunnerOption(
    runnerOptions,
    runnerId || session.runner_id,
    session.runner_label,
  );
  const selectedRunner =
    runnerSelectOptions.find((option) => option.value === (runnerId || session.runner_id || ''))
    || null;
  const isMemorySession = session.kind === 'memory';

  const formatDate = (timestamp: string | number) => {
    return new Date(timestamp).toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const loadSummary = useCallback(async () => {
    try {
      const res = await api.get<{ summary: ContextSummary | null }>(
        `/api/sessions/${encodeURIComponent(backingJid)}/summary`,
      );
      setSummaryInfo(res.summary);
    } catch {
      setSummaryInfo(null);
    }
  }, [backingJid]);

  useEffect(() => {
    if (session.context_compression && session.context_compression !== 'off') {
      loadSummary();
    }
  }, [session.context_compression, loadSummary]);

  useEffect(() => {
    let cancelled = false;
    api
      .get<{
        runners: Array<{
          id: string;
          label: string;
          can_serve_memory: boolean;
          compatibility: {
            chat: string;
            memory: string;
            im: string;
            observability: string;
          };
          capabilities: {
            sessionResume: string;
            interrupt: string;
            toolStreaming: string;
            midQueryPush: boolean;
            backgroundTasks: boolean;
          };
          lifecycle: {
            archivalTrigger: string[];
            contextShrinkTrigger: string;
            hookStreaming: string;
            postCompactRepair: string;
          };
          degradation_reasons: string[];
        }>;
      }>('/api/sessions/runners')
      .then((res) => {
        if (!cancelled) {
          const nextOptions =
            res.runners.length > 0
              ? res.runners.map((runner) => ({
                  value: runner.id,
                  label: runner.label,
                  canServeMemory: runner.can_serve_memory,
                  compatibility: runner.compatibility,
                  capabilities: runner.capabilities,
                  lifecycle: runner.lifecycle,
                  degradationReasons: runner.degradation_reasons,
                }))
              : [];
          setRunnerOptions(nextOptions);
          setRunnerId((current) => {
            if (session.runner_id || runnerTouchedRef.current) return current;
            const previousFallback = resolveRunnerValue(session.runner_id);
            if (current !== previousFallback) return current;
            return resolveRunnerValue(session.runner_id, nextOptions);
          });
        }
      })
      .catch(() => {
        if (!cancelled) setRunnerOptions([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!runnerId) {
      setRunnerProfiles([]);
      return () => {};
    }
    let cancelled = false;
    api
      .get<{ profiles: RunnerProfileOption[] }>(
        `/api/sessions/runner-profiles?${new URLSearchParams({ runner_id: runnerId })}`,
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
  }, [runnerId]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const updates: Record<string, unknown> = {};
      if (runnerDirty) {
        updates.runner_id = runnerId;
      }
      if (runnerProfileDirty) {
        updates.runner_profile_id = runnerProfileId || null;
      }
      if (modelDirty) {
        updates.model = model.trim() || null;
      }
      if (thinkingDirty) {
        updates.thinking_effort = thinkingEffort || null;
      }
      if (cwdDirty) {
        updates.cwd = cwd.trim();
      }
      if (compressionDirty) {
        updates.context_compression = compression;
      }
      await updateSession(session.jid, updates);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      if (compressionDirty && compression !== 'off') {
        loadSummary();
      }
    } catch (err) {
      console.error('Failed to update session:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleCompress = async () => {
    setCompressing(true);
    setCompressResult(null);
    try {
      const res = await api.post<{
        success: boolean;
        messageCount?: number;
        error?: string;
      }>(`/api/sessions/${encodeURIComponent(backingJid)}/compress`, undefined, 60000);
      if (res.success) {
        setCompressResult(`压缩完成，处理了 ${res.messageCount ?? '?'} 条消息`);
        loadSummary();
      } else {
        setCompressResult(`压缩失败：${res.error || '未知错误'}`);
      }
    } catch (err) {
      const msg = (err as ApiError)?.message || String(err);
      setCompressResult(`压缩失败：${msg}`);
    } finally {
      setCompressing(false);
    }
  };

  return (
    <div className="p-4 bg-background space-y-3">
      {/* JID */}
      <div>
        <div className="text-xs text-slate-500 mb-1">
          {isSessionView ? '会话 ID' : '完整 JID'}
        </div>
        <code className="block text-xs font-mono bg-card px-3 py-2 rounded border border-border break-all">
          {session.jid}
        </code>
      </div>

      {/* Folder / cwd */}
      <div>
        <div className="text-xs text-slate-500 mb-1">
          {isSessionView ? '工作目录' : '文件夹'}
        </div>
        <div className="text-sm text-foreground font-medium">
          {session.cwd || session.folder}
        </div>
      </div>

      {/* Added At */}
      <div>
        <div className="text-xs text-slate-500 mb-1">创建时间</div>
        <div className="text-sm text-foreground">
          {formatDate(session.created_at)}
        </div>
      </div>

      {/* Runner & Model */}
      <div>
        <div className="text-xs text-slate-500 mb-1">运行引擎 / 模型</div>
        <div className="text-sm text-foreground">
          {session.runner_label || runnerId}
          {session.model && <span className="text-slate-400"> / {session.model}</span>}
        </div>
        {session.binding_summary && (
          <div className="text-xs text-slate-400 mt-1">
            绑定: {session.binding_summary}
          </div>
        )}
        {session.degradation_reasons && session.degradation_reasons.length > 0 && (
          <div className="mt-2 space-y-1">
            {session.degradation_reasons.map((reason) => (
              <div key={reason} className="text-xs text-amber-600">
                {reason}
              </div>
            ))}
          </div>
        )}
        <div className="mt-3">
          <RunnerCapabilitySummary runner={selectedRunner} />
        </div>
      </div>

      {session.editable && (
        <div className="space-y-3">
          <div>
            <div className="text-xs text-slate-500 mb-1">运行引擎</div>
            <Select
              value={runnerId || undefined}
              onValueChange={(value) => {
                runnerTouchedRef.current = true;
                setRunnerId(value);
              }}
            >
              <SelectTrigger className="h-8 text-sm">
              <SelectValue placeholder="选择运行引擎" />
              </SelectTrigger>
              <SelectContent>
                {runnerSelectOptions.map((opt) => (
                  <SelectItem
                    key={opt.value}
                    value={opt.value}
                    disabled={
                      isMemorySession
                        ? opt.canServeMemory === false
                        : opt.compatibility?.chat === 'unsupported'
                    }
                  >
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <div className="text-xs text-slate-500 mb-1">运行配置</div>
            <Select
              value={runnerProfileId || '__default__'}
              onValueChange={(value) =>
                setRunnerProfileId(value === '__default__' ? '' : value)
              }
            >
              <SelectTrigger className="h-8 text-sm">
                <SelectValue placeholder="默认" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__default__">默认</SelectItem>
                {runnerProfileId &&
                  !runnerProfiles.some((profile) => profile.id === runnerProfileId) && (
                    <SelectItem value={runnerProfileId}>
                      当前配置 {runnerProfileId}
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

          <div>
            <div className="text-xs text-slate-500 mb-1">模型</div>
            <Input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="留空表示使用默认模型"
              className="h-8 text-sm"
            />
          </div>

          <div>
            <div className="text-xs text-slate-500 mb-1">思考强度</div>
            <Select
              value={thinkingEffort || '__default__'}
              onValueChange={(value) =>
                setThinkingEffort(value === '__default__' ? '' : value)
              }
            >
              <SelectTrigger className="h-8 text-sm">
                <SelectValue placeholder="默认" />
              </SelectTrigger>
              <SelectContent>
                {THINKING_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <div className="text-xs text-slate-500 mb-1">工作目录</div>
            <Input
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder="默认使用当前会话目录"
              className="h-8 text-sm font-mono"
            />
          </div>
        </div>
      )}

      {/* Context Compression */}
      {session.editable && (
        <div>
          <div className="text-xs text-slate-500 mb-1">上下文压缩</div>
          <div className="flex items-center gap-2">
            <Select value={compression} onValueChange={setCompression}>
              <SelectTrigger className="flex-1 h-8 text-sm">
                <SelectValue placeholder="关闭" />
              </SelectTrigger>
              <SelectContent>
                {COMPRESSION_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <p className="mt-1 text-xs text-slate-400">
            {compression === 'auto'
              ? '每轮对话结束后自动检查，消息数超过阈值时自动压缩。也可手动触发。'
              : '使用 Sonnet 压缩历史对话，减少 token 消耗。压缩后会重置当前会话，并把摘要注入系统提示。'}
          </p>

          {/* Compress button + status */}
          {(compression === 'manual' || compression === 'auto') && (
            <div className="mt-2 space-y-2">
              <button
                onClick={handleCompress}
                disabled={compressing}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-purple-600 hover:bg-purple-700 rounded transition-colors disabled:opacity-50"
              >
                {compressing ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Archive className="w-3.5 h-3.5" />
                )}
                {compressing ? '压缩中...' : '立即压缩'}
              </button>
              {compressResult && (
                <p className={`text-xs ${compressResult.includes('失败') ? 'text-red-500' : 'text-green-600'}`}>
                  {compressResult}
                </p>
              )}
              {summaryInfo && (
                <div className="text-xs text-slate-400 bg-card px-3 py-2 rounded border border-border">
                  <div>已有摘要（{summaryInfo.message_count} 条消息）</div>
                  <div>创建于 {formatDate(summaryInfo.created_at)}</div>
                  {summaryInfo.model_used && <div>模型：{summaryInfo.model_used}</div>}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Save button */}
      {session.editable && dirty && (
        <div className="flex items-center gap-2">
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded transition-colors disabled:opacity-50"
          >
            {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
            保存设置
          </button>
          {saved && <span className="text-xs text-green-600">已保存</span>}
        </div>
      )}

      {/* Last Message */}
      {session.lastMessage && (
        <div>
          <div className="text-xs text-slate-500 mb-1">最后消息</div>
          <div className="text-sm text-foreground bg-card px-3 py-2 rounded border border-border line-clamp-3 break-words">
            {session.lastMessage}
          </div>
          {session.lastMessageTime && (
            <div className="text-xs text-slate-400 mt-1">
              {formatDate(session.lastMessageTime)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
