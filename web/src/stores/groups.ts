import { create } from 'zustand';
import { api } from '../api/client';
import type { SessionInfo, SessionMember } from '../types';
import { useChatStore } from './chat';

export type GroupInfo = SessionInfo;
export type GroupMember = SessionMember;

interface GroupsState {
  groups: Record<string, SessionInfo>;
  loading: boolean;
  error: string | null;
  members: Record<string, SessionMember[]>;
  membersLoading: boolean;
  loadGroups: () => Promise<void>;
  updateGroup: (jid: string, updates: Record<string, unknown>) => Promise<void>;
  loadMembers: (jid: string) => Promise<void>;
}

export const useGroupsStore = create<GroupsState>((set, get) => ({
  groups: {},
  loading: false,
  error: null,
  members: {},
  membersLoading: false,

  loadGroups: async () => {
    set({ loading: true });
    try {
      const data = await api.get<{
        sessions?: Record<string, SessionInfo>;
        groups?: Record<string, SessionInfo>;
      }>('/api/sessions');
      const sessionMap = data.sessions || data.groups || {};
      const groups = Object.fromEntries(
        Object.entries(sessionMap).filter(
          ([, info]) =>
            info.session_kind === 'main' || info.session_kind === 'workspace',
        ),
      );
      set({ groups, loading: false, error: null });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  updateGroup: async (jid: string, updates: Record<string, unknown>) => {
    await api.patch(`/api/sessions/${encodeURIComponent(jid)}`, updates);
    await get().loadGroups();
    useChatStore.getState().loadGroups();
  },

  loadMembers: async (jid: string) => {
    set({ membersLoading: true });
    try {
      const data = await api.get<{ members: SessionMember[] }>(`/api/sessions/${encodeURIComponent(jid)}/members`);
      set((state) => ({
        members: { ...state.members, [jid]: data.members },
        membersLoading: false,
      }));
    } catch (err) {
      set({ membersLoading: false });
      throw err;
    }
  },
}));
