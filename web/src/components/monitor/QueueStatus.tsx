import { ListOrdered } from 'lucide-react';
import { SystemStatus } from '../../stores/monitor';

interface QueueStatusProps {
  status: SystemStatus;
}

export function QueueStatus({ status }: QueueStatusProps) {
  const sessionsWithQueue = status.sessions.filter((session) =>
    session.pendingMessages || session.pendingTasks > 0,
  );

  return (
    <div className="bg-card rounded-xl border border-border p-6">
      <div className="flex items-center gap-3 mb-4">
        <div className="p-2 bg-amber-100 rounded-lg">
          <ListOrdered className="w-6 h-6 text-amber-600" />
        </div>
        <div>
          <h3 className="text-sm font-medium text-slate-500">队列状态</h3>
          <p className="text-2xl font-bold text-foreground">
            {status.queueLength}
          </p>
        </div>
      </div>

      <div className="space-y-1">
        <div className="text-xs text-slate-500">
          {sessionsWithQueue.length} 个会话 runtime 有待处理任务或消息
        </div>

        {sessionsWithQueue.length > 0 && (
          <div className="mt-3 space-y-1">
            {sessionsWithQueue.slice(0, 3).map((session) => (
              <div
                key={session.runtime_key}
                className="flex items-center justify-between text-xs"
              >
                <span className="text-slate-600 truncate">
                  {session.session_name || session.session_id || '未知会话'}
                </span>
                <span className="text-foreground font-medium ml-2">
                  {session.pendingTasks}{session.pendingMessages ? ' + 消息' : ''}
                </span>
              </div>
            ))}
            {sessionsWithQueue.length > 3 && (
              <div className="text-xs text-slate-400">
                ... 还有 {sessionsWithQueue.length - 3} 个会话
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
