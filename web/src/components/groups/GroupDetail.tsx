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
import { api } from '@/api/client';

const MODEL_OPTIONS = [
  { value: '__default__', label: '默认（跟随全局配置）' },
  { value: 'opus', label: 'Opus（最强）' },
  { value: 'sonnet', label: 'Sonnet（均衡）' },
  { value: 'haiku', label: 'Haiku（快速/低成本）' },
];

const COMPRESSION_OPTIONS = [
  { value: 'off', label: '关闭' },
  { value: 'manual', label: '手动压缩' },
  // { value: 'auto', label: '自动压缩' }, // TODO: auto mode
];

interface ContextSummary {
  group_folder: string;
  chat_jid: string;
  summary: string;
  message_count: number;
  created_at: string;
  model_used: string | null;
}

interface GroupDetailProps {
  group: GroupInfo & { jid: string };
}

export function GroupDetail({ group }: GroupDetailProps) {
  const { updateGroup } = useGroupsStore();
  const [model, setModel] = useState(group.model || '__default__');
  const [compression, setCompression] = useState(group.context_compression || 'off');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [compressing, setCompressing] = useState(false);
  const [compressResult, setCompressResult] = useState<string | null>(null);
  const [summaryInfo, setSummaryInfo] = useState<ContextSummary | null>(null);

  const modelDirty = model !== (group.model || '__default__');
  const compressionDirty = compression !== (group.context_compression || 'off');
  const dirty = modelDirty || compressionDirty;

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
        `/api/groups/${encodeURIComponent(group.jid)}/summary`,
      );
      setSummaryInfo(res.summary);
    } catch {
      setSummaryInfo(null);
    }
  }, [group.jid]);

  useEffect(() => {
    if (group.context_compression && group.context_compression !== 'off') {
      loadSummary();
    }
  }, [group.context_compression, loadSummary]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const updates: Record<string, unknown> = {};
      if (modelDirty) {
        updates.model = model === '__default__' ? null : model;
      }
      if (compressionDirty) {
        updates.context_compression = compression;
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
      const res = await api.post<{ success: boolean; messageCount?: number; error?: string }>(
        `/api/groups/${encodeURIComponent(group.jid)}/compress`,
      );
      if (res.success) {
        setCompressResult(`压缩完成，处理了 ${res.messageCount ?? '?'} 条消息`);
        loadSummary();
      } else {
        setCompressResult(`压缩失败：${res.error || '未知错误'}`);
      }
    } catch (err) {
      setCompressResult(`压缩失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setCompressing(false);
    }
  };

  return (
    <div className="p-4 bg-background space-y-3">
      {/* JID */}
      <div>
        <div className="text-xs text-slate-500 mb-1">完整 JID</div>
        <code className="block text-xs font-mono bg-card px-3 py-2 rounded border border-border break-all">
          {group.jid}
        </code>
      </div>

      {/* Folder */}
      <div>
        <div className="text-xs text-slate-500 mb-1">文件夹</div>
        <div className="text-sm text-foreground font-medium">{group.folder}</div>
      </div>

      {/* Added At */}
      <div>
        <div className="text-xs text-slate-500 mb-1">添加时间</div>
        <div className="text-sm text-foreground">
          {formatDate(group.added_at)}
        </div>
      </div>

      {/* Model Override */}
      {group.editable && (
        <div>
          <div className="text-xs text-slate-500 mb-1">模型</div>
          <div className="flex items-center gap-2">
            <Select value={model} onValueChange={setModel}>
              <SelectTrigger className="flex-1 h-8 text-sm">
                <SelectValue placeholder="默认" />
              </SelectTrigger>
              <SelectContent>
                {MODEL_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <p className="mt-1 text-xs text-slate-400">
            覆盖此工作区使用的模型，留空则跟随全局配置
          </p>
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
            使用 Sonnet 压缩历史对话，减少 token 消耗。压缩后会话将重置，摘要注入系统提示。
          </p>

          {/* Compress button + status */}
          {(group.context_compression === 'manual' || compression === 'manual') && (
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

      {/* Save button (shared for model + compression) */}
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
