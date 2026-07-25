import { useEffect, useMemo, useState } from 'react';
import {
  Code2,
  Download,
  ExternalLink,
  Github,
  Heart,
  Lightbulb,
  Loader2,
  RefreshCw,
  RotateCcw,
  Save,
  Trash2,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

const updatePhaseText: Record<DesktopUpdateState['phase'], string> = {
  idle: '待检查',
  checking: '正在检查',
  available: '发现新版本',
  'not-available': '已是最新版本',
  downloading: '正在下载',
  downloaded: '已下载',
  error: '更新失败',
};

export function AboutSection() {
  const nativeApi =
    typeof window === 'undefined' ? undefined : window.agentdockNative;
  const isDesktop =
    typeof window !== 'undefined' &&
    window.__AGENTDOCK_DESKTOP__ === true &&
    typeof nativeApi?.getUpdateState === 'function';
  const [updateState, setUpdateState] = useState<DesktopUpdateState | null>(
    null,
  );
  const [feedUrl, setFeedUrl] = useState('');
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);

  useEffect(() => {
    if (!isDesktop || !nativeApi?.getUpdateState) return;
    let cancelled = false;
    nativeApi
      .getUpdateState()
      .then((next) => {
        if (cancelled) return;
        setUpdateState(next);
        setFeedUrl(next.source?.url || '');
      })
      .catch((error) => {
        if (!cancelled) {
          setUpdateError(errorMessage(error, '读取桌面更新状态失败'));
        }
      });
    const unsubscribe = nativeApi.onUpdateStatus?.((next) => {
      setUpdateState(next);
      if (next.source?.url) setFeedUrl(next.source.url);
      setUpdateError(next.error);
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [isDesktop, nativeApi]);

  const progressText = useMemo(() => {
    const progress = updateState?.progress;
    if (!progress) return null;
    return `${progress.percent.toFixed(1)}% · ${formatBytes(progress.transferred)} / ${formatBytes(progress.total)}`;
  }, [updateState?.progress]);
  const isBusy =
    busyAction !== null ||
    updateState?.phase === 'checking' ||
    updateState?.phase === 'downloading';

  async function runUpdateAction(
    name: string,
    action: () => Promise<DesktopUpdateState>,
  ): Promise<void> {
    setBusyAction(name);
    setUpdateError(null);
    try {
      const next = await action();
      setUpdateState(next);
      setUpdateError(next.error);
      if (next.source?.url) setFeedUrl(next.source.url);
    } catch (error) {
      setUpdateError(errorMessage(error, '桌面更新操作失败'));
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <div className="space-y-6">
      {/* 项目信息 */}
      <div>
        <h2 className="text-lg font-semibold text-foreground mb-1">
          AgentDock
        </h2>
        <p className="text-sm text-muted-foreground">
          自托管个人 AI Agent 系统
        </p>
      </div>

      {/* 开源地址 & 作者 */}
      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <Github className="w-4 h-4 text-muted-foreground/80 shrink-0" />
          <a
            href="https://github.com/riba2534/agentdock"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-primary hover:text-primary inline-flex items-center gap-1"
          >
            riba2534/agentdock
            <ExternalLink className="w-3 h-3" />
          </a>
        </div>
        <div className="flex items-center gap-3">
          <Code2 className="w-4 h-4 text-muted-foreground/80 shrink-0" />
          <span className="text-sm text-foreground">作者：riba2534</span>
        </div>
      </div>

      <hr className="border-border-subtle" />

      {isDesktop && (
        <>
          <div className="space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-medium text-foreground">
                  桌面端更新
                </h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  当前版本：{updateState?.currentVersion || '-'}
                </p>
              </div>
              <span className="text-xs text-muted-foreground">
                {updateState ? updatePhaseText[updateState.phase] : '正在读取'}
              </span>
            </div>

            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                value={feedUrl}
                onChange={(event) => setFeedUrl(event.target.value)}
                placeholder="https://host/path/to/updates/"
                disabled={isBusy}
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={
                    isBusy || !feedUrl.trim() || !nativeApi?.setUpdateFeedUrl
                  }
                  onClick={() =>
                    nativeApi?.setUpdateFeedUrl &&
                    void runUpdateAction('save', () =>
                      nativeApi.setUpdateFeedUrl!(feedUrl),
                    )
                  }
                >
                  {busyAction === 'save' ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <Save />
                  )}
                  保存
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  aria-label="清除更新源"
                  disabled={
                    isBusy ||
                    !updateState?.source ||
                    !nativeApi?.clearUpdateFeedUrl
                  }
                  onClick={() =>
                    nativeApi?.clearUpdateFeedUrl &&
                    void runUpdateAction('clear', async () => {
                      const next = await nativeApi.clearUpdateFeedUrl!();
                      setFeedUrl('');
                      return next;
                    })
                  }
                >
                  {busyAction === 'clear' ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <Trash2 />
                  )}
                </Button>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={
                  isBusy || !updateState?.source || !nativeApi?.checkForUpdates
                }
                onClick={() =>
                  nativeApi?.checkForUpdates &&
                  void runUpdateAction('check', nativeApi.checkForUpdates)
                }
              >
                {busyAction === 'check' || updateState?.phase === 'checking' ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <RefreshCw />
                )}
                检查更新
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={
                  isBusy ||
                  updateState?.phase !== 'available' ||
                  !nativeApi?.downloadUpdate
                }
                onClick={() =>
                  nativeApi?.downloadUpdate &&
                  void runUpdateAction('download', nativeApi.downloadUpdate)
                }
              >
                {busyAction === 'download' ||
                updateState?.phase === 'downloading' ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <Download />
                )}
                下载
              </Button>
              <Button
                size="sm"
                disabled={
                  isBusy ||
                  updateState?.phase !== 'downloaded' ||
                  !nativeApi?.installUpdate
                }
                onClick={() =>
                  nativeApi?.installUpdate &&
                  void runUpdateAction('install', nativeApi.installUpdate)
                }
              >
                {busyAction === 'install' ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <RotateCcw />
                )}
                重启安装
              </Button>
            </div>

            {(updateState?.updateInfo || progressText || updateError) && (
              <div className="rounded-md border border-border bg-surface px-3 py-2 text-xs">
                {updateState?.updateInfo && (
                  <div className="text-muted-foreground">
                    目标版本：{updateState.updateInfo.version}
                  </div>
                )}
                {progressText && (
                  <div className="text-muted-foreground">{progressText}</div>
                )}
                {updateError && <div className="text-error">{updateError}</div>}
              </div>
            )}
          </div>

          <hr className="border-border-subtle" />
        </>
      )}

      {/* 灵感来源 */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <Lightbulb className="w-4 h-4 text-warning" />
          <h3 className="text-sm font-medium text-foreground">灵感来源</h3>
        </div>
        <div className="space-y-4 text-sm text-muted-foreground">
          <div>
            <a
              href="https://github.com/slopus/happy"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:text-primary font-medium inline-flex items-center gap-1"
            >
              Happy
              <ExternalLink className="w-3 h-3" />
            </a>
            <p className="mt-1 leading-relaxed">
              我接触到的第一个类似项目。它是 Claude Code 的网页 Web
              版，让你可以在任何地方通过浏览器使用 Claude
              Code，不再受限于本地终端。这个理念深深吸引了我，但遗憾的是项目维护更新不够及时，许多问题长期得不到修复。
            </p>
          </div>
          <div>
            <a
              href="https://github.com/openclaw/openclaw"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:text-primary font-medium inline-flex items-center gap-1"
            >
              OpenClaw
              <ExternalLink className="w-3 h-3" />
            </a>
            <p className="mt-1 leading-relaxed">
              当下最火爆、最流行的个人 Agent
              项目。但我认为它的架构存在根本性的缺陷——它自己从头实现了一个
              Agent。而 Claude Code 已经是世界上最好的 Agent
              了，为什么不站在巨人的肩膀上去构建呢？
            </p>
          </div>
        </div>
      </div>

      <hr className="border-border-subtle" />

      {/* 设计哲学 */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <Heart className="w-4 h-4 text-[var(--tag-rose-fg)]" />
          <h3 className="text-sm font-medium text-foreground">设计哲学</h3>
        </div>
        <p className="text-sm text-muted-foreground leading-relaxed">
          站在巨人的肩膀上，基于 Claude Code（全世界最好的 Agent）构建。
        </p>
      </div>
    </div>
  );
}
