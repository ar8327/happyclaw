import { Hono } from 'hono';
import fs from 'fs';
import path from 'path';
import type { Variables } from '../web-context.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  getUsageDailyStats,
  getUsageDailySummary,
  getUsageModels,
  getUsageUsers,
  getUserHomeGroup,
} from '../db.js';
import { DATA_DIR } from '../config.js';
import { logger } from '../logger.js';
import type { AuthUser } from '../types.js';
import { getOpenAIProviderConfig } from '../runtime-config.js';

const usage = new Hono<{ Variables: Variables }>();

usage.use('*', authMiddleware);

/**
 * Resolve userId for queries:
 * - Admin can filter by any userId or see all (undefined = all)
 * - Member always sees only their own data
 */
function resolveUserId(
  user: AuthUser,
  requestedUserId?: string,
): string | undefined {
  if (user.role === 'admin') {
    return requestedUserId || undefined; // undefined = all users
  }
  return user.id; // member always sees only own data
}

/**
 * GET /api/usage/stats?days=7&userId=&model=
 * Returns aggregated token usage statistics from usage_daily_summary.
 * Fixes: token KPI (uses modelUsage data) + timezone (local date grouping).
 */
usage.get('/stats', (c) => {
  const user = c.get('user') as AuthUser;
  const daysParam = c.req.query('days');
  const days = daysParam
    ? Math.min(Math.max(parseInt(daysParam, 10) || 7, 1), 365)
    : 7;

  const userId = resolveUserId(user, c.req.query('userId') || undefined);
  const model = c.req.query('model') || undefined;

  const summary = getUsageDailySummary(days, userId, model);
  const breakdown = getUsageDailyStats(days, userId, model);

  // Compute actual data range for frontend display
  const dates = breakdown.map((r) => r.date);
  const uniqueDates = [...new Set(dates)].sort();
  const dataRange =
    uniqueDates.length > 0
      ? {
          from: uniqueDates[0],
          to: uniqueDates[uniqueDates.length - 1],
          activeDays: uniqueDates.length,
        }
      : null;

  return c.json({ summary, breakdown, days, dataRange });
});

/**
 * GET /api/usage/models
 * Returns list of all models that have usage data.
 */
usage.get('/models', (c) => {
  const models = getUsageModels();
  return c.json({ models });
});

/**
 * GET /api/usage/users
 * Returns list of users that have usage data. Admin only.
 */
usage.get('/users', (c) => {
  const user = c.get('user') as AuthUser;
  if (user.role !== 'admin') {
    return c.json({ users: [{ id: user.id, username: user.username }] });
  }
  const users = getUsageUsers();
  return c.json({ users });
});

// --- Anthropic subscription usage (OAuth API) ---

interface SubscriptionWindow {
  utilization: number;
  resets_at: string;
}

interface SubscriptionData {
  five_hour?: SubscriptionWindow;
  seven_day?: SubscriptionWindow;
  seven_day_sonnet?: SubscriptionWindow;
  extra_usage?: { is_enabled: boolean };
}

interface CachedSubscription {
  data: SubscriptionData;
  fetchedAt: number;
}

const subscriptionCache = new Map<string, CachedSubscription>();
const CACHE_TTL_MS = 300_000; // 5min — Anthropic rate-limits aggressively

/**
 * Read OAuth access token from a user's session credentials.
 */
function readSessionOAuthToken(folder: string): string | null {
  if (folder.includes('..') || folder.includes('/')) return null;
  try {
    const credFile = path.join(
      DATA_DIR,
      'sessions',
      folder,
      '.claude',
      '.credentials.json',
    );
    if (!fs.existsSync(credFile)) return null;
    const content = JSON.parse(fs.readFileSync(credFile, 'utf-8'));
    return content?.claudeAiOauth?.accessToken || null;
  } catch {
    return null;
  }
}

/**
 * GET /api/usage/subscription
 * Proxies the Anthropic OAuth usage API with per-user caching (60s).
 */
usage.get('/subscription', async (c) => {
  const user = c.get('user') as AuthUser;

  // Find user's home folder
  const homeGroup = getUserHomeGroup(user.id);
  if (!homeGroup) {
    return c.json({ error: 'no_home_group', message: '未找到主容器' }, 404);
  }
  const folder = homeGroup.folder;

  // Check cache
  const cached = subscriptionCache.get(user.id);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return c.json({
      subscription: cached.data,
      cached: true,
      cached_at: new Date(cached.fetchedAt).toISOString(),
    });
  }

  // Read OAuth token
  const token = readSessionOAuthToken(folder);
  if (!token) {
    return c.json({
      error: 'no_credentials',
      message: 'OAuth 凭据不可用，请先登录 Claude Code',
      subscription: null,
      cached: false,
      cached_at: new Date().toISOString(),
    });
  }

  // Call Anthropic usage API
  try {
    const resp = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'anthropic-beta': 'oauth-2025-04-20',
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (resp.status === 401) {
      // Try to parse the error body for more specific messages
      let errorDetail = '';
      try {
        const body = await resp.json() as { error?: { message?: string } };
        errorDetail = body?.error?.message || '';
      } catch { /* ignore parse errors */ }

      const isOAuthUnsupported = errorDetail.toLowerCase().includes('oauth authentication is currently not supported');
      return c.json({
        error: isOAuthUnsupported ? 'oauth_unsupported' : 'token_expired',
        message: isOAuthUnsupported
          ? 'Anthropic 已暂停 OAuth 对此 API 的访问，订阅配额暂不可用'
          : 'OAuth Token 已过期，请重新登录 Claude Code',
        subscription: null,
        cached: false,
        cached_at: new Date().toISOString(),
      });
    }

    if (resp.status === 429) {
      // Rate limited — return stale cache if available
      if (cached) {
        return c.json({
          subscription: cached.data,
          cached: true,
          cached_at: new Date(cached.fetchedAt).toISOString(),
          rate_limited: true,
        });
      }
      return c.json({
        error: 'rate_limited',
        message: 'API 限流，请稍后重试',
        subscription: null,
        cached: false,
        cached_at: new Date().toISOString(),
      });
    }

    if (!resp.ok) {
      logger.warn(
        { status: resp.status },
        'Anthropic usage API returned non-OK status',
      );
      return c.json({
        error: 'api_error',
        message: `Anthropic API 返回 ${resp.status}`,
        subscription: null,
        cached: false,
        cached_at: new Date().toISOString(),
      });
    }

    const data = (await resp.json()) as SubscriptionData;

    // Cache result
    subscriptionCache.set(user.id, { data, fetchedAt: Date.now() });

    return c.json({
      subscription: data,
      cached: false,
      cached_at: new Date().toISOString(),
    });
  } catch (err) {
    logger.error({ err }, 'Failed to fetch Anthropic subscription usage');
    return c.json({
      error: 'fetch_error',
      message: '无法连接 Anthropic API',
      subscription: null,
      cached: false,
      cached_at: new Date().toISOString(),
    });
  }
});

// --- OpenAI / ChatGPT subscription usage ---
// Uses the Codex/ChatGPT usage API (same as CodexBar)
// Endpoint: https://chatgpt.com/backend-api/wham/usage
// Returns: { plan_type, rate_limit: { primary_window, secondary_window }, credits }

interface CodexWindowSnapshot {
  used_percent: number;
  reset_at: number; // Unix timestamp (seconds)
  limit_window_seconds: number;
}

interface CodexUsageResponse {
  plan_type?: string;
  rate_limit?: {
    primary_window?: CodexWindowSnapshot;
    secondary_window?: CodexWindowSnapshot;
  };
  credits?: {
    has_credits: boolean;
    unlimited: boolean;
    balance?: number | string;
  };
}

interface OpenAIRateWindow {
  label: string;
  used_percent: number;
  resets_at?: string; // ISO string
  window_minutes?: number;
}

interface OpenAIAccountData {
  plan_type?: string;
  rate_windows?: OpenAIRateWindow[];
  credits?: {
    has_credits: boolean;
    unlimited: boolean;
    balance?: number;
  };
}

interface CachedOpenAIAccount {
  data: OpenAIAccountData;
  fetchedAt: number;
}

const openaiAccountCache = new Map<string, CachedOpenAIAccount>();
const OPENAI_CACHE_TTL_MS = 300_000; // 5min

function windowSecondsToLabel(seconds: number): string {
  const hours = Math.round(seconds / 3600);
  if (hours < 24) return `${hours} 小时窗口`;
  const days = Math.round(hours / 24);
  return `${days} 天窗口`;
}

/**
 * GET /api/usage/openai-subscription
 * Queries ChatGPT Codex usage API for plan info, rate limits, and credits.
 */
usage.get('/openai-subscription', async (c) => {
  const user = c.get('user') as AuthUser;

  // Check cache
  const cached = openaiAccountCache.get(user.id);
  if (cached && Date.now() - cached.fetchedAt < OPENAI_CACHE_TTL_MS) {
    return c.json({ account: cached.data, cached: true, cached_at: new Date(cached.fetchedAt).toISOString() });
  }

  // Get OpenAI OAuth token
  const openaiConfig = getOpenAIProviderConfig();
  const accessToken = openaiConfig.oauthTokens?.accessToken;
  if (!accessToken) {
    return c.json({
      error: 'no_credentials',
      message: 'OpenAI OAuth 未配置',
      account: null,
      cached: false,
      cached_at: new Date().toISOString(),
    });
  }

  try {
    const resp = await fetch('https://chatgpt.com/backend-api/wham/usage', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'User-Agent': 'CodexBar',
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (resp.status === 401 || resp.status === 403) {
      return c.json({
        error: 'token_expired',
        message: 'OpenAI OAuth Token 已过期，请重新登录',
        account: null,
        cached: false,
        cached_at: new Date().toISOString(),
      });
    }

    if (resp.status === 429) {
      if (cached) {
        return c.json({ account: cached.data, cached: true, cached_at: new Date(cached.fetchedAt).toISOString(), rate_limited: true });
      }
      return c.json({
        error: 'rate_limited',
        message: 'ChatGPT API 限流，请稍后重试',
        account: null,
        cached: false,
        cached_at: new Date().toISOString(),
      });
    }

    if (!resp.ok) {
      logger.warn({ status: resp.status }, 'ChatGPT usage API returned non-OK status');
      return c.json({
        error: 'api_error',
        message: `ChatGPT API 返回 ${resp.status}`,
        account: null,
        cached: false,
        cached_at: new Date().toISOString(),
      });
    }

    const raw = await resp.json() as CodexUsageResponse;

    // Transform to our format
    const rateWindows: OpenAIRateWindow[] = [];
    if (raw.rate_limit?.primary_window) {
      const w = raw.rate_limit.primary_window;
      rateWindows.push({
        label: windowSecondsToLabel(w.limit_window_seconds),
        used_percent: w.used_percent,
        resets_at: new Date(w.reset_at * 1000).toISOString(),
        window_minutes: Math.round(w.limit_window_seconds / 60),
      });
    }
    if (raw.rate_limit?.secondary_window) {
      const w = raw.rate_limit.secondary_window;
      rateWindows.push({
        label: windowSecondsToLabel(w.limit_window_seconds),
        used_percent: w.used_percent,
        resets_at: new Date(w.reset_at * 1000).toISOString(),
        window_minutes: Math.round(w.limit_window_seconds / 60),
      });
    }

    const credits = raw.credits ? {
      has_credits: raw.credits.has_credits,
      unlimited: raw.credits.unlimited,
      balance: typeof raw.credits.balance === 'string' ? parseFloat(raw.credits.balance) : raw.credits.balance,
    } : undefined;

    const data: OpenAIAccountData = {
      plan_type: raw.plan_type,
      rate_windows: rateWindows,
      credits,
    };

    openaiAccountCache.set(user.id, { data, fetchedAt: Date.now() });

    return c.json({
      account: data,
      cached: false,
      cached_at: new Date().toISOString(),
    });
  } catch (err) {
    logger.error({ err }, 'Failed to fetch ChatGPT usage');
    return c.json({
      error: 'fetch_error',
      message: '无法连接 ChatGPT API',
      account: null,
      cached: false,
      cached_at: new Date().toISOString(),
    });
  }
});

export { usage };
