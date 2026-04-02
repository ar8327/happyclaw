import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BookOpen } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { GroupInfo } from '../../stores/groups';
import { useChatStore } from '../../stores/chat';
import { useCodexModels } from '../../hooks/useCodexModels';

interface GroupDetailProps {
  group: GroupInfo & { jid: string };
}

export function GroupDetail({ group }: GroupDetailProps) {
  const navigate = useNavigate();
  const updateFlowSettings = useChatStore((s) => s.updateFlowSettings);
  const [saving, setSaving] = useState(false);
  const [llmProvider, setLlmProvider] = useState<'claude' | 'openai'>(
    group.llm_provider ?? 'claude',
  );
  const [model, setModel] = useState(group.model ?? '');
  const [thinkingEffort, setThinkingEffort] = useState<
    'default' | 'low' | 'medium' | 'high'
  >(group.thinking_effort ?? 'default');
  const [contextCompression, setContextCompression] = useState(
    group.context_compression === 'off' ? '' : group.context_compression ?? '',
  );
  const [knowledgeExtraction, setKnowledgeExtraction] = useState(
    group.knowledge_extraction ?? false,
  );
  const { models: codexModels, loading: codexModelsLoading } = useCodexModels(
    llmProvider === 'openai',
  );

  useEffect(() => {
    setLlmProvider(group.llm_provider ?? 'claude');
    setModel(group.model ?? '');
    setThinkingEffort(group.thinking_effort ?? 'default');
    setContextCompression(
      group.context_compression === 'off' ? '' : group.context_compression ?? '',
    );
    setKnowledgeExtraction(group.knowledge_extraction ?? false);
  }, [
    group.context_compression,
    group.knowledge_extraction,
    group.llm_provider,
    group.model,
    group.thinking_effort,
  ]);

  const hasRuntimeChanges = useMemo(() => {
    return (
      llmProvider !== (group.llm_provider ?? 'claude') ||
      model !== (group.model ?? '') ||
      thinkingEffort !== (group.thinking_effort ?? 'default') ||
      contextCompression !==
        (group.context_compression === 'off'
          ? ''
          : group.context_compression ?? '') ||
      knowledgeExtraction !== (group.knowledge_extraction ?? false)
    );
  }, [
    contextCompression,
    group.context_compression,
    group.knowledge_extraction,
    group.llm_provider,
    group.model,
    group.thinking_effort,
    knowledgeExtraction,
    llmProvider,
    model,
    thinkingEffort,
  ]);

  const formatDate = (timestamp: string | number) => {
    return new Date(timestamp).toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const handleSaveRuntimeSettings = async () => {
    setSaving(true);
    try {
      const ok = await updateFlowSettings(group.jid, {
        llm_provider: llmProvider,
        model,
        thinking_effort:
          thinkingEffort === 'default' ? null : thinkingEffort,
        context_compression: contextCompression,
        knowledge_extraction: knowledgeExtraction,
      });
      if (ok) {
        toast.success('工作区运行模型已更新，下一次消息会按新配置启动');
      } else {
        toast.error('保存失败，请稍后重试');
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="p-4 bg-background space-y-3">
      {/* JID */}
      <div>
        <div className="text-xs text-muted-foreground mb-1">完整 JID</div>
        <code className="block text-xs font-mono bg-card px-3 py-2 rounded border border-border break-all">
          {group.jid}
        </code>
      </div>

      {/* Folder */}
      <div>
        <div className="text-xs text-muted-foreground mb-1">文件夹</div>
        <div className="text-sm text-foreground font-medium">{group.folder}</div>
      </div>

      {/* Added At */}
      <div>
        <div className="text-xs text-muted-foreground mb-1">添加时间</div>
        <div className="text-sm text-foreground">
          {formatDate(group.added_at)}
        </div>
      </div>

      {/* Last Message */}
      {group.lastMessage && (
        <div>
          <div className="text-xs text-muted-foreground mb-1">最后消息</div>
          <div className="text-sm text-foreground bg-card px-3 py-2 rounded border border-border line-clamp-3 break-words">
            {group.lastMessage}
          </div>
          {group.lastMessageTime && (
            <div className="text-xs text-muted-foreground mt-1">
              {formatDate(group.lastMessageTime)}
            </div>
          )}
        </div>
      )}

      {/* Quick Actions */}
      <div className="pt-2 border-t border-border">
        {group.editable && (
          <div className="mb-4 space-y-3 rounded-lg border border-border bg-card p-3">
            <div>
              <div className="text-sm font-medium">运行模型</div>
              <p className="text-xs text-muted-foreground mt-1">
                修改后会停止当前 Runner，下一次消息会按新配置重启
              </p>
            </div>

            <div className="grid gap-3">
              <div>
                <Label className="mb-2 text-xs text-muted-foreground">Provider</Label>
                <Select
                  value={llmProvider}
                  onValueChange={(value) => setLlmProvider(value as 'claude' | 'openai')}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="claude">Anthropic</SelectItem>
                    <SelectItem value="openai">OpenAI / Codex</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label className="mb-2 text-xs text-muted-foreground">模型</Label>
                <Input
                  list={llmProvider === 'openai' ? `codex-model-options-${group.jid}` : undefined}
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="留空时跟随系统默认模型"
                />
                {llmProvider === 'openai' && (
                  <datalist id={`codex-model-options-${group.jid}`}>
                    {codexModels.map((option) => (
                      option.value === '__default__' ? null : (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      )
                    ))}
                  </datalist>
                )}
                {llmProvider === 'openai' && codexModelsLoading && (
                  <p className="mt-1 text-xs text-muted-foreground">正在加载 Codex 模型列表…</p>
                )}
              </div>

              <div>
                <Label className="mb-2 text-xs text-muted-foreground">推理强度</Label>
                <Select
                  value={thinkingEffort}
                  onValueChange={(value) => setThinkingEffort(value as 'default' | 'low' | 'medium' | 'high')}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="default">跟随模型默认</SelectItem>
                    <SelectItem value="low">低</SelectItem>
                    <SelectItem value="medium">中</SelectItem>
                    <SelectItem value="high">高</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label className="mb-2 text-xs text-muted-foreground">上下文压缩策略</Label>
                <Input
                  value={contextCompression}
                  onChange={(e) => setContextCompression(e.target.value)}
                  placeholder="留空时跟随默认值"
                />
              </div>

              <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
                <div>
                  <div className="text-sm font-medium">知识提取</div>
                  <p className="text-xs text-muted-foreground mt-1">
                    允许工作区自动沉淀结构化知识
                  </p>
                </div>
                <Switch
                  checked={knowledgeExtraction}
                  onCheckedChange={setKnowledgeExtraction}
                />
              </div>

              <Button
                size="sm"
                onClick={handleSaveRuntimeSettings}
                disabled={saving || !hasRuntimeChanges}
              >
                {saving ? '保存中…' : '保存运行模型配置'}
              </Button>
            </div>
          </div>
        )}

        <Button
          variant="outline"
          size="sm"
          onClick={() => navigate(`/settings?tab=memory&folder=${encodeURIComponent(group.folder)}`)}
        >
          <BookOpen className="w-4 h-4" />
          记忆管理
        </Button>
      </div>
    </div>
  );
}
