import { useEffect } from 'react';
import { Users } from 'lucide-react';
import { useSessionsStore } from '../stores/sessions';
import { SessionCard } from '../components/sessions/SessionCard';
import { PageHeader } from '@/components/common/PageHeader';
import { SkeletonCardGrid } from '@/components/common/Skeletons';
import { EmptyState } from '@/components/common/EmptyState';

export function SessionsPage() {
  const { sessions, loading, loadSessions } = useSessionsStore();

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  const sessionCards = Object.entries(sessions).map(([jid, info]) => ({
    jid,
    ...info,
  }));

  return (
    <div className="min-h-full bg-background p-4 lg:p-8">
      <div className="max-w-7xl mx-auto">
        <PageHeader
          title="会话管理"
          subtitle={`${sessionCards.length} 个已注册会话`}
          className="mb-6"
        />

        {loading && (
          <SkeletonCardGrid />
        )}

        {!loading && sessionCards.length === 0 && (
          <EmptyState
            icon={Users}
            title="暂无会话"
            description="当前还没有可展示的会话"
          />
        )}

        {!loading && sessionCards.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {sessionCards.map((session) => (
              <SessionCard key={session.jid} session={session} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
