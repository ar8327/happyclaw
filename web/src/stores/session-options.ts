import { create } from 'zustand';
import { api } from '../api/client';
import type { SessionOption } from '../types';

interface SessionOptionsState {
  options: SessionOption[];
  loading: boolean;
  error: string | null;
  loaded: boolean;
  loadOptions: (force?: boolean) => Promise<void>;
}

let inFlight: Promise<void> | null = null;

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

export const useSessionOptionsStore = create<SessionOptionsState>(
  (set, get) => ({
    options: [],
    loading: false,
    error: null,
    loaded: false,

    loadOptions: async (force = false) => {
      if (!force && get().loaded) return;
      if (inFlight) return inFlight;

      const request = (async () => {
        set({ loading: true, error: null });
        try {
          const data = await api.get<{ sessions: SessionOption[] }>(
            '/api/sessions/options',
          );
          set({
            options: data.sessions,
            loading: false,
            error: null,
            loaded: true,
          });
        } catch (error) {
          set({ loading: false, error: getErrorMessage(error) });
        }
      })();

      inFlight = request;
      try {
        await request;
      } finally {
        if (inFlight === request) inFlight = null;
      }
    },
  }),
);
