import { Badge } from '@/components/ui/badge';
import type { RuntimeSessionStatus } from '../../stores/monitor';

interface SessionStatusCardProps {
  session: RuntimeSessionStatus;
}

export function SessionStatusCard({ session }: SessionStatusCardProps) {
  const sessionLabel = session.session_name || session.session_id || '未知会话';

  return (
    <div className="bg-card rounded-xl border border-border p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium text-foreground truncate mr-2">
          {sessionLabel}
        </span>
        {session.active ? (
          <Badge variant="default" className="bg-green-100 text-green-700 hover:bg-green-200 shrink-0">
            运行中
          </Badge>
        ) : (
          <Badge variant="secondary" className="shrink-0">
            空闲
          </Badge>
        )}
      </div>

      <div className="space-y-1.5 text-xs text-slate-500">
        <div className="flex items-center justify-between">
          <span>队列</span>
          <span className="text-foreground">
            {session.pendingTasks} 个任务 / {session.pendingMessages ? '有新消息' : '无新消息'}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span>Session ID</span>
          <span className="text-foreground font-mono truncate ml-2 max-w-[60%] text-right">
            {session.session_id || '-'}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span>Runner</span>
          <span className="text-foreground">{session.runner_id || '-'}</span>
        </div>
        <div className="flex items-center justify-between">
          <span>进程标识</span>
          <span className="text-foreground font-mono truncate ml-2 max-w-[60%] text-right">
            {session.runtime_identifier || '-'}
          </span>
        </div>
      </div>
    </div>
  );
}
