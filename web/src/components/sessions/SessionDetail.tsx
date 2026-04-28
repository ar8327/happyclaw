import { useState, useEffect, useRef } from 'react';
import { Check, Loader2 } from 'lucide-react';
import type { SessionInfo } from '../../types';
import { useSessionsStore } from '../../stores/sessions';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { api } from '@/api/client';
import { Input } from '@/components/ui/input';

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
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

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
  }, [
    session.jid,
    session.runner_id,
    session.runner_profile_id,
    session.model,
    session.thinking_effort,
    session.cwd,
    session.folder,
  ]);

  const runnerDirty =
    runnerId !==
    resolveRunnerValue(session.runner_id, runnerOptions);
  const runnerProfileDirty = runnerProfileId !== (session.runner_profile_id || '');
  const modelDirty = model !== (session.model || '');
  const thinkingDirty = thinkingEffort !== (session.thinking_effort || '');
  const cwdDirty = cwd !== (session.cwd || session.folder);
  const isMemorySession = session.kind === 'memory';
  const dirty =
    runnerDirty ||
    runnerProfileDirty ||
    modelDirty ||
    thinkingDirty ||
    (!isMemorySession && cwdDirty);
  const runnerSelectOptions = withCurrentRunnerOption(
    runnerOptions,
    runnerId || session.runner_id,
    session.runner_label,
  );
  const selectedRunner =
    runnerSelectOptions.find((option) => option.value === (runnerId || session.runner_id || ''))
    || null;

  const formatDate = (timestamp: string | number) => {
    return new Date(timestamp).toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

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
      if (!isMemorySession && cwdDirty) {
        updates.cwd = cwd.trim();
      }
      await updateSession(session.jid, updates);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      console.error('Failed to update session:', err);
    } finally {
      setSaving(false);
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
      {(!isMemorySession || session.cwd) && (
        <div>
          <div className="text-xs text-slate-500 mb-1">
            {isSessionView ? '工作目录' : '文件夹'}
          </div>
          <div className="text-sm text-foreground font-medium">
            {session.cwd || session.folder}
          </div>
        </div>
      )}

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
        {!isMemorySession && session.binding_summary && (
          <div className="text-xs text-slate-400 mt-1">
            绑定: {session.binding_summary}
          </div>
        )}
        {isMemorySession && (
          <div className="text-xs text-slate-400 mt-1">
            这是 memory runner 的配置投影，只决定单次记忆请求用哪个 runner，不保存可恢复对话状态。
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
          {!isMemorySession && (
            <div>
              <div className="text-xs text-slate-500 mb-1">工作目录</div>
              <Input
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
                placeholder="默认使用当前会话目录"
                className="h-8 text-sm font-mono"
              />
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
