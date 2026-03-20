import { create } from 'zustand';
import { api } from '../api/client';

export interface UsageSummary {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  totalCostUSD: number;
  totalMessages: number;
  totalActiveDays: number;
}

export interface UsageBreakdown {
  date: string;
  model: string;
  user_id: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_usd: number;
  request_count: number;
}

export interface DataRange {
  from: string;
  to: string;
  activeDays: number;
}

export interface UsageUser {
  id: string;
  username: string;
}

export interface SubscriptionWindow {
  utilization: number;
  resets_at: string;
}

export interface SubscriptionData {
  five_hour?: SubscriptionWindow;
  seven_day?: SubscriptionWindow;
  seven_day_sonnet?: SubscriptionWindow;
  extra_usage?: { is_enabled: boolean };
}

export interface SubscriptionResponse {
  subscription: SubscriptionData;
  cached: boolean;
  cached_at: string;
  rate_limited?: boolean;
  error?: string;
  message?: string;
}

// --- OpenAI account / rate limits ---

export interface OpenAIRateWindow {
  label: string;
  used_percent: number;
  resets_at?: string;
  window_minutes?: number;
}

export interface OpenAICredits {
  has_credits: boolean;
  unlimited: boolean;
  balance?: number;
}

export interface OpenAIAccountData {
  plan_type?: string;
  rate_windows?: OpenAIRateWindow[];
  credits?: OpenAICredits;
}

export interface OpenAIAccountResponse {
  account: OpenAIAccountData | null;
  cached: boolean;
  cached_at: string;
  rate_limited?: boolean;
  error?: string;
  message?: string;
}

interface UsageState {
  summary: UsageSummary | null;
  breakdown: UsageBreakdown[];
  dataRange: DataRange | null;
  days: number;
  loading: boolean;
  error: string | null;

  // Filters
  selectedUserId: string | null; // null = all
  selectedModel: string | null; // null = all
  availableModels: string[];
  availableUsers: UsageUser[];

  // Subscription (Anthropic plan limits)
  subscription: SubscriptionData | null;
  subscriptionLoading: boolean;
  subscriptionError: string | null;
  subscriptionErrorCode: string | null; // 'no_credentials' means user isn't on OAuth

  // OpenAI account
  openaiAccount: OpenAIAccountData | null;
  openaiAccountLoading: boolean;
  openaiAccountError: string | null;
  openaiAccountErrorCode: string | null;

  // Actions
  loadStats: (days?: number) => Promise<void>;
  setDays: (days: number) => void;
  setSelectedUserId: (id: string | null) => void;
  setSelectedModel: (model: string | null) => void;
  loadFilters: () => Promise<void>;
  loadSubscription: () => Promise<void>;
  loadOpenAIAccount: () => Promise<void>;
}

export const useUsageStore = create<UsageState>((set, get) => ({
  summary: null,
  breakdown: [],
  dataRange: null,
  days: 7,
  loading: false,
  error: null,
  selectedUserId: null,
  selectedModel: null,
  availableModels: [],
  availableUsers: [],
  subscription: null,
  subscriptionLoading: false,
  subscriptionError: null,
  subscriptionErrorCode: null,
  openaiAccount: null,
  openaiAccountLoading: false,
  openaiAccountError: null,
  openaiAccountErrorCode: null,

  loadStats: async (days?: number) => {
    const d = days ?? get().days;
    const { selectedUserId, selectedModel } = get();
    set({ loading: true, days: d });
    try {
      const params = new URLSearchParams({ days: String(d) });
      if (selectedUserId) params.set('userId', selectedUserId);
      if (selectedModel) params.set('model', selectedModel);

      const data = await api.get<{
        summary: UsageSummary;
        breakdown: UsageBreakdown[];
        days: number;
        dataRange: DataRange | null;
      }>(`/api/usage/stats?${params.toString()}`);
      set({
        summary: data.summary,
        breakdown: data.breakdown,
        dataRange: data.dataRange,
        loading: false,
        error: null,
      });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  setDays: (days: number) => {
    set({ days });
    get().loadStats(days);
  },

  setSelectedUserId: (id: string | null) => {
    set({ selectedUserId: id });
    get().loadStats();
  },

  setSelectedModel: (model: string | null) => {
    set({ selectedModel: model });
    get().loadStats();
  },

  loadFilters: async () => {
    try {
      const [modelsData, usersData] = await Promise.all([
        api.get<{ models: string[] }>('/api/usage/models'),
        api.get<{ users: UsageUser[] }>('/api/usage/users'),
      ]);
      set({
        availableModels: modelsData.models,
        availableUsers: usersData.users,
      });
    } catch {
      // Filters are non-critical, silently fail
    }
  },

  loadSubscription: async () => {
    set({ subscriptionLoading: true, subscriptionError: null, subscriptionErrorCode: null });
    try {
      const data = await api.get<SubscriptionResponse>('/api/usage/subscription');
      if (data.error) {
        set({
          subscriptionLoading: false,
          subscriptionError: data.message || data.error,
          subscriptionErrorCode: data.error,
        });
      } else {
        set({ subscription: data.subscription, subscriptionLoading: false });
      }
    } catch (err) {
      const errorMessage =
        err instanceof Error
          ? err.message
          : typeof err === 'object' && err !== null && 'message' in err
            ? String((err as { message: unknown }).message)
            : String(err);
      set({
        subscriptionLoading: false,
        subscriptionError: errorMessage,
        subscriptionErrorCode: 'fetch_error',
      });
    }
  },

  loadOpenAIAccount: async () => {
    set({ openaiAccountLoading: true, openaiAccountError: null, openaiAccountErrorCode: null });
    try {
      const data = await api.get<OpenAIAccountResponse>('/api/usage/openai-subscription');
      if (data.error) {
        set({
          openaiAccountLoading: false,
          openaiAccountError: data.message || data.error,
          openaiAccountErrorCode: data.error,
        });
      } else {
        set({ openaiAccount: data.account, openaiAccountLoading: false });
      }
    } catch (err) {
      const errorMessage =
        err instanceof Error
          ? err.message
          : typeof err === 'object' && err !== null && 'message' in err
            ? String((err as { message: unknown }).message)
            : String(err);
      set({
        openaiAccountLoading: false,
        openaiAccountError: errorMessage,
        openaiAccountErrorCode: 'fetch_error',
      });
    }
  },
}));
