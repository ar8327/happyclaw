import type { AgentInfo } from '../../types';

interface AgentStatusCardProps {
  agent: AgentInfo;
  onClick?: () => void;
}

const STATUS_COLORS: Record<string, { bg: string; text: string; dot: string }> = {
  running: { bg: 'bg-info-bg', text: 'text-info', dot: 'bg-info animate-pulse' },
  completed: { bg: 'bg-success-bg', text: 'text-success', dot: 'bg-success' },
  error: { bg: 'bg-error-bg', text: 'text-error', dot: 'bg-error' },
};

const STATUS_LABELS: Record<string, string> = {
  running: '执行中',
  completed: '已完成',
  error: '出错',
};

export function AgentStatusCard({ agent, onClick }: AgentStatusCardProps) {
  const colors = STATUS_COLORS[agent.status] || STATUS_COLORS.running;

  return (
    <div
      onClick={onClick}
      className={`${colors.bg} border border-current/10 rounded-lg p-3 my-2 cursor-pointer hover:shadow-sm transition-shadow`}
    >
      <div className="flex items-center gap-2">
        <span className={`w-2 h-2 rounded-full ${colors.dot}`} />
        <span className={`text-sm font-medium ${colors.text}`}>
          子 Agent: {agent.name}
        </span>
        <span className={`text-xs ${colors.text} opacity-70`}>
          {STATUS_LABELS[agent.status]}
        </span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground line-clamp-2">
        {agent.prompt}
      </p>
      {agent.result_summary && agent.status !== 'running' && (
        <p className="mt-1.5 text-xs text-muted-foreground line-clamp-3 border-t border-current/5 pt-1.5">
          {agent.result_summary}
        </p>
      )}
    </div>
  );
}
