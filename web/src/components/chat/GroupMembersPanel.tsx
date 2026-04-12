import { useEffect, useRef } from 'react';
import { Crown } from 'lucide-react';

import { useGroupsStore } from '../../stores/groups';
import { useChatStore } from '../../stores/chat';

interface GroupMembersPanelProps {
  groupJid: string;
}

export function GroupMembersPanel({ groupJid }: GroupMembersPanelProps) {
  const group = useChatStore((s) => s.groups[groupJid]);
  const members = useGroupsStore((s) => s.members[groupJid]);
  const membersLoading = useGroupsStore((s) => s.membersLoading);
  const membersList = members ?? [];

  const loadedRef = useRef<string | null>(null);
  useEffect(() => {
    if (loadedRef.current === groupJid) return;
    loadedRef.current = groupJid;
    useGroupsStore.getState().loadMembers(groupJid).catch(() => {});
  }, [groupJid]);

  if (membersLoading && membersList.length === 0) {
    return (
      <div className="flex items-center justify-center h-32 text-sm text-slate-400">
        加载中...
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-100 bg-slate-50/80">
        <div className="text-xs font-medium text-slate-600">
          单用户模式
        </div>
        <div className="mt-1 text-xs leading-5 text-slate-500">
          当前会话固定只有本机操作者。
          {group?.session_kind === 'main' || group?.session_kind === 'workspace'
            ? '成员管理能力已经移除，这里只展示当前 owner。'
            : '这里仅展示当前 owner。'}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {membersList.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-sm text-slate-400">
            暂无成员
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {membersList.map((member) => (
              <div
                key={member.user_id}
                className="flex items-center gap-3 px-4 py-2.5"
              >
                <div className="w-8 h-8 rounded-full bg-slate-200 flex items-center justify-center text-xs font-medium text-slate-600 flex-shrink-0">
                  {(member.display_name || member.username).charAt(0).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm font-medium text-slate-900 truncate">
                      {member.display_name || member.username}
                    </span>
                    <span className="text-[10px] text-slate-400">(我)</span>
                    {member.role === 'owner' && (
                      <Crown className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" />
                    )}
                  </div>
                  <div className="text-xs text-slate-400 truncate">
                    @{member.username}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
