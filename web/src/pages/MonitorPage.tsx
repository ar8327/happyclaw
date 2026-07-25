import { useEffect } from 'react';
import { useMonitorStore } from '../stores/monitor';
import { RuntimeStatusCard } from '../components/monitor/RuntimeStatusCard';
import { QueueStatus } from '../components/monitor/QueueStatus';
import { SystemInfo } from '../components/monitor/SystemInfo';
import { SessionStatusCard } from '../components/monitor/SessionStatusCard';
import { RefreshCw } from 'lucide-react';
import { PageHeader } from '@/components/common/PageHeader';
import { SkeletonStatCards } from '@/components/common/Skeletons';
import { Button } from '@/components/ui/button';

export function MonitorPage() {
  const { status, loading, loadStatus } = useMonitorStore();

  useEffect(() => {
    loadStatus();

    const interval = setInterval(() => {
      loadStatus();
    }, 10000);

    return () => clearInterval(interval);
  }, [loadStatus]);

  return (
    <div className="min-h-full bg-background p-4 lg:p-8">
      <div className="max-w-7xl mx-auto">
        <PageHeader
          title="系统监控"
          subtitle="实时监控系统状态（10秒自动刷新）"
          className="mb-6"
          actions={
            <Button variant="outline" onClick={loadStatus} disabled={loading}>
              <RefreshCw className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} />
              刷新
            </Button>
          }
        />

        {loading && !status && (
          <SkeletonStatCards />
        )}

        {status && (
          <div className="space-y-6">
            {/* 统计卡片 */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <RuntimeStatusCard status={status} />
              <QueueStatus status={status} />
              <SystemInfo status={status} />
            </div>

            {/* 会话 Runtime 详情 */}
            {status.sessions.length > 0 && (
              <div className="bg-card rounded-xl border border-border p-4 lg:p-6">
                <h2 className="text-lg font-semibold text-foreground mb-4">
                  会话 Runtime 状态
                </h2>

                {/* 移动端：卡片列表 */}
                <div className="lg:hidden space-y-3">
                  {status.sessions.map((session) => (
                    <SessionStatusCard key={session.runtime_key} session={session} />
                  ))}
                </div>

                {/* 桌面端：表格 */}
                <div className="hidden lg:block overflow-x-auto">
                  <table className="min-w-full divide-y divide-border">
                    <thead>
                      <tr>
                        <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                          会话
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                          Session ID
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                          Runner
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                          队列
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                          运行状态
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase">
                          进程标识
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {status.sessions.map((session) => (
                        <tr key={session.runtime_key} className="hover:bg-muted/50">
                          <td className="px-4 py-3 text-sm font-medium text-foreground">
                            {session.session_name || session.session_id || '未知会话'}
                          </td>
                          <td className="px-4 py-3 text-sm text-muted-foreground font-mono">
                            {session.session_id || '-'}
                          </td>
                          <td className="px-4 py-3 text-sm text-muted-foreground">
                            {session.runner_id || '-'}
                          </td>
                          <td className="px-4 py-3 text-sm text-muted-foreground">
                            {session.pendingTasks} 个任务 / {session.pendingMessages ? '有新消息' : '无新消息'}
                          </td>
                          <td className="px-4 py-3 text-sm">
                            {session.active ? (
                              <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-success-bg text-success">
                                运行中
                              </span>
                            ) : (
                              <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-surface-2 text-muted-foreground">
                                空闲
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-sm text-muted-foreground font-mono text-xs">
                            {session.runtime_identifier || '-'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
