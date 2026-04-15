// Configuration management routes

import { randomBytes, createHash } from 'node:crypto';
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
  setRegisteredGroup,
  saveSessionBinding,
  getAgent,
} from '../db.js';
import { authMiddleware, systemConfigMiddleware } from '../middleware/auth.js';
import {
  ClaudeConfigSchema,
  ClaudeSecretsSchema,
  ClaudeCustomEnvSchema,
  ClaudeThirdPartyProfileCreateSchema,
  ClaudeThirdPartyProfilePatchSchema,
  ClaudeThirdPartyProfileSecretsSchema,
  CodexModeSchema,
  CodexProfileCreateSchema,
  CodexProfilePatchSchema,
  CodexProfileSecretsSchema,
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
  getClaudeProviderConfig,
  toPublicClaudeProviderConfig,
  saveClaudeProviderConfig,
  saveClaudeOfficialProviderSecrets,
  appendClaudeConfigAudit,
  listClaudeThirdPartyProfiles,
  toPublicClaudeThirdPartyProfile,
  createClaudeThirdPartyProfile,
  updateClaudeThirdPartyProfile,
  updateClaudeThirdPartyProfileSecret,
  activateClaudeThirdPartyProfile,
  deleteClaudeThirdPartyProfile,
  getActiveProfileCustomEnv,
  saveOfficialCustomEnv,
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
  getUserFeishuConfig,
  saveUserFeishuConfig,
  getUserFeishuOAuthTokens,
  saveUserFeishuOAuthTokens,
  clearUserFeishuOAuthTokens,
  getUserTelegramConfig,
  saveUserTelegramConfig,
  getUserQQConfig,
  saveUserQQConfig,
  getUserImGeneralConfig,
  saveUserImGeneralConfig,
  getUserWeChatConfig,
  saveUserWeChatConfig,
  updateAllSessionCredentials,
  detectLocalClaudeCode,
  importLocalClaudeCredentials,
  getUserIMPreferences,
  saveUserIMPreferences,
  getCodexMode,
  setCodexMode,
  getCodexProviderConfig,
  detectLocalCodexCli,
  listCodexProfiles,
  toPublicCodexProfile,
  createCodexProfile,
  updateCodexProfile,
  updateCodexProfileSecret,
  activateCodexProfile,
  deleteCodexProfile,
  appendCodexConfigAudit,
} from '../runtime-config.js';
import type { ClaudeOAuthCredentials } from '../runtime-config.js';
import { queryCodexRateLimits } from '../codex-app-server.js';
import type { AuthUser, RegisteredGroup } from '../types.js';
import { hasPermission } from '../permissions.js';
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

interface ClaudeApplyResultPayload {
  success: boolean;
  stoppedCount: number;
  failedCount: number;
  error?: string;
}

async function applyClaudeConfigToAllGroups(
  actor: string,
  metadata?: Record<string, unknown>,
): Promise<ClaudeApplyResultPayload> {
  if (!deps) {
    throw new Error('Server not initialized');
  }

  const groupJids = Object.keys(deps.getRegisteredGroups());
  const results = await Promise.allSettled(
    groupJids.map((jid) => deps.queue.stopSession(jid)),
  );
  const failedCount = results.filter((r) => r.status === 'rejected').length;
  const stoppedCount = groupJids.length - failedCount;

  appendClaudeConfigAudit(actor, 'apply_to_all_flows', ['queue.stopGroup'], {
    stoppedCount,
    failedCount,
    ...(metadata || {}),
  });

  if (failedCount > 0) {
    return {
      success: false,
      stoppedCount,
      failedCount,
      error: `${failedCount} container(s) failed to stop`,
    };
  }

  return {
    success: true,
    stoppedCount,
    failedCount: 0,
  };
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
    const config = getCodexProviderConfig();
    const cliStatus = detectLocalCodexCli();
    return c.json({
      mode: config.mode,
      hasCliAuth: config.hasCliAuth,
      cliAuthMode: cliStatus.authMode,
      cliAuthAccountId: cliStatus.accountId,
      cliAuthLastRefresh: cliStatus.lastRefresh,
      hasEnvApiKey: config.hasEnvApiKey,
    });
  } catch (err) {
    logger.error({ err }, 'Failed to load Codex config');
    return c.json({ error: 'Failed to load Codex config' }, 500);
  }
});

configRoutes.post(
  '/codex/mode',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    try {
      const body = await c.req.json();
      const parsed = CodexModeSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: parsed.error.message }, 400);
      }
      setCodexMode(parsed.data.mode);
      const user = c.get('user') as AuthUser;
      appendCodexConfigAudit(user.username, 'set_mode', ['mode'], {
        mode: parsed.data.mode,
      });
      return c.json({ success: true, mode: parsed.data.mode });
    } catch (err) {
      logger.error({ err }, 'Failed to set Codex mode');
      return c.json({ error: 'Failed to set Codex mode' }, 500);
    }
  },
);

configRoutes.get(
  '/codex/detect-local',
  authMiddleware,
  systemConfigMiddleware,
  (c) => {
    return c.json(detectLocalCodexCli());
  },
);

configRoutes.get(
  '/codex/profiles',
  authMiddleware,
  systemConfigMiddleware,
  (c) => {
    try {
      const { activeProfileId, profiles } = listCodexProfiles();
      return c.json({
        activeProfileId,
        profiles: profiles.map(toPublicCodexProfile),
      });
    } catch (err) {
      logger.error({ err }, 'Failed to list Codex profiles');
      return c.json({ error: 'Failed to list Codex profiles' }, 500);
    }
  },
);

configRoutes.post(
  '/codex/profiles',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    try {
      const body = await c.req.json();
      const parsed = CodexProfileCreateSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: parsed.error.message }, 400);
      }
      const profile = createCodexProfile(parsed.data);
      const user = c.get('user') as AuthUser;
      appendCodexConfigAudit(user.username, 'create_profile', ['name', 'baseUrl', 'defaultModel'], {
        profileId: profile.id,
        profileName: profile.name,
      });
      return c.json(toPublicCodexProfile(profile));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to create Codex profile';
      return c.json({ error: msg }, 400);
    }
  },
);

configRoutes.patch(
  '/codex/profiles/:id',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    try {
      const id = c.req.param('id');
      const body = await c.req.json();
      const parsed = CodexProfilePatchSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: parsed.error.message }, 400);
      }
      const profile = updateCodexProfile(id, parsed.data);
      const user = c.get('user') as AuthUser;
      appendCodexConfigAudit(user.username, 'update_profile', Object.keys(parsed.data), {
        profileId: profile.id,
        profileName: profile.name,
      });
      return c.json(toPublicCodexProfile(profile));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to update Codex profile';
      return c.json({ error: msg }, 400);
    }
  },
);

configRoutes.put(
  '/codex/profiles/:id/secrets',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    try {
      const id = c.req.param('id');
      const body = await c.req.json();
      const parsed = CodexProfileSecretsSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: parsed.error.message }, 400);
      }
      const profile = updateCodexProfileSecret(id, parsed.data);
      const user = c.get('user') as AuthUser;
      appendCodexConfigAudit(user.username, 'update_profile_secret', ['openaiApiKey'], {
        profileId: profile.id,
      });
      return c.json(toPublicCodexProfile(profile));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to update Codex profile secret';
      return c.json({ error: msg }, 400);
    }
  },
);

configRoutes.post(
  '/codex/profiles/:id/activate',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    try {
      const id = c.req.param('id');
      const { activeProfileId: prevId } = listCodexProfiles();
      const alreadyActive = prevId === id;
      const profile = activateCodexProfile(id);

      if (!alreadyActive) {
        const user = c.get('user') as AuthUser;
        appendCodexConfigAudit(user.username, 'activate_profile', ['activeProfileId'], {
          profileId: profile.id,
          profileName: profile.name,
          previousProfileId: prevId,
        });
      }

      // Also stop all running groups so they pick up new config on restart
      let stoppedCount = 0;
      let failedCount = 0;
      if (!alreadyActive && deps) {
        const groupJids = Object.keys(deps.getRegisteredGroups());
        const results = await Promise.allSettled(
          groupJids.map((jid: string) => deps.queue.stopSession(jid)),
        );
        failedCount = results.filter((r: PromiseSettledResult<unknown>) => r.status === 'rejected').length;
        stoppedCount = groupJids.length - failedCount;
      }

      return c.json({
        success: true,
        alreadyActive,
        activeProfileId: profile.id,
        profile: toPublicCodexProfile(profile),
        stoppedCount,
        failedCount,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to activate Codex profile';
      return c.json({ error: msg }, 400);
    }
  },
);

configRoutes.delete(
  '/codex/profiles/:id',
  authMiddleware,
  systemConfigMiddleware,
  (c) => {
    try {
      const id = c.req.param('id');
      const result = deleteCodexProfile(id);
      const user = c.get('user') as AuthUser;
      appendCodexConfigAudit(user.username, 'delete_profile', ['profiles'], {
        deletedProfileId: result.deletedProfileId,
      });
      return c.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to delete Codex profile';
      return c.json({ error: msg }, 400);
    }
  },
);

configRoutes.post(
  '/codex/apply',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    try {
      if (!deps) throw new Error('Server not initialized');
      const groupJids = Object.keys(deps.getRegisteredGroups());
      const results = await Promise.allSettled(
        groupJids.map((jid: string) => deps.queue.stopSession(jid)),
      );
      const failedCount = results.filter((r: PromiseSettledResult<unknown>) => r.status === 'rejected').length;
      const stoppedCount = groupJids.length - failedCount;
      const user = c.get('user') as AuthUser;
      appendCodexConfigAudit(user.username, 'apply', [], { stoppedCount, failedCount });
      return c.json({ success: failedCount === 0, stoppedCount, failedCount });
    } catch (err) {
      logger.error({ err }, 'Failed to apply Codex config');
      return c.json({ error: 'Failed to apply Codex config' }, 500);
    }
  },
);

configRoutes.get(
  '/codex/rate-limits',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    try {
      const mode = getCodexMode();
      if (mode !== 'cli') {
        return c.json({ available: false, reason: 'not_cli_mode' });
      }
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
    return c.json(toPublicClaudeProviderConfig(getClaudeProviderConfig()));
  } catch (err) {
    logger.error({ err }, 'Failed to load Claude config');
    return c.json({ error: 'Failed to load Claude config' }, 500);
  }
});

configRoutes.get(
  '/claude/custom-env',
  authMiddleware,
  systemConfigMiddleware,
  (c) => {
    try {
      const user = c.get('user') as AuthUser;
      if (!hasPermission(user, 'manage_system_config')) {
        return c.json({ customEnv: {} });
      }
      const customEnv = getActiveProfileCustomEnv();
      return c.json({ customEnv });
    } catch (err) {
      logger.error({ err }, 'Failed to load Claude custom env');
      return c.json({ error: 'Failed to load Claude custom env' }, 500);
    }
  },
);

configRoutes.put(
  '/claude',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const validation = ClaudeConfigSchema.safeParse(body);
    if (!validation.success) {
      return c.json(
        { error: 'Invalid request body', details: validation.error.format() },
        400,
      );
    }

    const actor = (c.get('user') as AuthUser).username;
    const current = getClaudeProviderConfig();

    // When clearing baseUrl, also clear anthropicAuthToken since it requires a baseUrl
    const newBaseUrl = validation.data.anthropicBaseUrl;
    const keepAuthToken = newBaseUrl ? current.anthropicAuthToken : '';

    try {
      const saved = saveClaudeProviderConfig(
        {
          anthropicBaseUrl: newBaseUrl,
          anthropicAuthToken: keepAuthToken,
          anthropicApiKey: current.anthropicApiKey,
          claudeCodeOauthToken: current.claudeCodeOauthToken,
          claudeOAuthCredentials: current.claudeOAuthCredentials,
          happyclawModel:
            validation.data.happyclawModel !== undefined
              ? validation.data.happyclawModel
              : current.happyclawModel,
        },
        {
          mode: newBaseUrl ? 'third_party' : 'official',
        },
      );
      appendClaudeConfigAudit(actor, 'update_base_url', [
        'anthropicBaseUrl',
        ...(validation.data.happyclawModel !== undefined
          ? ['happyclawModel']
          : []),
      ]);
      return c.json(toPublicClaudeProviderConfig(saved));
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Invalid Claude config payload';
      logger.warn({ err }, 'Invalid Claude config payload');
      return c.json({ error: message }, 400);
    }
  },
);

configRoutes.put(
  '/claude/custom-env',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const validation = ClaudeCustomEnvSchema.safeParse(body);
    if (!validation.success) {
      return c.json(
        { error: 'Invalid request body', details: validation.error.format() },
        400,
      );
    }

    try {
      // Determine active profile and write to it
      const profiles = listClaudeThirdPartyProfiles();
      const activeId = profiles.activeProfileId;

      if (activeId === '__official__') {
        const saved = saveOfficialCustomEnv(validation.data.customEnv);
        return c.json({ customEnv: saved });
      }

      const profile = updateClaudeThirdPartyProfile(activeId, {
        customEnv: validation.data.customEnv,
      });
      return c.json({ customEnv: profile.customEnv });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Invalid custom env payload';
      logger.warn({ err }, 'Invalid Claude custom env payload');
      return c.json({ error: message }, 400);
    }
  },
);

configRoutes.put(
  '/claude/secrets',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    const body = await c.req.json().catch(() => ({}));

    const validation = ClaudeSecretsSchema.safeParse(body);
    if (!validation.success) {
      return c.json(
        { error: 'Invalid request body', details: validation.error.format() },
        400,
      );
    }

    const actor = (c.get('user') as AuthUser).username;
    const current = getClaudeProviderConfig();

    const changedFields: string[] = [];
    const nextOfficial = {
      anthropicApiKey: current.anthropicApiKey,
      claudeCodeOauthToken: current.claudeCodeOauthToken,
      claudeOAuthCredentials: current.claudeOAuthCredentials,
    };
    let hasOfficialSecretChanges = false;

    if (typeof validation.data.anthropicApiKey === 'string') {
      nextOfficial.anthropicApiKey = validation.data.anthropicApiKey;
      changedFields.push('anthropicApiKey:set');
      hasOfficialSecretChanges = true;
    } else if (validation.data.clearAnthropicApiKey === true) {
      nextOfficial.anthropicApiKey = '';
      changedFields.push('anthropicApiKey:clear');
      hasOfficialSecretChanges = true;
    }

    if (typeof validation.data.claudeCodeOauthToken === 'string') {
      nextOfficial.claudeCodeOauthToken = validation.data.claudeCodeOauthToken;
      changedFields.push('claudeCodeOauthToken:set');
      hasOfficialSecretChanges = true;
    } else if (validation.data.clearClaudeCodeOauthToken === true) {
      nextOfficial.claudeCodeOauthToken = '';
      changedFields.push('claudeCodeOauthToken:clear');
      hasOfficialSecretChanges = true;
    }

    if (validation.data.claudeOAuthCredentials) {
      nextOfficial.claudeOAuthCredentials =
        validation.data.claudeOAuthCredentials;
      nextOfficial.claudeCodeOauthToken = '';
      changedFields.push('claudeOAuthCredentials:set');
      hasOfficialSecretChanges = true;
    } else if (validation.data.clearClaudeOAuthCredentials === true) {
      nextOfficial.claudeOAuthCredentials = null;
      changedFields.push('claudeOAuthCredentials:clear');
      hasOfficialSecretChanges = true;
    }

    const shouldUpdateThirdPartyToken =
      !hasOfficialSecretChanges &&
      current.anthropicBaseUrl &&
      (typeof validation.data.anthropicAuthToken === 'string' ||
        validation.data.clearAnthropicAuthToken === true);

    if (shouldUpdateThirdPartyToken) {
      changedFields.push(
        typeof validation.data.anthropicAuthToken === 'string'
          ? 'anthropicAuthToken:set'
          : 'anthropicAuthToken:clear',
      );
    }

    // Detect silent discard: user sent anthropicAuthToken/clearAnthropicAuthToken
    // but we're in official mode (no baseUrl), so shouldUpdateThirdPartyToken is false
    if (
      changedFields.length === 0 &&
      !hasOfficialSecretChanges &&
      (typeof validation.data.anthropicAuthToken === 'string' ||
        validation.data.clearAnthropicAuthToken === true)
    ) {
      return c.json(
        {
          error:
            '当前为官方 API 模式，无法更新第三方 Auth Token。请先切换到第三方模式或选择一个第三方 Profile',
        },
        400,
      );
    }

    if (changedFields.length === 0) {
      return c.json({ error: 'No secret changes provided' }, 400);
    }

    try {
      let saved = current;

      if (hasOfficialSecretChanges) {
        saved = saveClaudeOfficialProviderSecrets(nextOfficial, {
          activateOfficial: !current.anthropicBaseUrl,
        });
      }

      if (shouldUpdateThirdPartyToken) {
        saved = saveClaudeProviderConfig(
          {
            anthropicBaseUrl: current.anthropicBaseUrl,
            anthropicAuthToken:
              typeof validation.data.anthropicAuthToken === 'string'
                ? validation.data.anthropicAuthToken
                : '',
            anthropicApiKey: current.anthropicApiKey,
            claudeCodeOauthToken: current.claudeCodeOauthToken,
            claudeOAuthCredentials: current.claudeOAuthCredentials,
            happyclawModel: current.happyclawModel,
          },
          {
            mode: 'third_party',
          },
        );
      }

      // Update .credentials.json in all session directories when credentials change
      if (validation.data.claudeOAuthCredentials) {
        updateAllSessionCredentials(saved);
        deps?.queue?.closeAllActiveForRuntimeRefresh();
      }

      appendClaudeConfigAudit(actor, 'update_secrets', changedFields);
      return c.json(toPublicClaudeProviderConfig(saved));
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Invalid Claude config payload';
      logger.warn({ err }, 'Invalid Claude secret payload');
      return c.json({ error: message }, 400);
    }
  },
);

configRoutes.post(
  '/claude/apply',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    const actor = (c.get('user') as AuthUser).username;
    try {
      const result = await applyClaudeConfigToAllGroups(actor);
      if (!result.success) {
        return c.json(result, 207);
      }
      return c.json(result);
    } catch (err) {
      logger.error({ err }, 'Failed to apply Claude config to all groups');
      return c.json({ error: 'Server not initialized' }, 500);
    }
  },
);

configRoutes.get(
  '/claude/third-party/profiles',
  authMiddleware,
  systemConfigMiddleware,
  (c) => {
    try {
      const state = listClaudeThirdPartyProfiles();
      return c.json({
        activeProfileId: state.activeProfileId,
        profiles: state.profiles.map((profile) =>
          toPublicClaudeThirdPartyProfile(profile),
        ),
      });
    } catch (err) {
      logger.error({ err }, 'Failed to load Claude third-party profiles');
      return c.json(
        { error: 'Failed to load Claude third-party profiles' },
        500,
      );
    }
  },
);

configRoutes.post(
  '/claude/third-party/profiles',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const validation = ClaudeThirdPartyProfileCreateSchema.safeParse(body);
    if (!validation.success) {
      return c.json(
        { error: 'Invalid request body', details: validation.error.format() },
        400,
      );
    }

    const actor = (c.get('user') as AuthUser).username;
    try {
      const profile = createClaudeThirdPartyProfile({
        ...validation.data,
        customEnv: validation.data.customEnv,
      });
      appendClaudeConfigAudit(
        actor,
        'create_third_party_profile',
        [
          'name',
          'anthropicBaseUrl',
          'anthropicAuthToken:set',
          'happyclawModel',
          ...(validation.data.customEnv ? ['customEnv'] : []),
        ],
        {
          profileId: profile.id,
          profileName: profile.name,
        },
      );
      return c.json(toPublicClaudeThirdPartyProfile(profile));
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : 'Invalid Claude third-party profile payload';
      logger.warn({ err }, 'Invalid Claude third-party profile payload');
      return c.json({ error: message }, 400);
    }
  },
);

configRoutes.patch(
  '/claude/third-party/profiles/:id',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const validation = ClaudeThirdPartyProfilePatchSchema.safeParse(body);
    if (!validation.success) {
      return c.json(
        { error: 'Invalid request body', details: validation.error.format() },
        400,
      );
    }

    const actor = (c.get('user') as AuthUser).username;
    const profileId = c.req.param('id');
    const changedFields: string[] = [];
    if (validation.data.name !== undefined) changedFields.push('name');
    if (validation.data.anthropicBaseUrl !== undefined) {
      changedFields.push('anthropicBaseUrl');
    }
    if (validation.data.happyclawModel !== undefined) {
      changedFields.push('happyclawModel');
    }
    if (validation.data.customEnv !== undefined) {
      changedFields.push('customEnv');
    }

    try {
      // Check if updating the active profile
      const currentState = listClaudeThirdPartyProfiles();
      const isActiveProfile = currentState.activeProfileId === profileId;

      const profile = updateClaudeThirdPartyProfile(profileId, validation.data);
      appendClaudeConfigAudit(
        actor,
        'update_third_party_profile',
        changedFields,
        {
          profileId: profile.id,
          profileName: profile.name,
        },
      );

      // If updated the active profile, apply to all running containers
      if (isActiveProfile) {
        const applyResult = await applyClaudeConfigToAllGroups(actor, {
          trigger: 'update_active_profile',
          profileId: profile.id,
          profileName: profile.name,
          changedFields,
        });

        return c.json({
          profile: toPublicClaudeThirdPartyProfile(profile),
          applied: applyResult,
        });
      }

      return c.json(toPublicClaudeThirdPartyProfile(profile));
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : 'Invalid Claude third-party profile payload';
      logger.warn({ err }, 'Invalid Claude third-party profile patch payload');
      return c.json({ error: message }, 400);
    }
  },
);

configRoutes.put(
  '/claude/third-party/profiles/:id/secrets',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const validation = ClaudeThirdPartyProfileSecretsSchema.safeParse(body);
    if (!validation.success) {
      return c.json(
        { error: 'Invalid request body', details: validation.error.format() },
        400,
      );
    }

    const actor = (c.get('user') as AuthUser).username;
    const profileId = c.req.param('id');
    const changedFields = [
      validation.data.clearAnthropicAuthToken
        ? 'anthropicAuthToken:clear'
        : 'anthropicAuthToken:set',
    ];

    try {
      // Check if updating the active profile
      const currentState = listClaudeThirdPartyProfiles();
      const isActiveProfile = currentState.activeProfileId === profileId;

      const profile = updateClaudeThirdPartyProfileSecret(
        profileId,
        validation.data,
      );
      appendClaudeConfigAudit(
        actor,
        'update_third_party_profile_secrets',
        changedFields,
        {
          profileId: profile.id,
          profileName: profile.name,
        },
      );

      // If updated the active profile secrets, apply to all running containers
      if (isActiveProfile) {
        const applyResult = await applyClaudeConfigToAllGroups(actor, {
          trigger: 'update_active_profile_secrets',
          profileId: profile.id,
          profileName: profile.name,
          changedFields,
        });

        return c.json({
          profile: toPublicClaudeThirdPartyProfile(profile),
          applied: applyResult,
        });
      }

      return c.json(toPublicClaudeThirdPartyProfile(profile));
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : 'Invalid Claude third-party profile secret payload';
      logger.warn({ err }, 'Invalid Claude third-party profile secret payload');
      return c.json({ error: message }, 400);
    }
  },
);

configRoutes.post(
  '/claude/third-party/profiles/:id/activate',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    const actor = (c.get('user') as AuthUser).username;
    const profileId = c.req.param('id');

    try {
      const currentState = listClaudeThirdPartyProfiles();
      const previousActiveId = currentState.activeProfileId;
      const currentActive = currentState.profiles.find(
        (profile) => profile.id === currentState.activeProfileId,
      );
      const nextActive = currentState.profiles.find(
        (profile) => profile.id === profileId,
      );
      if (!nextActive) {
        return c.json({ error: '未找到指定第三方配置' }, 404);
      }
      if (previousActiveId === profileId) {
        return c.json({
          success: true,
          alreadyActive: true,
          activeProfileId: profileId,
          profile: toPublicClaudeThirdPartyProfile(nextActive),
          stoppedCount: 0,
          failedCount: 0,
          error: undefined,
        });
      }

      activateClaudeThirdPartyProfile(profileId);
      appendClaudeConfigAudit(
        actor,
        'activate_third_party_profile',
        ['activeProfileId'],
        {
          profileId: nextActive.id,
          profileName: nextActive.name,
          previousProfileId: previousActiveId,
          previousProfileName: currentActive?.name ?? null,
        },
      );

      const applyResult = await applyClaudeConfigToAllGroups(actor, {
        trigger: 'activate_third_party_profile',
        profileId: nextActive.id,
        profileName: nextActive.name,
        previousProfileId: previousActiveId,
      });

      const fresh = listClaudeThirdPartyProfiles();
      const active = fresh.profiles.find(
        (profile) => profile.id === fresh.activeProfileId,
      );
      return c.json(
        {
          success: applyResult.success,
          activeProfileId: fresh.activeProfileId,
          profile: active ? toPublicClaudeThirdPartyProfile(active) : null,
          stoppedCount: applyResult.stoppedCount,
          failedCount: applyResult.failedCount,
          error: applyResult.error,
        },
        applyResult.success ? 200 : 207,
      );
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : 'Failed to activate Claude third-party profile';
      logger.warn({ err }, 'Failed to activate Claude third-party profile');
      if (message.includes('未找到指定第三方配置')) {
        return c.json({ error: message }, 404);
      }
      return c.json({ error: message }, 400);
    }
  },
);

configRoutes.delete(
  '/claude/third-party/profiles/:id',
  authMiddleware,
  systemConfigMiddleware,
  (c) => {
    const actor = (c.get('user') as AuthUser).username;
    const profileId = c.req.param('id');

    try {
      const before = listClaudeThirdPartyProfiles();
      const target = before.profiles.find(
        (profile) => profile.id === profileId,
      );
      if (!target) {
        return c.json({ error: '未找到指定第三方配置' }, 404);
      }
      if (before.profiles.length <= 1) {
        return c.json({ error: '至少需要保留一个第三方配置' }, 400);
      }
      if (before.activeProfileId === profileId) {
        return c.json(
          { error: '当前激活配置不可删除，请先切换到其他配置' },
          400,
        );
      }

      const result = deleteClaudeThirdPartyProfile(profileId);
      appendClaudeConfigAudit(
        actor,
        'delete_third_party_profile',
        ['profile'],
        {
          profileId: result.deletedProfileId,
          profileName: target.name,
          activeProfileId: result.activeProfileId,
        },
      );
      return c.json(result);
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : 'Failed to delete Claude third-party profile';
      logger.warn({ err }, 'Failed to delete Claude third-party profile');
      return c.json({ error: message }, 400);
    }
  },
);

// ─── Claude OAuth (PKCE) ─────────────────────────────────────────

const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const OAUTH_REDIRECT_URI = 'https://console.anthropic.com/oauth/code/callback';
const OAUTH_SCOPES = 'org:create_api_key user:profile user:inference';
const OAUTH_AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
const OAUTH_TOKEN_URL = 'https://api.anthropic.com/v1/oauth/token';
const OAUTH_FLOW_TTL = 10 * 60 * 1000; // 10 minutes

interface OAuthFlow {
  codeVerifier: string;
  expiresAt: number;
}
const oauthFlows = new Map<string, OAuthFlow>();

// Periodic cleanup of expired flows
setInterval(() => {
  const now = Date.now();
  for (const [key, flow] of oauthFlows) {
    if (flow.expiresAt < now) oauthFlows.delete(key);
  }
}, 60_000);

configRoutes.post(
  '/claude/oauth/start',
  authMiddleware,
  systemConfigMiddleware,
  (c) => {
    const state = randomBytes(32).toString('hex');
    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');

    oauthFlows.set(state, {
      codeVerifier,
      expiresAt: Date.now() + OAUTH_FLOW_TTL,
    });

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: OAUTH_CLIENT_ID,
      redirect_uri: OAUTH_REDIRECT_URI,
      scope: OAUTH_SCOPES,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });

    return c.json({
      authorizeUrl: `${OAUTH_AUTHORIZE_URL}?${params.toString()}`,
      state,
    });
  },
);

configRoutes.post(
  '/claude/oauth/callback',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { state, code } = body as { state?: string; code?: string };

    if (!state || !code) {
      return c.json({ error: 'Missing state or code' }, 400);
    }

    // Clean up code: strip URL fragments and query params that users may accidentally copy
    const cleanedCode = code.trim().split('#')[0]?.split('&')[0] ?? code.trim();

    const flow = oauthFlows.get(state);
    if (!flow) {
      return c.json({ error: 'Invalid or expired OAuth state' }, 400);
    }
    if (flow.expiresAt < Date.now()) {
      oauthFlows.delete(state);
      return c.json({ error: 'OAuth flow expired' }, 400);
    }
    oauthFlows.delete(state);

    try {
      const tokenResp = await fetch(OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          Accept: 'application/json, text/plain, */*',
          Referer: 'https://claude.ai/',
          Origin: 'https://claude.ai',
        },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: OAUTH_CLIENT_ID,
          code: cleanedCode,
          redirect_uri: OAUTH_REDIRECT_URI,
          code_verifier: flow.codeVerifier,
          state,
          expires_in: 31536000, // 1 year — matches `claude setup-token` behavior
        }),
      });

      if (!tokenResp.ok) {
        const errText = await tokenResp.text().catch(() => '');
        logger.warn(
          { status: tokenResp.status, body: errText },
          'OAuth token exchange failed',
        );
        return c.json(
          { error: `Token exchange failed: ${tokenResp.status}` },
          400,
        );
      }

      const tokenData = (await tokenResp.json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        scope?: string;
        [key: string]: unknown;
      };

      if (!tokenData.access_token) {
        return c.json({ error: 'No access_token in response' }, 400);
      }

      const actor = (c.get('user') as AuthUser).username;

      // Build full OAuth credentials when refresh_token is available
      let oauthCredentials: ClaudeOAuthCredentials | null = null;
      if (tokenData.refresh_token) {
        // expiresAt 计算与 SDK 保持一致：Date.now() + expires_in * 1000
        const expiresAt = tokenData.expires_in
          ? Date.now() + tokenData.expires_in * 1000
          : Date.now() + 8 * 60 * 60 * 1000; // default 8h
        oauthCredentials = {
          accessToken: tokenData.access_token,
          refreshToken: tokenData.refresh_token,
          expiresAt,
          scopes: tokenData.scope ? tokenData.scope.split(' ') : [],
        };
      }

      const saved = saveClaudeOfficialProviderSecrets(
        {
          anthropicApiKey: '',
          claudeCodeOauthToken: oauthCredentials ? '' : tokenData.access_token,
          claudeOAuthCredentials: oauthCredentials,
        },
        {
          activateOfficial: true,
        },
      );

      // Write .credentials.json to all session directories
      if (oauthCredentials) {
        updateAllSessionCredentials(saved);
        deps?.queue?.closeAllActiveForRuntimeRefresh();
      }

      appendClaudeConfigAudit(actor, 'oauth_login', [
        oauthCredentials
          ? 'claudeOAuthCredentials:set'
          : 'claudeCodeOauthToken:set',
        'anthropicApiKey:clear',
        'providerMode:official',
      ]);

      return c.json(toPublicClaudeProviderConfig(saved));
    } catch (err) {
      logger.error({ err }, 'OAuth token exchange error');
      const message =
        err instanceof Error ? err.message : 'OAuth token exchange failed';
      return c.json({ error: message }, 500);
    }
  },
);

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
    && binding.session_id === resolveDefaultBindingSessionId(imGroup);
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

  if (!sessionId || sessionId === resolveDefaultBindingSessionId(imGroup)) {
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
    'GET /api/config/user-im/feishu',
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
    'GET /api/config/user-im/telegram',
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

// ─── Per-user IM connection status ──────────────────────────────────

configRoutes.get('/user-im/status', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  return c.json({
    feishu: deps?.isUserFeishuConnected?.(user.id) ?? false,
    telegram: deps?.isUserTelegramConnected?.(user.id) ?? false,
    qq: deps?.isUserQQConnected?.(user.id) ?? false,
    wechat: deps?.isUserWeChatConnected?.(user.id) ?? false,
  });
});

// ─── Per-user IM config (all logged-in users) ─────────────────────

configRoutes.get('/user-im/feishu', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  try {
    const config = getUserFeishuConfig(user.id);
    const connected = deps?.isUserFeishuConnected?.(user.id) ?? false;
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
    logger.error({ err }, 'Failed to load user Feishu config');
    return c.json({ error: 'Failed to load user Feishu config' }, 500);
  }
});

configRoutes.put('/user-im/feishu', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const body = await c.req.json().catch(() => ({}));
  const validation = FeishuConfigSchema.safeParse(body);
  if (!validation.success) {
    return c.json(
      { error: 'Invalid request body', details: validation.error.format() },
      400,
    );
  }

  const current = getUserFeishuConfig(user.id);
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
    const saved = saveUserFeishuConfig(user.id, {
      appId: next.appId,
      appSecret: next.appSecret,
      enabled: next.enabled,
      replyThreadingMode: next.replyThreadingMode,
      streamingCard: next.streamingCard,
      imCommentary: next.imCommentary,
    });

    // Hot-reload: reconnect user's Feishu channel
    if (deps?.reloadUserIMConfig) {
      try {
        await deps.reloadUserIMConfig(user.id, 'feishu');
      } catch (err) {
        logger.warn(
          { err, userId: user.id },
          'Failed to hot-reload user Feishu connection',
        );
      }
    }

    const connected = deps?.isUserFeishuConnected?.(user.id) ?? false;
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
    logger.warn({ err }, 'Invalid user Feishu config payload');
    return c.json({ error: message }, 400);
  }
});

// ─── Feishu OAuth Document Access ────────────────────────────────────

/**
 * GET /api/config/user-im/feishu/oauth-status
 * Returns the current OAuth authorization status for the user.
 */
configRoutes.get(
  '/user-im/feishu/oauth-status',
  authMiddleware,
  (c) => {
    const user = c.get('user') as AuthUser;
    const tokens = getUserFeishuOAuthTokens(user.id);
    const config = getUserFeishuConfig(user.id);

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
 * GET /api/config/user-im/feishu/oauth-url
 * Generates a Feishu OAuth authorization URL for the user.
 * Requires existing Feishu app credentials (appId + appSecret).
 */
configRoutes.get(
  '/user-im/feishu/oauth-url',
  authMiddleware,
  (c) => {
    const user = c.get('user') as AuthUser;
    const config = getUserFeishuConfig(user.id);

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

    const state = createOAuthState(user.id);
    const url = buildOAuthUrl(config.appId, redirectUri, state);

    return c.json({ url, state, redirectUri });
  },
);

/**
 * POST /api/config/user-im/feishu/oauth-callback
 * Exchanges the authorization code for access + refresh tokens.
 * Body: { code: string, state: string, redirectUri: string }
 */
configRoutes.post(
  '/user-im/feishu/oauth-callback',
  authMiddleware,
  async (c) => {
    const user = c.get('user') as AuthUser;
    const body = await c.req.json().catch(() => ({}));

    const { code, state, redirectUri } = body as {
      code?: string;
      state?: string;
      redirectUri?: string;
    };

    if (!code || !state || !redirectUri) {
      return c.json({ error: 'Missing required fields: code, state, redirectUri' }, 400);
    }

    // Validate state — peek first, consume only after userId match
    const stateUserId = consumeOAuthState(state, user.id);
    if (!stateUserId) {
      return c.json({ error: '授权状态已过期或不匹配，请重新发起授权' }, 400);
    }

    // Get app credentials
    const config = getUserFeishuConfig(user.id);
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

      saveUserFeishuOAuthTokens(user.id, {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        scopes: tokens.scopes,
      });

      logger.info(
        { userId: user.id, scopes: tokens.scopes },
        'Feishu OAuth authorized successfully',
      );

      return c.json({
        success: true,
        scopes: tokens.scopes,
        expiresIn: Math.floor((tokens.expiresAt - Date.now()) / 1000),
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'OAuth 授权失败';
      logger.error({ err, userId: user.id }, 'Feishu OAuth callback failed');
      return c.json({ error: message }, 500);
    }
  },
);

/**
 * DELETE /api/config/user-im/feishu/oauth-revoke
 * Revokes the user's OAuth authorization (clears stored tokens).
 */
configRoutes.delete(
  '/user-im/feishu/oauth-revoke',
  authMiddleware,
  (c) => {
    const user = c.get('user') as AuthUser;

    clearUserFeishuOAuthTokens(user.id);
    logger.info({ userId: user.id }, 'Feishu OAuth authorization revoked');

    return c.json({ success: true });
  },
);

// ─── Telegram per-user config ─────────────────────────────────────

configRoutes.get('/user-im/telegram', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  try {
    const config = getUserTelegramConfig(user.id);
    const connected = deps?.isUserTelegramConnected?.(user.id) ?? false;
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
    logger.error({ err }, 'Failed to load user Telegram config');
    return c.json({ error: 'Failed to load user Telegram config' }, 500);
  }
});

configRoutes.put('/user-im/telegram', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const body = await c.req.json().catch(() => ({}));
  const validation = TelegramConfigSchema.safeParse(body);
  if (!validation.success) {
    return c.json(
      { error: 'Invalid request body', details: validation.error.format() },
      400,
    );
  }

  const current = getUserTelegramConfig(user.id);
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
    const saved = saveUserTelegramConfig(user.id, {
      botToken: next.botToken,
      proxyUrl: next.proxyUrl || undefined,
      enabled: next.enabled,
    });

    // Hot-reload: reconnect user's Telegram channel
    if (deps?.reloadUserIMConfig) {
      try {
        await deps.reloadUserIMConfig(user.id, 'telegram');
      } catch (err) {
        logger.warn(
          { err, userId: user.id },
          'Failed to hot-reload user Telegram connection',
        );
      }
    }

    const connected = deps?.isUserTelegramConnected?.(user.id) ?? false;
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
    logger.warn({ err }, 'Invalid user Telegram config payload');
    return c.json({ error: message }, 400);
  }
});

configRoutes.post('/user-im/telegram/test', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const config = getUserTelegramConfig(user.id);
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
    logger.warn({ err }, 'Failed to test user Telegram connection');
    return c.json({ error: message }, 400);
  } finally {
    destroyTelegramApiAgent(agent);
  }
});

configRoutes.post(
  '/user-im/telegram/pairing-code',
  authMiddleware,
  async (c) => {
    const user = c.get('user') as AuthUser;
    const config = getUserTelegramConfig(user.id);
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
configRoutes.get('/user-im/telegram/paired-chats', authMiddleware, (c) => {
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
  '/user-im/telegram/paired-chats/:jid',
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

// ─── QQ User IM Config ──────────────────────────────────────────

function maskQQAppSecret(secret: string): string | null {
  if (!secret) return null;
  if (secret.length <= 8) return '***';
  return secret.slice(0, 4) + '***' + secret.slice(-4);
}

configRoutes.get('/user-im/qq', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  try {
    const config = getUserQQConfig(user.id);
    const connected = deps?.isUserQQConnected?.(user.id) ?? false;
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
    logger.error({ err }, 'Failed to load user QQ config');
    return c.json({ error: 'Failed to load user QQ config' }, 500);
  }
});

configRoutes.put('/user-im/qq', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const body = await c.req.json().catch(() => ({}));
  const validation = QQConfigSchema.safeParse(body);
  if (!validation.success) {
    return c.json(
      { error: 'Invalid request body', details: validation.error.format() },
      400,
    );
  }

  const current = getUserQQConfig(user.id);
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
    const saved = saveUserQQConfig(user.id, {
      appId: next.appId,
      appSecret: next.appSecret,
      enabled: next.enabled,
    });

    // Hot-reload: reconnect user's QQ channel
    if (deps?.reloadUserIMConfig) {
      try {
        await deps.reloadUserIMConfig(user.id, 'qq');
      } catch (err) {
        logger.warn(
          { err, userId: user.id },
          'Failed to hot-reload user QQ connection',
        );
      }
    }

    const connected = deps?.isUserQQConnected?.(user.id) ?? false;
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
    logger.warn({ err }, 'Invalid user QQ config payload');
    return c.json({ error: message }, 400);
  }
});

configRoutes.post('/user-im/qq/test', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const config = getUserQQConfig(user.id);
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
    logger.warn({ err }, 'Failed to test user QQ connection');
    return c.json({ error: message }, 400);
  }
});

configRoutes.post('/user-im/qq/pairing-code', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const config = getUserQQConfig(user.id);
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
configRoutes.get('/user-im/qq/paired-chats', authMiddleware, (c) => {
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
configRoutes.delete('/user-im/qq/paired-chats/:jid', authMiddleware, (c) => {
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

// ─── User IM Preferences ────────────────────────────────────────

configRoutes.get('/user-im/preferences', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const prefs = getUserIMPreferences(user.id);
  return c.json(prefs);
});

configRoutes.put('/user-im/preferences', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const body = UserIMPreferencesSchema.parse(await c.req.json());
  const saved = saveUserIMPreferences(user.id, {
    ...body,
    autoCreateExecutionMode: body.autoCreateExecutionMode,
  });
  return c.json(saved);
});

// ─── Per-user IM general settings ────────────────────────────────

configRoutes.get('/user-im/general', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const config = getUserImGeneralConfig(user.id);
  return c.json(config);
});

configRoutes.put('/user-im/general', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const body = await c.req.json();
  const parsed = ImGeneralConfigSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: 'Invalid config', details: parsed.error.format() },
      400,
    );
  }
  const saved = saveUserImGeneralConfig(user.id, parsed.data);
  return c.json(saved);
});


// ─── Per-user WeChat IM config ──────────────────────────────────

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

configRoutes.get('/user-im/wechat', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  try {
    const config = getUserWeChatConfig(user.id);
    const connected = deps?.isUserWeChatConnected?.(user.id) ?? false;
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
    logger.error({ err }, 'Failed to load user WeChat config');
    return c.json({ error: 'Failed to load user WeChat config' }, 500);
  }
});

configRoutes.put('/user-im/wechat', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const body = await c.req.json().catch(() => ({}));
  const validation = WeChatConfigSchema.safeParse(body);
  if (!validation.success) {
    return c.json(
      { error: 'Invalid request body', details: validation.error.format() },
      400,
    );
  }

  const current = getUserWeChatConfig(user.id);
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
    const saved = saveUserWeChatConfig(user.id, next);

    // Hot-reload: reconnect user's WeChat channel
    if (deps?.reloadUserIMConfig) {
      try {
        await deps.reloadUserIMConfig(user.id, 'wechat');
      } catch (err) {
        logger.warn(
          { err, userId: user.id },
          'Failed to hot-reload user WeChat connection',
        );
      }
    }

    const connected = deps?.isUserWeChatConnected?.(user.id) ?? false;
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
    logger.warn({ err }, 'Invalid user WeChat config payload');
    return c.json({ error: message }, 400);
  }
});

// Generate QR code for WeChat iLink login
configRoutes.post('/user-im/wechat/qrcode', authMiddleware, async (c) => {
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
  '/user-im/wechat/qrcode-status',
  authMiddleware,
  async (c) => {
    const user = c.get('user') as AuthUser;
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
        const saved = saveUserWeChatConfig(user.id, {
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
        if (deps?.reloadUserIMConfig) {
          try {
            await deps.reloadUserIMConfig(user.id, 'wechat');
          } catch (err) {
            logger.warn(
              { err, userId: user.id },
              'Failed to hot-reload WeChat after QR login',
            );
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
configRoutes.post('/user-im/wechat/disconnect', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  try {
    const current = getUserWeChatConfig(user.id);
    if (current) {
      saveUserWeChatConfig(user.id, {
        botToken: '',
        ilinkBotId: '',
        enabled: false,
        getUpdatesBuf: current.getUpdatesBuf,
      });
    }

    // Disconnect
    if (deps?.reloadUserIMConfig) {
      try {
        await deps.reloadUserIMConfig(user.id, 'wechat');
      } catch (err) {
        logger.warn(
          { err, userId: user.id },
          'Failed to disconnect WeChat',
        );
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

configRoutes.put('/user-im/bindings/:imJid', authMiddleware, async (c) => {
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
  const requestedAgentId =
    typeof body.target_agent_id === 'string' && body.target_agent_id.trim()
      ? body.target_agent_id.trim()
      : null;
  const requestedMainJid =
    typeof body.target_main_jid === 'string' && body.target_main_jid.trim()
      ? body.target_main_jid.trim()
      : null;
  const legacySessionId =
    requestedAgentId
      ? `worker:${requestedAgentId}`
      : (() => {
          if (!requestedMainJid) return null;
          const targetGroup = getRegisteredGroup(requestedMainJid);
          return targetGroup ? `main:${targetGroup.folder}` : null;
        })();

  if (
    requestedSessionId &&
    legacySessionId &&
    requestedSessionId !== legacySessionId
  ) {
    return c.json(
      {
        error:
          'session_id does not match legacy target_main_jid/target_agent_id',
      },
      400,
    );
  }
  const targetSessionId = requestedSessionId || legacySessionId;

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
      target_main_jid: undefined,
      target_agent_id: undefined,
      reply_policy: replyPolicy ?? imGroup.reply_policy,
      activation_mode: activationMode ?? 'disabled',
      require_mention:
        requireMention !== undefined
          ? requireMention
          : imGroup.require_mention,
    };
    applyBindingUpdate(imJid, updated);
    applyExplicitSessionBinding(imJid, null, updated, {});
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

  if (targetSessionId.startsWith('worker:')) {
    const agentId = targetSessionId.slice('worker:'.length);
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
      target_agent_id: undefined,
      target_main_jid: undefined,
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

  if (target.group.is_home) {
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
    target_main_jid: undefined,
    target_agent_id: undefined,
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

configRoutes.post(
  '/claude/import-local',
  authMiddleware,
  systemConfigMiddleware,
  (c) => {
    const creds = importLocalClaudeCredentials();
    if (!creds) {
      return c.json({ error: '未检测到本机 Claude Code 登录凭据' }, 404);
    }

    const actor = (c.get('user') as AuthUser).username;

    try {
      const saved = saveClaudeOfficialProviderSecrets(
        {
          anthropicApiKey: '',
          claudeCodeOauthToken: '',
          claudeOAuthCredentials: creds,
        },
        {
          activateOfficial: true,
        },
      );

      updateAllSessionCredentials(saved);
      deps?.queue?.closeAllActiveForRuntimeRefresh();
      appendClaudeConfigAudit(actor, 'import_local_cc', [
        'claudeOAuthCredentials:import_local',
      ]);

      return c.json(toPublicClaudeProviderConfig(saved));
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : 'Failed to import local credentials';
      logger.warn({ err }, 'Failed to import local Claude Code credentials');
      return c.json({ error: message }, 500);
    }
  },
);

export default configRoutes;
