import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, DATA_DIR } from './config.js';
import { logger } from './logger.js';

const MAX_FIELD_LENGTH = 2000;
const CLAUDE_CONFIG_DIR = path.join(DATA_DIR, 'config');
const CLAUDE_CONFIG_KEY_FILE = path.join(
  CLAUDE_CONFIG_DIR,
  'claude-provider.key',
);
const FEISHU_CONFIG_FILE = path.join(CLAUDE_CONFIG_DIR, 'feishu-provider.json');
const TELEGRAM_CONFIG_FILE = path.join(
  CLAUDE_CONFIG_DIR,
  'telegram-provider.json',
);
export interface ClaudeOAuthCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // Unix timestamp (ms)
  scopes: string[];
}

export interface ClaudeProviderConfig {
  anthropicBaseUrl: string;
  anthropicAuthToken: string;
  anthropicApiKey: string;
  claudeCodeOauthToken: string;
  claudeOAuthCredentials: ClaudeOAuthCredentials | null;
  happyclawModel: string;
  updatedAt: string | null;
}

export interface FeishuProviderConfig {
  appId: string;
  appSecret: string;
  enabled?: boolean;
  updatedAt: string | null;
}

export type FeishuConfigSource = 'runtime' | 'env' | 'none';

export interface FeishuProviderPublicConfig {
  appId: string;
  hasAppSecret: boolean;
  appSecretMasked: string | null;
  enabled: boolean;
  updatedAt: string | null;
  source: FeishuConfigSource;
}

export interface TelegramProviderConfig {
  botToken: string;
  proxyUrl?: string;
  enabled?: boolean;
  updatedAt: string | null;
}

export type TelegramConfigSource = 'runtime' | 'env' | 'none';

export interface TelegramProviderPublicConfig {
  hasBotToken: boolean;
  botTokenMasked: string | null;
  proxyUrl: string;
  enabled: boolean;
  updatedAt: string | null;
  source: TelegramConfigSource;
}

interface EncryptedSecrets {
  iv: string;
  tag: string;
  data: string;
}

interface FeishuSecretPayload {
  appSecret: string;
}

/** OAuth token payload stored encrypted alongside IM credentials. */
interface FeishuOAuthSecretPayload {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string;
}

interface TelegramSecretPayload {
  botToken: string;
}

interface StoredFeishuProviderConfigV1 {
  version: 1;
  appId: string;
  enabled?: boolean;
  updatedAt: string;
  secret: EncryptedSecrets;
  /** Encrypted OAuth tokens (separate from IM secret). */
  oauthSecret?: EncryptedSecrets;
  oauthAuthorizedAt?: string;
  /** Reply threading mode: 'auto' (trigger-based) or 'agent' (agent-specified). */
  replyThreadingMode?: 'auto' | 'agent';
  /** Show real-time execution progress card in Feishu. */
  streamingCard?: boolean;
  /** Send tool-call IM commentary during long-running tasks. */
  imCommentary?: boolean;
}

interface StoredTelegramProviderConfigV1 {
  version: 1;
  proxyUrl?: string;
  enabled?: boolean;
  updatedAt: string;
  secret: EncryptedSecrets;
}

function normalizeSecret(input: unknown, fieldName: string): string {
  if (typeof input !== 'string') {
    throw new Error(`Invalid field: ${fieldName}`);
  }
  // Strip ALL whitespace and non-ASCII characters — API keys/tokens are always ASCII;
  // users often paste with accidental spaces, line breaks, or smart quotes (e.g. U+2019).
  // eslint-disable-next-line no-control-regex
  const value = input.replace(/\s+/g, '').replace(/[^\x00-\x7F]/g, '');
  if (value.length > MAX_FIELD_LENGTH) {
    throw new Error(`Field too long: ${fieldName}`);
  }
  return value;
}

function normalizeFeishuAppId(input: unknown): string {
  if (typeof input !== 'string') {
    throw new Error('Invalid field: appId');
  }
  const value = input.trim();
  if (!value) return '';
  if (value.length > MAX_FIELD_LENGTH) {
    throw new Error('Field too long: appId');
  }
  return value;
}

function normalizeTelegramProxyUrl(input: unknown): string {
  if (input === undefined || input === null) return '';
  if (typeof input !== 'string') {
    throw new Error('Invalid field: proxyUrl');
  }
  const value = input.trim();
  if (!value) return '';
  if (value.length > MAX_FIELD_LENGTH) {
    throw new Error('Field too long: proxyUrl');
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Invalid field: proxyUrl');
  }
  const protocol = parsed.protocol.toLowerCase();
  if (!['http:', 'https:', 'socks:', 'socks5:'].includes(protocol)) {
    throw new Error('Invalid field: proxyUrl');
  }
  return value;
}

function getOrCreateEncryptionKey(): Buffer {
  fs.mkdirSync(CLAUDE_CONFIG_DIR, { recursive: true });

  if (fs.existsSync(CLAUDE_CONFIG_KEY_FILE)) {
    const raw = fs.readFileSync(CLAUDE_CONFIG_KEY_FILE, 'utf-8').trim();
    const key = Buffer.from(raw, 'hex');
    if (key.length === 32) return key;
    throw new Error('Invalid encryption key file');
  }

  const key = crypto.randomBytes(32);
  fs.writeFileSync(CLAUDE_CONFIG_KEY_FILE, key.toString('hex') + '\n', {
    encoding: 'utf-8',
    mode: 0o600,
  });
  return key;
}

function encryptFeishuSecret(payload: FeishuSecretPayload): EncryptedSecrets {
  const key = getOrCreateEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const plaintext = Buffer.from(JSON.stringify(payload), 'utf-8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: encrypted.toString('base64'),
  };
}

function decryptFeishuSecret(secrets: EncryptedSecrets): FeishuSecretPayload {
  const key = getOrCreateEncryptionKey();
  const iv = Buffer.from(secrets.iv, 'base64');
  const tag = Buffer.from(secrets.tag, 'base64');
  const encrypted = Buffer.from(secrets.data, 'base64');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]).toString('utf-8');
  const parsed = JSON.parse(decrypted) as Record<string, unknown>;
  return {
    appSecret: normalizeSecret(parsed.appSecret ?? '', 'appSecret'),
  };
}

function readStoredFeishuConfig(): FeishuProviderConfig | null {
  if (!fs.existsSync(FEISHU_CONFIG_FILE)) return null;
  const content = fs.readFileSync(FEISHU_CONFIG_FILE, 'utf-8');
  const parsed = JSON.parse(content) as Record<string, unknown>;
  if (parsed.version !== 1) return null;

  const stored = parsed as unknown as StoredFeishuProviderConfigV1;
  const secret = decryptFeishuSecret(stored.secret);
  return {
    appId: normalizeFeishuAppId(stored.appId ?? ''),
    appSecret: secret.appSecret,
    enabled: stored.enabled,
    updatedAt: stored.updatedAt || null,
  };
}

function defaultsFeishuFromEnv(): FeishuProviderConfig {
  const raw = {
    appId: process.env.FEISHU_APP_ID || '',
    appSecret: process.env.FEISHU_APP_SECRET || '',
  };
  return {
    appId: raw.appId.trim(),
    appSecret: raw.appSecret.trim(),
    updatedAt: null,
  };
}

export function getFeishuProviderConfigWithSource(): {
  config: FeishuProviderConfig;
  source: FeishuConfigSource;
} {
  try {
    const stored = readStoredFeishuConfig();
    if (stored) return { config: stored, source: 'runtime' };
  } catch (err) {
    logger.warn(
      { err },
      'Failed to read runtime Feishu config, falling back to env',
    );
  }

  const fromEnv = defaultsFeishuFromEnv();
  if (fromEnv.appId || fromEnv.appSecret) {
    return { config: fromEnv, source: 'env' };
  }

  return { config: fromEnv, source: 'none' };
}

export function getFeishuProviderConfig(): FeishuProviderConfig {
  return getFeishuProviderConfigWithSource().config;
}

export function saveFeishuProviderConfig(
  next: Omit<FeishuProviderConfig, 'updatedAt'>,
): FeishuProviderConfig {
  const normalized: FeishuProviderConfig = {
    appId: normalizeFeishuAppId(next.appId),
    appSecret: normalizeSecret(next.appSecret, 'appSecret'),
    enabled: next.enabled,
    updatedAt: new Date().toISOString(),
  };

  const payload: StoredFeishuProviderConfigV1 = {
    version: 1,
    appId: normalized.appId,
    enabled: normalized.enabled,
    updatedAt: normalized.updatedAt || new Date().toISOString(),
    secret: encryptFeishuSecret({ appSecret: normalized.appSecret }),
  };

  fs.mkdirSync(CLAUDE_CONFIG_DIR, { recursive: true });
  const tmp = `${FEISHU_CONFIG_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, FEISHU_CONFIG_FILE);
  return normalized;
}

export function toPublicFeishuProviderConfig(
  config: FeishuProviderConfig,
  source: FeishuConfigSource,
): FeishuProviderPublicConfig {
  return {
    appId: config.appId,
    hasAppSecret: !!config.appSecret,
    appSecretMasked: maskSecret(config.appSecret),
    enabled: config.enabled !== false,
    updatedAt: config.updatedAt,
    source,
  };
}

// ========== Telegram Provider Config ==========

function encryptTelegramSecret(
  payload: TelegramSecretPayload,
): EncryptedSecrets {
  const key = getOrCreateEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const plaintext = Buffer.from(JSON.stringify(payload), 'utf-8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: encrypted.toString('base64'),
  };
}

function decryptTelegramSecret(
  secrets: EncryptedSecrets,
): TelegramSecretPayload {
  const key = getOrCreateEncryptionKey();
  const iv = Buffer.from(secrets.iv, 'base64');
  const tag = Buffer.from(secrets.tag, 'base64');
  const encrypted = Buffer.from(secrets.data, 'base64');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]).toString('utf-8');
  const parsed = JSON.parse(decrypted) as Record<string, unknown>;
  return {
    botToken: normalizeSecret(parsed.botToken ?? '', 'botToken'),
  };
}

function readStoredTelegramConfig(): TelegramProviderConfig | null {
  if (!fs.existsSync(TELEGRAM_CONFIG_FILE)) return null;
  const content = fs.readFileSync(TELEGRAM_CONFIG_FILE, 'utf-8');
  const parsed = JSON.parse(content) as Record<string, unknown>;
  if (parsed.version !== 1) return null;

  const stored = parsed as unknown as StoredTelegramProviderConfigV1;
  const secret = decryptTelegramSecret(stored.secret);
  return {
    botToken: secret.botToken,
    proxyUrl: normalizeTelegramProxyUrl(stored.proxyUrl ?? ''),
    enabled: stored.enabled,
    updatedAt: stored.updatedAt || null,
  };
}

function defaultsTelegramFromEnv(): TelegramProviderConfig {
  const raw = {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    proxyUrl: process.env.TELEGRAM_PROXY_URL || '',
  };
  return {
    botToken: raw.botToken.trim(),
    proxyUrl: normalizeTelegramProxyUrl(raw.proxyUrl),
    updatedAt: null,
  };
}

export function getTelegramProviderConfigWithSource(): {
  config: TelegramProviderConfig;
  source: TelegramConfigSource;
} {
  try {
    const stored = readStoredTelegramConfig();
    if (stored) return { config: stored, source: 'runtime' };
  } catch (err) {
    logger.warn(
      { err },
      'Failed to read runtime Telegram config, falling back to env',
    );
  }

  const fromEnv = defaultsTelegramFromEnv();
  if (fromEnv.botToken) {
    return { config: fromEnv, source: 'env' };
  }

  return { config: fromEnv, source: 'none' };
}

export function getTelegramProviderConfig(): TelegramProviderConfig {
  return getTelegramProviderConfigWithSource().config;
}

export function saveTelegramProviderConfig(
  next: Omit<TelegramProviderConfig, 'updatedAt'>,
): TelegramProviderConfig {
  const normalized: TelegramProviderConfig = {
    botToken: normalizeSecret(next.botToken, 'botToken'),
    proxyUrl: normalizeTelegramProxyUrl(next.proxyUrl),
    enabled: next.enabled,
    updatedAt: new Date().toISOString(),
  };

  const payload: StoredTelegramProviderConfigV1 = {
    version: 1,
    proxyUrl: normalized.proxyUrl,
    enabled: normalized.enabled,
    updatedAt: normalized.updatedAt || new Date().toISOString(),
    secret: encryptTelegramSecret({ botToken: normalized.botToken }),
  };

  fs.mkdirSync(CLAUDE_CONFIG_DIR, { recursive: true });
  const tmp = `${TELEGRAM_CONFIG_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, TELEGRAM_CONFIG_FILE);
  return normalized;
}

export function toPublicTelegramProviderConfig(
  config: TelegramProviderConfig,
  source: TelegramConfigSource,
): TelegramProviderPublicConfig {
  return {
    hasBotToken: !!config.botToken,
    botTokenMasked: maskSecret(config.botToken),
    proxyUrl: config.proxyUrl ?? '',
    enabled: config.enabled !== false,
    updatedAt: config.updatedAt,
    source,
  };
}

function maskSecret(value: string): string | null {
  if (!value) return null;
  if (value.length <= 8)
    return `${'*'.repeat(Math.max(value.length - 2, 1))}${value.slice(-2)}`;
  return `${value.slice(0, 3)}${'*'.repeat(Math.max(value.length - 7, 4))}${value.slice(-4)}`;
}

// ─── OAuth credentials file management ────────────────────────────

/**
 * Write .credentials.json to a Claude session directory.
 * Format matches what Claude Code CLI/Agent SDK natively reads.
 *
 * IMPORTANT: Skips overwrite if the on-disk file has a newer `expiresAt` than
 * what we're about to write. This prevents overwriting tokens that the SDK's
 * CLI process has already refreshed (OAuth refresh tokens are single-use, so
 * overwriting with stale tokens would break authentication for all new processes).
 */
export function writeCredentialsFile(
  sessionDir: string,
  config: ClaudeProviderConfig,
): void {
  const creds = config.claudeOAuthCredentials;
  if (!creds) return;

  const filePath = path.join(sessionDir, '.credentials.json');

  // Don't overwrite if on-disk credentials are newer (refreshed by CLI)
  try {
    if (fs.existsSync(filePath)) {
      const existing = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const existingExpiresAt = existing?.claudeAiOauth?.expiresAt;
      if (
        typeof existingExpiresAt === 'number' &&
        existingExpiresAt > creds.expiresAt
      ) {
        return; // on-disk is newer, don't overwrite
      }
    }
  } catch {
    // Can't read existing file — proceed with write
  }

  const credentialsData = {
    claudeAiOauth: {
      accessToken: creds.accessToken,
      refreshToken: creds.refreshToken,
      expiresAt: creds.expiresAt,
      scopes: creds.scopes,
    },
  };

  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(credentialsData, null, 2) + '\n', {
    encoding: 'utf-8',
    mode: 0o644,
  });
  fs.renameSync(tmp, filePath);
}

// ─── Local Claude Code detection ──────────────────────────────────

export interface LocalClaudeCodeStatus {
  detected: boolean;
  hasCredentials: boolean;
  expiresAt: number | null;
  accessTokenMasked: string | null;
}

/**
 * Read and parse OAuth credentials from ~/.claude/.credentials.json.
 * Returns the raw oauth object with accessToken, refreshToken, expiresAt, scopes,
 * or null if the file is missing / invalid / incomplete.
 */
function readLocalOAuthCredentials(): {
  accessToken: string;
  refreshToken: string;
  expiresAt?: number;
  scopes?: string[];
} | null {
  const homeDir = process.env.HOME || '/root';
  const credFile = path.join(homeDir, '.claude', '.credentials.json');

  try {
    if (!fs.existsSync(credFile)) return null;

    const content = JSON.parse(fs.readFileSync(credFile, 'utf-8'));
    const oauth = content?.claudeAiOauth;

    if (oauth?.accessToken && oauth?.refreshToken) {
      return {
        accessToken: oauth.accessToken,
        refreshToken: oauth.refreshToken,
        expiresAt:
          typeof oauth.expiresAt === 'number' ? oauth.expiresAt : undefined,
        scopes: Array.isArray(oauth.scopes) ? oauth.scopes : undefined,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Detect if the host machine has a valid ~/.claude/.credentials.json
 * (i.e. user has logged into Claude Code locally).
 */
export function detectLocalClaudeCode(): LocalClaudeCodeStatus {
  const oauth = readLocalOAuthCredentials();

  if (oauth) {
    return {
      detected: true,
      hasCredentials: true,
      expiresAt: oauth.expiresAt ?? null,
      accessTokenMasked: maskSecret(oauth.accessToken),
    };
  }

  // Check if the file exists at all (detected but no valid credentials)
  const homeDir = process.env.HOME || '/root';
  const credFile = path.join(homeDir, '.claude', '.credentials.json');
  const fileExists = fs.existsSync(credFile);

  return {
    detected: fileExists,
    hasCredentials: false,
    expiresAt: null,
    accessTokenMasked: null,
  };
}

/**
 * Read local ~/.claude/.credentials.json and return parsed OAuth credentials.
 * Returns null if not found or invalid.
 */
export function importLocalClaudeCredentials(): ClaudeOAuthCredentials | null {
  const oauth = readLocalOAuthCredentials();
  if (!oauth) return null;

  return {
    accessToken: oauth.accessToken,
    refreshToken: oauth.refreshToken,
    expiresAt: oauth.expiresAt ?? Date.now() + 8 * 3600_000,
    scopes: oauth.scopes ?? [],
  };
}

// ─── Appearance config (plain JSON, no encryption) ────────────────

const APPEARANCE_CONFIG_FILE = path.join(CLAUDE_CONFIG_DIR, 'appearance.json');

export interface AppearanceConfig {
  appName: string;
  aiName: string;
  aiAvatarEmoji: string;
  aiAvatarColor: string;
}

const DEFAULT_APPEARANCE_CONFIG: AppearanceConfig = {
  appName: ASSISTANT_NAME,
  aiName: ASSISTANT_NAME,
  aiAvatarEmoji: '\u{1F431}',
  aiAvatarColor: '#0d9488',
};

export function getAppearanceConfig(): AppearanceConfig {
  try {
    if (!fs.existsSync(APPEARANCE_CONFIG_FILE)) {
      return { ...DEFAULT_APPEARANCE_CONFIG };
    }
    const raw = JSON.parse(
      fs.readFileSync(APPEARANCE_CONFIG_FILE, 'utf-8'),
    ) as Record<string, unknown>;
    return {
      appName:
        typeof raw.appName === 'string' && raw.appName
          ? raw.appName
          : DEFAULT_APPEARANCE_CONFIG.appName,
      aiName:
        typeof raw.aiName === 'string' && raw.aiName
          ? raw.aiName
          : DEFAULT_APPEARANCE_CONFIG.aiName,
      aiAvatarEmoji:
        typeof raw.aiAvatarEmoji === 'string' && raw.aiAvatarEmoji
          ? raw.aiAvatarEmoji
          : DEFAULT_APPEARANCE_CONFIG.aiAvatarEmoji,
      aiAvatarColor:
        typeof raw.aiAvatarColor === 'string' && raw.aiAvatarColor
          ? raw.aiAvatarColor
          : DEFAULT_APPEARANCE_CONFIG.aiAvatarColor,
    };
  } catch (err) {
    logger.warn(
      { err },
      'Failed to read appearance config, returning defaults',
    );
    return { ...DEFAULT_APPEARANCE_CONFIG };
  }
}

export function saveAppearanceConfig(
  next: Partial<Pick<AppearanceConfig, 'appName'>> &
    Omit<AppearanceConfig, 'appName'>,
): AppearanceConfig {
  const existing = getAppearanceConfig();
  const config = {
    appName: next.appName || existing.appName,
    aiName: next.aiName,
    aiAvatarEmoji: next.aiAvatarEmoji,
    aiAvatarColor: next.aiAvatarColor,
    updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(CLAUDE_CONFIG_DIR, { recursive: true });
  const tmp = `${APPEARANCE_CONFIG_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, APPEARANCE_CONFIG_FILE);
  return {
    appName: config.appName,
    aiName: config.aiName,
    aiAvatarEmoji: config.aiAvatarEmoji,
    aiAvatarColor: config.aiAvatarColor,
  };
}

// ─── Per-user IM config (AES-256-GCM encrypted) ─────────────────

const LEGACY_USER_IM_CONFIG_DIR = path.join(DATA_DIR, 'config', 'user-im');
const GLOBAL_IM_CONFIG_DIR = path.join(DATA_DIR, 'config', 'im');
const LEGACY_IM_CONFIG_FILES = [
  'feishu.json',
  'telegram.json',
  'qq.json',
  'wechat.json',
  'general.json',
  'preferences.json',
] as const;

let legacyUserImConfigMigrated = false;

export interface UserFeishuConfig {
  appId: string;
  appSecret: string;
  enabled?: boolean;
  updatedAt: string | null;
  /** Reply threading mode: 'auto' (trigger-based) or 'agent' (agent-specified). */
  replyThreadingMode?: 'auto' | 'agent';
  /** Show real-time execution progress card in Feishu. */
  streamingCard?: boolean;
  /** Send tool-call IM commentary during long-running tasks. */
  imCommentary?: boolean;
}

export interface UserFeishuOAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // Unix timestamp ms
  scopes: string;
  authorizedAt?: string; // ISO timestamp
}

export interface UserTelegramConfig {
  botToken: string;
  proxyUrl?: string;
  enabled?: boolean;
  updatedAt: string | null;
}

export interface UserQQConfig {
  appId: string;
  appSecret: string;
  enabled?: boolean;
  updatedAt: string | null;
}

interface StoredQQProviderConfigV1 {
  version: 1;
  appId: string;
  enabled?: boolean;
  updatedAt: string;
  secret: EncryptedSecrets;
}

interface QQSecretPayload {
  appSecret: string;
}

function globalImDir(): string {
  return GLOBAL_IM_CONFIG_DIR;
}

function globalImFile(fileName: (typeof LEGACY_IM_CONFIG_FILES)[number]): string {
  return path.join(globalImDir(), fileName);
}

function movePathWithFallback(src: string, dst: string): void {
  try {
    fs.renameSync(src, dst);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
      fs.cpSync(src, dst, { recursive: true });
      fs.rmSync(src, { recursive: true, force: true });
      return;
    }
    throw err;
  }
}

function cleanupLegacyImDir(dir: string): void {
  try {
    const entries = fs.readdirSync(dir);
    if (entries.length === 0) {
      fs.rmdirSync(dir);
    }
  } catch {
    // ignore cleanup failures
  }
}

export function migrateLegacyUserImConfigToGlobal(): void {
  if (legacyUserImConfigMigrated) return;
  legacyUserImConfigMigrated = true;

  if (!fs.existsSync(LEGACY_USER_IM_CONFIG_DIR)) return;

  try {
    const userDirs = fs
      .readdirSync(LEGACY_USER_IM_CONFIG_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    if (userDirs.length === 0) {
      cleanupLegacyImDir(LEGACY_USER_IM_CONFIG_DIR);
      return;
    }

    fs.mkdirSync(GLOBAL_IM_CONFIG_DIR, { recursive: true });

    const migrated: string[] = [];
    const skipped = new Map<string, string[]>();

    for (const fileName of LEGACY_IM_CONFIG_FILES) {
      const target = globalImFile(fileName);
      if (fs.existsSync(target)) {
        for (const userId of userDirs) {
          const source = path.join(LEGACY_USER_IM_CONFIG_DIR, userId, fileName);
          if (fs.existsSync(source)) {
            skipped.set(fileName, [...(skipped.get(fileName) ?? []), userId]);
          }
        }
        continue;
      }

      for (const userId of userDirs) {
        const source = path.join(LEGACY_USER_IM_CONFIG_DIR, userId, fileName);
        if (!fs.existsSync(source)) continue;
        movePathWithFallback(source, target);
        migrated.push(`${userId}/${fileName}`);
        break;
      }
    }

    for (const userId of userDirs) {
      cleanupLegacyImDir(path.join(LEGACY_USER_IM_CONFIG_DIR, userId));
    }
    cleanupLegacyImDir(LEGACY_USER_IM_CONFIG_DIR);

    if (migrated.length > 0) {
      logger.info(
        { migrated, targetDir: GLOBAL_IM_CONFIG_DIR },
        'Migrated legacy user IM config to global IM config',
      );
    }
    if (skipped.size > 0) {
      logger.warn(
        { skipped: Object.fromEntries(skipped), targetDir: GLOBAL_IM_CONFIG_DIR },
        'Skipped legacy IM config files because global IM config already exists',
      );
    }
  } catch (err) {
    legacyUserImConfigMigrated = false;
    logger.warn({ err }, 'Failed to migrate legacy user IM config');
  }
}

export function getImFeishuConfig(): UserFeishuConfig | null {
  migrateLegacyUserImConfigToGlobal();
  const filePath = globalImFile('feishu.json');
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (parsed.version !== 1) return null;

    const stored = parsed as unknown as StoredFeishuProviderConfigV1;
    const secret = decryptFeishuSecret(stored.secret);
    return {
      appId: normalizeFeishuAppId(stored.appId ?? ''),
      appSecret: secret.appSecret,
      enabled: stored.enabled,
      updatedAt: stored.updatedAt || null,
      replyThreadingMode: stored.replyThreadingMode === 'agent' ? 'agent' : 'auto',
      streamingCard: stored.streamingCard ?? false,
      imCommentary: stored.imCommentary ?? false,
    };
  } catch (err) {
    logger.warn({ err }, 'Failed to read global Feishu IM config');
    return null;
  }
}

export function saveImFeishuConfig(
  next: Omit<UserFeishuConfig, 'updatedAt'>,
): UserFeishuConfig {
  migrateLegacyUserImConfigToGlobal();
  const normalized: UserFeishuConfig = {
    appId: normalizeFeishuAppId(next.appId),
    appSecret: normalizeSecret(next.appSecret, 'appSecret'),
    enabled: next.enabled,
    updatedAt: new Date().toISOString(),
    replyThreadingMode: next.replyThreadingMode === 'agent' ? 'agent' : 'auto',
    streamingCard: next.streamingCard ?? false,
    imCommentary: next.imCommentary ?? false,
  };

  // Preserve existing OAuth tokens when saving IM config
  const existing = readRawFeishuConfig();

  const payload: StoredFeishuProviderConfigV1 = {
    version: 1,
    appId: normalized.appId,
    enabled: normalized.enabled,
    updatedAt: normalized.updatedAt || new Date().toISOString(),
    secret: encryptFeishuSecret({ appSecret: normalized.appSecret }),
    replyThreadingMode: normalized.replyThreadingMode,
    streamingCard: normalized.streamingCard,
    imCommentary: normalized.imCommentary,
    ...(existing?.oauthSecret ? { oauthSecret: existing.oauthSecret } : {}),
    ...(existing?.oauthAuthorizedAt
      ? { oauthAuthorizedAt: existing.oauthAuthorizedAt }
      : {}),
  };

  writeFeishuConfigFile(payload);
  return normalized;
}

/** Read the raw stored config without decryption (for preserving fields). */
function readRawFeishuConfig(): StoredFeishuProviderConfigV1 | null {
  migrateLegacyUserImConfigToGlobal();
  const filePath = globalImFile('feishu.json');
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (parsed.version !== 1) return null;
    return parsed as unknown as StoredFeishuProviderConfigV1;
  } catch {
    return null;
  }
}

/** Atomic write of feishu.json. */
function writeFeishuConfigFile(payload: StoredFeishuProviderConfigV1): void {
  const dir = globalImDir();
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'feishu.json');
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, filePath);
}

function encryptFeishuOAuthSecret(
  payload: FeishuOAuthSecretPayload,
): EncryptedSecrets {
  const key = getOrCreateEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const plaintext = Buffer.from(JSON.stringify(payload), 'utf-8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: encrypted.toString('base64'),
  };
}

function decryptFeishuOAuthSecret(
  secrets: EncryptedSecrets,
): FeishuOAuthSecretPayload {
  const key = getOrCreateEncryptionKey();
  const iv = Buffer.from(secrets.iv, 'base64');
  const tag = Buffer.from(secrets.tag, 'base64');
  const encrypted = Buffer.from(secrets.data, 'base64');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]).toString('utf-8');
  const parsed = JSON.parse(decrypted) as Record<string, unknown>;

  return {
    accessToken: String(parsed.accessToken ?? ''),
    refreshToken: String(parsed.refreshToken ?? ''),
    expiresAt: typeof parsed.expiresAt === 'number' ? parsed.expiresAt : 0,
    scopes: String(parsed.scopes ?? ''),
  };
}

/** Read OAuth tokens for the global Feishu IM config. Returns null if not authorized. */
export function getImFeishuOAuthTokens(): UserFeishuOAuthTokens | null {
  const stored = readRawFeishuConfig();
  if (!stored?.oauthSecret) return null;

  try {
    const decrypted = decryptFeishuOAuthSecret(stored.oauthSecret);
    if (!decrypted.accessToken) return null;

    return {
      ...decrypted,
      authorizedAt: stored.oauthAuthorizedAt || null,
    } as UserFeishuOAuthTokens;
  } catch (err) {
    logger.warn({ err }, 'Failed to decrypt Feishu OAuth tokens');
    return null;
  }
}

/** Save OAuth tokens for the global Feishu IM config. */
export function saveImFeishuOAuthTokens(
  tokens: Omit<UserFeishuOAuthTokens, 'authorizedAt'>,
): void {
  migrateLegacyUserImConfigToGlobal();
  const existing = readRawFeishuConfig();

  if (!existing) {
    // No existing config — create minimal config with just OAuth
    const payload: StoredFeishuProviderConfigV1 = {
      version: 1,
      appId: '',
      enabled: false,
      updatedAt: new Date().toISOString(),
      secret: encryptFeishuSecret({ appSecret: '' }),
      oauthSecret: encryptFeishuOAuthSecret(tokens),
      oauthAuthorizedAt: new Date().toISOString(),
    };
    writeFeishuConfigFile(payload);
    return;
  }

  // Preserve existing IM config, update OAuth tokens
  existing.oauthSecret = encryptFeishuOAuthSecret(tokens);
  if (!existing.oauthAuthorizedAt) {
    existing.oauthAuthorizedAt = new Date().toISOString();
  }
  existing.updatedAt = new Date().toISOString();
  writeFeishuConfigFile(existing);
}

/** Clear OAuth tokens for the global Feishu IM config. */
export function clearImFeishuOAuthTokens(): void {
  const existing = readRawFeishuConfig();
  if (!existing) return;

  delete existing.oauthSecret;
  delete existing.oauthAuthorizedAt;
  existing.updatedAt = new Date().toISOString();
  writeFeishuConfigFile(existing);
}

export function getImTelegramConfig(): UserTelegramConfig | null {
  migrateLegacyUserImConfigToGlobal();
  const filePath = globalImFile('telegram.json');
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (parsed.version !== 1) return null;

    const stored = parsed as unknown as StoredTelegramProviderConfigV1;
    const secret = decryptTelegramSecret(stored.secret);
    return {
      botToken: secret.botToken,
      proxyUrl: normalizeTelegramProxyUrl(stored.proxyUrl ?? ''),
      enabled: stored.enabled,
      updatedAt: stored.updatedAt || null,
    };
  } catch (err) {
    logger.warn({ err }, 'Failed to read global Telegram IM config');
    return null;
  }
}

export function saveImTelegramConfig(
  next: Omit<UserTelegramConfig, 'updatedAt'>,
): UserTelegramConfig {
  migrateLegacyUserImConfigToGlobal();
  const normalizedProxyUrl = next.proxyUrl
    ? normalizeTelegramProxyUrl(next.proxyUrl)
    : '';
  const normalized: UserTelegramConfig = {
    botToken: normalizeSecret(next.botToken, 'botToken'),
    proxyUrl: normalizedProxyUrl || undefined,
    enabled: next.enabled,
    updatedAt: new Date().toISOString(),
  };

  const payload: StoredTelegramProviderConfigV1 = {
    version: 1,
    proxyUrl: normalizedProxyUrl || undefined,
    enabled: normalized.enabled,
    updatedAt: normalized.updatedAt || new Date().toISOString(),
    secret: encryptTelegramSecret({ botToken: normalized.botToken }),
  };

  const dir = globalImDir();
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'telegram.json');
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, filePath);
  return normalized;
}

// ========== QQ User IM Config ==========

function encryptQQSecret(payload: QQSecretPayload): EncryptedSecrets {
  const key = getOrCreateEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const plaintext = Buffer.from(JSON.stringify(payload), 'utf-8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: encrypted.toString('base64'),
  };
}

function decryptQQSecret(secrets: EncryptedSecrets): QQSecretPayload {
  const key = getOrCreateEncryptionKey();
  const iv = Buffer.from(secrets.iv, 'base64');
  const tag = Buffer.from(secrets.tag, 'base64');
  const encrypted = Buffer.from(secrets.data, 'base64');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]).toString('utf-8');
  const parsed = JSON.parse(decrypted) as Record<string, unknown>;
  return {
    appSecret: normalizeSecret(parsed.appSecret ?? '', 'appSecret'),
  };
}

export function getImQQConfig(): UserQQConfig | null {
  migrateLegacyUserImConfigToGlobal();
  const filePath = globalImFile('qq.json');
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (parsed.version !== 1) return null;

    const stored = parsed as unknown as StoredQQProviderConfigV1;
    const secret = decryptQQSecret(stored.secret);
    return {
      appId: normalizeFeishuAppId(stored.appId ?? ''),
      appSecret: secret.appSecret,
      enabled: stored.enabled,
      updatedAt: stored.updatedAt || null,
    };
  } catch (err) {
    logger.warn({ err }, 'Failed to read global QQ IM config');
    return null;
  }
}

export function saveImQQConfig(
  next: Omit<UserQQConfig, 'updatedAt'>,
): UserQQConfig {
  migrateLegacyUserImConfigToGlobal();
  const normalized: UserQQConfig = {
    appId: normalizeFeishuAppId(next.appId),
    appSecret: normalizeSecret(next.appSecret, 'appSecret'),
    enabled: next.enabled,
    updatedAt: new Date().toISOString(),
  };

  const payload: StoredQQProviderConfigV1 = {
    version: 1,
    appId: normalized.appId,
    enabled: normalized.enabled,
    updatedAt: normalized.updatedAt || new Date().toISOString(),
    secret: encryptQQSecret({ appSecret: normalized.appSecret }),
  };

  const dir = globalImDir();
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'qq.json');
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, filePath);
  return normalized;
}

// ─── Per-user IM general settings (plain JSON, no encryption) ────

export interface UserImGeneralConfig {
  autoUnbindOnSendFailure: boolean;
  updatedAt: string | null;
}

export function getImGeneralConfig(): UserImGeneralConfig {
  migrateLegacyUserImConfigToGlobal();
  const filePath = globalImFile('general.json');
  try {
    if (!fs.existsSync(filePath)) {
      return { autoUnbindOnSendFailure: true, updatedAt: null };
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content) as Record<string, unknown>;
    return {
      autoUnbindOnSendFailure: parsed.autoUnbindOnSendFailure === true,
      updatedAt:
        typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
    };
  } catch (err) {
    logger.warn({ err }, 'Failed to read global IM general config');
    return { autoUnbindOnSendFailure: true, updatedAt: null };
  }
}

export function saveImGeneralConfig(
  next: Omit<UserImGeneralConfig, 'updatedAt'>,
): UserImGeneralConfig {
  migrateLegacyUserImConfigToGlobal();
  const config: UserImGeneralConfig = {
    autoUnbindOnSendFailure: next.autoUnbindOnSendFailure,
    updatedAt: new Date().toISOString(),
  };
  const dir = globalImDir();
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'general.json');
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, filePath);
  return config;
}

// ========== WeChat User IM Config ==========

export interface UserWeChatConfig {
  botToken: string; // iLink bot_token
  ilinkBotId: string; // bot ID (xxx@im.bot)
  baseUrl?: string; // 默认 https://ilinkai.weixin.qq.com
  cdnBaseUrl?: string; // 默认 https://novac2c.cdn.weixin.qq.com/c2c
  getUpdatesBuf?: string; // 长轮询游标
  enabled?: boolean;
  updatedAt: string | null;
}

interface StoredWeChatProviderConfigV1 {
  version: 1;
  ilinkBotId: string;
  baseUrl?: string;
  cdnBaseUrl?: string;
  getUpdatesBuf?: string;
  enabled?: boolean;
  updatedAt: string;
  secret: EncryptedSecrets;
}

interface WeChatSecretPayload {
  botToken: string;
}

function encryptWeChatSecret(payload: WeChatSecretPayload): EncryptedSecrets {
  const key = getOrCreateEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const plaintext = Buffer.from(JSON.stringify(payload), 'utf-8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: encrypted.toString('base64'),
  };
}

function decryptWeChatSecret(secrets: EncryptedSecrets): WeChatSecretPayload {
  const key = getOrCreateEncryptionKey();
  const iv = Buffer.from(secrets.iv, 'base64');
  const tag = Buffer.from(secrets.tag, 'base64');
  const encrypted = Buffer.from(secrets.data, 'base64');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]).toString('utf-8');
  const parsed = JSON.parse(decrypted) as Record<string, unknown>;
  return {
    botToken: normalizeSecret(parsed.botToken ?? '', 'botToken'),
  };
}

export function getImWeChatConfig(): UserWeChatConfig | null {
  migrateLegacyUserImConfigToGlobal();
  const filePath = globalImFile('wechat.json');
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (parsed.version !== 1) return null;

    const stored = parsed as unknown as StoredWeChatProviderConfigV1;
    const secret = decryptWeChatSecret(stored.secret);
    return {
      botToken: secret.botToken,
      ilinkBotId: ((stored.ilinkBotId as string) ?? '').trim(),
      baseUrl: stored.baseUrl,
      cdnBaseUrl: stored.cdnBaseUrl,
      getUpdatesBuf: stored.getUpdatesBuf,
      enabled: stored.enabled,
      updatedAt: stored.updatedAt || null,
    };
  } catch (err) {
    logger.warn({ err }, 'Failed to read global WeChat IM config');
    return null;
  }
}

export function saveImWeChatConfig(
  next: Omit<UserWeChatConfig, 'updatedAt'>,
): UserWeChatConfig {
  migrateLegacyUserImConfigToGlobal();
  const normalized: UserWeChatConfig = {
    botToken: normalizeSecret(next.botToken, 'botToken'),
    ilinkBotId: (next.ilinkBotId ?? '').trim(),
    baseUrl: next.baseUrl?.trim() || undefined,
    cdnBaseUrl: next.cdnBaseUrl?.trim() || undefined,
    getUpdatesBuf: next.getUpdatesBuf,
    enabled: next.enabled,
    updatedAt: new Date().toISOString(),
  };

  const payload: StoredWeChatProviderConfigV1 = {
    version: 1,
    ilinkBotId: normalized.ilinkBotId,
    baseUrl: normalized.baseUrl,
    cdnBaseUrl: normalized.cdnBaseUrl,
    getUpdatesBuf: normalized.getUpdatesBuf,
    enabled: normalized.enabled,
    updatedAt: normalized.updatedAt || new Date().toISOString(),
    secret: encryptWeChatSecret({ botToken: normalized.botToken }),
  };

  const dir = globalImDir();
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'wechat.json');
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, filePath);
  return normalized;
}

// ─── System settings (plain JSON, no encryption) ─────────────────

const SYSTEM_SETTINGS_FILE = path.join(
  CLAUDE_CONFIG_DIR,
  'system-settings.json',
);

export interface SystemSettings {
  runtimeTimeout: number;
  idleTimeout: number;
  runtimeMaxOutputSize: number;
  maxConcurrentRuntimes: number;
  maxConcurrentScripts: number;
  scriptTimeout: number;
  queryActivityTimeoutMs: number;
  toolCallHardTimeoutMs: number;
  memoryQueryTimeout: number;
  memoryGlobalSleepTimeout: number;
  memorySendTimeout: number;
  codexArchiveThreshold: number;
  turnBatchWindowMs: number;
  turnMaxBatchMs: number;
  traceRetentionDays: number;
  // Feishu
  feishuApiDomain: string;
  feishuDocDomain: string;
  // Web
  webPublicUrl: string;
  // Global default models (workspace-level overrides these)
  defaultClaudeModel: string;
}

const DEFAULT_SYSTEM_SETTINGS: SystemSettings = {
  runtimeTimeout: 1800000,
  idleTimeout: 1500000,
  runtimeMaxOutputSize: 10485760,
  maxConcurrentRuntimes: 20,
  maxConcurrentScripts: 10,
  scriptTimeout: 60000,
  queryActivityTimeoutMs: 300000,
  toolCallHardTimeoutMs: 1200000,
  memoryQueryTimeout: 60000,
  memoryGlobalSleepTimeout: 300000,
  memorySendTimeout: 120000,
  codexArchiveThreshold: 100000,
  turnBatchWindowMs: 5000,
  turnMaxBatchMs: 30000,
  traceRetentionDays: 7,
  feishuApiDomain: 'open.feishu.cn',
  feishuDocDomain: 'bytedance.larkoffice.com',
  webPublicUrl: '',
  defaultClaudeModel: '',
};

function parseIntEnv(envVar: string | undefined, fallback: number): number {
  if (!envVar) return fallback;
  const parsed = parseInt(envVar, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseFloatEnv(envVar: string | undefined, fallback: number): number {
  if (!envVar) return fallback;
  const parsed = parseFloat(envVar);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readPositiveNumber(
  raw: Record<string, unknown>,
  preferredKey: string,
  legacyKey: string,
  fallback: number,
): number {
  const preferred = raw[preferredKey];
  if (typeof preferred === 'number' && preferred > 0) return preferred;
  const legacy = raw[legacyKey];
  if (typeof legacy === 'number' && legacy > 0) return legacy;
  return fallback;
}

// In-memory cache: avoid synchronous file I/O on hot paths (stdout data handler, queue capacity check)
let _settingsCache: SystemSettings | null = null;
let _settingsMtimeMs = 0;

function readSystemSettingsFromFile(): SystemSettings | null {
  if (!fs.existsSync(SYSTEM_SETTINGS_FILE)) return null;
  const raw = JSON.parse(
    fs.readFileSync(SYSTEM_SETTINGS_FILE, 'utf-8'),
  ) as Record<string, unknown>;
  const normalized: SystemSettings = {
    runtimeTimeout: readPositiveNumber(
      raw,
      'runtimeTimeout',
      'containerTimeout',
      DEFAULT_SYSTEM_SETTINGS.runtimeTimeout,
    ),
    idleTimeout:
      typeof raw.idleTimeout === 'number' && raw.idleTimeout > 0
        ? raw.idleTimeout
        : DEFAULT_SYSTEM_SETTINGS.idleTimeout,
    runtimeMaxOutputSize: readPositiveNumber(
      raw,
      'runtimeMaxOutputSize',
      'containerMaxOutputSize',
      DEFAULT_SYSTEM_SETTINGS.runtimeMaxOutputSize,
    ),
    maxConcurrentRuntimes: readPositiveNumber(
      raw,
      'maxConcurrentRuntimes',
      'maxConcurrentContainers',
      DEFAULT_SYSTEM_SETTINGS.maxConcurrentRuntimes,
    ),
    maxConcurrentScripts:
      typeof raw.maxConcurrentScripts === 'number' &&
      raw.maxConcurrentScripts > 0
        ? raw.maxConcurrentScripts
        : DEFAULT_SYSTEM_SETTINGS.maxConcurrentScripts,
    scriptTimeout:
      typeof raw.scriptTimeout === 'number' && raw.scriptTimeout > 0
        ? raw.scriptTimeout
        : DEFAULT_SYSTEM_SETTINGS.scriptTimeout,
    queryActivityTimeoutMs:
      typeof raw.queryActivityTimeoutMs === 'number' &&
      raw.queryActivityTimeoutMs > 0
        ? raw.queryActivityTimeoutMs
        : DEFAULT_SYSTEM_SETTINGS.queryActivityTimeoutMs,
    toolCallHardTimeoutMs:
      typeof raw.toolCallHardTimeoutMs === 'number' &&
      raw.toolCallHardTimeoutMs > 0
        ? raw.toolCallHardTimeoutMs
        : DEFAULT_SYSTEM_SETTINGS.toolCallHardTimeoutMs,
    memoryQueryTimeout:
      typeof raw.memoryQueryTimeout === 'number' && raw.memoryQueryTimeout > 0
        ? raw.memoryQueryTimeout
        : DEFAULT_SYSTEM_SETTINGS.memoryQueryTimeout,
    memoryGlobalSleepTimeout:
      typeof raw.memoryGlobalSleepTimeout === 'number' &&
      raw.memoryGlobalSleepTimeout > 0
        ? raw.memoryGlobalSleepTimeout
        : DEFAULT_SYSTEM_SETTINGS.memoryGlobalSleepTimeout,
    memorySendTimeout:
      typeof raw.memorySendTimeout === 'number' && raw.memorySendTimeout > 0
        ? raw.memorySendTimeout
        : DEFAULT_SYSTEM_SETTINGS.memorySendTimeout,
    codexArchiveThreshold:
      typeof raw.codexArchiveThreshold === 'number' &&
      raw.codexArchiveThreshold > 0
        ? raw.codexArchiveThreshold
        : DEFAULT_SYSTEM_SETTINGS.codexArchiveThreshold,
    turnBatchWindowMs:
      typeof raw.turnBatchWindowMs === 'number' && raw.turnBatchWindowMs > 0
        ? raw.turnBatchWindowMs
        : DEFAULT_SYSTEM_SETTINGS.turnBatchWindowMs,
    turnMaxBatchMs:
      typeof raw.turnMaxBatchMs === 'number' && raw.turnMaxBatchMs > 0
        ? raw.turnMaxBatchMs
        : DEFAULT_SYSTEM_SETTINGS.turnMaxBatchMs,
    traceRetentionDays:
      typeof raw.traceRetentionDays === 'number' && raw.traceRetentionDays > 0
        ? raw.traceRetentionDays
        : DEFAULT_SYSTEM_SETTINGS.traceRetentionDays,
    feishuApiDomain:
      typeof raw.feishuApiDomain === 'string' && raw.feishuApiDomain
        ? raw.feishuApiDomain
        : DEFAULT_SYSTEM_SETTINGS.feishuApiDomain,
    feishuDocDomain:
      typeof raw.feishuDocDomain === 'string' && raw.feishuDocDomain
        ? raw.feishuDocDomain
        : DEFAULT_SYSTEM_SETTINGS.feishuDocDomain,
    webPublicUrl:
      typeof raw.webPublicUrl === 'string'
        ? raw.webPublicUrl
        : DEFAULT_SYSTEM_SETTINGS.webPublicUrl,
    defaultClaudeModel:
      typeof raw.defaultClaudeModel === 'string'
        ? raw.defaultClaudeModel.trim()
        : DEFAULT_SYSTEM_SETTINGS.defaultClaudeModel,
  };
  if (
    raw.containerTimeout !== undefined ||
    raw.containerMaxOutputSize !== undefined ||
    raw.maxConcurrentContainers !== undefined
  ) {
    const tmp = `${SYSTEM_SETTINGS_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(normalized, null, 2) + '\n', 'utf-8');
    fs.renameSync(tmp, SYSTEM_SETTINGS_FILE);
  }
  return normalized;
}

function buildEnvFallbackSettings(): SystemSettings {
  return {
    runtimeTimeout: parseIntEnv(
      process.env.RUNTIME_TIMEOUT ?? process.env.CONTAINER_TIMEOUT,
      DEFAULT_SYSTEM_SETTINGS.runtimeTimeout,
    ),
    idleTimeout: parseIntEnv(
      process.env.IDLE_TIMEOUT,
      DEFAULT_SYSTEM_SETTINGS.idleTimeout,
    ),
    runtimeMaxOutputSize: parseIntEnv(
      process.env.RUNTIME_MAX_OUTPUT_SIZE ??
        process.env.CONTAINER_MAX_OUTPUT_SIZE,
      DEFAULT_SYSTEM_SETTINGS.runtimeMaxOutputSize,
    ),
    maxConcurrentRuntimes: parseIntEnv(
      process.env.MAX_CONCURRENT_RUNTIMES ??
        process.env.MAX_CONCURRENT_CONTAINERS,
      DEFAULT_SYSTEM_SETTINGS.maxConcurrentRuntimes,
    ),
    maxConcurrentScripts: parseIntEnv(
      process.env.MAX_CONCURRENT_SCRIPTS,
      DEFAULT_SYSTEM_SETTINGS.maxConcurrentScripts,
    ),
    scriptTimeout: parseIntEnv(
      process.env.SCRIPT_TIMEOUT,
      DEFAULT_SYSTEM_SETTINGS.scriptTimeout,
    ),
    queryActivityTimeoutMs: parseIntEnv(
      process.env.QUERY_ACTIVITY_TIMEOUT_MS,
      DEFAULT_SYSTEM_SETTINGS.queryActivityTimeoutMs,
    ),
    toolCallHardTimeoutMs: parseIntEnv(
      process.env.TOOL_CALL_HARD_TIMEOUT_MS,
      DEFAULT_SYSTEM_SETTINGS.toolCallHardTimeoutMs,
    ),
    memoryQueryTimeout: parseIntEnv(
      process.env.MEMORY_QUERY_TIMEOUT,
      DEFAULT_SYSTEM_SETTINGS.memoryQueryTimeout,
    ),
    memoryGlobalSleepTimeout: parseIntEnv(
      process.env.MEMORY_GLOBAL_SLEEP_TIMEOUT,
      DEFAULT_SYSTEM_SETTINGS.memoryGlobalSleepTimeout,
    ),
    memorySendTimeout: parseIntEnv(
      process.env.MEMORY_SEND_TIMEOUT,
      DEFAULT_SYSTEM_SETTINGS.memorySendTimeout,
    ),
    codexArchiveThreshold: parseIntEnv(
      process.env.CODEX_ARCHIVE_THRESHOLD,
      DEFAULT_SYSTEM_SETTINGS.codexArchiveThreshold,
    ),
    turnBatchWindowMs: parseIntEnv(
      process.env.TURN_BATCH_WINDOW_MS,
      DEFAULT_SYSTEM_SETTINGS.turnBatchWindowMs,
    ),
    turnMaxBatchMs: parseIntEnv(
      process.env.TURN_MAX_BATCH_MS,
      DEFAULT_SYSTEM_SETTINGS.turnMaxBatchMs,
    ),
    traceRetentionDays: parseIntEnv(
      process.env.TRACE_RETENTION_DAYS,
      DEFAULT_SYSTEM_SETTINGS.traceRetentionDays,
    ),
    feishuApiDomain:
      process.env.FEISHU_API_DOMAIN || DEFAULT_SYSTEM_SETTINGS.feishuApiDomain,
    feishuDocDomain:
      process.env.FEISHU_DOC_DOMAIN || DEFAULT_SYSTEM_SETTINGS.feishuDocDomain,
    webPublicUrl:
      process.env.WEB_PUBLIC_URL || DEFAULT_SYSTEM_SETTINGS.webPublicUrl,
    defaultClaudeModel: process.env.DEFAULT_CLAUDE_MODEL || DEFAULT_SYSTEM_SETTINGS.defaultClaudeModel,
  };
}

export function getSystemSettings(): SystemSettings {
  // Fast path: return cached value if file hasn't changed
  try {
    if (_settingsCache) {
      if (!fs.existsSync(SYSTEM_SETTINGS_FILE)) return _settingsCache;
      const mtimeMs = fs.statSync(SYSTEM_SETTINGS_FILE).mtimeMs;
      if (mtimeMs === _settingsMtimeMs) return _settingsCache;
    }
  } catch {
    // stat failed — fall through to full read
  }

  // 1. Try reading from file
  try {
    if (fs.existsSync(SYSTEM_SETTINGS_FILE)) {
      const settings = readSystemSettingsFromFile();
      if (settings) {
        _settingsCache = settings;
        try {
          _settingsMtimeMs = fs.statSync(SYSTEM_SETTINGS_FILE).mtimeMs;
        } catch {
          /* ignore */
        }
        return settings;
      }
    }
  } catch (err) {
    logger.warn(
      { err },
      'Failed to read system settings, falling back to env/defaults',
    );
  }

  // 2. Fall back to env vars, then hardcoded defaults
  const settings = buildEnvFallbackSettings();
  _settingsCache = settings;
  _settingsMtimeMs = 0; // no file — will re-check on next call
  return settings;
}

export function saveSystemSettings(
  partial: Partial<SystemSettings>,
): SystemSettings {
  const existing = getSystemSettings();
  const merged: SystemSettings = { ...existing, ...partial };

  // Range validation
  if (merged.runtimeTimeout < 60000) merged.runtimeTimeout = 60000; // min 1 min
  if (merged.runtimeTimeout > 86400000) merged.runtimeTimeout = 86400000; // max 24 hours
  if (merged.idleTimeout < 60000) merged.idleTimeout = 60000;
  if (merged.idleTimeout > 86400000) merged.idleTimeout = 86400000;
  if (merged.runtimeMaxOutputSize < 1048576)
    merged.runtimeMaxOutputSize = 1048576; // min 1MB
  if (merged.runtimeMaxOutputSize > 104857600)
    merged.runtimeMaxOutputSize = 104857600; // max 100MB
  if (merged.maxConcurrentRuntimes < 1) merged.maxConcurrentRuntimes = 1;
  if (merged.maxConcurrentRuntimes > 100)
    merged.maxConcurrentRuntimes = 100;
  if (merged.maxConcurrentScripts < 1) merged.maxConcurrentScripts = 1;
  if (merged.maxConcurrentScripts > 50) merged.maxConcurrentScripts = 50;
  if (merged.scriptTimeout < 5000) merged.scriptTimeout = 5000; // min 5s
  if (merged.scriptTimeout > 600000) merged.scriptTimeout = 600000; // max 10 min
  if (merged.queryActivityTimeoutMs < 30000)
    merged.queryActivityTimeoutMs = 30000; // min 30s
  if (merged.queryActivityTimeoutMs > 3600000)
    merged.queryActivityTimeoutMs = 3600000; // max 1 hour
  if (merged.toolCallHardTimeoutMs < 60000)
    merged.toolCallHardTimeoutMs = 60000; // min 1 min
  if (merged.toolCallHardTimeoutMs > 7200000)
    merged.toolCallHardTimeoutMs = 7200000; // max 2 hours
  if (merged.memoryQueryTimeout < 10000) merged.memoryQueryTimeout = 10000; // min 10s
  if (merged.memoryQueryTimeout > 600000) merged.memoryQueryTimeout = 600000; // max 10 min
  if (merged.memoryGlobalSleepTimeout < 60000)
    merged.memoryGlobalSleepTimeout = 60000; // min 1 min
  if (merged.memoryGlobalSleepTimeout > 3600000)
    merged.memoryGlobalSleepTimeout = 3600000; // max 1 hour
  if (merged.memorySendTimeout < 30000) merged.memorySendTimeout = 30000; // min 30s
  if (merged.memorySendTimeout > 3600000) merged.memorySendTimeout = 3600000; // max 1 hour
  if (merged.codexArchiveThreshold < 10000)
    merged.codexArchiveThreshold = 10000;
  if (merged.codexArchiveThreshold > 2000000)
    merged.codexArchiveThreshold = 2000000;
  if (merged.turnBatchWindowMs < 1000) merged.turnBatchWindowMs = 1000; // min 1s
  if (merged.turnBatchWindowMs > 60000) merged.turnBatchWindowMs = 60000; // max 60s
  if (merged.turnMaxBatchMs < 5000) merged.turnMaxBatchMs = 5000; // min 5s
  if (merged.turnMaxBatchMs > 300000) merged.turnMaxBatchMs = 300000; // max 5 min
  if (merged.traceRetentionDays < 1) merged.traceRetentionDays = 1; // min 1 day
  if (merged.traceRetentionDays > 90) merged.traceRetentionDays = 90; // max 90 days
  // webPublicUrl: strip trailing slash
  if (typeof merged.webPublicUrl === 'string') {
    merged.webPublicUrl = merged.webPublicUrl.replace(/\/+$/, '');
  }
  // Feishu domains: strip protocol prefix and trailing slash
  for (const key of ['feishuApiDomain', 'feishuDocDomain'] as const) {
    if (typeof merged[key] === 'string') {
      merged[key] = merged[key]
        .replace(/^https?:\/\//, '')
        .replace(/\/+$/, '')
        .trim();
    }
    if (!merged[key]) {
      merged[key] = DEFAULT_SYSTEM_SETTINGS[key];
    }
  }

  fs.mkdirSync(CLAUDE_CONFIG_DIR, { recursive: true });
  const tmp = `${SYSTEM_SETTINGS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, SYSTEM_SETTINGS_FILE);

  // Update in-memory cache immediately
  _settingsCache = merged;
  try {
    _settingsMtimeMs = fs.statSync(SYSTEM_SETTINGS_FILE).mtimeMs;
  } catch {
    /* ignore */
  }

  return merged;
}

// ─── User IM Preferences ─────────────────────────────────────────

export interface UserIMPreferences {
  autoCreateWorkspaceForGroups?: boolean;
  autoCreateExecutionMode?: 'local';
}

export function getImPreferences(): UserIMPreferences {
  migrateLegacyUserImConfigToGlobal();
  const filePath = globalImFile('preferences.json');
  try {
    if (!fs.existsSync(filePath)) return {};
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content) as {
      autoCreateWorkspaceForGroups?: boolean;
      autoCreateExecutionMode?: string;
    };
    return {
      autoCreateWorkspaceForGroups: parsed.autoCreateWorkspaceForGroups,
      autoCreateExecutionMode:
        parsed.autoCreateExecutionMode !== undefined ? 'local' : undefined,
    };
  } catch (err) {
    logger.warn({ err }, 'Failed to read global IM preferences');
    return {};
  }
}

export function saveImPreferences(
  prefs: UserIMPreferences,
): UserIMPreferences {
  migrateLegacyUserImConfigToGlobal();
  const dir = globalImDir();
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'preferences.json');
  const merged: UserIMPreferences = {
    ...getImPreferences(),
    ...prefs,
  };
  fs.writeFileSync(filePath, JSON.stringify(merged, null, 2), 'utf-8');
  return merged;
}

// ═══════════════════════════════════════════════════════════════════
export interface LocalCodexCliStatus {
  detected: boolean;
  hasAuth: boolean;
  authMode: string | null;
  accountId: string | null;
  lastRefresh: string | null;
}

// ─── Codex CLI detection (read-only) ────────────────────────────

/**
 * Read and parse ~/.codex/auth.json.
 * Returns the raw parsed JSON object, or null if missing/invalid.
 */
function readLocalCodexAuth(): Record<string, unknown> | null {
  const homeDir = process.env.HOME || '/root';
  const authFile = path.join(
    process.env.CODEX_HOME || path.join(homeDir, '.codex'),
    'auth.json',
  );
  try {
    if (!fs.existsSync(authFile)) return null;
    const content = JSON.parse(fs.readFileSync(authFile, 'utf-8'));
    if (typeof content !== 'object' || content === null) return null;
    return content as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function detectLocalCodexCli(): LocalCodexCliStatus {
  const homeDir = process.env.HOME || '/root';
  const codexHome = process.env.CODEX_HOME || path.join(homeDir, '.codex');

  const auth = readLocalCodexAuth();
  if (auth && auth.tokens && typeof auth.tokens === 'object') {
    const tokens = auth.tokens as Record<string, unknown>;
    const accountId = typeof tokens.account_id === 'string' ? tokens.account_id : null;
    return {
      detected: true,
      hasAuth: true,
      authMode: typeof auth.auth_mode === 'string' ? auth.auth_mode : null,
      accountId: accountId ? maskSecret(accountId) : null,
      lastRefresh: typeof auth.last_refresh === 'string' ? auth.last_refresh : null,
    };
  }

  // Check if directory exists at all
  const dirExists = fs.existsSync(codexHome);
  return {
    detected: dirExists,
    hasAuth: false,
    authMode: null,
    accountId: null,
    lastRefresh: null,
  };
}
