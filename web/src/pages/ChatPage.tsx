import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { PanelLeftOpen } from 'lucide-react';
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
  } = useChatStore();
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
  const hasSessions = Object.keys(sessions).length > 0;

  // Sync URL param to store selection. No auto-redirect to the main session.
  // Users land on the welcome screen and choose a session manually.
  useEffect(() => {
    if (!sessionSlug) return;
    if (routeSessionId && currentSession !== routeSessionId) {
      selectSession(routeSessionId);
      return;
    }
    if (hasSessions && !routeSessionId) {
      navigate('/chat', { replace: true });
    }
  }, [
    sessionSlug,
    routeSessionId,
    hasSessions,
    currentSession,
    selectSession,
    navigate,
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
        <div className="hidden lg:flex flex-1 items-center justify-center bg-background relative">
          {sidebarCollapsed && (
            <button
              onClick={() => setSidebarCollapsed(false)}
              className="absolute left-3 top-3 p-1.5 rounded-md border hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
              title="展开侧边栏"
            >
              <PanelLeftOpen className="w-4 h-4" />
            </button>
          )}
          <div className="text-center max-w-sm">
            {/* Logo */}
            <div className="w-16 h-16 rounded-2xl overflow-hidden mx-auto mb-6">
              <img src={`${import.meta.env.BASE_URL}icons/icon-192.png`} alt="HappyClaw" className="w-full h-full object-cover" />
            </div>
            <h2 className="text-xl font-semibold text-slate-900 mb-2">
              欢迎使用 {appearance?.appName || 'HappyClaw'}
            </h2>
            <p className="text-slate-500 text-sm">
              从左侧选择一个会话开始对话
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
