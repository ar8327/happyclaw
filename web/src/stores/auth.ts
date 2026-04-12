import { create } from 'zustand';
import { api, apiFetch } from '../api/client';

export type Permission =
  | 'manage_system_config'
  | 'manage_group_env';

export interface UserPublic {
  id: string;
  username: string;
  display_name: string;
  role: 'admin' | 'member';
  status: 'active' | 'disabled' | 'deleted';
  permissions: Permission[];
  must_change_password: boolean;
  disable_reason: string | null;
  notes: string | null;
  created_at: string;
  last_login_at: string | null;
  last_active_at: string | null;
  deleted_at: string | null;
  avatar_emoji: string | null;
  avatar_color: string | null;
  ai_name: string | null;
  ai_avatar_emoji: string | null;
  ai_avatar_color: string | null;
  ai_avatar_url: string | null;
}

export interface AppearanceConfig {
  appName: string;
  aiName: string;
  aiAvatarEmoji: string;
  aiAvatarColor: string;
}

interface AuthState {
  authenticated: boolean;
  user: UserPublic | null;
  appearance: AppearanceConfig | null;
  initialized: boolean | null; // null = not checked yet
  checking: boolean;
  logout: () => Promise<void>;
  checkAuth: () => Promise<void>;
  updateProfile: (payload: { username?: string; display_name?: string; avatar_emoji?: string | null; avatar_color?: string | null; ai_name?: string | null; ai_avatar_emoji?: string | null; ai_avatar_color?: string | null; ai_avatar_url?: string | null }) => Promise<void>;
  uploadAvatar: (file: File) => Promise<string>;
  fetchAppearance: () => Promise<void>;
  hasPermission: (permission: Permission) => boolean;
}

let checkAuthInFlight: Promise<void> | null = null;

export const useAuthStore = create<AuthState>((set, get) => ({
  authenticated: false,
  user: null,
  appearance: null,
  initialized: null,
  checking: true,

  logout: async () => {
    await api.post('/api/auth/logout').catch(() => {});
    await get().checkAuth();
  },

  checkAuth: async () => {
    if (checkAuthInFlight) return checkAuthInFlight;

    checkAuthInFlight = (async () => {
      set({ checking: true });
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const data = await api.get<{ user: UserPublic; appearance?: AppearanceConfig }>('/api/auth/me');
          set({ authenticated: true, user: data.user, appearance: data.appearance ?? null, initialized: true, checking: false });
          return;
        } catch (err) {
          const status =
            typeof err === 'object' && err !== null && 'status' in err
              ? Number((err as { status?: unknown }).status)
              : NaN;
          const retryable = status === 0 || status === 408;
          if (!retryable || attempt === 2) {
            set({
              authenticated: false,
              user: null,
              appearance: null,
              initialized: retryable ? false : true,
              checking: false,
            });
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 1200));
        }
      }
    })().finally(() => {
      checkAuthInFlight = null;
    });

    return checkAuthInFlight;
  },

  updateProfile: async (payload) => {
    const data = await api.put<{ success: boolean; user: UserPublic }>('/api/auth/profile', payload);
    set({ user: data.user });
  },

  uploadAvatar: async (file: File) => {
    const formData = new FormData();
    formData.append('avatar', file);
    const data = await apiFetch<{ success: boolean; avatarUrl: string; user: UserPublic }>('/api/auth/avatar', {
      method: 'POST',
      body: formData,
      headers: {},
    });
    set({ user: data.user });
    return data.avatarUrl;
  },

  fetchAppearance: async () => {
    try {
      const data = await api.get<AppearanceConfig>('/api/config/appearance/public');
      set({ appearance: data });
    } catch {
      // API not yet available, keep current state
    }
  },

  hasPermission: (permission: Permission): boolean => {
    const user = get().user;
    if (!user) return false;
    if (user.role === 'admin') return true;
    return user.permissions.includes(permission);
  },
}));
