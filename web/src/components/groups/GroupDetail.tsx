import { useState, useEffect, useCallback } from 'react';
import { Check, Loader2, Archive } from 'lucide-react';
import { GroupInfo, useGroupsStore } from '../../stores/groups';
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

const DEFAULT_RUNNER_OPTIONS = [
  { value: 'claude', label: 'Claude' },
  { value: 'codex', label: 'Codex' },
];

const THINKING_OPTIONS = [
  { value: '__default__', label: '默认' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
];

interface ContextSummary {
  group_folder: string;
  chat_jid: string;
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
}

interface GroupDetailProps {
  group: GroupInfo & { jid: string };
}

export function GroupDetail({ group }: GroupDetailProps) {
  const { updateGroup } = useGroupsStore();
  const isSessionView = !!group.session_kind;
  const backingJid = group.backing_jid || group.jid;
  const [runnerId, setRunnerId] = useState<string>(
    group.runner_id || 'claude',
  );
  const [runnerProfileId, setRunnerProfileId] = useState<string>(
    group.runner_profile_id || '',
  );
  const [runnerOptions, setRunnerOptions] = useState<RunnerOption[]>(DEFAULT_RUNNER_OPTIONS);
  const [runnerProfiles, setRunnerProfiles] = useState<RunnerProfileOption[]>([]);
  const [model, setModel] = useState(group.model || '');
  const [thinkingEffort, setThinkingEffort] = useState<string>(
    group.thinking_effort || '',
  );
  const [cwd, setCwd] = useState(group.cwd || group.custom_cwd || group.folder);
  const [compression, setCompression] = useState<string>(group.context_compression || 'off');
  const [knowledgeExtraction, setKnowledgeExtraction] = useState(group.knowledge_extraction ?? false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [compressing, setCompressing] = useState(false);
  const [compressResult, setCompressResult] = useState<string | null>(null);
  const [summaryInfo, setSummaryInfo] = useState<ContextSummary | null>(null);

  // Sync local state when group prop changes
  useEffect(() => {
    setRunnerId(
      group.runner_id || 'claude',
    );
    setRunnerProfileId(group.runner_profile_id || '');
    setModel(group.model || '');
    setThinkingEffort(group.thinking_effort || '');
    setCwd(group.cwd || group.custom_cwd || group.folder);
    setCompression(group.context_compression || 'off');
    setKnowledgeExtraction(group.knowledge_extraction ?? false);
    setCompressResult(null);
    setSummaryInfo(null);
  }, [
    group.jid,
    group.runner_id,
    group.runner_profile_id,
    group.model,
    group.thinking_effort,
    group.cwd,
    group.custom_cwd,
    group.folder,
    group.context_compression,
    group.knowledge_extraction,
  ]);

  const runnerDirty =
    runnerId !==
    (group.runner_id || 'claude');
  const runnerProfileDirty = runnerProfileId !== (group.runner_profile_id || '');
  const modelDirty = model !== (group.model || '');
  const thinkingDirty = thinkingEffort !== (group.thinking_effort || '');
  const cwdDirty = cwd !== (group.cwd || group.custom_cwd || group.folder);
  const compressionDirty = compression !== (group.context_compression || 'off');
  const knowledgeDirty = knowledgeExtraction !== (group.knowledge_extraction ?? false);
  const dirty =
    runnerDirty ||
    runnerProfileDirty ||
    modelDirty ||
    thinkingDirty ||
    cwdDirty ||
    compressionDirty ||
    knowledgeDirty;

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
    if (group.context_compression && group.context_compression !== 'off') {
      loadSummary();
    }
  }, [group.context_compression, loadSummary]);

  useEffect(() => {
    let cancelled = false;
    api
      .get<{ runners: Array<{ id: string; label: string }> }>('/api/sessions/runners')
      .then((res) => {
        if (!cancelled) {
          setRunnerOptions(
            res.runners.length > 0
              ? res.runners.map((runner) => ({
                  value: runner.id,
                  label: runner.label,
                }))
              : DEFAULT_RUNNER_OPTIONS,
          );
        }
      })
      .catch(() => {
        if (!cancelled) setRunnerOptions(DEFAULT_RUNNER_OPTIONS);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
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
        if (compression === 'off' && knowledgeExtraction) {
          setKnowledgeExtraction(false);
          updates.knowledge_extraction = false;
        }
      }
      if (knowledgeDirty && !('knowledge_extraction' in updates)) {
        updates.knowledge_extraction = knowledgeExtraction;
      }
      await updateGroup(group.jid, updates);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      if (compressionDirty && compression !== 'off') {
        loadSummary();
      }
    } catch (err) {
      console.error('Failed to update group:', err);
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
        extractedKnowledge?: number;
        error?: string;
      }>(`/api/sessions/${encodeURIComponent(backingJid)}/compress`, undefined, 60000);
      if (res.success) {
        const knowledgeMsg =
          res.extractedKnowledge === -1 ? '（知识萃取在后台进行中）'
          : res.extractedKnowledge ? `，萃取了 ${res.extractedKnowledge} 条知识`
          : '';
        setCompressResult(`压缩完成，处理了 ${res.messageCount ?? '?'} 条消息${knowledgeMsg}`);
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
          {group.jid}
        </code>
      </div>

      {/* Folder / cwd */}
      <div>
        <div className="text-xs text-slate-500 mb-1">
          {isSessionView ? '工作目录' : '文件夹'}
        </div>
        <div className="text-sm text-foreground font-medium">
          {group.cwd || group.custom_cwd || group.folder}
        </div>
      </div>

      {/* Added At */}
      <div>
        <div className="text-xs text-slate-500 mb-1">添加时间</div>
        <div className="text-sm text-foreground">
          {formatDate(group.added_at)}
        </div>
      </div>

      {/* Runner & Model */}
      <div>
        <div className="text-xs text-slate-500 mb-1">运行引擎 / 模型</div>
        <div className="text-sm text-foreground">
          {group.runner_label || runnerId}
          {group.model && <span className="text-slate-400"> / {group.model}</span>}
        </div>
        {group.binding_summary && (
          <div className="text-xs text-slate-400 mt-1">
            绑定: {group.binding_summary}
          </div>
        )}
        {group.degradation_reasons && group.degradation_reasons.length > 0 && (
          <div className="mt-2 space-y-1">
            {group.degradation_reasons.map((reason) => (
              <div key={reason} className="text-xs text-amber-600">
                {reason}
              </div>
            ))}
          </div>
        )}
      </div>

      {group.editable && (
        <div className="space-y-3">
          <div>
            <div className="text-xs text-slate-500 mb-1">运行引擎</div>
            <Select value={runnerId} onValueChange={setRunnerId}>
              <SelectTrigger className="h-8 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {runnerOptions.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <div className="text-xs text-slate-500 mb-1">运行模式</div>
            <div className="h-8 px-3 rounded-md border border-border bg-muted/40 text-sm text-foreground flex items-center">
              本地 Runtime
            </div>
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
      {group.editable && (
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

          {/* Knowledge extraction toggle */}
          {(compression === 'manual' || compression === 'auto') && (
            <label className="mt-2 flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={knowledgeExtraction}
                onChange={(e) => setKnowledgeExtraction(e.target.checked)}
                className="w-3.5 h-3.5 rounded border-slate-300"
              />
              <span className="text-xs text-slate-500">
                知识萃取（压缩时提取关键知识写入记忆系统）
              </span>
            </label>
          )}

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
      {group.editable && dirty && (
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
      {group.lastMessage && (
        <div>
          <div className="text-xs text-slate-500 mb-1">最后消息</div>
          <div className="text-sm text-foreground bg-card px-3 py-2 rounded border border-border line-clamp-3 break-words">
            {group.lastMessage}
          </div>
          {group.lastMessageTime && (
            <div className="text-xs text-slate-400 mt-1">
              {formatDate(group.lastMessageTime)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
