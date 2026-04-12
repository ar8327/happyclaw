import { create } from 'zustand';
import { api } from '../api/client';

export interface RuntimeEnvPublicConfig {
  anthropicBaseUrl: string;
  anthropicAuthTokenMasked: string | null;
  anthropicApiKeyMasked: string | null;
  claudeCodeOauthTokenMasked: string | null;
  hasAnthropicAuthToken: boolean;
  hasAnthropicApiKey: boolean;
  hasClaudeCodeOauthToken: boolean;
  happyclawModel: string;
  customEnv: Record<string, string>;
  codexBaseUrl: string;
  codexDefaultModel: string;
  codexCustomEnv: Record<string, string>;
}

interface RuntimeEnvState {
  configs: Record<string, RuntimeEnvPublicConfig>;
  loading: boolean;
  saving: boolean;
  error: string | null;

  loadConfig: (jid: string) => Promise<void>;
  saveConfig: (jid: string, data: {
    anthropicBaseUrl?: string;
    anthropicAuthToken?: string;
    anthropicApiKey?: string;
    claudeCodeOauthToken?: string;
    happyclawModel?: string;
    customEnv?: Record<string, string>;
    codexBaseUrl?: string;
    codexDefaultModel?: string;
    codexCustomEnv?: Record<string, string>;
  }) => Promise<boolean>;
}

export const useRuntimeEnvStore = create<RuntimeEnvState>((set) => ({
  configs: {},
  loading: false,
  saving: false,
  error: null,

  loadConfig: async (jid: string) => {
    set({ loading: true, error: null });
    try {
      const data = await api.get<RuntimeEnvPublicConfig>(
        `/api/sessions/${encodeURIComponent(jid)}/env`
      );
      set((s) => ({
        configs: { ...s.configs, [jid]: data },
        loading: false,
      }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load config';
      console.error('Failed to load runtime env config:', err);
      set({ loading: false, error: msg });
    }
  },

  saveConfig: async (jid, data) => {
    set({ saving: true });
    try {
      const result = await api.put<RuntimeEnvPublicConfig>(
        `/api/sessions/${encodeURIComponent(jid)}/env`,
        data,
      );
      set((s) => ({
        configs: { ...s.configs, [jid]: result },
        saving: false,
      }));
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to save config';
      console.error('Failed to save runtime env config:', err);
      set({ saving: false, error: msg });
      return false;
    }
  },
}));
