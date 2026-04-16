import { useEffect, useState, useCallback } from 'react';
import { AlertTriangle, RefreshCw, X } from 'lucide-react';

import { useChatStore } from '../../stores/chat';
import { api } from '../../api/client';
import { Input } from '@/components/ui/input';
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
  context_compression?: SessionInfo['context_compression'] | null;
  knowledge_extraction?: boolean | null;
};

interface RunnerProfileOption {
  id: string;
  runner_id: string;
  name: string;
  is_default: boolean;
}

interface RunnerCompatibility {
  chat: string;
  memory: string;
  im: string;
  observability: string;
}

interface RunnerCapabilities {
  sessionResume: string;
  interrupt: string;
  toolStreaming: string;
  midQueryPush: boolean;
  backgroundTasks: boolean;
}

interface RunnerLifecycle {
  archivalTrigger: string[];
  contextShrinkTrigger: string;
  hookStreaming: string;
  postCompactRepair: string;
}

interface RunnerOption {
  id: string;
  label: string;
  can_serve_memory: boolean;
  compatibility: RunnerCompatibility;
  capabilities: RunnerCapabilities;
  lifecycle: RunnerLifecycle;
  degradation_reasons: string[];
}

function RunnerCapabilityCard({ runner }: { runner: RunnerOption | null }) {
  if (!runner) return null;
  return (
    <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs font-medium text-slate-700">{runner.label}</div>
          <div className="text-[11px] text-slate-500 font-mono">{runner.id}</div>
        </div>
        <div className="text-[11px] text-slate-500 text-right">
          <div>chat: {runner.compatibility.chat}</div>
          <div>memory: {runner.compatibility.memory}</div>
          <div>IM: {runner.compatibility.im}</div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 text-[11px]">
        <div className="rounded border border-slate-200 bg-white px-2 py-1.5">
          恢复: <span className="font-medium text-slate-700">{runner.capabilities.sessionResume}</span>
        </div>
        <div className="rounded border border-slate-200 bg-white px-2 py-1.5">
          中断: <span className="font-medium text-slate-700">{runner.capabilities.interrupt}</span>
        </div>
        <div className="rounded border border-slate-200 bg-white px-2 py-1.5">
          工具流: <span className="font-medium text-slate-700">{runner.capabilities.toolStreaming}</span>
        </div>
        <div className="rounded border border-slate-200 bg-white px-2 py-1.5">
          后台任务: <span className="font-medium text-slate-700">{runner.capabilities.backgroundTasks ? '支持' : '不支持'}</span>
        </div>
      </div>
      <div className="text-[11px] text-slate-500 space-y-1">
        <div>归档触发: {runner.lifecycle.archivalTrigger.join(' / ') || 'none'}</div>
        <div>上下文收缩: {runner.lifecycle.contextShrinkTrigger}</div>
        <div>Hook 观测: {runner.lifecycle.hookStreaming}</div>
        <div>Post-compact 修复: {runner.lifecycle.postCompactRepair}</div>
        <div>中途注入: {runner.capabilities.midQueryPush ? '支持' : '不支持'}</div>
      </div>
      {runner.degradation_reasons.length > 0 && (
        <div className="rounded border border-amber-200 bg-amber-50 px-2 py-2 space-y-1">
          <div className="text-[11px] font-medium text-amber-700">退化说明</div>
          {runner.degradation_reasons.map((reason) => (
            <div key={reason} className="text-[11px] text-amber-700">
              {reason}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const CLAUDE_MODEL_OPTIONS = [
  { value: '__default__', label: '默认' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' },
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
  const sessionFromChat = useChatStore((s) => s.groups[sessionId]);
  const reloadChatSessions = useChatStore((s) => s.loadGroups);
  const session = sessionProp ?? sessionFromChat;
  const [runnerOptions, setRunnerOptions] = useState<RunnerOption[]>([]);

  const currentRunnerId = session?.runner_id || runnerOptions[0]?.id || '';
  const selectedRunner =
    runnerOptions.find((runner) => runner.id === currentRunnerId) || null;
  const isCodex = currentRunnerId === 'codex';
  const { models: codexModelOptions, loading: codexModelsLoading } = useCodexModels(isCodex);

  const [model, setModel] = useState(session?.model || '__default__');
  const [thinkingEffort, setThinkingEffort] = useState(session?.thinking_effort || '__default__');
  const [runnerProfileId, setRunnerProfileId] = useState(session?.runner_profile_id || '__default__');
  const [runnerProfiles, setRunnerProfiles] = useState<RunnerProfileOption[]>([]);
  const [cwd, setCwd] = useState(session?.cwd || '');
  const [contextCompression, setContextCompression] = useState<'off' | 'manual' | 'auto'>(
    session?.context_compression || 'off',
  );
  const [knowledgeExtraction, setKnowledgeExtraction] = useState(
    session?.knowledge_extraction ?? false,
  );
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    setModel(session?.model || '__default__');
    setThinkingEffort(session?.thinking_effort || '__default__');
    setRunnerProfileId(session?.runner_profile_id || '__default__');
    setCwd(session?.cwd || '');
    setContextCompression(session?.context_compression || 'off');
    setKnowledgeExtraction(session?.knowledge_extraction ?? false);
  }, [
    session?.context_compression,
    session?.cwd,
    session?.knowledge_extraction,
    session?.model,
    session?.runner_id,
    session?.runner_profile_id,
    session?.thinking_effort,
  ]);

  useEffect(() => {
    let cancelled = false;
    api
      .get<{ runners: RunnerOption[] }>('/api/sessions/runners')
      .then((res) => {
        if (!cancelled) setRunnerOptions(res.runners);
      })
      .catch(() => {
        if (!cancelled) setRunnerOptions([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

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

  const patchSession = useCallback(async (updates: Record<string, unknown>) => {
    try {
      await api.patch(`/api/sessions/${encodeURIComponent(sessionId)}`, updates);
      await Promise.allSettled([
        reloadChatSessions(),
        Promise.resolve(onSessionReload?.()),
      ]);
    } catch {
      // ignore
    }
  }, [onSessionReload, reloadChatSessions, sessionId]);

  const reloadSessionState = useCallback(async () => {
    setRefreshing(true);
    await Promise.allSettled([
      reloadChatSessions(),
      Promise.resolve(onSessionReload?.()),
    ]);
    setRefreshing(false);
  }, [onSessionReload, reloadChatSessions]);

  const handleProviderChange = useCallback(async (value: string) => {
    if (value === currentRunnerId) return;
    if (!window.confirm(
      '切换 Runner 将开始新对话，当前上下文不会继承。\n确定要切换吗？',
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
    const currentCwd = (session?.cwd || '').trim();
    if (!nextCwd || nextCwd === currentCwd) return;
    await patchSession({ cwd: nextCwd });
  }, [cwd, patchSession, session?.cwd]);

  const modelOptions = isCodex ? codexModelOptions : CLAUDE_MODEL_OPTIONS;

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
        <h3 className="font-semibold text-slate-900 text-sm">{title}</h3>
        <div className="flex items-center gap-1">
          <button
            onClick={() => void reloadSessionState()}
            className="text-slate-400 hover:text-slate-600 p-2 rounded-md hover:bg-slate-100 cursor-pointer"
            title="刷新"
          >
            <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
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

      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-4">
        {!hideSessionFields && (
          <div className="space-y-3">
            <div className="text-xs font-medium text-slate-500 uppercase tracking-wide">Runner</div>

            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">
                Runner
              </label>
              <Select value={currentRunnerId} onValueChange={handleProviderChange}>
                <SelectTrigger className="text-xs h-8">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {runnerOptions.map((runner) => (
                    <SelectItem
                      key={runner.id}
                      value={runner.id}
                      disabled={runner.compatibility.chat === 'unsupported'}
                    >
                      {runner.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="flex items-start gap-1.5 mt-1.5 px-2 py-1.5 rounded bg-amber-50 border border-amber-200">
                <AlertTriangle className="w-3.5 h-3.5 text-amber-500 flex-shrink-0 mt-0.5" />
                <p className="text-[11px] text-amber-700 leading-relaxed">
                  切换 Runner 会开始新对话，当前上下文不会继承。
                </p>
              </div>
              <div className="mt-2">
                <RunnerCapabilityCard runner={selectedRunner} />
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
            </div>

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

        {!hideSessionFields && <div className="border-t border-slate-100" />}

        <div className="space-y-3">
          <div className="text-xs font-medium text-slate-500 uppercase tracking-wide">本机命令模式</div>
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600 leading-6">
            HappyClaw 不再管理 Claude 或 Codex 的连接配置。认证、Base URL、API Key、自定义环境变量都需要由宿主机自己提供。
            当前面板只保留 Session 级的 Runner、模型和工作目录设置。
          </div>
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 leading-6">
            如果本机 <code className="rounded bg-white px-1.5 py-0.5 text-xs">claude</code> 或
            <code className="rounded bg-white px-1.5 py-0.5 text-xs">codex</code> 命令没有先在宿主机跑通，切换 Runner 以后会直接启动失败。
          </div>
        </div>
      </div>
    </div>
  );
}
