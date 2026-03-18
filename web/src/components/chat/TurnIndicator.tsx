/**
 * TurnIndicator: shows current turn info and pending queue status.
 * Displayed above the StreamingDisplay when a turn is active.
 */
import { useEffect, useState } from 'react';
import { useChatStore } from '../../stores/chat';

interface TurnIndicatorProps {
  chatJid: string;
}

function formatChannel(channel: string): string {
  if (channel.startsWith('feishu:')) return '飞书';
  if (channel.startsWith('telegram:')) return 'Telegram';
  if (channel.startsWith('qq:')) return 'QQ';
  if (channel.startsWith('web:')) return 'Web';
  return channel;
}

function formatDuration(startedAt: number): string {
  const elapsed = Math.floor((Date.now() - startedAt) / 1000);
  if (elapsed < 60) return `${elapsed}s`;
  const min = Math.floor(elapsed / 60);
  const sec = elapsed % 60;
  return `${min}m${sec}s`;
}

function formatAge(iso?: string): string | null {
  if (!iso) return null;
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return null;
  const elapsed = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (elapsed < 60) return `${elapsed}s`;
  const min = Math.floor(elapsed / 60);
  const sec = elapsed % 60;
  return `${min}m${sec}s`;
}

function formatRunnerState(state?: string, detail?: string): string {
  switch (state) {
    case 'queued':
      return detail ? `排队中 · ${detail}` : '排队中';
    case 'capacity_wait':
      return detail ? `等待资源 · ${detail}` : '等待资源';
    case 'starting':
      return detail ? `启动中 · ${detail}` : '启动中';
    case 'interrupting':
      return detail ? `正在中断 · ${detail}` : '正在中断';
    case 'interrupted':
      return detail ? `已中断 · ${detail}` : '已中断';
    case 'error':
      return detail ? `出错 · ${detail}` : '出错';
    case 'drained':
      return '已切换到下一轮';
    case 'completed':
      return '已完成';
    case 'running':
    default:
      return detail ? `执行中 · ${detail}` : '执行中';
  }
}

export function TurnIndicator({ chatJid }: TurnIndicatorProps) {
  const activeTurn = useChatStore((s) => s.activeTurn[chatJid]);
  const pendingBuffer = useChatStore((s) => s.pendingBuffer[chatJid]);
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!activeTurn) return;
    const id = window.setInterval(() => {
      setTick((n) => n + 1);
    }, 1000);
    return () => window.clearInterval(id);
  }, [activeTurn]);

  if (!activeTurn && !pendingBuffer) return null;

  const pendingEntries = pendingBuffer
    ? Object.entries(pendingBuffer).filter(([, count]) => count > 0)
    : [];

  if (!activeTurn && pendingEntries.length === 0) return null;

  const runnerState = activeTurn?.runnerState;
  const lastEventAge = formatAge(activeTurn?.lastEventAt);
  const stale =
    !!activeTurn &&
    activeTurn.status !== 'interrupted' &&
    runnerState?.state !== 'queued' &&
    runnerState?.state !== 'capacity_wait' &&
    !!activeTurn.lastEventAt &&
    (() => {
      const ts = Date.parse(activeTurn.lastEventAt!);
      return Number.isFinite(ts) && Date.now() - ts >= 30_000;
    })();

  return (
    <div className="px-4 py-2">
      {activeTurn && (
        <div className="rounded-xl border border-teal-200/70 bg-teal-50/40 px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-teal-800 dark:text-teal-200">
            <span className="inline-flex items-center gap-1.5 font-medium">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-teal-500 animate-pulse" />
              <span>当前 Turn</span>
            </span>
            <span className="opacity-50">·</span>
            <span>{formatChannel(activeTurn.channel)}</span>
            <span className="opacity-50">·</span>
            <span>{activeTurn.messageCount} 条</span>
            <span className="opacity-50">·</span>
            <span>已运行 {formatDuration(activeTurn.startedAt)}</span>
          </div>

          <div className={`mt-1 text-xs ${stale ? 'text-amber-700 dark:text-amber-300' : 'text-slate-600 dark:text-slate-300'}`}>
            {formatRunnerState(runnerState?.state || activeTurn.status, runnerState?.detail)}
          </div>

          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500 dark:text-slate-400">
            {lastEventAge ? (
              <span className={stale ? 'text-amber-600 dark:text-amber-300 font-medium' : ''}>
                最近事件 {lastEventAge} 前
              </span>
            ) : (
              <span>尚未收到执行事件</span>
            )}
            {stale && (
              <span className="text-amber-600 dark:text-amber-300">
                长时间无新进展，可能卡住
              </span>
            )}
          </div>
        </div>
      )}
      {pendingEntries.length > 0 && (
        <div className="mt-2 text-[11px] text-amber-700 dark:text-amber-300">
          {pendingEntries
            .map(([ch, count]) => `${formatChannel(ch)} ${count} 条等待中`)
            .join(' · ')}
        </div>
      )}
    </div>
  );
}
