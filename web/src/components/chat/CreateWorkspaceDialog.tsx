import { useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  FolderInput,
  GitBranch,
  Loader2,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DirectoryBrowser } from '../shared/DirectoryBrowser';
import { useChatStore } from '../../stores/chat';

interface CreateWorkspaceDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: (jid: string, folder: string) => void;
}

export function CreateWorkspaceDialog({
  open,
  onClose,
  onCreated,
}: CreateWorkspaceDialogProps) {
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [initMode, setInitMode] = useState<'empty' | 'local' | 'git'>('empty');
  const [initSourcePath, setInitSourcePath] = useState('');
  const [initGitUrl, setInitGitUrl] = useState('');

  const createFlow = useChatStore((s) => s.createFlow);

  const reset = () => {
    setName('');
    setAdvancedOpen(false);
    setError(null);
    setInitMode('empty');
    setInitSourcePath('');
    setInitGitUrl('');
  };

  const handleClose = () => {
    onClose();
    reset();
  };

  const handleConfirm = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;

    setLoading(true);
    setError(null);
    try {
      const options: Record<string, string> = {};
      if (initMode === 'local' && initSourcePath.trim()) {
        options.init_source_path = initSourcePath.trim();
      } else if (initMode === 'git' && initGitUrl.trim()) {
        options.init_git_url = initGitUrl.trim();
      }
      const created = await createFlow(trimmed, Object.keys(options).length ? options : undefined);
      if (created) {
        onCreated(created.jid, created.folder);
        handleClose();
      } else {
        setError('创建失败，请重试');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建失败');
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
                <div className="pt-3">
                  <label className="block text-sm font-medium mb-2">工作区来源</label>
                  <div className="space-y-2">
                    <label className="flex items-start gap-3 p-2 rounded-lg border cursor-pointer hover:bg-accent/50 transition-colors">
                      <input type="radio" name="init_mode" value="empty" checked={initMode === 'empty'} onChange={() => setInitMode('empty')} className="mt-0.5 accent-primary" />
                      <div>
                        <span className="text-sm font-medium">空白工作区</span>
                        <p className="text-xs text-muted-foreground mt-0.5">从空目录开始</p>
                      </div>
                    </label>
                    <label className="flex items-start gap-3 p-2 rounded-lg border cursor-pointer hover:bg-accent/50 transition-colors">
                      <input type="radio" name="init_mode" value="local" checked={initMode === 'local'} onChange={() => setInitMode('local')} className="mt-0.5 accent-primary" />
                      <div className="flex-1">
                        <div className="flex items-center gap-1.5">
                          <FolderInput className="w-4 h-4 text-muted-foreground" />
                          <span className="text-sm font-medium">复制本地目录</span>
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5">复制目录内容到新的工作区</p>
                      </div>
                    </label>
                    {initMode === 'local' && (
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
                        <p className="text-xs text-muted-foreground mt-0.5">从远端仓库初始化工作区</p>
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

                <div className="flex items-start gap-2 p-2 bg-muted/40 border border-border rounded-lg">
                  <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
                  <p className="text-xs text-muted-foreground">
                    新工作区统一使用本地 runtime。运行目录、runner 和 profile 可在会话详情里继续调整。
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* Error */}
          {error && (
            <div className="flex items-start gap-2 p-3 bg-destructive/10 border border-destructive/20 rounded-lg">
              <AlertTriangle className="w-4 h-4 text-destructive flex-shrink-0 mt-0.5" />
              <p className="text-sm text-destructive">{error}</p>
            </div>
          )}
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
