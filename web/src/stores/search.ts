import { create } from 'zustand';
import { api } from '../api/client';

export interface GlobalSearchResult {
  id: string;
  chat_jid: string;
  sender_name: string;
  content: string;
  snippet: string;
  timestamp: string;
  is_from_me: boolean;
  session_id?: string;
  session_folder?: string;
  session_name?: string;
  group_folder?: string;
  group_name?: string;
}

interface SearchResponse {
  results: GlobalSearchResult[];
  total: number;
  hasMore: boolean;
}

interface SearchState {
  query: string;
  days: number;
  results: GlobalSearchResult[];
  total: number;
  hasMore: boolean;
  loading: boolean;
  loadingMore: boolean;
  searched: boolean;

  setQuery: (q: string) => void;
  setDays: (days: number) => void;
  search: (q: string, daysOverride?: number) => Promise<void>;
  loadMore: () => Promise<void>;
  clear: () => void;
}

export const useSearchStore = create<SearchState>((set, get) => ({
  query: '',
  days: 7,
  results: [],
  total: 0,
  hasMore: false,
  loading: false,
  loadingMore: false,
  searched: false,

  setQuery: (q) => set({ query: q }),
  setDays: (days) => set({ days }),

  search: async (q, daysOverride?) => {
    const daysFilter = daysOverride ?? get().days;
    if (!q.trim()) {
      set({ results: [], total: 0, hasMore: false, searched: false, query: q });
      return;
    }
    set({ loading: true, query: q });
    try {
      const params = new URLSearchParams({ q, limit: '50', offset: '0' });
      if (daysFilter > 0) params.set('days', String(daysFilter));
      const data = await api.get<SearchResponse>(`/api/search/messages?${params}`);
      set({
        results: data.results,
        total: data.total,
        hasMore: data.hasMore,
        searched: true,
      });
    } catch {
      // Error handled by api client
    } finally {
      set({ loading: false });
    }
  },

  loadMore: async () => {
    const { query, days, results, loading, loadingMore, hasMore } = get();
    if (loading || loadingMore || !hasMore || !query.trim()) return;

    set({ loadingMore: true });
    try {
      const params = new URLSearchParams({
        q: query,
        limit: '50',
        offset: String(results.length),
      });
      if (days > 0) params.set('days', String(days));
      const data = await api.get<SearchResponse>(`/api/search/messages?${params}`);
      set({
        results: [...results, ...data.results],
        total: data.total,
        hasMore: data.hasMore,
      });
    } catch {
      // Error handled by api client
    } finally {
      set({ loadingMore: false });
    }
  },

  clear: () =>
    set({
      query: '',
      days: 7,
      results: [],
      total: 0,
      hasMore: false,
      loading: false,
      loadingMore: false,
      searched: false,
    }),
}));
