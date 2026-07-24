import { useState, useMemo, useEffect, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useNavigate } from 'react-router-dom';
import { Plus, PanelLeftClose } from 'lucide-react';
import { useChatStore } from '../../stores/chat';
import { useAuthStore } from '../../stores/auth';
import { Button } from '@/components/ui/button';
import { SearchInput } from '@/components/common';
import { ConfirmDialog } from '@/components/common';
import { ChatGroupItem } from './ChatGroupItem';
import { CreateWorkspaceDialog } from './CreateWorkspaceDialog';
import { RenameDialog } from './RenameDialog';
import { SkeletonCardList } from '@/components/common/Skeletons';
import { cn } from '@/lib/utils';
import type { SessionInfo } from '../../types';

type SessionEntry = SessionInfo & { jid: string };
type DateSection = { label: string; items: SessionEntry[] };
type SidebarListItem =
  | { type: 'heading'; key: string; label: string; variant: 'section' | 'date' }
  | { type: 'session'; key: string; session: SessionEntry; isHome: boolean; isPinned: boolean };

function groupByDate(items: SessionEntry[]): DateSection[] {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekAgo = new Date(today.getTime() - 7 * 86400000);
  const sections: DateSection[] = [
    { label: '今天', items: [] },
    { label: '最近 7 天', items: [] },
    { label: '更早', items: [] },
  ];
  items.forEach((g) => {
    const time = new Date(g.lastMessageTime || g.created_at);
    if (time >= today) sections[0].items.push(g);
    else if (time >= weekAgo) sections[1].items.push(g);
    else sections[2].items.push(g);
  });
  return sections.filter((s) => s.items.length > 0);
}

interface ChatSidebarProps {
  className?: string;
  onToggleCollapse?: () => void;
}

export function ChatSidebar({ className, onToggleCollapse }: ChatSidebarProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [createOpen, setCreateOpen] = useState(false);

  // Rename dialog state
  const [renameState, setRenameState] = useState({ open: false, jid: '', name: '' });

  // Delete confirm state
  const [deleteState, setDeleteState] = useState({ open: false, jid: '', name: '' });
  const [deleteLoading, setDeleteLoading] = useState(false);

  // Clear history confirm state
  const [clearState, setClearState] = useState({ open: false, jid: '', name: '' });
  const [clearLoading, setClearLoading] = useState(false);

  const {
    groups: sessions,
    currentGroup: currentSession,
    selectGroup: selectSession,
    loadGroups: loadSessions,
    loading,
    deleteFlow,
    clearHistory,
    togglePin,
  } = useChatStore();
  const navigate = useNavigate();
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  // Keep the main session pinned above other sessions, then sort the rest by activity.
  const { mainSession, otherSessions } = useMemo(() => {
    let main: (typeof sessions)[string] & { jid: string } | null = null;
    const others: ((typeof sessions)[string] & { jid: string })[] = [];

    for (const [jid, info] of Object.entries(sessions)) {
      const entry = { jid, ...info };
      if (info.kind === 'main') {
        main = entry;
      } else {
        others.push(entry);
      }
    }

    others.sort((a, b) => {
      const timeA = a.lastMessageTime || a.created_at;
      const timeB = b.lastMessageTime || b.created_at;
      return new Date(timeB).getTime() - new Date(timeA).getTime();
    });

    return { mainSession: main, otherSessions: others };
  }, [sessions]);

  const { pinnedSessions, workspaceSections } = useMemo(() => {
    const filtered = searchQuery.trim()
      ? otherSessions.filter((entry) =>
          entry.name.toLowerCase().includes(searchQuery.toLowerCase()),
        )
      : otherSessions;

    const pinned: typeof otherSessions = [];
    const workspaces: typeof otherSessions = [];

    filtered.forEach((g) => {
      if (g.pinned_at) {
        pinned.push(g);
      } else {
        workspaces.push(g);
      }
    });

    // Sort pinned by pinned_at ascending (earliest pinned first = stable top)
    pinned.sort((a, b) => (a.pinned_at || '').localeCompare(b.pinned_at || ''));

    return { pinnedSessions: pinned, workspaceSections: groupByDate(workspaces) };
  }, [otherSessions, searchQuery]);

  const handleSessionSelect = (jid: string, sessionSlug: string) => {
    selectSession(jid);
    navigate(`/chat/${sessionSlug}`);
  };

  const appearance = useAuthStore((s) => s.appearance);
  const appName = appearance?.appName || 'AgentDock';

  const handleCreated = (jid: string, sessionSlug: string) => {
    selectSession(jid);
    navigate(`/chat/${sessionSlug}`);
  };

  const handleDeleteConfirm = async () => {
    setDeleteLoading(true);
    try {
      await deleteFlow(deleteState.jid);
      setDeleteState({ open: false, jid: '', name: '' });
      // Navigate to the auto-selected next session, or list view if none remain
      const nextSessionId = useChatStore.getState().currentGroup;
      const nextFolder = nextSessionId
        ? useChatStore.getState().groups[nextSessionId]?.folder
        : null;
      navigate(nextFolder ? `/chat/${nextFolder}` : '/chat');
    } catch (err: unknown) {
      const typed = err as { boundAgents?: Array<{ agentName: string; imGroups: Array<{ name: string }> }> };
      if (typed.boundAgents) {
        const details = typed.boundAgents
          .map((a) => `「${a.agentName}」→ ${a.imGroups.map((g) => g.name).join('、')}`)
          .join('\n');
        alert(`该会话下有子会话绑定了 IM 渠道，请先解绑后再删除：\n${details}`);
      } else {
        const message = err instanceof Error ? err.message : '未知错误';
        alert(`删除会话失败：${message}`);
      }
      setDeleteState({ open: false, jid: '', name: '' });
    } finally {
      setDeleteLoading(false);
    }
  };

  const handleClearConfirm = async () => {
    setClearLoading(true);
    try {
      const ok = await clearHistory(clearState.jid);
      if (ok) setClearState({ open: false, jid: '', name: '' });
    } finally {
      setClearLoading(false);
    }
  };

  const allSessions = mainSession ? [mainSession, ...otherSessions] : otherSessions;

  const listItems = useMemo<SidebarListItem[]>(() => {
    const items: SidebarListItem[] = [];
    if (mainSession) {
      items.push(
        { type: 'heading', key: 'heading-main', label: '主会话', variant: 'section' },
        { type: 'session', key: `session-${mainSession.jid}`, session: mainSession, isHome: true, isPinned: false },
      );
    }
    if (pinnedSessions.length > 0) {
      items.push({ type: 'heading', key: 'heading-pinned', label: '已固定', variant: 'section' });
      for (const session of pinnedSessions) {
        items.push({ type: 'session', key: `session-${session.jid}`, session, isHome: false, isPinned: true });
      }
    }
    if (workspaceSections.length > 0) {
      items.push({ type: 'heading', key: 'heading-workspaces', label: '其他会话', variant: 'section' });
      for (const section of workspaceSections) {
        items.push({ type: 'heading', key: `heading-date-${section.label}`, label: section.label, variant: 'date' });
        for (const session of section.items) {
          items.push({ type: 'session', key: `session-${session.jid}`, session, isHome: false, isPinned: false });
        }
      }
    }
    return items;
  }, [mainSession, pinnedSessions, workspaceSections]);

  const listVirtualizer = useVirtualizer({
    count: listItems.length,
    getScrollElement: () => listRef.current,
    getItemKey: (index) => listItems[index]?.key || index,
    estimateSize: (index) => {
      const item = listItems[index];
      if (item?.type === 'heading') return item.variant === 'date' ? 28 : 38;
      return item?.type === 'session' && item.session.lastMessage ? 61 : 47;
    },
    overscan: 10,
  });

  return (
    <div className={cn('flex flex-col h-full bg-background border-r', className)}>
      {/* Logo Header — only on mobile (PC has NavRail logo) */}
      <div className="flex items-center gap-2.5 px-4 pt-4 pb-1 lg:hidden">
        <img
          src={`${import.meta.env.BASE_URL}icons/icon-192.png`}
          alt={appName}
          className="w-8 h-8 rounded-lg"
        />
        <span className="text-lg font-bold text-foreground truncate">{appName}</span>
      </div>

      {/* New Chat + Search */}
      <div className="p-3 space-y-2">
        <div className="flex gap-2">
          <Button
            variant="outline"
            className="flex-1 justify-start gap-2"
            onClick={() => setCreateOpen(true)}
          >
            <Plus className="w-4 h-4" />
            新建会话
          </Button>
          <button
            onClick={onToggleCollapse}
            className="hidden lg:flex items-center p-2 rounded-md border hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
            title="折叠侧边栏"
          >
            <PanelLeftClose className="w-4 h-4" />
          </button>
        </div>
        <SearchInput
          value={searchQuery}
          onChange={setSearchQuery}
          placeholder="搜索会话..."
          debounce={200}
          className="max-lg:bg-background/60 max-lg:backdrop-blur-lg max-lg:border-border/30 max-lg:rounded-lg"
        />
      </div>

      {/* Groups List */}
      <div ref={listRef} className="flex-1 overflow-y-auto px-2">
        {loading && allSessions.length === 0 ? (
          <SkeletonCardList count={6} compact />
        ) : listItems.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 px-4">
            <p className="text-sm text-muted-foreground text-center">
              {searchQuery ? '未找到匹配的会话' : '暂无会话'}
            </p>
          </div>
        ) : (
          <div className="relative w-full" style={{ height: `${listVirtualizer.getTotalSize()}px` }}>
            {listVirtualizer.getVirtualItems().map((virtualItem) => {
              const item = listItems[virtualItem.index];
              if (!item) return null;
              const positionStyle = {
                transform: `translateY(${virtualItem.start}px)`,
              };

              if (item.type === 'heading') {
                return (
                  <div
                    key={virtualItem.key}
                    ref={listVirtualizer.measureElement}
                    data-index={virtualItem.index}
                    className={cn(
                      'absolute left-0 top-0 w-full px-2',
                      item.variant === 'date' ? 'pt-2 pb-1' : 'pt-3 pb-1.5',
                      item.key === 'heading-main' && 'pt-1',
                    )}
                    style={positionStyle}
                  >
                    <span className={item.variant === 'date'
                      ? 'text-[10px] text-muted-foreground/70 tracking-wide'
                      : 'text-[11px] font-bold text-muted-foreground uppercase tracking-wider'}
                    >
                      {item.label}
                    </span>
                  </div>
                );
              }

              const session = item.session;
              return (
                <div
                  key={virtualItem.key}
                  ref={listVirtualizer.measureElement}
                  data-index={virtualItem.index}
                  className="absolute left-0 top-0 w-full"
                  style={positionStyle}
                >
                  <ChatGroupItem
                    jid={session.jid}
                    name={session.name}
                    sessionSlug={session.folder}
                    lastMessage={session.lastMessage}
                    isActive={currentSession === session.jid}
                    isHome={item.isHome}
                    isPinned={item.isPinned}
                    runnerLabel={session.runner_label}
                    model={session.model}
                    editable={item.isHome ? true : session.editable}
                    deletable={session.deletable}
                    onSelect={handleSessionSelect}
                    onRename={(jid, name) => setRenameState({ open: true, jid, name })}
                    onClearHistory={(jid, name) => setClearState({ open: true, jid, name })}
                    onDelete={item.isHome ? undefined : (jid, name) => setDeleteState({ open: true, jid, name })}
                    onTogglePin={item.isHome ? undefined : togglePin}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Dialogs */}
      <CreateWorkspaceDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={handleCreated}
      />

      <RenameDialog
        open={renameState.open}
        jid={renameState.jid}
        currentName={renameState.name}
        onClose={() => setRenameState({ open: false, jid: '', name: '' })}
      />

      <ConfirmDialog
        open={clearState.open}
        onClose={() => setClearState({ open: false, jid: '', name: '' })}
        onConfirm={handleClearConfirm}
        title="重建会话"
        message={`确认重建会话「${clearState.name}」吗？这会清除全部聊天记录、上下文，并删除工作目录中的所有文件。此操作不可撤销。`}
        confirmText="确认重建"
        cancelText="取消"
        confirmVariant="danger"
        loading={clearLoading}
      />

      <ConfirmDialog
        open={deleteState.open}
        onClose={() => setDeleteState({ open: false, jid: '', name: '' })}
        onConfirm={handleDeleteConfirm}
        title="删除会话"
        message={`确认删除会话「${deleteState.name}」吗？此操作会彻底删除该会话的全部数据，包括聊天记录、工作目录文件、定时任务和相关 IM 绑定。此操作不可撤销。`}
        confirmText="删除"
        cancelText="取消"
        confirmVariant="danger"
        loading={deleteLoading}
      />
    </div>
  );
}
