import { Loader2, MessageSquare, Users, ArrowRightLeft, Unlink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { AvailableImGroup } from '../../types';
import { ChannelBadge } from './channel-meta';

interface ImBindingRowProps {
  group: AvailableImGroup;
  isActioning: boolean;
  onRebind: (group: AvailableImGroup) => void;
  onUnbind: (group: AvailableImGroup) => void;
  onUpdatePolicy: (
    group: AvailableImGroup,
    updates: {
      reply_policy?: 'source_only' | 'mirror';
      activation_mode?: 'auto' | 'always' | 'when_mentioned' | 'disabled';
      require_mention?: boolean;
    },
  ) => void;
}

export function ImBindingRow({
  group,
  isActioning,
  onRebind,
  onUnbind,
  onUpdatePolicy,
}: ImBindingRowProps) {
  const hasBound = !!group.bound_agent_id || !!group.bound_main_jid;

  const bindingLabel = (): string => {
    if (group.bound_agent_id && group.bound_target_name) {
      return group.bound_workspace_name && group.bound_workspace_name !== group.bound_target_name
        ? `${group.bound_workspace_name} / ${group.bound_target_name}`
        : group.bound_target_name;
    }
    if (group.bound_main_jid && group.bound_target_name) {
      return `${group.bound_target_name} / 主会话`;
    }
    return '默认（主会话）';
  };

  const bindingModeLabel =
    group.binding_mode === 'mirror'
      ? '镜像'
      : group.binding_mode === 'direct'
        ? '直绑'
        : '默认';

  return (
    <div className={`flex items-center gap-3 p-3 rounded-lg border transition-colors ${
      hasBound
        ? 'border-teal-200 bg-teal-50/50 dark:border-teal-800/30 dark:bg-teal-950/20'
        : 'border-border'
    }`}>
      {/* Avatar */}
      {group.avatar ? (
        <img
          src={group.avatar}
          alt=""
          className="w-10 h-10 rounded-lg flex-shrink-0 object-cover"
        />
      ) : (
        <div className="w-10 h-10 rounded-lg flex-shrink-0 bg-muted flex items-center justify-center">
          <MessageSquare className="w-5 h-5 text-muted-foreground" />
        </div>
      )}

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium truncate">{group.name}</span>
          <ChannelBadge channelType={group.channel_type} />
        </div>
        <div className="flex items-center gap-2 mt-0.5 text-xs text-muted-foreground">
          {group.member_count != null && (
            <span className="flex items-center gap-0.5">
              <Users className="w-3 h-3" />
              {group.member_count}
            </span>
          )}
          <span className={hasBound ? 'text-teal-600 dark:text-teal-400' : 'text-slate-400'}>
            → {bindingLabel()}
          </span>
          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">
            {bindingModeLabel}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2 mt-2">
          <select
            value={group.reply_policy || 'source_only'}
            onChange={(e) =>
              onUpdatePolicy(group, {
                reply_policy: e.target.value as 'source_only' | 'mirror',
              })
            }
            disabled={isActioning}
            className="h-7 rounded border border-border bg-background px-2 text-[11px]"
          >
            <option value="source_only">回复原渠道</option>
            <option value="mirror">镜像回流</option>
          </select>
          <select
            value={group.activation_mode || 'auto'}
            onChange={(e) =>
              onUpdatePolicy(group, {
                activation_mode: e.target.value as
                  | 'auto'
                  | 'always'
                  | 'when_mentioned'
                  | 'disabled',
              })
            }
            disabled={isActioning}
            className="h-7 rounded border border-border bg-background px-2 text-[11px]"
          >
            <option value="auto">自动响应</option>
            <option value="always">始终响应</option>
            <option value="when_mentioned">仅 @mention</option>
            <option value="disabled">禁用</option>
          </select>
          <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <input
              type="checkbox"
              checked={group.require_mention === true}
              disabled={isActioning}
              onChange={(e) =>
                onUpdatePolicy(group, { require_mention: e.target.checked })
              }
              className="rounded border-gray-300"
            />
            群聊需 @
          </label>
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 flex-shrink-0">
        {hasBound && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onUnbind(group)}
            disabled={isActioning}
            className="text-slate-400 hover:text-red-500"
          >
            {isActioning ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Unlink className="w-3.5 h-3.5" />
            )}
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          onClick={() => onRebind(group)}
          disabled={isActioning}
        >
          {isActioning ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <ArrowRightLeft className="w-3 h-3 mr-1" />
          )}
          换绑
        </Button>
      </div>
    </div>
  );
}
