import { Badge } from '@/components/ui/badge';

interface GroupStatusCardProps {
  group: {
    jid: string;
    session_id?: string | null;
    active: boolean;
    pendingMessages: boolean;
    pendingTasks: number;
    runtime_mode?: 'local';
    runner_id?: string;
    runtime_identifier?: string | null;
  };
}

export function GroupStatusCard({ group }: GroupStatusCardProps) {
  return (
    <div className="bg-card rounded-xl border border-border p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium text-foreground truncate mr-2">
          {group.session_id || group.jid}
        </span>
        {group.active ? (
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
            {group.pendingTasks} 个任务 / {group.pendingMessages ? '有新消息' : '无新消息'}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span>Runner</span>
          <span className="text-foreground">
            {group.runner_id || '-'} / {group.runtime_mode || '-'}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span>进程标识</span>
          <span className="text-foreground font-mono truncate ml-2 max-w-[60%] text-right">
            {group.runtime_identifier || '-'}
          </span>
        </div>
      </div>
    </div>
  );
}
