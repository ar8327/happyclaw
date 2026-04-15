import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import type { SessionInfo } from '../../types';
import { SessionDetail } from './SessionDetail';

interface SessionCardProps {
  session: SessionInfo & { jid: string };
}

export function SessionCard({ session }: SessionCardProps) {
  const [expanded, setExpanded] = useState(false);
  const isSessionView =
    session.kind === 'main' ||
    session.kind === 'workspace' ||
    session.kind === 'worker' ||
    session.kind === 'memory';

  const truncateId = (value: string) => {
    if (value.length <= 30) return value;
    const parts = value.split(':');
    if (parts.length === 2 && parts[1].length > 20) {
      const id = parts[1];
      return `${parts[0]}:${id.slice(0, 8)}...${id.slice(-4)}`;
    }
    return value;
  };

  return (
    <div className="bg-card rounded-xl border border-border hover:border-brand-300 transition-colors duration-200">
      {/* Card Header - Clickable */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full p-4 text-left cursor-pointer"
      >
        <div className="flex items-start justify-between">
          <div className="flex-1 min-w-0">
            {/* Group Name */}
            <div className="flex items-center gap-2 mb-1">
              <h3 className="text-lg font-semibold text-foreground truncate">
                {session.name}
              </h3>
            </div>

            {/* Session ID / JID */}
            <p className="text-xs text-slate-500 font-mono mb-2">
              {truncateId(session.jid)}
            </p>

            {/* Core metadata */}
            <div className="space-y-1 text-sm">
              <div className="flex items-center gap-2">
                <span className="text-slate-500">
                  {isSessionView ? '会话类型:' : '会话目录:'}
                </span>
                <span className="text-foreground font-medium">
                  {isSessionView ? (session.kind || 'unknown') : session.folder}
                </span>
              </div>
              {isSessionView && (
                <div className="flex items-center gap-2">
                  <span className="text-slate-500">运行引擎:</span>
                  <span className="text-foreground font-medium">
                    {session.runner_label || session.runner_id || 'unknown'}
                  </span>
                </div>
              )}
              {isSessionView && (
                <div className="flex items-center gap-2">
                  <span className="text-slate-500">渠道绑定:</span>
                  <span className="text-foreground font-medium truncate">
                    {session.binding_summary || '无渠道绑定'}
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Expand Icon */}
          <div className="ml-4 flex-shrink-0">
            {expanded ? (
              <ChevronUp className="w-5 h-5 text-slate-400" />
            ) : (
              <ChevronDown className="w-5 h-5 text-slate-400" />
            )}
          </div>
        </div>
      </button>

      {/* Expanded Detail */}
      {expanded && (
        <div className="border-t border-border">
          <SessionDetail session={session} />
        </div>
      )}
    </div>
  );
}
