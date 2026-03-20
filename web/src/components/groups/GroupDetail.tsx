import { useState } from 'react';
import { Check, Loader2 } from 'lucide-react';
import { GroupInfo, useGroupsStore } from '../../stores/groups';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const MODEL_OPTIONS = [
  { value: '__default__', label: '默认（跟随全局配置）' },
  { value: 'opus', label: 'Opus（最强）' },
  { value: 'sonnet', label: 'Sonnet（均衡）' },
  { value: 'haiku', label: 'Haiku（快速/低成本）' },
];

interface GroupDetailProps {
  group: GroupInfo & { jid: string };
}

export function GroupDetail({ group }: GroupDetailProps) {
  const { updateGroup } = useGroupsStore();
  const [model, setModel] = useState(group.model || '__default__');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const dirty = model !== (group.model || '__default__');

  const formatDate = (timestamp: string | number) => {
    return new Date(timestamp).toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const handleSaveModel = async () => {
    setSaving(true);
    try {
      await updateGroup(group.jid, { model: model === '__default__' ? null : model });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      console.error('Failed to update model:', err);
    } finally {
      setSaving(false);
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
            {dirty && (
              <button
                onClick={handleSaveModel}
                disabled={saving}
                className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded transition-colors disabled:opacity-50"
              >
                {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                保存
              </button>
            )}
            {saved && (
              <span className="text-xs text-green-600">已保存</span>
            )}
          </div>
          <p className="mt-1 text-xs text-slate-400">
            覆盖此工作区使用的模型，留空则跟随全局配置
          </p>
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
