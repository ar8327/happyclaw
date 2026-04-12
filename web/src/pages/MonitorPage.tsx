import { useEffect } from 'react';
import { useMonitorStore } from '../stores/monitor';
import { RuntimeStatusCard } from '../components/monitor/RuntimeStatusCard';
import { QueueStatus } from '../components/monitor/QueueStatus';
import { SystemInfo } from '../components/monitor/SystemInfo';
import { GroupStatusCard } from '../components/monitor/GroupStatusCard';
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
            {status.groups && status.groups.length > 0 && (
              <div className="bg-card rounded-xl border border-border p-4 lg:p-6">
                <h2 className="text-lg font-semibold text-foreground mb-4">
                  会话 Runtime 状态
                </h2>

                {/* 移动端：卡片列表 */}
                <div className="lg:hidden space-y-3">
                  {status.groups.map((group) => (
                    <GroupStatusCard key={group.jid} group={group} />
                  ))}
                </div>

                {/* 桌面端：表格 */}
                <div className="hidden lg:block overflow-x-auto">
                  <table className="min-w-full divide-y divide-border">
                    <thead>
                      <tr>
                        <th className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase">
                          会话
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase">
                          Runner
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase">
                          队列
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase">
                          运行状态
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase">
                          进程标识
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {status.groups.map((group) => (
                        <tr key={group.jid} className="hover:bg-muted/50">
                          <td className="px-4 py-3 text-sm font-medium text-foreground">
                            {group.session_id || group.jid}
                          </td>
                          <td className="px-4 py-3 text-sm text-slate-600">
                            {group.runner_id || '-'} / {group.runtime_mode || '-'}
                          </td>
                          <td className="px-4 py-3 text-sm text-slate-600">
                            {group.pendingTasks} 个任务 / {group.pendingMessages ? '有新消息' : '无新消息'}
                          </td>
                          <td className="px-4 py-3 text-sm">
                            {group.active ? (
                              <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-600">
                                运行中
                              </span>
                            ) : (
                              <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-500">
                                空闲
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-sm text-slate-600 font-mono text-xs">
                            {group.runtime_identifier || '-'}
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
