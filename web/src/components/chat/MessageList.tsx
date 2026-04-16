import { useEffect, useLayoutEffect, useRef, useState, useMemo, useCallback } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Message, TurnInfo, useChatStore } from '../../stores/chat';
import { useAuthStore } from '../../stores/auth';
import type { AgentInfo } from '../../types';
import { MessageBubble } from './MessageBubble';
import { StreamingDisplay } from './StreamingDisplay';
import { TurnIndicator } from './TurnIndicator';
import { AgentStatusCard } from './AgentStatusCard';
import { EmojiAvatar } from '../common/EmojiAvatar';
import { Loader2, ChevronUp, ChevronDown, AlertTriangle, Square } from 'lucide-react';
import { useDisplayMode } from '../../hooks/useDisplayMode';

interface MessageListProps {
  messages: Message[];
  loading: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
  /** Increment to force scroll to bottom (e.g. after sending a message) */
  scrollTrigger?: number;
  /** Current group JID — used to save/restore scroll position across group switches */
  sessionId?: string;
  /** Whether the agent is currently processing */
  isWaiting?: boolean;
  /** Callback to interrupt the current agent query */
  onInterrupt?: () => void;
  /** Sub-agents to display as status cards in the main conversation */
  agents?: AgentInfo[];
  /** Callback when a sub-agent status card is clicked */
  onAgentClick?: (agentId: string) => void;
  /** If set, this MessageList is showing a sub-agent's messages */
  agentId?: string;
  /** Callback to send a message (used for quick prompts in empty state) */
  onSend?: (content: string) => void;
}

type FlatItem =
  | { type: 'date'; content: string }
  | { type: 'divider'; content: string }
  | { type: 'error'; content: string }
  | { type: 'turn_start'; content: TurnInfo }
  | { type: 'message'; content: Message };

const quickPrompts = [
  '帮我分析一段代码',
  '写一个自动化脚本',
  '解释一个技术概念',
  '帮我调试一个问题',
];

export function MessageList({ messages, loading, hasMore, onLoadMore, scrollTrigger, sessionId, isWaiting, onInterrupt, agents, onAgentClick, agentId, onSend }: MessageListProps) {
  const { mode: displayMode } = useDisplayMode();
  const thinkingCache = useChatStore(s => s.thinkingCache ?? {});
  const highlightMessageId = useChatStore(s => s.highlightMessageId[sessionId ?? ''] ?? null);
  const clearHighlight = useChatStore(s => s.clearHighlight);
  const isShared = false;
  const currentUser = useAuthStore(s => s.user);
  const appearance = useAuthStore(s => s.appearance);
  const aiName = currentUser?.ai_name || appearance?.aiName || 'AI 助手';
  const aiEmoji = currentUser?.ai_avatar_emoji || appearance?.aiAvatarEmoji;
  const aiColor = currentUser?.ai_avatar_color || appearance?.aiAvatarColor;
  const aiImageUrl = currentUser?.ai_avatar_url;
  const turns = useChatStore(s => s.turns[sessionId ?? '']);
  const parentRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [atTop, setAtTop] = useState(false);
  const prevMessageCount = useRef(messages.length);

  // Turn boundaries:
  // 1. Prefer anchoring a turn to its first visible input message via messageIds.
  // 2. Fall back to startedAt when the input message is outside the loaded window.
  // This avoids the old behavior where the divider often appeared between
  // the user's input and the AI reply, or disappeared entirely for the first
  // visible turn in the current page.
  const turnBoundaryPlan = useMemo(() => {
    if (!turns || turns.length === 0) {
      return {
        byMessageId: new Map<string, TurnInfo[]>(),
        fallback: [] as Array<{ timestamp: string; turn: TurnInfo }>,
      };
    }

    const messageIndex = new Map<string, number>();
    for (let i = 0; i < messages.length; i++) {
      messageIndex.set(messages[i].id, i);
    }

    const byMessageId = new Map<string, TurnInfo[]>();
    const fallback: Array<{ timestamp: string; turn: TurnInfo }> = [];

    for (const turn of turns) {
      let firstVisibleMessageId: string | null = null;
      let firstVisibleIndex = Number.POSITIVE_INFINITY;

      for (const messageId of turn.messageIds) {
        const idx = messageIndex.get(messageId);
        if (idx == null) continue;
        if (idx < firstVisibleIndex) {
          firstVisibleIndex = idx;
          firstVisibleMessageId = messageId;
        }
      }

      if (firstVisibleMessageId) {
        const existing = byMessageId.get(firstVisibleMessageId) || [];
        existing.push(turn);
        byMessageId.set(firstVisibleMessageId, existing);
      } else {
        fallback.push({ timestamp: turn.startedAt, turn });
      }
    }

    for (const [messageId, group] of byMessageId.entries()) {
      group.sort((a, b) => {
        if (a.startedAt === b.startedAt) return a.id.localeCompare(b.id);
        return a.startedAt.localeCompare(b.startedAt);
      });
      byMessageId.set(messageId, group);
    }

    fallback.sort((a, b) => {
      if (a.timestamp === b.timestamp) return a.turn.id.localeCompare(b.turn.id);
      return a.timestamp.localeCompare(b.timestamp);
    });

    return { byMessageId, fallback };
  }, [turns, messages]);

  // Compute flatMessages (with date headers and turn boundaries) before virtualizer
  const flatMessages = useMemo<FlatItem[]>(() => {
    const grouped = messages.reduce((acc, msg) => {
      const date = new Date(msg.timestamp).toLocaleDateString('zh-CN', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });
      if (!acc[date]) acc[date] = [];
      acc[date].push(msg);
      return acc;
    }, {} as Record<string, Message[]>);

    const items: FlatItem[] = [];
    // Time-based fallback insertion: for turns whose input messages are
    // outside the loaded window, insert based on startedAt.
    let fallbackIdx = 0;
    const fallbackBoundaries = turnBoundaryPlan.fallback;

    Object.entries(grouped).forEach(([date, msgs]) => {
      items.push({ type: 'date', content: date });
      msgs.forEach((msg) => {
        if (msg.sender === '__system__') {
          if (msg.content === 'context_reset') {
            items.push({ type: 'divider', content: '上下文已清除' });
          } else if (msg.content === 'query_interrupted') {
            items.push({ type: 'divider', content: '当前 Turn 已中断' });
          } else if (msg.content.startsWith('agent_error:')) {
            items.push({ type: 'error', content: msg.content.slice('agent_error:'.length) });
          } else if (msg.content.startsWith('agent_max_retries:')) {
            items.push({ type: 'error', content: msg.content.slice('agent_max_retries:'.length) });
          }
        } else {
          // Prefer exact anchor by input messageId
          const anchoredTurns = turnBoundaryPlan.byMessageId.get(msg.id);
          if (anchoredTurns?.length) {
            for (const turn of anchoredTurns) {
              items.push({ type: 'turn_start', content: turn });
            }
          }

          // Fallback: Insert any turn boundaries whose startedAt <= this message's timestamp
          while (fallbackIdx < fallbackBoundaries.length && fallbackBoundaries[fallbackIdx].timestamp <= msg.timestamp) {
            items.push({ type: 'turn_start', content: fallbackBoundaries[fallbackIdx].turn });
            fallbackIdx++;
          }
          items.push({ type: 'message', content: msg });
        }
      });
    });

    // Tail flush: if the loaded window ends before a fallback boundary finds
    // a later message to attach to, still render it at the end so it doesn't
    // silently disappear.
    while (fallbackIdx < fallbackBoundaries.length) {
      items.push({ type: 'turn_start', content: fallbackBoundaries[fallbackIdx].turn });
      fallbackIdx++;
    }

    return items;
  }, [messages, turnBoundaryPlan]);

  // Chat always starts at bottom — no scroll position restoration.
  // key={...} on <MessageList> guarantees a fresh mount on group/tab switch.
  const virtualizer = useVirtualizer({
    count: flatMessages.length,
    getScrollElement: () => parentRef.current,
    initialOffset: flatMessages.length > 0 ? 99999999 : 0,
    getItemKey: (index) => {
      const item = flatMessages[index];
      if (!item) return index;
      switch (item.type) {
        case 'date': return `date-${item.content}`;
        case 'divider': return `div-${index}`;
        case 'error': return `err-${index}`;
        case 'turn_start': return `turn-${item.content.id}`;
        case 'message': return item.content.id;
      }
    },
    estimateSize: (index) => {
      const item = flatMessages[index];
      if (!item) return 100;
      switch (item.type) {
        case 'date': return 48;
        case 'divider':
        case 'error': return 56;
        case 'turn_start': return 36;
        case 'message': {
          const len = item.content.content.length;
          if (item.content.is_from_me) {
            // AI messages often contain markdown tables, code blocks, and
            // structured content that renders much taller than plain text.
            // A low cap causes the virtualizer to miscalculate total height,
            // leading to scroll position oscillation (visible flickering).
            return Math.max(80, Math.ceil(len / 40) * 24 + 80);
          }
          return Math.max(48, Math.min(200, Math.ceil(len / 80) * 24 + 40));
        }
        default: return 100;
      }
    },
    overscan: 8,
  });

  // 检测向上滚动触发 loadMore + 保存滚动位置
  useEffect(() => {
    const parent = parentRef.current;
    if (!parent) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = parent;
      const atBottom = scrollHeight - scrollTop - clientHeight < 100;
      setAutoScroll(atBottom);
      setAtTop(scrollTop < 50);

      if (scrollTop < 100 && hasMore && !loading) {
        onLoadMore();
      }
    };

    parent.addEventListener('scroll', handleScroll);
    return () => parent.removeEventListener('scroll', handleScroll);
  }, [hasMore, loading, onLoadMore, sessionId]);

  // 新消息自动滚到底部
  useEffect(() => {
    if (autoScroll && messages.length > prevMessageCount.current) {
      requestAnimationFrame(() => {
        parentRef.current?.scrollTo({ top: parentRef.current.scrollHeight, behavior: 'smooth' });
      });
    }
    prevMessageCount.current = messages.length;
  }, [messages.length, autoScroll]);

  // 外部触发滚到底部（发送消息后）
  useEffect(() => {
    if (scrollTrigger && scrollTrigger > 0) {
      setAutoScroll(true);
      requestAnimationFrame(() => {
        parentRef.current?.scrollTo({ top: parentRef.current.scrollHeight, behavior: 'smooth' });
      });
    }
  }, [scrollTrigger]);

  // Fallback: 消息在挂载后加载（首次页面加载时 store 为空）
  // initialOffset 只在挂载时生效，消息后加载需要手动定位
  const initialScrollDone = useRef(flatMessages.length > 0);
  useLayoutEffect(() => {
    if (!initialScrollDone.current && flatMessages.length > 0) {
      initialScrollDone.current = true;
      prevMessageCount.current = messages.length;
      // Skip scroll-to-bottom if we have a highlight target (search result navigation)
      if (!highlightMessageId) {
        virtualizer.scrollToIndex(flatMessages.length - 1, { align: 'end' });
        if (parentRef.current) {
          parentRef.current.scrollTop = parentRef.current.scrollHeight;
        }
        setAutoScroll(true);
      }
    }
  }, [flatMessages.length, virtualizer, messages.length, highlightMessageId]);

  // Safety net: initialOffset relies on estimated sizes which may be inaccurate.
  // After mount, verify we're actually at the bottom and correct if not.
  useEffect(() => {
    if (flatMessages.length === 0 || highlightMessageId) return;
    const raf1 = requestAnimationFrame(() => {
      const el = parentRef.current;
      if (!el) return;
      const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (gap > 100) {
        el.scrollTop = el.scrollHeight;
      }
    });
    return () => cancelAnimationFrame(raf1);
    // Only on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Scroll to highlighted message (from search results)
  const lastHighlightRef = useRef<string | null>(null);
  useEffect(() => {
    if (!highlightMessageId || highlightMessageId === lastHighlightRef.current) return;
    // Find the target message in flatMessages
    const targetIndex = flatMessages.findIndex(
      (item) => item.type === 'message' && item.content.id === highlightMessageId,
    );
    if (targetIndex < 0) return;

    lastHighlightRef.current = highlightMessageId;
    setAutoScroll(false);
    // Scroll with a small delay to let virtualizer measure
    requestAnimationFrame(() => {
      virtualizer.scrollToIndex(targetIndex, { align: 'center' });
      // Double-scroll for accuracy after measurement
      requestAnimationFrame(() => {
        virtualizer.scrollToIndex(targetIndex, { align: 'center' });
      });
    });

    // Auto-clear highlight after 3 seconds
    const timer = setTimeout(() => {
      if (sessionId) clearHighlight(sessionId);
    }, 3000);
    return () => clearTimeout(timer);
  }, [highlightMessageId, flatMessages, virtualizer, sessionId, clearHighlight]);

  // Auto-scroll when streaming content updates
  const streaming = useChatStore(s => agentId ? s.agentStreaming[agentId] : s.streaming[sessionId ?? '']);
  useEffect(() => {
    if (autoScroll && streaming) {
      parentRef.current?.scrollTo({ top: parentRef.current.scrollHeight });
    }
  }, [streaming, autoScroll]);

  const scrollToTop = useCallback(() => {
    parentRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const scrollToBottom = useCallback(() => {
    const parent = parentRef.current;
    if (!parent) return;
    parent.scrollTo({ top: parent.scrollHeight, behavior: 'smooth' });
  }, []);

  const showScrollButtons = messages.length > 0;

  return (
    <div className="relative flex-1 overflow-hidden overflow-x-hidden">
      <div
        ref={parentRef}
        className="h-full overflow-y-auto overflow-x-hidden py-6 bg-background"
      >
        <div className={displayMode === 'compact' ? 'mx-auto px-4 min-w-0' : 'max-w-3xl mx-auto px-4 min-w-0'}>
        {loading && hasMore && (
          <div className="flex justify-center py-4">
            <Loader2 className="animate-spin text-primary" size={24} />
          </div>
        )}

        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            width: '100%',
            position: 'relative',
          }}
        >
          {virtualizer.getVirtualItems().map((virtualItem) => {
            const item = flatMessages[virtualItem.index];
            if (!item) return null;

            if (item.type === 'date') {
              return (
                <div
                  key={virtualItem.key}
                  ref={virtualizer.measureElement}
                  data-index={virtualItem.index}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualItem.start}px)`,
                  }}
                >
                  <div className="flex justify-center my-6">
                    <span className="bg-card px-4 py-1 rounded-full text-xs text-muted-foreground border border-border">
                      {item.content}
                    </span>
                  </div>
                </div>
              );
            }

            if (item.type === 'divider') {
              return (
                <div
                  key={virtualItem.key}
                  ref={virtualizer.measureElement}
                  data-index={virtualItem.index}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualItem.start}px)`,
                  }}
                >
                  <div className="flex items-center gap-3 my-6 px-4">
                    <div className="flex-1 border-t border-amber-300" />
                    <span className="text-xs text-amber-600 whitespace-pre-wrap">
                      {item.content}
                    </span>
                    <div className="flex-1 border-t border-amber-300" />
                  </div>
                </div>
              );
            }

            if (item.type === 'error') {
              return (
                <div
                  key={virtualItem.key}
                  ref={virtualizer.measureElement}
                  data-index={virtualItem.index}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualItem.start}px)`,
                  }}
                >
                  <div className="flex items-center gap-3 my-6 px-4">
                    <div className="flex-1 border-t border-red-300" />
                    <span className="text-xs text-red-600 whitespace-pre-wrap flex items-center gap-1">
                      <AlertTriangle size={14} />
                      {item.content}
                    </span>
                    <div className="flex-1 border-t border-red-300" />
                  </div>
                </div>
              );
            }

            if (item.type === 'turn_start') {
              const turn = item.content;
              const ch = turn.channel.startsWith('feishu:') ? '飞书'
                : turn.channel.startsWith('telegram:') ? 'Telegram'
                : turn.channel.startsWith('qq:') ? 'QQ'
                : turn.channel.startsWith('web:') ? 'Web' : turn.channel;
              let duration = '';
              if (turn.startedAt && turn.completedAt) {
                const ms = new Date(turn.completedAt).getTime() - new Date(turn.startedAt).getTime();
                if (ms > 0) {
                  const sec = Math.floor(ms / 1000);
                  duration = sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m${sec % 60}s`;
                }
              }
              const label = [ch, turn.messageIds.length > 1 ? `${turn.messageIds.length} 条` : null, duration || null, turn.status !== 'completed' ? turn.status : null].filter(Boolean).join(' · ');
              return (
                <div
                  key={virtualItem.key}
                  ref={virtualizer.measureElement}
                  data-index={virtualItem.index}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualItem.start}px)`,
                  }}
                >
                  <div className="flex items-center gap-2 my-3 px-4">
                    <div className="flex-1 border-t border-dashed border-border" />
                    <span className="text-[11px] text-muted-foreground/60 whitespace-nowrap">
                      {label}
                    </span>
                    <div className="flex-1 border-t border-dashed border-border" />
                  </div>
                </div>
              );
            }

            const message = item.content;
            const showTime = true;
            const isHighlighted = highlightMessageId === message.id;

            return (
              <div
                key={virtualItem.key}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${virtualItem.start}px)`,
                }}
                ref={virtualizer.measureElement}
                data-index={virtualItem.index}
                className={isHighlighted ? 'animate-highlight-fade' : undefined}
              >
                <MessageBubble message={message} showTime={showTime} thinkingContent={thinkingCache[message.id]} chatJid={sessionId || ''} isShared={isShared} />
              </div>
            );
          })}
        </div>

        {messages.length === 0 && !loading && (
          <div className="flex flex-col items-center justify-center h-full px-6">
            <div className="max-w-sm w-full space-y-6">
              {/* AI avatar + welcome */}
              <div className="flex flex-col items-center text-center space-y-3">
                <div className="w-16 h-16">
                  <EmojiAvatar
                    imageUrl={aiImageUrl}
                    emoji={aiEmoji}
                    color={aiColor}
                    fallbackChar={aiName[0]}
                    size="lg"
                    className="!w-16 !h-16 !text-2xl"
                  />
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-slate-900">{aiName}</h3>
                  <p className="text-sm text-slate-500 mt-1">有什么我可以帮你的吗？</p>
                </div>
              </div>

              {/* Quick prompts */}
              {onSend && (
                <div className="space-y-2">
                  {quickPrompts.map((prompt) => (
                    <button
                      key={prompt}
                      onClick={() => onSend(prompt)}
                      className="w-full text-left px-4 py-3 rounded-xl text-sm text-foreground transition-all active:scale-[0.98] cursor-pointer bg-card/60 backdrop-blur-sm border border-border/60 shadow-[0_2px_8px_rgba(0,0,0,0.04)] hover:bg-card/80 hover:shadow-[0_4px_12px_rgba(0,0,0,0.06)]"
                    >
                      {prompt}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {sessionId && !agentId && (
          <>
            <TurnIndicator chatJid={sessionId} />
            <StreamingDisplay sessionId={sessionId} isWaiting={!!isWaiting} />
          </>
        )}
        {sessionId && agentId && (
          <StreamingDisplay sessionId={sessionId} isWaiting={!!isWaiting} agentId={agentId} />
        )}

        {/* Agent status cards in main conversation (task agents only) */}
        {!agentId && agents && agents.filter(a => a.kind === 'task').length > 0 && (
          <div className="py-2">
            {agents.filter(a => a.kind === 'task').map((agent) => (
              <AgentStatusCard
                key={agent.id}
                agent={agent}
                onClick={() => onAgentClick?.(agent.id)}
              />
            ))}
          </div>
        )}

        {isWaiting && onInterrupt && (
          <div className="flex justify-center py-1">
            <button
              type="button"
              onClick={onInterrupt}
              className="inline-flex items-center gap-1.5 px-3 py-1 text-xs text-slate-500 hover:text-red-600 bg-slate-100 hover:bg-red-50 rounded-full transition-colors cursor-pointer"
            >
              <Square className="w-3 h-3" />
              中断
            </button>
          </div>
        )}
        </div>
      </div>

      {/* Floating scroll buttons */}
      {showScrollButtons && (
        <div className="absolute right-4 bottom-4 flex flex-col gap-1.5">
          {!atTop && (
            <button
              onClick={scrollToTop}
              className="w-10 h-10 rounded-full bg-card border border-border shadow-sm flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent transition-colors cursor-pointer"
              title="回到顶部"
            >
              <ChevronUp className="w-4 h-4" />
            </button>
          )}
          {!autoScroll && (
            <button
              onClick={scrollToBottom}
              className="w-10 h-10 rounded-full bg-card border border-border shadow-sm flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent transition-colors cursor-pointer"
              title="回到底部"
            >
              <ChevronDown className="w-4 h-4" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
