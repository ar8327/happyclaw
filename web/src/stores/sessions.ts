import { create } from 'zustand';
import { api } from '../api/client';
import type { SessionInfo, SessionListResponse } from '../types';
import { useChatStore } from './chat';

const DEFAULT_PAGE_SIZE = 24;
let loadRequestSequence = 0;

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return error.message;
  }
  return String(error);
}

interface LoadSessionsOptions {
  page?: number;
  query?: string;
}

interface SessionsState {
  sessions: Record<string, SessionInfo>;
  loading: boolean;
  error: string | null;
  query: string;
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  loadSessions: (options?: LoadSessionsOptions) => Promise<void>;
  setQuery: (query: string) => Promise<void>;
  setPage: (page: number) => Promise<void>;
  updateSession: (
    jid: string,
    updates: Record<string, unknown>,
  ) => Promise<void>;
}

export const useSessionsStore = create<SessionsState>((set, get) => ({
  sessions: {},
  loading: false,
  error: null,
  query: '',
  page: 1,
  pageSize: DEFAULT_PAGE_SIZE,
  total: 0,
  totalPages: 0,

  loadSessions: async (options = {}) => {
    const state = get();
    const page = Math.max(1, options.page ?? state.page);
    const query = (options.query ?? state.query).trim();
    const requestId = ++loadRequestSequence;
    set({ loading: true, error: null, page, query });

    try {
      const params = new URLSearchParams({
        kinds: 'main,workspace',
        page: String(page),
        page_size: String(state.pageSize),
      });
      if (query) params.set('q', query);
      const data = await api.get<SessionListResponse>(
        `/api/sessions?${params}`,
      );
      if (requestId !== loadRequestSequence) return;

      set({
        sessions: data.sessions,
        loading: false,
        error: null,
        query: data.query,
        page: data.pagination.page,
        pageSize: data.pagination.page_size,
        total: data.pagination.total,
        totalPages: data.pagination.total_pages,
      });
    } catch (error) {
      if (requestId !== loadRequestSequence) return;
      set({ loading: false, error: getErrorMessage(error) });
    }
  },

  setQuery: async (query: string) => {
    await get().loadSessions({ page: 1, query });
  },

  setPage: async (page: number) => {
    const state = get();
    const target = Math.min(Math.max(1, page), Math.max(1, state.totalPages));
    if (target === state.page && Object.keys(state.sessions).length > 0) return;
    await state.loadSessions({ page: target });
  },

  updateSession: async (jid: string, updates: Record<string, unknown>) => {
    await api.patch(`/api/sessions/${encodeURIComponent(jid)}`, updates);
    await get().loadSessions();
    await useChatStore.getState().loadGroups({ reset: true });
  },
}));
