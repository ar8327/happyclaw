import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { Loader2, PanelLeftOpen, RefreshCw } from 'lucide-react';
import { useChatStore } from '../stores/chat';
import { useAuthStore } from '../stores/auth';
import { ChatSidebar } from '../components/chat/ChatSidebar';
import { ChatView } from '../components/chat/ChatView';
import { useSwipeBack } from '../hooks/useSwipeBack';

export function ChatPage() {
  const { sessionSlug } = useParams<{ sessionSlug?: string }>();
  const navigate = useNavigate();
  const {
    groups: sessions,
    currentGroup: currentSession,
    selectGroup: selectSession,
    ensureGroupLoaded,
  } = useChatStore();
  const [resolvingSlug, setResolvingSlug] = useState(false);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [resolveAttempt, setResolveAttempt] = useState(0);
  const routeSessionId = useMemo(() => {
    if (!sessionSlug) return null;
    const entry =
      Object.entries(sessions).find(([_, info]) => info.id === sessionSlug) ||
      Object.entries(sessions).find(
        ([sessionId, info]) =>
          info.folder === sessionSlug &&
          sessionId.startsWith('web:') &&
          info.kind === 'main',
      ) ||
      Object.entries(sessions).find(
        ([sessionId, info]) =>
          info.folder === sessionSlug && sessionId.startsWith('web:'),
      ) ||
      Object.entries(sessions).find(([_, info]) => info.folder === sessionSlug);
    return entry?.[0] || null;
  }, [sessions, sessionSlug]);
  const [searchParams, setSearchParams] = useSearchParams();
  const highlightId = searchParams.get('highlightId');
  const highlightTs = searchParams.get('ts');
  const appearance = useAuthStore((s) => s.appearance);

  useEffect(() => {
    if (!sessionSlug) return;
    if (routeSessionId && currentSession !== routeSessionId) {
      selectSession(routeSessionId);
    }
  }, [sessionSlug, routeSessionId, currentSession, selectSession]);

  // The requested session may be outside the sidebar's currently loaded page.
  useEffect(() => {
    if (!sessionSlug || routeSessionId) {
      setResolvingSlug(false);
      setResolveError(null);
      return;
    }

    let cancelled = false;
    setResolvingSlug(true);
    setResolveError(null);
    ensureGroupLoaded(sessionSlug)
      .then((resolvedId) => {
        if (cancelled) return;
        setResolvingSlug(false);
        if (!resolvedId) {
          navigate('/chat', { replace: true });
          return;
        }
        selectSession(resolvedId);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setResolvingSlug(false);
        const message =
          typeof error === 'object' &&
          error !== null &&
          'message' in error &&
          typeof error.message === 'string'
            ? error.message
            : '会话加载失败，请检查服务状态后重试';
        setResolveError(message);
      });
    return () => {
      cancelled = true;
    };
  }, [
    sessionSlug,
    routeSessionId,
    resolveAttempt,
    ensureGroupLoaded,
    navigate,
    selectSession,
  ]);

  const activeSessionId = sessionSlug ? routeSessionId : currentSession;
  const chatViewRef = useRef<HTMLDivElement>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const loadMessagesAroundTimestamp = useChatStore((s) => s.loadMessagesAroundTimestamp);

  // Handle search highlight: load messages around the target and clear URL params
  useEffect(() => {
    if (highlightId && highlightTs && activeSessionId) {
      loadMessagesAroundTimestamp(activeSessionId, highlightTs, highlightId);
      // Clear URL params to avoid re-triggering on refresh
      setSearchParams({}, { replace: true });
    }
  }, [
    highlightId,
    highlightTs,
    activeSessionId,
    loadMessagesAroundTimestamp,
    setSearchParams,
  ]);

  const handleBackToList = () => {
    navigate('/chat');
  };

  useSwipeBack(chatViewRef, handleBackToList);

  return (
    <div className="h-full flex">
      {/* Sidebar - Desktop: always visible, Mobile: visible in list route */}
      <div className={`${sessionSlug ? 'hidden lg:block' : 'block'} w-full ${sidebarCollapsed ? 'lg:w-0 lg:overflow-hidden' : 'lg:w-72'} flex-shrink-0 transition-all duration-200`}>
        <ChatSidebar onToggleCollapse={() => setSidebarCollapsed(true)} />
      </div>

      {/* Chat View - Desktop: visible when a session is active, Mobile: only in detail route */}
      {activeSessionId ? (
        <div ref={chatViewRef} className={`${sessionSlug ? 'flex-1' : 'hidden lg:block flex-1'}`}>
          <ChatView
            sessionId={activeSessionId}
            onBack={handleBackToList}
            headerLeft={sidebarCollapsed ? (
              <button
                onClick={() => setSidebarCollapsed(false)}
                className="hidden lg:flex p-1.5 -ml-1 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
                title="展开侧边栏"
              >
                <PanelLeftOpen className="w-4 h-4" />
              </button>
            ) : undefined}
          />
        </div>
      ) : (
        <div className={`${sessionSlug ? 'flex' : 'hidden lg:flex'} flex-1 items-center justify-center bg-background relative`}>
          {sidebarCollapsed && (
            <button
              onClick={() => setSidebarCollapsed(false)}
              className="absolute left-3 top-3 p-1.5 rounded-md border hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
              title="展开侧边栏"
            >
              <PanelLeftOpen className="w-4 h-4" />
            </button>
          )}
          {resolvingSlug ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              正在加载会话…
            </div>
          ) : resolveError ? (
            <div className="max-w-sm px-6 text-center">
              <p className="mb-3 text-sm text-destructive">{resolveError}</p>
              <button
                type="button"
                onClick={() => setResolveAttempt((attempt) => attempt + 1)}
                className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm hover:bg-accent"
              >
                <RefreshCw className="size-4" />
                重试
              </button>
            </div>
          ) : (
          <div className="text-center max-w-sm">
            {/* Logo */}
            <div className="w-16 h-16 rounded-2xl overflow-hidden mx-auto mb-6">
              <img src={`${import.meta.env.BASE_URL}icons/icon-192.png`} alt="AgentDock" className="w-full h-full object-cover" />
            </div>
            <h2 className="text-xl font-semibold text-foreground mb-2">
              欢迎使用 {appearance?.appName || 'AgentDock'}
            </h2>
            <p className="text-muted-foreground text-sm">
              从左侧选择一个会话开始对话
            </p>
          </div>
          )}
        </div>
      )}
    </div>
  );
}
