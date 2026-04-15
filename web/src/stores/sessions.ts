import { create } from 'zustand';
import { api } from '../api/client';
import type { SessionInfo } from '../types';
import { useChatStore } from './chat';

interface SessionsState {
  sessions: Record<string, SessionInfo>;
  loading: boolean;
  error: string | null;
  loadSessions: () => Promise<void>;
  updateSession: (jid: string, updates: Record<string, unknown>) => Promise<void>;
}

export const useSessionsStore = create<SessionsState>((set, get) => ({
  sessions: {},
  loading: false,
  error: null,

  loadSessions: async () => {
    set({ loading: true });
    try {
      const data = await api.get<{
        sessions: Record<string, SessionInfo>;
      }>('/api/sessions');
      const sessionMap = data.sessions;
      const sessions = Object.fromEntries(
        Object.entries(sessionMap).filter(
          ([, info]) =>
            info.kind === 'main' || info.kind === 'workspace',
        ),
      );
      set({ sessions, loading: false, error: null });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  updateSession: async (jid: string, updates: Record<string, unknown>) => {
    await api.patch(`/api/sessions/${encodeURIComponent(jid)}`, updates);
    await get().loadSessions();
    useChatStore.getState().loadGroups();
  },
}));
