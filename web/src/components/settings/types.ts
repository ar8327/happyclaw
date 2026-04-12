export interface ClaudeConfigPublic {
  anthropicBaseUrl: string;
  happyclawModel: string;
  updatedAt: string | null;
  hasAnthropicAuthToken: boolean;
  hasAnthropicApiKey: boolean;
  hasClaudeCodeOauthToken: boolean;
  anthropicAuthTokenMasked: string | null;
  anthropicApiKeyMasked: string | null;
  claudeCodeOauthTokenMasked: string | null;
  hasClaudeOAuthCredentials: boolean;
  claudeOAuthCredentialsExpiresAt: number | null;
  claudeOAuthCredentialsAccessTokenMasked: string | null;
}

export interface ClaudeThirdPartyProfileItem {
  id: string;
  name: string;
  anthropicBaseUrl: string;
  happyclawModel: string;
  updatedAt: string | null;
  hasAnthropicAuthToken: boolean;
  anthropicAuthTokenMasked: string | null;
  customEnv: Record<string, string>;
}

export interface ClaudeThirdPartyProfilesResp {
  activeProfileId: string;
  profiles: ClaudeThirdPartyProfileItem[];
}

export interface ClaudeThirdPartyActivateResult {
  success: boolean;
  alreadyActive?: boolean;
  activeProfileId: string;
  profile: ClaudeThirdPartyProfileItem | null;
  stoppedCount: number;
  failedCount: number;
  error?: string;
}

export interface ClaudeApplyResult {
  success: boolean;
  stoppedCount: number;
  failedCount?: number;
  error?: string;
}

export interface EnvRow {
  key: string;
  value: string;
}

export interface SessionInfo {
  id: string;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
  last_active_at: string;
  is_current: boolean;
}

export interface SettingsNotification {
  setNotice: (msg: string | null) => void;
  setError: (msg: string | null) => void;
}

export interface SystemSettings {
  runtimeTimeout: number;
  idleTimeout: number;
  runtimeMaxOutputSize: number;
  maxConcurrentRuntimes: number;
  maxConcurrentScripts: number;
  scriptTimeout: number;
  memoryQueryTimeout: number;
  memoryGlobalSleepTimeout: number;
  memorySendTimeout: number;
  turnBatchWindowMs: number;
  turnMaxBatchMs: number;
  traceRetentionDays: number;
  webPublicUrl: string;
  defaultClaudeModel: string;
}

export type SettingsTab =
  | 'claude'
  | 'codex'
  | 'runners'
  | 'appearance'
  | 'system'
  | 'profile'
  | 'channels'
  | 'sessions'
  | 'memory'
  | 'skills'
  | 'mcp-servers'
  | 'agent-definitions'
  | 'about'
  | 'bindings';

// ─── Codex Provider Types ───────────────────────────────────────

export interface CodexConfigPublic {
  mode: 'cli' | 'api_key';
  hasCliAuth: boolean;
  cliAuthMode: string | null;
  cliAuthAccountId: string | null;
  cliAuthLastRefresh: string | null;
  hasEnvApiKey: boolean;
}

export interface CodexProfileItem {
  id: string;
  name: string;
  baseUrl: string;
  defaultModel: string;
  updatedAt: string | null;
  hasOpenaiApiKey: boolean;
  openaiApiKeyMasked: string | null;
  customEnv: Record<string, string>;
}

export interface CodexProfilesResp {
  activeProfileId: string;
  profiles: CodexProfileItem[];
}

export interface CodexActivateResult {
  success: boolean;
  alreadyActive?: boolean;
  activeProfileId: string;
  profile: CodexProfileItem | null;
  stoppedCount: number;
  failedCount: number;
  error?: string;
}

export interface LocalCodexCliStatus {
  detected: boolean;
  hasAuth: boolean;
  authMode: string | null;
  accountId: string | null;
  lastRefresh: string | null;
}

// ─── Codex Rate Limits ─────────────────────────────────────

export interface CodexRateLimitWindow {
  usedPercent: number;
  windowDurationMins: number;
  resetsAt: number;
}

export interface CodexRateLimitCredits {
  hasCredits: boolean;
  unlimited: boolean;
  balance: string;
}

export interface CodexRateLimitData {
  limitId: string | null;
  planType: string | null;
  primary: CodexRateLimitWindow | null;
  secondary: CodexRateLimitWindow | null;
  credits: CodexRateLimitCredits | null;
}

export type CodexRateLimitsResponse =
  | { available: true; rateLimits: CodexRateLimitData }
  | { available: false; reason: string };

export function getErrorMessage(err: unknown, fallback: string): string {
  if (typeof err === 'object' && err !== null && 'message' in err) {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === 'string' && msg.trim()) return msg;
  }
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}
