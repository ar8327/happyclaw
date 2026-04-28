// Configuration management routes

import { randomBytes } from 'node:crypto';
import { Agent as HttpsAgent } from 'node:https';
import { ProxyAgent } from 'proxy-agent';
import QRCode from 'qrcode';
import { Hono } from 'hono';
import type { Variables } from '../web-context.js';
import { canAccessGroup, getWebDeps } from '../web-context.js';
import { getChannelType } from '../im-channel.js';
import {
  deleteSessionBinding,
  deleteRegisteredGroup,
  deleteChatHistory,
  getJidsByFolder,
  getRegisteredGroup,
  getSessionBinding,
  getSessionRecord,
  isPrimarySessionFolder,
  setRegisteredGroup,
  saveSessionBinding,
  getAgent,
} from '../db.js';
import { authMiddleware, systemConfigMiddleware } from '../middleware/auth.js';
import {
  extractAgentIdFromWorkerSessionId,
  isWorkerSessionId,
} from '../worker-session.js';
import {
  FeishuConfigSchema,
  TelegramConfigSchema,
  QQConfigSchema,
  ImGeneralConfigSchema,
  WeChatConfigSchema,
  AppearanceConfigSchema,
  SystemSettingsSchema,
  UserIMPreferencesSchema,
} from '../schemas.js';
import {
  getFeishuProviderConfig,
  getFeishuProviderConfigWithSource,
  toPublicFeishuProviderConfig,
  saveFeishuProviderConfig,
  getTelegramProviderConfig,
  getTelegramProviderConfigWithSource,
  toPublicTelegramProviderConfig,
  saveTelegramProviderConfig,
  getAppearanceConfig,
  saveAppearanceConfig,
  getSystemSettings,
  saveSystemSettings,
  getImFeishuConfig,
  saveImFeishuConfig,
  getImFeishuOAuthTokens,
  saveImFeishuOAuthTokens,
  clearImFeishuOAuthTokens,
  getImTelegramConfig,
  saveImTelegramConfig,
  getImQQConfig,
  saveImQQConfig,
  getImGeneralConfig,
  saveImGeneralConfig,
  getImWeChatConfig,
  saveImWeChatConfig,
  detectLocalClaudeCode,
  getImPreferences,
  saveImPreferences,
  detectLocalCodexCli,
} from '../runtime-config.js';
import { queryCodexRateLimits } from '../codex-app-server.js';
import type { AuthUser, RegisteredGroup } from '../types.js';
import { logger } from '../logger.js';
import {
  createOAuthState,
  consumeOAuthState,
  buildOAuthUrl,
  exchangeCodeForTokens,
} from '../feishu-oauth.js';

const configRoutes = new Hono<{ Variables: Variables }>();

/**
 * Resolve IM chat owner from session binding or its default main session.
 */
function resolveImGroupOwnerKey(
  jid: string,
  group?: Pick<RegisteredGroup, 'folder'>,
): string | undefined {
  const resolvedGroup = group ?? getRegisteredGroup(jid);
  if (!resolvedGroup) return undefined;

  const binding = getSessionBinding(jid);
  if (binding) {
    const session = getSessionRecord(binding.session_id);
    if (session?.owner_key) return session.owner_key;
    if (session?.parent_session_id) {
      const parentSession = getSessionRecord(session.parent_session_id);
      if (parentSession?.owner_key) return parentSession.owner_key;
    }
  }

  if (resolvedGroup.folder) {
    const mainSession = getSessionRecord(`main:${resolvedGroup.folder}`);
    if (mainSession?.owner_key) return mainSession.owner_key;
  }

  return undefined;
}

// Inject deps at runtime
let deps: any = null;
export function injectConfigDeps(d: any) {
  deps = d;
}

function createTelegramApiAgent(proxyUrl?: string): HttpsAgent | ProxyAgent {
  if (proxyUrl && proxyUrl.trim()) {
    const fixedProxyUrl = proxyUrl.trim();
    return new ProxyAgent({
      getProxyForUrl: () => fixedProxyUrl,
    });
  }
  return new HttpsAgent({ keepAlive: false, family: 4 });
}

function destroyTelegramApiAgent(agent: HttpsAgent | ProxyAgent): void {
  agent.destroy();
}

// --- Routes ---

// GET /api/config/codex/models — 动态读取 Codex 支持的模型列表
configRoutes.get('/codex/models', authMiddleware, async (c) => {
  const os = await import('node:os');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const cacheFile = path.join(os.homedir(), '.codex', 'models_cache.json');

  try {
    if (!fs.existsSync(cacheFile)) {
      return c.json({ models: [], source: 'fallback' });
    }
    const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
    const models = (raw.models || [])
      .filter((m: { visibility?: string }) => m.visibility === 'list')
      .map((m: {
        slug: string;
        display_name?: string;
        description?: string;
        priority?: number;
        default_reasoning_level?: string;
        supported_reasoning_levels?: Array<{ effort: string }>;
      }) => ({
        slug: m.slug,
        displayName: m.display_name || m.slug,
        description: m.description || '',
        priority: m.priority ?? 999,
        defaultReasoningLevel: m.default_reasoning_level,
        supportedReasoningLevels: (m.supported_reasoning_levels || []).map(
          (r: { effort: string }) => r.effort,
        ),
      }))
      .sort((a: { priority: number }, b: { priority: number }) => a.priority - b.priority);
    return c.json({ models, source: 'cache', fetchedAt: raw.fetched_at });
  } catch (err) {
    logger.error({ err }, 'Failed to read Codex models cache');
    return c.json({ models: [], source: 'error' });
  }
});

// ─── Codex Provider Config Routes ───────────────────────────────

configRoutes.get('/codex', authMiddleware, systemConfigMiddleware, (c) => {
  try {
    const cliStatus = detectLocalCodexCli();
    return c.json({
      mode: 'cli',
      hasCliAuth: cliStatus.hasAuth,
      cliAuthMode: cliStatus.authMode,
      cliAuthAccountId: cliStatus.accountId,
      cliAuthLastRefresh: cliStatus.lastRefresh,
      hasEnvApiKey: !!process.env.OPENAI_API_KEY,
    });
  } catch (err) {
    logger.error({ err }, 'Failed to load Codex config');
    return c.json({ error: 'Failed to load Codex config' }, 500);
  }
});

configRoutes.get(
  '/codex/detect-local',
  authMiddleware,
  systemConfigMiddleware,
  (c) => {
    return c.json(detectLocalCodexCli());
  },
);

configRoutes.get(
  '/codex/rate-limits',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    try {
      const cli = detectLocalCodexCli();
      if (!cli.hasAuth) {
        return c.json({ available: false, reason: 'not_logged_in' });
      }
      const refresh = c.req.query('refresh') === '1';
      const data = await queryCodexRateLimits(refresh);
      return c.json({ available: true, rateLimits: data.rateLimits });
    } catch (err) {
      logger.error({ err }, 'Failed to query Codex rate limits');
      const msg = err instanceof Error ? err.message : 'Unknown error';
      return c.json({ error: msg }, 500);
    }
  },
);

configRoutes.get('/claude', authMiddleware, systemConfigMiddleware, (c) => {
  try {
    const local = detectLocalClaudeCode();
    return c.json({
      anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL || '',
      happyclawModel: '',
      updatedAt: null,
      hasAnthropicAuthToken: false,
      hasAnthropicApiKey: !!process.env.ANTHROPIC_API_KEY,
      hasClaudeCodeOauthToken: !!process.env.CLAUDE_CODE_OAUTH_TOKEN,
      anthropicAuthTokenMasked: null,
      anthropicApiKeyMasked: process.env.ANTHROPIC_API_KEY ? '***' : null,
      claudeCodeOauthTokenMasked: process.env.CLAUDE_CODE_OAUTH_TOKEN ? '***' : null,
      hasClaudeOAuthCredentials: local.hasCredentials,
      claudeOAuthCredentialsExpiresAt: local.expiresAt,
      claudeOAuthCredentialsAccessTokenMasked: local.accessTokenMasked,
    });
  } catch (err) {
    logger.error({ err }, 'Failed to load Claude config');
    return c.json({ error: 'Failed to load Claude config' }, 500);
  }
});

// ─── Helpers ────────────────────────────────────────────────────

const _deprecationLogged = new Set<string>();
function logDeprecationOnce(endpoint: string, replacement: string): void {
  if (_deprecationLogged.has(endpoint)) return;
  logger.warn(`Deprecated: ${endpoint} — use ${replacement} instead`);
  _deprecationLogged.add(endpoint);
}

function resolveProxyInfo(
  userProxy: string,
  sysProxy: string,
): { effectiveProxyUrl: string; proxySource: 'user' | 'system' | 'none' } {
  return {
    effectiveProxyUrl: userProxy || sysProxy,
    proxySource: userProxy ? 'user' : sysProxy ? 'system' : 'none',
  };
}

/** Persist a RegisteredGroup update and sync to the in-memory cache. */
function applyBindingUpdate(imJid: string, updated: RegisteredGroup): void {
  setRegisteredGroup(imJid, updated);
  const webDeps = getWebDeps();
  if (webDeps) {
    const groups = webDeps.getRegisteredGroups();
    if (groups[imJid]) groups[imJid] = updated;
    webDeps.clearImFailCounts?.(imJid);
  }
}

function resolveDefaultBindingSessionId(imGroup: RegisteredGroup): string {
  return `main:${imGroup.folder}`;
}

function isImplicitDefaultSessionBinding(
  imGroup: RegisteredGroup,
  binding: ReturnType<typeof getSessionBinding> | undefined,
): boolean {
  return !!binding
    && binding.session_id === resolveDefaultBindingSessionId(imGroup)
    && binding.binding_mode === 'source_only'
    && binding.reply_policy === 'source_only'
    && binding.activation_mode === 'auto'
    && binding.require_mention !== true;
}

function getExplicitSessionBinding(
  imJid: string,
  imGroup: RegisteredGroup,
): ReturnType<typeof getSessionBinding> | undefined {
  const binding = getSessionBinding(imJid);
  return isImplicitDefaultSessionBinding(imGroup, binding) ? undefined : binding;
}

function applyExplicitSessionBinding(
  imJid: string,
  sessionId: string | null,
  imGroup: RegisteredGroup,
  updates: {
    reply_policy?: 'source_only' | 'mirror';
    activation_mode?: 'auto' | 'always' | 'when_mentioned' | 'disabled';
    require_mention?: boolean;
  },
): void {
  const now = new Date().toISOString();
  const currentBinding = getSessionBinding(imJid);
  const nextReplyPolicy = updates.reply_policy ?? imGroup.reply_policy ?? 'source_only';
  const nextActivationMode = updates.activation_mode ?? imGroup.activation_mode ?? 'auto';
  const nextRequireMention =
    updates.require_mention !== undefined
      ? updates.require_mention
      : imGroup.require_mention === true;
  const isDefaultPolicy =
    nextReplyPolicy === 'source_only'
    && nextActivationMode === 'auto'
    && !nextRequireMention;

  if (
    !sessionId
    || (
      sessionId === resolveDefaultBindingSessionId(imGroup)
      && isDefaultPolicy
    )
  ) {
    deleteSessionBinding(imJid);
    return;
  }

  const boundSession = getSessionRecord(sessionId);
  const bindingMode =
    !boundSession || boundSession.kind === 'main' ? 'source_only'
      : boundSession.kind === 'worker' ? 'direct'
      : 'direct';

  saveSessionBinding({
    channel_jid: imJid,
    session_id: sessionId,
    binding_mode:
      nextReplyPolicy === 'mirror' ? 'mirror' : bindingMode,
    activation_mode: nextActivationMode,
    require_mention: nextRequireMention,
    display_name: imGroup.name,
    reply_policy: nextReplyPolicy,
    created_at: currentBinding?.created_at || imGroup.added_at || now,
    updated_at: now,
  });
}

function getSessionFolder(sessionId: string): string | null {
  if (sessionId.startsWith('main:')) return sessionId.slice('main:'.length);
  const session = getSessionRecord(sessionId);
  if (session?.parent_session_id?.startsWith('main:')) {
    return session.parent_session_id.slice('main:'.length);
  }
  return null;
}

function resolveSessionBindingAccessTarget(sessionId: string): {
  session: NonNullable<ReturnType<typeof getSessionRecord>>;
  accessJid: string;
  group: RegisteredGroup;
} | null {
  const session = getSessionRecord(sessionId);
  if (!session) return null;
  const folder = getSessionFolder(sessionId);
  if (!folder) return null;
  const accessJid =
    getJidsByFolder(folder).find((jid) => jid.startsWith('web:')) || `web:${folder}`;
  const group = getRegisteredGroup(accessJid);
  return group ? { session, accessJid, group } : null;
}

configRoutes.get('/feishu', authMiddleware, systemConfigMiddleware, (c) => {
  logDeprecationOnce(
    'GET /api/config/feishu',
    'GET /api/config/im/feishu',
  );
  try {
    const { config, source } = getFeishuProviderConfigWithSource();
    const pub = toPublicFeishuProviderConfig(config, source);
    const connected = deps?.isFeishuConnected?.() ?? false;
    return c.json({ ...pub, connected });
  } catch (err) {
    logger.error({ err }, 'Failed to load Feishu config');
    return c.json({ error: 'Failed to load Feishu config' }, 500);
  }
});

configRoutes.put(
  '/feishu',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const validation = FeishuConfigSchema.safeParse(body);
    if (!validation.success) {
      return c.json(
        { error: 'Invalid request body', details: validation.error.format() },
        400,
      );
    }

    const current = getFeishuProviderConfig();
    const next = { ...current };
    if (typeof validation.data.appId === 'string') {
      next.appId = validation.data.appId;
    }
    if (typeof validation.data.appSecret === 'string') {
      next.appSecret = validation.data.appSecret;
    } else if (validation.data.clearAppSecret === true) {
      next.appSecret = '';
    }
    if (typeof validation.data.enabled === 'boolean') {
      next.enabled = validation.data.enabled;
    }

    try {
      const saved = saveFeishuProviderConfig({
        appId: next.appId,
        appSecret: next.appSecret,
        enabled: next.enabled,
      });

      // Hot-reload: reconnect/disconnect Feishu channel
      let connected = false;
      if (deps?.reloadFeishuConnection) {
        try {
          connected = await deps.reloadFeishuConnection(saved);
        } catch (err: unknown) {
          logger.warn({ err }, 'Failed to reload Feishu connection');
        }
      }

      return c.json({
        ...toPublicFeishuProviderConfig(saved, 'runtime'),
        connected,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Invalid Feishu config payload';
      logger.warn({ err }, 'Invalid Feishu config payload');
      return c.json({ error: message }, 400);
    }
  },
);

// ─── Telegram config ─────────────────────────────────────────────

configRoutes.get('/telegram', authMiddleware, systemConfigMiddleware, (c) => {
  logDeprecationOnce(
    'GET /api/config/telegram',
    'GET /api/config/im/telegram',
  );
  try {
    const { config, source } = getTelegramProviderConfigWithSource();
    const pub = toPublicTelegramProviderConfig(config, source);
    const connected = deps?.isTelegramConnected?.() ?? false;
    return c.json({ ...pub, connected });
  } catch (err) {
    logger.error({ err }, 'Failed to load Telegram config');
    return c.json({ error: 'Failed to load Telegram config' }, 500);
  }
});

configRoutes.put(
  '/telegram',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const validation = TelegramConfigSchema.safeParse(body);
    if (!validation.success) {
      return c.json(
        { error: 'Invalid request body', details: validation.error.format() },
        400,
      );
    }

    const current = getTelegramProviderConfig();
    const next = { ...current };
    if (typeof validation.data.botToken === 'string') {
      next.botToken = validation.data.botToken;
    } else if (validation.data.clearBotToken === true) {
      next.botToken = '';
    }
    if (typeof validation.data.proxyUrl === 'string') {
      next.proxyUrl = validation.data.proxyUrl;
    } else if (validation.data.clearProxyUrl === true) {
      next.proxyUrl = '';
    }
    if (typeof validation.data.enabled === 'boolean') {
      next.enabled = validation.data.enabled;
    }

    try {
      const saved = saveTelegramProviderConfig({
        botToken: next.botToken,
        proxyUrl: next.proxyUrl,
        enabled: next.enabled,
      });

      // Hot-reload: reconnect/disconnect Telegram channel
      let connected = false;
      if (deps?.reloadTelegramConnection) {
        try {
          connected = await deps.reloadTelegramConnection(saved);
        } catch (err: unknown) {
          logger.warn({ err }, 'Failed to reload Telegram connection');
        }
      }

      return c.json({
        ...toPublicTelegramProviderConfig(saved, 'runtime'),
        connected,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Invalid Telegram config payload';
      logger.warn({ err }, 'Invalid Telegram config payload');
      return c.json({ error: message }, 400);
    }
  },
);

configRoutes.post(
  '/telegram/test',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    const config = getTelegramProviderConfig();
    if (!config.botToken) {
      return c.json({ error: 'Telegram bot token not configured' }, 400);
    }

    const agent = createTelegramApiAgent(config.proxyUrl);
    try {
      const { Bot } = await import('grammy');
      const testBot = new Bot(config.botToken, {
        client: {
          timeoutSeconds: 15,
          baseFetchConfig: {
            agent,
          },
        },
      });

      let me: { username?: string; id: number; first_name: string } | null =
        null;
      let lastErr: unknown = null;
      for (let i = 0; i < 3; i++) {
        try {
          me = await testBot.api.getMe();
          break;
        } catch (err) {
          lastErr = err;
          // Small retry window for intermittent network timeouts.
          if (i < 2) await new Promise((resolve) => setTimeout(resolve, 300));
        }
      }
      if (!me) {
        throw lastErr instanceof Error
          ? lastErr
          : new Error('Telegram API request failed');
      }

      return c.json({
        success: true,
        bot_username: me.username,
        bot_id: me.id,
        bot_name: me.first_name,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to connect to Telegram';
      logger.warn({ err }, 'Failed to test Telegram connection');
      return c.json({ error: message }, 400);
    } finally {
      destroyTelegramApiAgent(agent);
    }
  },
);

// ─── Appearance config ────────────────────────────────────────────

configRoutes.get('/appearance', authMiddleware, systemConfigMiddleware, (c) => {
  try {
    return c.json(getAppearanceConfig());
  } catch (err) {
    logger.error({ err }, 'Failed to load appearance config');
    return c.json({ error: 'Failed to load appearance config' }, 500);
  }
});

configRoutes.put(
  '/appearance',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const validation = AppearanceConfigSchema.safeParse(body);
    if (!validation.success) {
      return c.json(
        { error: 'Invalid request body', details: validation.error.format() },
        400,
      );
    }

    try {
      const saved = saveAppearanceConfig(validation.data);
      return c.json(saved);
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : 'Invalid appearance config payload';
      logger.warn({ err }, 'Invalid appearance config payload');
      return c.json({ error: message }, 400);
    }
  },
);

// Public endpoint — no auth required (like /api/auth/status)
configRoutes.get('/appearance/public', (c) => {
  try {
    const config = getAppearanceConfig();
    return c.json({
      appName: config.appName,
      aiName: config.aiName,
      aiAvatarEmoji: config.aiAvatarEmoji,
      aiAvatarColor: config.aiAvatarColor,
    });
  } catch (err) {
    logger.error({ err }, 'Failed to load public appearance config');
    return c.json({ error: 'Failed to load appearance config' }, 500);
  }
});

// ─── System settings ───────────────────────────────────────────────

configRoutes.get('/system', authMiddleware, systemConfigMiddleware, (c) => {
  try {
    return c.json(getSystemSettings());
  } catch (err) {
    logger.error({ err }, 'Failed to load system settings');
    return c.json({ error: 'Failed to load system settings' }, 500);
  }
});

configRoutes.put(
  '/system',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const validation = SystemSettingsSchema.safeParse(body);
    if (!validation.success) {
      return c.json(
        { error: 'Invalid request body', details: validation.error.format() },
        400,
      );
    }

    try {
      const saved = saveSystemSettings(validation.data);
      return c.json(saved);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Invalid system settings payload';
      logger.warn({ err }, 'Invalid system settings payload');
      return c.json({ error: message }, 400);
    }
  },
);

// ─── Global IM connection status ───────────────────────────────────

configRoutes.get('/im/status', authMiddleware, (c) => {
  return c.json({
    feishu: deps?.isIMFeishuConnected?.() ?? false,
    telegram: deps?.isIMTelegramConnected?.() ?? false,
    qq: deps?.isIMQQConnected?.() ?? false,
    wechat: deps?.isIMWeChatConnected?.() ?? false,
  });
});

// ─── Global IM config ─────────────────────────────────────────────

configRoutes.get('/im/feishu', authMiddleware, (c) => {
  try {
    const config = getImFeishuConfig();
    const connected = deps?.isIMFeishuConnected?.() ?? false;
    if (!config) {
      return c.json({
        appId: '',
        hasAppSecret: false,
        appSecretMasked: null,
        enabled: false,
        updatedAt: null,
        connected,
        replyThreadingMode: 'auto',
        streamingCard: false,
        imCommentary: false,
      });
    }
    return c.json({
      ...toPublicFeishuProviderConfig(config, 'runtime'),
      connected,
      replyThreadingMode: config.replyThreadingMode ?? 'auto',
      streamingCard: config.streamingCard ?? false,
      imCommentary: config.imCommentary ?? false,
    });
  } catch (err) {
    logger.error({ err }, 'Failed to load Feishu IM config');
    return c.json({ error: 'Failed to load Feishu IM config' }, 500);
  }
});

configRoutes.put('/im/feishu', authMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const validation = FeishuConfigSchema.safeParse(body);
  if (!validation.success) {
    return c.json(
      { error: 'Invalid request body', details: validation.error.format() },
      400,
    );
  }

  const current = getImFeishuConfig();
  const next: { appId: string; appSecret: string; enabled: boolean; updatedAt: string | null; replyThreadingMode?: 'auto' | 'agent'; streamingCard?: boolean; imCommentary?: boolean } = {
    appId: current?.appId || '',
    appSecret: current?.appSecret || '',
    enabled: current?.enabled ?? true,
    updatedAt: current?.updatedAt || null,
    replyThreadingMode: current?.replyThreadingMode ?? 'auto',
    streamingCard: current?.streamingCard ?? false,
    imCommentary: current?.imCommentary ?? false,
  };
  if (typeof validation.data.appId === 'string') {
    const appId = validation.data.appId.trim();
    if (appId) next.appId = appId;
  }
  if (typeof validation.data.appSecret === 'string') {
    const appSecret = validation.data.appSecret.trim();
    if (appSecret) next.appSecret = appSecret;
  } else if (validation.data.clearAppSecret === true) {
    next.appSecret = '';
  }
  if (typeof validation.data.enabled === 'boolean') {
    next.enabled = validation.data.enabled;
  } else if (!current && (next.appId || next.appSecret)) {
    // First-time config with credentials should connect immediately.
    next.enabled = true;
  }
  if (validation.data.replyThreadingMode) {
    next.replyThreadingMode = validation.data.replyThreadingMode;
  }
  if (typeof validation.data.streamingCard === 'boolean') {
    next.streamingCard = validation.data.streamingCard;
  }
  if (typeof validation.data.imCommentary === 'boolean') {
    next.imCommentary = validation.data.imCommentary;
  }

  try {
    const saved = saveImFeishuConfig({
      appId: next.appId,
      appSecret: next.appSecret,
      enabled: next.enabled,
      replyThreadingMode: next.replyThreadingMode,
      streamingCard: next.streamingCard,
      imCommentary: next.imCommentary,
    });

    // Hot-reload: reconnect user's Feishu channel
    if (deps?.reloadIMConfig) {
      try {
        await deps.reloadIMConfig('feishu');
      } catch (err) {
        logger.warn({ err }, 'Failed to hot-reload Feishu connection');
      }
    }

    const connected = deps?.isIMFeishuConnected?.() ?? false;
    return c.json({
      ...toPublicFeishuProviderConfig(saved, 'runtime'),
      connected,
      replyThreadingMode: saved.replyThreadingMode ?? 'auto',
      streamingCard: saved.streamingCard ?? false,
      imCommentary: saved.imCommentary ?? false,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Invalid Feishu config payload';
    logger.warn({ err }, 'Invalid Feishu IM config payload');
    return c.json({ error: message }, 400);
  }
});

// ─── Feishu OAuth Document Access ────────────────────────────────────

/**
 * GET /api/config/im/feishu/oauth-status
 * Returns the current OAuth authorization status for the global IM config.
 */
configRoutes.get(
  '/im/feishu/oauth-status',
  authMiddleware,
  (c) => {
    const tokens = getImFeishuOAuthTokens();
    const config = getImFeishuConfig();

    if (!tokens) {
      return c.json({
        authorized: false,
        hasAppCredentials: !!(config?.appId && config?.appSecret),
      });
    }

    return c.json({
      authorized: true,
      hasAppCredentials: !!(config?.appId && config?.appSecret),
      authorizedAt: tokens.authorizedAt || null,
      scopes: tokens.scopes || '',
      tokenExpired: tokens.expiresAt < Date.now(),
      hasRefreshToken: !!tokens.refreshToken,
    });
  },
);

/**
 * GET /api/config/im/feishu/oauth-url
 * Generates a Feishu OAuth authorization URL for the current auth session.
 * Requires existing Feishu app credentials (appId + appSecret).
 */
configRoutes.get(
  '/im/feishu/oauth-url',
  authMiddleware,
  (c) => {
    const config = getImFeishuConfig();
    const sessionId = c.get('sessionId') as string;

    if (!config?.appId || !config?.appSecret) {
      return c.json(
        { error: '请先配置飞书应用的 App ID 和 App Secret' },
        400,
      );
    }

    // Build redirect URI from request origin
    const origin = c.req.header('Origin') || c.req.header('Referer')?.replace(/\/[^/]*$/, '') || '';
    if (!origin) {
      return c.json({ error: '无法确定回调地址，请从 Web 界面发起授权' }, 400);
    }
    const redirectUri = `${origin}/feishu-oauth-callback`;

    const state = createOAuthState(sessionId);
    const url = buildOAuthUrl(config.appId, redirectUri, state);

    return c.json({ url, state, redirectUri });
  },
);

/**
 * POST /api/config/im/feishu/oauth-callback
 * Exchanges the authorization code for access + refresh tokens.
 * Body: { code: string, state: string, redirectUri: string }
 */
configRoutes.post(
  '/im/feishu/oauth-callback',
  authMiddleware,
  async (c) => {
    const sessionId = c.get('sessionId') as string;
    const body = await c.req.json().catch(() => ({}));

    const { code, state, redirectUri } = body as {
      code?: string;
      state?: string;
      redirectUri?: string;
    };

    if (!code || !state || !redirectUri) {
      return c.json({ error: 'Missing required fields: code, state, redirectUri' }, 400);
    }

    // Validate state against the current auth session before consuming it.
    if (!consumeOAuthState(state, sessionId)) {
      return c.json({ error: '授权状态已过期或不匹配，请重新发起授权' }, 400);
    }

    // Get app credentials
    const config = getImFeishuConfig();
    if (!config?.appId || !config?.appSecret) {
      return c.json({ error: '飞书应用凭据缺失' }, 400);
    }

    try {
      const tokens = await exchangeCodeForTokens(
        config.appId,
        config.appSecret,
        code,
        redirectUri,
      );

      saveImFeishuOAuthTokens({
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        scopes: tokens.scopes,
      });

      logger.info({ scopes: tokens.scopes }, 'Feishu OAuth authorized successfully');

      return c.json({
        success: true,
        scopes: tokens.scopes,
        expiresIn: Math.floor((tokens.expiresAt - Date.now()) / 1000),
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'OAuth 授权失败';
      logger.error({ err }, 'Feishu OAuth callback failed');
      return c.json({ error: message }, 500);
    }
  },
);

/**
 * DELETE /api/config/im/feishu/oauth-revoke
 * Revokes the current OAuth authorization from the global IM config.
 */
configRoutes.delete(
  '/im/feishu/oauth-revoke',
  authMiddleware,
  (c) => {
    clearImFeishuOAuthTokens();
    logger.info('Feishu OAuth authorization revoked');

    return c.json({ success: true });
  },
);

// ─── Telegram IM config ───────────────────────────────────────────

configRoutes.get('/im/telegram', authMiddleware, (c) => {
  try {
    const config = getImTelegramConfig();
    const connected = deps?.isIMTelegramConnected?.() ?? false;
    const globalConfig = getTelegramProviderConfig();
    const userProxy = config?.proxyUrl || '';
    const sysProxy = globalConfig.proxyUrl || '';
    const proxy = resolveProxyInfo(userProxy, sysProxy);
    if (!config) {
      return c.json({
        hasBotToken: false,
        botTokenMasked: null,
        enabled: false,
        updatedAt: null,
        connected,
        proxyUrl: '',
        ...proxy,
      });
    }
    return c.json({
      ...toPublicTelegramProviderConfig(config, 'runtime'),
      connected,
      proxyUrl: userProxy,
      ...proxy,
    });
  } catch (err) {
    logger.error({ err }, 'Failed to load Telegram IM config');
    return c.json({ error: 'Failed to load Telegram IM config' }, 500);
  }
});

configRoutes.put('/im/telegram', authMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const validation = TelegramConfigSchema.safeParse(body);
  if (!validation.success) {
    return c.json(
      { error: 'Invalid request body', details: validation.error.format() },
      400,
    );
  }

  const current = getImTelegramConfig();
  const next = {
    botToken: current?.botToken || '',
    proxyUrl: current?.proxyUrl || '',
    enabled: current?.enabled ?? true,
    updatedAt: current?.updatedAt || null,
  };
  if (typeof validation.data.botToken === 'string') {
    const botToken = validation.data.botToken.trim();
    if (botToken) next.botToken = botToken;
  } else if (validation.data.clearBotToken === true) {
    next.botToken = '';
  }
  if (typeof validation.data.proxyUrl === 'string') {
    next.proxyUrl = validation.data.proxyUrl.trim();
  } else if (validation.data.clearProxyUrl === true) {
    next.proxyUrl = '';
  }
  if (typeof validation.data.enabled === 'boolean') {
    next.enabled = validation.data.enabled;
  } else if (!current && next.botToken) {
    // First-time config with token should connect immediately.
    next.enabled = true;
  }

  try {
    const saved = saveImTelegramConfig({
      botToken: next.botToken,
      proxyUrl: next.proxyUrl || undefined,
      enabled: next.enabled,
    });

    if (deps?.reloadIMConfig) {
      try {
        await deps.reloadIMConfig('telegram');
      } catch (err) {
        logger.warn({ err }, 'Failed to hot-reload Telegram connection');
      }
    }

    const connected = deps?.isIMTelegramConnected?.() ?? false;
    const userProxy = saved.proxyUrl || '';
    const sysProxy = getTelegramProviderConfig().proxyUrl || '';
    return c.json({
      ...toPublicTelegramProviderConfig(saved, 'runtime'),
      connected,
      proxyUrl: userProxy,
      ...resolveProxyInfo(userProxy, sysProxy),
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Invalid Telegram config payload';
    logger.warn({ err }, 'Invalid Telegram IM config payload');
    return c.json({ error: message }, 400);
  }
});

configRoutes.post('/im/telegram/test', authMiddleware, async (c) => {
  const config = getImTelegramConfig();
  if (!config?.botToken) {
    return c.json({ error: 'Telegram bot token not configured' }, 400);
  }

  const globalTelegramConfig = getTelegramProviderConfig();
  const effectiveProxy = config.proxyUrl || globalTelegramConfig.proxyUrl;
  const agent = createTelegramApiAgent(effectiveProxy);
  try {
    const { Bot } = await import('grammy');
    const testBot = new Bot(config.botToken, {
      client: {
        timeoutSeconds: 15,
        baseFetchConfig: {
          agent,
        },
      },
    });
    const me = await testBot.api.getMe();
    return c.json({
      success: true,
      bot_username: me.username,
      bot_id: me.id,
      bot_name: me.first_name,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Failed to connect to Telegram';
    logger.warn({ err }, 'Failed to test Telegram connection');
    return c.json({ error: message }, 400);
  } finally {
    destroyTelegramApiAgent(agent);
  }
});

configRoutes.post(
  '/im/telegram/pairing-code',
  authMiddleware,
  async (c) => {
    const user = c.get('user') as AuthUser;
    const config = getImTelegramConfig();
    if (!config?.botToken) {
      return c.json({ error: 'Telegram bot token not configured' }, 400);
    }

    try {
      const { generatePairingCode } = await import('../telegram-pairing.js');
      const result = generatePairingCode(user.id);
      return c.json(result);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to generate pairing code';
      logger.warn({ err }, 'Failed to generate pairing code');
      return c.json({ error: message }, 500);
    }
  },
);

// List Telegram paired chats for the current user
configRoutes.get('/im/telegram/paired-chats', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const groups = (deps?.getRegisteredGroups() ?? {}) as Record<
    string,
    RegisteredGroup
  >;
  const chats: Array<{ jid: string; name: string; addedAt: string }> = [];
  for (const [jid, group] of Object.entries(groups)) {
    if (
      jid.startsWith('telegram:')
      && resolveImGroupOwnerKey(jid, group) === user.id
    ) {
      chats.push({ jid, name: group.name, addedAt: group.added_at });
    }
  }
  return c.json({ chats });
});

// Remove (unpair) a Telegram chat
configRoutes.delete(
  '/im/telegram/paired-chats/:jid',
  authMiddleware,
  (c) => {
    const user = c.get('user') as AuthUser;
    const jid = decodeURIComponent(c.req.param('jid'));

    if (!jid.startsWith('telegram:')) {
      return c.json({ error: 'Invalid Telegram chat JID' }, 400);
    }

    const groups = deps?.getRegisteredGroups() ?? {};
    const group = groups[jid];
    if (!group) {
      return c.json({ error: 'Chat not found' }, 404);
    }
    if (resolveImGroupOwnerKey(jid, group) !== user.id) {
      return c.json({ error: 'Not authorized to remove this chat' }, 403);
    }

    deleteRegisteredGroup(jid);
    deleteChatHistory(jid);
    delete groups[jid];
    logger.info({ jid, userId: user.id }, 'Telegram chat unpaired');
    return c.json({ success: true });
  },
);

// ─── QQ IM Config ───────────────────────────────────────────────

function maskQQAppSecret(secret: string): string | null {
  if (!secret) return null;
  if (secret.length <= 8) return '***';
  return secret.slice(0, 4) + '***' + secret.slice(-4);
}

configRoutes.get('/im/qq', authMiddleware, (c) => {
  try {
    const config = getImQQConfig();
    const connected = deps?.isIMQQConnected?.() ?? false;
    if (!config) {
      return c.json({
        appId: '',
        hasAppSecret: false,
        appSecretMasked: null,
        enabled: false,
        updatedAt: null,
        connected,
      });
    }
    return c.json({
      appId: config.appId,
      hasAppSecret: !!config.appSecret,
      appSecretMasked: maskQQAppSecret(config.appSecret),
      enabled: config.enabled ?? false,
      updatedAt: config.updatedAt,
      connected,
    });
  } catch (err) {
    logger.error({ err }, 'Failed to load QQ IM config');
    return c.json({ error: 'Failed to load QQ IM config' }, 500);
  }
});

configRoutes.put('/im/qq', authMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const validation = QQConfigSchema.safeParse(body);
  if (!validation.success) {
    return c.json(
      { error: 'Invalid request body', details: validation.error.format() },
      400,
    );
  }

  const current = getImQQConfig();
  const next = {
    appId: current?.appId || '',
    appSecret: current?.appSecret || '',
    enabled: current?.enabled ?? true,
  };
  if (typeof validation.data.appId === 'string') {
    next.appId = validation.data.appId.trim();
  }
  if (typeof validation.data.appSecret === 'string') {
    const appSecret = validation.data.appSecret.trim();
    if (appSecret) next.appSecret = appSecret;
  } else if (validation.data.clearAppSecret === true) {
    next.appSecret = '';
  }
  if (typeof validation.data.enabled === 'boolean') {
    next.enabled = validation.data.enabled;
  } else if (!current && next.appId && next.appSecret) {
    next.enabled = true;
  }

  try {
    const saved = saveImQQConfig({
      appId: next.appId,
      appSecret: next.appSecret,
      enabled: next.enabled,
    });

    if (deps?.reloadIMConfig) {
      try {
        await deps.reloadIMConfig('qq');
      } catch (err) {
        logger.warn({ err }, 'Failed to hot-reload QQ connection');
      }
    }

    const connected = deps?.isIMQQConnected?.() ?? false;
    return c.json({
      appId: saved.appId,
      hasAppSecret: !!saved.appSecret,
      appSecretMasked: maskQQAppSecret(saved.appSecret),
      enabled: saved.enabled ?? false,
      updatedAt: saved.updatedAt,
      connected,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Invalid QQ config payload';
    logger.warn({ err }, 'Invalid QQ IM config payload');
    return c.json({ error: message }, 400);
  }
});

configRoutes.post('/im/qq/test', authMiddleware, async (c) => {
  const config = getImQQConfig();
  if (!config?.appId || !config?.appSecret) {
    return c.json({ error: 'QQ App ID and App Secret not configured' }, 400);
  }

  try {
    // Test by fetching access token
    const https = await import('node:https');
    const body = JSON.stringify({
      appId: config.appId,
      clientSecret: config.appSecret,
    });

    const result = await new Promise<{
      access_token?: string;
      expires_in?: number;
    }>((resolve, reject) => {
      const url = new URL('https://bots.qq.com/app/getAppAccessToken');
      const req = https.request(
        {
          hostname: url.hostname,
          path: url.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': String(Buffer.byteLength(body)),
          },
          timeout: 15000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
            } catch (err) {
              reject(err);
            }
          });
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy(new Error('Request timeout'));
      });
      req.write(body);
      req.end();
    });

    if (!result.access_token) {
      return c.json(
        {
          error:
            'Failed to obtain access token. Please check App ID and App Secret.',
        },
        400,
      );
    }

    return c.json({
      success: true,
      expires_in: result.expires_in,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Failed to connect to QQ';
    logger.warn({ err }, 'Failed to test QQ connection');
    return c.json({ error: message }, 400);
  }
});

configRoutes.post('/im/qq/pairing-code', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const config = getImQQConfig();
  if (!config?.appId || !config?.appSecret) {
    return c.json({ error: 'QQ App ID and App Secret not configured' }, 400);
  }

  try {
    const { generatePairingCode } = await import('../telegram-pairing.js');
    const result = generatePairingCode(user.id);
    return c.json(result);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Failed to generate pairing code';
    logger.warn({ err }, 'Failed to generate QQ pairing code');
    return c.json({ error: message }, 500);
  }
});

// List QQ paired chats for the current user
configRoutes.get('/im/qq/paired-chats', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const groups = (deps?.getRegisteredGroups() ?? {}) as Record<
    string,
    RegisteredGroup
  >;
  const chats: Array<{ jid: string; name: string; addedAt: string }> = [];
  for (const [jid, group] of Object.entries(groups)) {
    if (jid.startsWith('qq:') && resolveImGroupOwnerKey(jid, group) === user.id) {
      chats.push({ jid, name: group.name, addedAt: group.added_at });
    }
  }
  return c.json({ chats });
});

// Remove (unpair) a QQ chat
configRoutes.delete('/im/qq/paired-chats/:jid', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const jid = decodeURIComponent(c.req.param('jid'));

  if (!jid.startsWith('qq:')) {
    return c.json({ error: 'Invalid QQ chat JID' }, 400);
  }

  const groups = deps?.getRegisteredGroups() ?? {};
  const group = groups[jid];
  if (!group) {
    return c.json({ error: 'Chat not found' }, 404);
  }
  if (resolveImGroupOwnerKey(jid, group) !== user.id) {
    return c.json({ error: 'Not authorized to remove this chat' }, 403);
  }

  deleteRegisteredGroup(jid);
  deleteChatHistory(jid);
  delete groups[jid];
  logger.info({ jid, userId: user.id }, 'QQ chat unpaired');
  return c.json({ success: true });
});

// ─── Global IM Preferences ──────────────────────────────────────

configRoutes.get('/im/preferences', authMiddleware, (c) => {
  const prefs = getImPreferences();
  return c.json(prefs);
});

configRoutes.put('/im/preferences', authMiddleware, async (c) => {
  const body = UserIMPreferencesSchema.parse(await c.req.json());
  const saved = saveImPreferences({
    ...body,
    autoCreateExecutionMode: body.autoCreateExecutionMode,
  });
  return c.json(saved);
});

// ─── Global IM general settings ──────────────────────────────────

configRoutes.get('/im/general', authMiddleware, (c) => {
  const config = getImGeneralConfig();
  return c.json(config);
});

configRoutes.put('/im/general', authMiddleware, async (c) => {
  const body = await c.req.json();
  const parsed = ImGeneralConfigSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: 'Invalid config', details: parsed.error.format() },
      400,
    );
  }
  const saved = saveImGeneralConfig(parsed.data);
  return c.json(saved);
});


// ─── WeChat IM config ───────────────────────────────────────────

const WECHAT_API_BASE = 'https://ilinkai.weixin.qq.com';
const WECHAT_QR_BOT_TYPE = '3';

function randomWechatUin(): string {
  const uint32 = randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), 'utf-8').toString('base64');
}

function maskBotToken(token: string | undefined): string | null {
  if (!token) return null;
  if (token.length <= 8) return '***';
  return token.slice(0, 4) + '***' + token.slice(-4);
}

configRoutes.get('/im/wechat', authMiddleware, (c) => {
  try {
    const config = getImWeChatConfig();
    const connected = deps?.isIMWeChatConnected?.() ?? false;
    if (!config) {
      return c.json({
        ilinkBotId: '',
        hasBotToken: false,
        botTokenMasked: null,
        enabled: false,
        updatedAt: null,
        connected,
      });
    }
    return c.json({
      ilinkBotId: config.ilinkBotId || '',
      hasBotToken: !!config.botToken,
      botTokenMasked: maskBotToken(config.botToken),
      enabled: config.enabled ?? false,
      updatedAt: config.updatedAt,
      connected,
    });
  } catch (err) {
    logger.error({ err }, 'Failed to load WeChat IM config');
    return c.json({ error: 'Failed to load WeChat IM config' }, 500);
  }
});

configRoutes.put('/im/wechat', authMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const validation = WeChatConfigSchema.safeParse(body);
  if (!validation.success) {
    return c.json(
      { error: 'Invalid request body', details: validation.error.format() },
      400,
    );
  }

  const current = getImWeChatConfig();
  const next = {
    botToken: current?.botToken || '',
    ilinkBotId: current?.ilinkBotId || '',
    baseUrl: current?.baseUrl,
    cdnBaseUrl: current?.cdnBaseUrl,
    getUpdatesBuf: current?.getUpdatesBuf,
    enabled: current?.enabled ?? false,
  };

  if (validation.data.clearBotToken === true) {
    next.botToken = '';
    next.ilinkBotId = '';
  }
  if (typeof validation.data.enabled === 'boolean') {
    next.enabled = validation.data.enabled;
  }

  try {
    const saved = saveImWeChatConfig(next);

    if (deps?.reloadIMConfig) {
      try {
        await deps.reloadIMConfig('wechat');
      } catch (err) {
        logger.warn({ err }, 'Failed to hot-reload WeChat connection');
      }
    }

    const connected = deps?.isIMWeChatConnected?.() ?? false;
    return c.json({
      ilinkBotId: saved.ilinkBotId || '',
      hasBotToken: !!saved.botToken,
      botTokenMasked: maskBotToken(saved.botToken),
      enabled: saved.enabled ?? false,
      updatedAt: saved.updatedAt,
      connected,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Invalid WeChat config payload';
    logger.warn({ err }, 'Invalid WeChat IM config payload');
    return c.json({ error: message }, 400);
  }
});

// Generate QR code for WeChat iLink login
configRoutes.post('/im/wechat/qrcode', authMiddleware, async (c) => {
  try {
    const url = `${WECHAT_API_BASE}/ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(WECHAT_QR_BOT_TYPE)}`;
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.error(
        { status: res.status, body },
        'WeChat QR code fetch failed',
      );
      return c.json(
        { error: `Failed to fetch QR code: ${res.status}` },
        502,
      );
    }
    const data = (await res.json()) as {
      qrcode?: string;
      qrcode_img_content?: string;
    };
    if (!data.qrcode) {
      return c.json({ error: 'No QR code in response' }, 502);
    }

    // qrcode_img_content is a URL string (WeChat deep link) to be encoded
    // INTO a QR code image, not an image URL itself.
    let qrcodeDataUri = '';
    if (data.qrcode_img_content) {
      try {
        qrcodeDataUri = await QRCode.toDataURL(data.qrcode_img_content, {
          width: 512,
          margin: 2,
          color: { dark: '#000000', light: '#ffffff' },
        });
      } catch (qrErr) {
        logger.warn({ err: qrErr }, 'Failed to generate QR code image');
      }
    }

    return c.json({
      qrcode: data.qrcode,
      qrcodeUrl: qrcodeDataUri,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Failed to generate QR code';
    logger.error({ err }, 'WeChat QR code generation failed');
    return c.json({ error: message }, 500);
  }
});

// Poll QR code scan status
configRoutes.get(
  '/im/wechat/qrcode-status',
  authMiddleware,
  async (c) => {
    const qrcode = c.req.query('qrcode');
    if (!qrcode) {
      return c.json({ error: 'qrcode query parameter required' }, 400);
    }

    try {
      const url = `${WECHAT_API_BASE}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
      const headers: Record<string, string> = {
        'iLink-App-ClientVersion': '1',
      };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 35000);
      let res: Response;
      try {
        res = await fetch(url, { headers, signal: controller.signal });
        clearTimeout(timer);
      } catch (err) {
        clearTimeout(timer);
        if (
          err instanceof Error &&
          err.name === 'AbortError'
        ) {
          return c.json({ status: 'wait' });
        }
        throw err;
      }

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return c.json(
          { error: `QR status poll failed: ${res.status}`, body },
          502,
        );
      }

      const data = (await res.json()) as {
        status?: 'wait' | 'scaned' | 'confirmed' | 'expired';
        bot_token?: string;
        ilink_bot_id?: string;
        baseurl?: string;
        ilink_user_id?: string;
      };

      if (data.status === 'confirmed' && data.bot_token && data.ilink_bot_id) {
        // Auto-save credentials and connect
        const saved = saveImWeChatConfig({
          botToken: data.bot_token,
          ilinkBotId: data.ilink_bot_id.replace(/[^a-zA-Z0-9@._-]/g, ''),
          baseUrl: data.baseurl || undefined,
          enabled: true,
        });

        // Note: ilink_user_id (the QR scanner) is NOT auto-paired here.
        // The scanner needs to send a message to the bot and use /pair <code>
        // to complete pairing, same as QQ/Telegram flow.
        // This ensures proper group registration via buildOnNewChat/registerGroup.

        // Hot-reload: connect WeChat
        if (deps?.reloadIMConfig) {
          try {
            await deps.reloadIMConfig('wechat');
          } catch (err) {
            logger.warn({ err }, 'Failed to hot-reload WeChat after QR login');
          }
        }

        return c.json({
          status: 'confirmed',
          ilinkBotId: saved.ilinkBotId,
        });
      }

      return c.json({
        status: data.status || 'wait',
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'QR status poll failed';
      logger.error({ err }, 'WeChat QR status poll failed');
      return c.json({ error: message }, 500);
    }
  },
);

// Disconnect WeChat and clear token
configRoutes.post('/im/wechat/disconnect', authMiddleware, async (c) => {
  try {
    const current = getImWeChatConfig();
    if (current) {
      saveImWeChatConfig({
        botToken: '',
        ilinkBotId: '',
        enabled: false,
        getUpdatesBuf: current.getUpdatesBuf,
      });
    }

    // Disconnect
    if (deps?.reloadIMConfig) {
      try {
        await deps.reloadIMConfig('wechat');
      } catch (err) {
        logger.warn({ err }, 'Failed to disconnect WeChat');
      }
    }

    return c.json({ success: true });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Failed to disconnect WeChat';
    logger.error({ err }, 'WeChat disconnect failed');
    return c.json({ error: message }, 500);
  }
});

// ─── IM Binding management (bindings panoramic page) ────────────

configRoutes.put('/im/bindings/:imJid', authMiddleware, async (c) => {
  const imJid = decodeURIComponent(c.req.param('imJid'));
  const user = c.get('user') as AuthUser;

  // Validate IM JID
  const channelType = getChannelType(imJid);
  if (!channelType) {
    return c.json({ error: 'Invalid IM JID' }, 400);
  }

  const imGroup = getRegisteredGroup(imJid);
  if (!imGroup) {
    return c.json({ error: 'IM group not found' }, 404);
  }
  if (!canAccessGroup(user, { ...imGroup, jid: imJid })) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const body = await c.req.json().catch(() => ({}));
  const replyPolicy =
    body.reply_policy === 'mirror'
      ? 'mirror'
      : body.reply_policy === 'source_only'
        ? 'source_only'
        : undefined;
  const activationMode =
    body.activation_mode === 'auto' ||
    body.activation_mode === 'always' ||
    body.activation_mode === 'when_mentioned' ||
    body.activation_mode === 'disabled'
      ? body.activation_mode
      : undefined;
  const requireMention =
    typeof body.require_mention === 'boolean'
      ? body.require_mention
      : undefined;
  const requestedSessionId =
    typeof body.session_id === 'string' && body.session_id.trim()
      ? body.session_id.trim()
      : null;
  const targetSessionId = requestedSessionId;

  if (
    body.unbind !== true &&
    !targetSessionId &&
    (activationMode !== undefined ||
      requireMention !== undefined ||
      body.reply_policy !== undefined)
  ) {
    const updated: RegisteredGroup = {
      ...imGroup,
      reply_policy: replyPolicy ?? imGroup.reply_policy,
      activation_mode: activationMode ?? imGroup.activation_mode,
      require_mention:
        requireMention !== undefined
          ? requireMention
          : imGroup.require_mention,
    };
    applyBindingUpdate(imJid, updated);
    applyExplicitSessionBinding(
      imJid,
      getExplicitSessionBinding(imJid, imGroup)?.session_id
        || resolveDefaultBindingSessionId(updated),
      updated,
      {},
    );
    return c.json({ success: true });
  }

  // Unbind mode
  if (body.unbind === true) {
    const updated: RegisteredGroup = {
      ...imGroup,
      reply_policy: replyPolicy ?? imGroup.reply_policy,
      activation_mode: activationMode ?? 'disabled',
      require_mention:
        requireMention !== undefined
          ? requireMention
          : imGroup.require_mention,
    };
    applyBindingUpdate(imJid, updated);
    applyExplicitSessionBinding(
      imJid,
      resolveDefaultBindingSessionId(updated),
      updated,
      {},
    );
    logger.info({ imJid, userId: user.id }, 'IM group unbound (bindings page)');
    return c.json({ success: true });
  }

  if (!targetSessionId) {
    return c.json(
      { error: 'Must provide session_id or unbind' },
      400,
    );
  }

  const target = resolveSessionBindingAccessTarget(targetSessionId);
  if (!target) {
    return c.json({ error: 'Target session not found' }, 404);
  }
  if (!canAccessGroup(user, { ...target.group, jid: target.accessJid })) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  if (isWorkerSessionId(targetSessionId)) {
    const agentId = extractAgentIdFromWorkerSessionId(targetSessionId);
    if (!agentId) {
      return c.json({ error: 'Invalid worker session id' }, 400);
    }
    const agent = getAgent(agentId);
    if (!agent) {
      return c.json({ error: 'Agent not found' }, 404);
    }
    if (agent.kind !== 'conversation') {
      return c.json(
        { error: 'Only conversation agents can bind IM groups' },
        400,
      );
    }

    const force = body.force === true;
    const currentBinding = getExplicitSessionBinding(imJid, imGroup);
    const hasConflict =
      !!currentBinding && currentBinding.session_id !== targetSessionId;
    if (hasConflict && !force) {
      return c.json({ error: 'IM group is already bound elsewhere' }, 409);
    }

    const updated: RegisteredGroup = {
      ...imGroup,
      reply_policy: replyPolicy ?? imGroup.reply_policy,
      activation_mode:
        activationMode
        ?? (imGroup.activation_mode === 'disabled' ? 'auto' : imGroup.activation_mode),
      require_mention:
        requireMention !== undefined
          ? requireMention
          : imGroup.require_mention,
    };
    applyBindingUpdate(imJid, updated);
    applyExplicitSessionBinding(imJid, targetSessionId, updated, {});
    logger.info(
      { imJid, agentId, userId: user.id },
      'IM group bound to agent (bindings page)',
    );
    return c.json({ success: true });
  }

  if (isPrimarySessionFolder(target.group.folder)) {
    return c.json(
      { error: 'Home workspace main conversation uses default IM routing' },
      400,
    );
  }

  const force = body.force === true;
  const currentBinding = getExplicitSessionBinding(imJid, imGroup);
  const hasConflict =
    !!currentBinding && currentBinding.session_id !== targetSessionId;
  if (hasConflict && !force) {
    return c.json({ error: 'IM group is already bound elsewhere' }, 409);
  }

  const updated: RegisteredGroup = {
    ...imGroup,
    reply_policy: replyPolicy ?? imGroup.reply_policy,
    activation_mode:
      activationMode
      ?? (imGroup.activation_mode === 'disabled' ? 'auto' : imGroup.activation_mode),
    require_mention:
      requireMention !== undefined
        ? requireMention
        : imGroup.require_mention,
  };
  applyBindingUpdate(imJid, updated);
  applyExplicitSessionBinding(imJid, targetSessionId, updated, {});
  logger.info(
    { imJid, sessionId: targetSessionId, userId: user.id },
    'IM group bound to session (bindings page)',
  );
  return c.json({ success: true });
});

// ─── Local Claude Code detection ──────────────────────────────────

configRoutes.get(
  '/claude/detect-local',
  authMiddleware,
  systemConfigMiddleware,
  (c) => {
    return c.json(detectLocalClaudeCode());
  },
);

export default configRoutes;
