import { create } from 'zustand';
import { api } from '../api/client';

export interface LogEntry {
  filename: string;
  timestamp: string;
  duration: number;
  exitCode: number | null;
  filePrefix: string;
  agentId?: string;
  agentName?: string;
  fileSize: number;
}

export interface LogSection {
  name: string;
  content: string;
}

export interface LogDetail {
  filename: string;
  fileSize: number;
  sections: LogSection[];
}

interface LogsState {
  entries: LogEntry[];
  total: number;
  selectedFolder: string | null;
  selectedLog: LogDetail | null;
  loading: boolean;
  loadingDetail: boolean;
  error: string | null;

  loadEntries: (folder: string, offset?: number) => Promise<void>;
  loadDetail: (folder: string, filename: string) => Promise<void>;
  clearDetail: () => void;
  setSelectedFolder: (folder: string | null) => void;
}

export const useLogsStore = create<LogsState>((set) => ({
  entries: [],
  total: 0,
  selectedFolder: null,
  selectedLog: null,
  loading: false,
  loadingDetail: false,
  error: null,

  loadEntries: async (folder: string, offset = 0) => {
    set({ loading: true, error: null, selectedFolder: folder });
    try {
      const data = await api.get<{ entries: LogEntry[]; total: number }>(
        `/api/logs/${encodeURIComponent(folder)}?offset=${offset}&limit=50`,
      );
      if (offset === 0) {
        set({ entries: data.entries, total: data.total, loading: false });
      } else {
        set((s) => ({
          entries: [...s.entries, ...data.entries],
          total: data.total,
          loading: false,
        }));
      }
    } catch {
      set({ error: '加载日志列表失败', loading: false });
    }
  },

  loadDetail: async (folder: string, filename: string) => {
    set({ loadingDetail: true });
    try {
      const data = await api.get<LogDetail>(
        `/api/logs/${encodeURIComponent(folder)}/${encodeURIComponent(filename)}`,
      );
      set({ selectedLog: data, loadingDetail: false });
    } catch {
      set({ selectedLog: null, loadingDetail: false });
    }
  },

  clearDetail: () => set({ selectedLog: null }),

  setSelectedFolder: (folder) =>
    set({ selectedFolder: folder, entries: [], total: 0, selectedLog: null }),
}));
