import { create } from 'zustand';
import { api } from '../api/client';
import type { SessionInfo } from '../types';
import { useChatStore } from './chat';

export type GroupInfo = SessionInfo;

interface GroupsState {
  groups: Record<string, SessionInfo>;
  loading: boolean;
  error: string | null;
  loadGroups: () => Promise<void>;
  updateGroup: (jid: string, updates: Record<string, unknown>) => Promise<void>;
}

export const useGroupsStore = create<GroupsState>((set, get) => ({
  groups: {},
  loading: false,
  error: null,

  loadGroups: async () => {
    set({ loading: true });
    try {
      const data = await api.get<{
        sessions: Record<string, SessionInfo>;
      }>('/api/sessions');
      const sessionMap = data.sessions;
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
}));
