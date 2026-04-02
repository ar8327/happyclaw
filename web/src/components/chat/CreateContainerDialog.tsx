import { useEffect, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  Monitor,
  Box,
  FolderInput,
  GitBranch,
  Loader2,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
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
import { DirectoryBrowser } from '../shared/DirectoryBrowser';
import { useChatStore } from '../../stores/chat';
import { useAuthStore } from '../../stores/auth';
import { api } from '../../api/client';
import { useCodexModels } from '../../hooks/useCodexModels';

interface SystemDefaults {
  defaultLlmProvider?: 'claude' | 'openai';
  defaultClaudeModel?: string;
  defaultCodexModel?: string;
}

interface CreateContainerDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: (jid: string, folder: string) => void;
}

export function CreateContainerDialog({
  open,
  onClose,
  onCreated,
}: CreateContainerDialogProps) {
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [executionMode, setExecutionMode] = useState<'container' | 'host'>('container');
  const [customCwd, setCustomCwd] = useState('');
  const [initMode, setInitMode] = useState<'empty' | 'local' | 'git'>('empty');
  const [initSourcePath, setInitSourcePath] = useState('');
  const [initGitUrl, setInitGitUrl] = useState('');
  const [systemDefaults, setSystemDefaults] = useState<SystemDefaults>({
    defaultLlmProvider: 'claude',
    defaultClaudeModel: '',
    defaultCodexModel: '',
  });
  const [defaultsLoaded, setDefaultsLoaded] = useState(false);
  const [llmProvider, setLlmProvider] = useState<'claude' | 'openai'>('claude');
  const [model, setModel] = useState('');
  const [thinkingEffort, setThinkingEffort] = useState<'default' | 'low' | 'medium' | 'high'>('default');
  const [contextCompression, setContextCompression] = useState('');
  const [knowledgeExtraction, setKnowledgeExtraction] = useState(false);

  const createFlow = useChatStore((s) => s.createFlow);
  const canHostExec = useAuthStore((s) => s.user?.role === 'admin');
  const { models: codexModels, loading: codexModelsLoading } = useCodexModels(
    open && advancedOpen && llmProvider === 'openai',
  );

  const applyDefaults = (defaults?: SystemDefaults) => {
    const provider = defaults?.defaultLlmProvider ?? 'claude';
    setSystemDefaults({
      defaultLlmProvider: provider,
      defaultClaudeModel: defaults?.defaultClaudeModel ?? '',
      defaultCodexModel: defaults?.defaultCodexModel ?? '',
    });
    setLlmProvider(provider);
    setModel(
      provider === 'openai'
        ? defaults?.defaultCodexModel ?? ''
        : defaults?.defaultClaudeModel ?? '',
    );
    setThinkingEffort('default');
    setContextCompression('');
    setKnowledgeExtraction(false);
  };

  const reset = (defaults?: SystemDefaults) => {
    setName('');
    setAdvancedOpen(false);
    setExecutionMode('container');
    setCustomCwd('');
    setInitMode('empty');
    setInitSourcePath('');
    setInitGitUrl('');
    applyDefaults(defaults);
  };

  const handleClose = () => {
    onClose();
    reset();
  };

  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    setDefaultsLoaded(false);

    void api
      .get<SystemDefaults>('/api/config/system')
      .then((defaults) => {
        if (cancelled) return;
        reset(defaults);
      })
      .catch(() => {
        if (cancelled) return;
        reset();
      })
      .finally(() => {
        if (!cancelled) setDefaultsLoaded(true);
      });

    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!defaultsLoaded) return;
    const claudeDefault = systemDefaults.defaultClaudeModel ?? '';
    const codexDefault = systemDefaults.defaultCodexModel ?? '';
    const nextDefault = llmProvider === 'openai' ? codexDefault : claudeDefault;

    if (!model.trim() || model === claudeDefault || model === codexDefault) {
      setModel(nextDefault);
    }
  }, [defaultsLoaded, llmProvider, model, systemDefaults]);

  const handleConfirm = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;

    setLoading(true);
    try {
      const options: {
        execution_mode?: 'container' | 'host';
        custom_cwd?: string;
        init_source_path?: string;
        init_git_url?: string;
        llm_provider?: 'claude' | 'openai';
        model?: string;
        thinking_effort?: 'low' | 'medium' | 'high' | null;
        context_compression?: string;
        knowledge_extraction?: boolean;
      } = {};
      if (executionMode === 'host') {
        options.execution_mode = 'host';
        if (customCwd.trim()) options.custom_cwd = customCwd.trim();
      } else {
        if (initMode === 'local' && initSourcePath.trim()) {
          options.init_source_path = initSourcePath.trim();
        } else if (initMode === 'git' && initGitUrl.trim()) {
          options.init_git_url = initGitUrl.trim();
        }
      }
      options.llm_provider = llmProvider;
      if (model.trim()) options.model = model.trim();
      if (thinkingEffort !== 'default') options.thinking_effort = thinkingEffort;
      if (contextCompression.trim()) options.context_compression = contextCompression.trim();
      options.knowledge_extraction = knowledgeExtraction;
      const created = await createFlow(trimmed, Object.keys(options).length ? options : undefined);
      if (created) {
        onCreated(created.jid, created.folder);
        handleClose();
      } else {
        toast.error('创建失败，请重试');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '创建失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>新建工作区</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Name input */}
          <div>
            <label className="block text-sm font-medium mb-2">工作区名称</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleConfirm(); }}
              placeholder="输入工作区名称"
              autoFocus
            />
          </div>

          {/* Advanced options */}
          <div className="border rounded-lg overflow-hidden">
            <button
              type="button"
              onClick={() => setAdvancedOpen(!advancedOpen)}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground hover:bg-accent transition-colors cursor-pointer"
            >
              {advancedOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
              高级选项
            </button>
            {advancedOpen && (
              <div className="px-3 pb-3 space-y-3 border-t">
                {/* Execution mode */}
                <div className="pt-3">
                  <label className="block text-sm font-medium mb-2">执行模式</label>
                  <div className="space-y-2">
                    <label className="flex items-start gap-3 p-2 rounded-lg border cursor-pointer hover:bg-accent/50 transition-colors">
                      <input
                        type="radio"
                        name="execution_mode"
                        value="container"
                        checked={executionMode === 'container'}
                        onChange={() => { setExecutionMode('container'); setCustomCwd(''); }}
                        className="mt-0.5 accent-primary"
                      />
                      <div>
                        <div className="flex items-center gap-1.5">
                          <Box className="w-4 h-4 text-muted-foreground" />
                          <span className="text-sm font-medium">Docker 模式</span>
                          <span className="text-xs text-primary font-medium">推荐</span>
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5">在隔离的 Docker 环境中执行</p>
                      </div>
                    </label>
                    <label className={`flex items-start gap-3 p-2 rounded-lg border transition-colors ${canHostExec ? 'cursor-pointer hover:bg-accent/50' : 'opacity-50 cursor-not-allowed'}`}>
                      <input
                        type="radio"
                        name="execution_mode"
                        value="host"
                        checked={executionMode === 'host'}
                        onChange={() => { if (canHostExec) { setExecutionMode('host'); setInitMode('empty'); setInitSourcePath(''); setInitGitUrl(''); } }}
                        disabled={!canHostExec}
                        className="mt-0.5 accent-primary"
                      />
                      <div>
                        <div className="flex items-center gap-1.5">
                          <Monitor className="w-4 h-4 text-muted-foreground" />
                          <span className="text-sm font-medium">宿主机模式</span>
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {canHostExec ? '直接在服务器上执行' : '需要管理员权限'}
                        </p>
                      </div>
                    </label>
                  </div>
                </div>

                {/* Container mode: workspace source */}
                {executionMode === 'container' && (
                  <div className="pt-1">
                    <label className="block text-sm font-medium mb-2">工作区来源</label>
                    <div className="space-y-2">
                      <label className="flex items-start gap-3 p-2 rounded-lg border cursor-pointer hover:bg-accent/50 transition-colors">
                        <input type="radio" name="init_mode" value="empty" checked={initMode === 'empty'} onChange={() => setInitMode('empty')} className="mt-0.5 accent-primary" />
                        <div>
                          <span className="text-sm font-medium">空白工作区</span>
                          <p className="text-xs text-muted-foreground mt-0.5">从空目录开始</p>
                        </div>
                      </label>
                      {canHostExec && (
                        <label className="flex items-start gap-3 p-2 rounded-lg border cursor-pointer hover:bg-accent/50 transition-colors">
                          <input type="radio" name="init_mode" value="local" checked={initMode === 'local'} onChange={() => setInitMode('local')} className="mt-0.5 accent-primary" />
                          <div className="flex-1">
                            <div className="flex items-center gap-1.5">
                              <FolderInput className="w-4 h-4 text-muted-foreground" />
                              <span className="text-sm font-medium">复制本地目录</span>
                            </div>
                            <p className="text-xs text-muted-foreground mt-0.5">将宿主机目录复制到工作区（隔离副本）</p>
                          </div>
                        </label>
                      )}
                      {initMode === 'local' && canHostExec && (
                        <div className="ml-6">
                          <DirectoryBrowser value={initSourcePath} onChange={setInitSourcePath} placeholder="选择要复制的目录" />
                        </div>
                      )}
                      <label className="flex items-start gap-3 p-2 rounded-lg border cursor-pointer hover:bg-accent/50 transition-colors">
                        <input type="radio" name="init_mode" value="git" checked={initMode === 'git'} onChange={() => setInitMode('git')} className="mt-0.5 accent-primary" />
                        <div className="flex-1">
                          <div className="flex items-center gap-1.5">
                            <GitBranch className="w-4 h-4 text-muted-foreground" />
                            <span className="text-sm font-medium">克隆 Git 仓库</span>
                          </div>
                          <p className="text-xs text-muted-foreground mt-0.5">从 GitHub 等平台克隆仓库到工作区</p>
                        </div>
                      </label>
                      {initMode === 'git' && (
                        <div className="ml-6">
                          <Input
                            value={initGitUrl}
                            onChange={(e) => setInitGitUrl(e.target.value)}
                            placeholder="https://github.com/user/repo"
                          />
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Host mode: custom cwd */}
                {executionMode === 'host' && (
                  <>
                    <DirectoryBrowser value={customCwd} onChange={setCustomCwd} placeholder="默认: data/groups/{folder}/" />
                    <div className="flex items-start gap-2 p-2 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg">
                      <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
                      <p className="text-xs text-amber-700 dark:text-amber-300">
                        宿主机模式下 Agent 可访问完整文件系统和工具链，请谨慎使用。
                      </p>
                    </div>
                  </>
                )}

                <div className="pt-1 space-y-3">
                  <div>
                    <Label className="mb-2">运行模型</Label>
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
                          list={llmProvider === 'openai' ? 'codex-model-options' : undefined}
                          value={model}
                          onChange={(e) => setModel(e.target.value)}
                          placeholder="留空时跟随系统默认模型"
                        />
                        {llmProvider === 'openai' && (
                          <datalist id="codex-model-options">
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
                          placeholder="留空时使用系统默认值"
                        />
                      </div>

                      <div className="flex items-center justify-between rounded-lg border px-3 py-2">
                        <div>
                          <div className="text-sm font-medium">知识提取</div>
                          <p className="text-xs text-muted-foreground">允许工作区自动提取并沉淀结构化知识</p>
                        </div>
                        <Switch checked={knowledgeExtraction} onCheckedChange={setKnowledgeExtraction} />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={loading}>
            取消
          </Button>
          <Button onClick={handleConfirm} disabled={loading || !name.trim()}>
            {loading && <Loader2 className="w-4 h-4 animate-spin" />}
            {loading && (initMode === 'local' || initMode === 'git') ? '正在初始化工作区...' : '创建'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
