import fs from 'fs';

import type { RunnerModel } from './runner-health.js';

export interface TraexAuthContext {
  authMode?: string;
  hasOpenAiApiKey: boolean;
}

export interface TraexModelSelection {
  model: string;
  modelProvider?: string;
  correctedLegacySelection: boolean;
}

export interface LegacyTraexRunnerMigration extends TraexModelSelection {
  runnerId: 'traex';
}

interface TraexResumeState {
  sessionId?: string;
  resumeAnchor?: string;
  bootstrapState?: {
    providerState?: Record<string, unknown>;
    recentImChannels?: string[];
    imChannelLastSeen?: Record<string, number>;
    currentPermissionMode?: string | null;
    lastMessageCursor?: string | null;
  };
}

interface TraexAuthFile {
  auth_mode?: unknown;
  OPENAI_API_KEY?: unknown;
}

export function readTraexAuthContext(
  authFile: string,
  env: Record<string, string | undefined>,
): TraexAuthContext {
  let auth: TraexAuthFile = {};
  try {
    if (fs.existsSync(authFile)) {
      auth = JSON.parse(fs.readFileSync(authFile, 'utf8')) as TraexAuthFile;
    }
  } catch {
    // Let TraeX report malformed authentication state. This helper only
    // provides a safe compatibility fallback for valid legacy sessions.
  }

  return {
    authMode:
      typeof auth.auth_mode === 'string' ? auth.auth_mode.trim() : undefined,
    hasOpenAiApiKey:
      !!env.OPENAI_API_KEY?.trim() ||
      (typeof auth.OPENAI_API_KEY === 'string' &&
        auth.OPENAI_API_KEY.trim().length > 0),
  };
}

/**
 * Repair the historical TraeX selection that stored only a lower-case model
 * id. Once provider-aware catalogs were enabled, `gpt-5.6-sol` started
 * resolving to OpenAI even though the session was authenticated with Trae and
 * had previously used `trae + GPT-5.6-Sol`.
 *
 * Keep this fallback deliberately narrow: only replace an exact OpenAI match
 * when OpenAI has no credential, Trae is the active auth mode, and the Trae
 * catalog contains exactly one case-insensitive equivalent.
 */
export function resolveTraexModelSelection(
  model: string,
  models: RunnerModel[],
  auth: TraexAuthContext,
): TraexModelSelection {
  const exact = models.find((candidate) => candidate.id === model);
  const exactSelection: TraexModelSelection = {
    model,
    modelProvider: exact?.modelProvider,
    correctedLegacySelection: false,
  };

  const normalized = model.toLocaleLowerCase('en-US');
  if (
    model !== normalized ||
    exact?.modelProvider !== 'openai' ||
    auth.authMode !== 'trae' ||
    auth.hasOpenAiApiKey
  ) {
    return exactSelection;
  }

  const traeMatches = models.filter(
    (candidate) =>
      candidate.modelProvider === 'trae' &&
      candidate.id.toLocaleLowerCase('en-US') === normalized,
  );
  if (traeMatches.length !== 1) return exactSelection;

  return {
    model: traeMatches[0].id,
    modelProvider: 'trae',
    correctedLegacySelection: true,
  };
}

/**
 * Some historical sessions persisted the Codex runner together with TraeX's
 * lower-case OpenAI catalog entry. Migrate only the same narrow legacy
 * selection handled above; all real Codex/OpenAI sessions remain untouched.
 */
export function resolveLegacyTraexRunnerMigration(
  storedRunnerId: string,
  model: string,
  models: RunnerModel[],
  auth: TraexAuthContext,
): LegacyTraexRunnerMigration | null {
  if (storedRunnerId !== 'codex') return null;

  const selection = resolveTraexModelSelection(model, models, auth);
  if (!selection.correctedLegacySelection) return null;
  return {
    ...selection,
    runnerId: 'traex',
  };
}

/**
 * A resumed TraeX thread keeps the ModelClient/AuthManager that was created
 * with it. When repairing a legacy OpenAI selection, metadata passed to
 * thread/resume is therefore insufficient: the old thread must not be
 * resumed. Preserve channel routing and permission state, but discard all
 * provider-thread-specific bootstrap data.
 */
export function resetTraexResumeStateForCorrectedSelection<
  T extends TraexResumeState,
>(input: T, correctedLegacySelection: boolean): T {
  if (!correctedLegacySelection) return input;

  return {
    ...input,
    sessionId: undefined,
    resumeAnchor: undefined,
    bootstrapState: input.bootstrapState
      ? {
          ...input.bootstrapState,
          providerState: undefined,
          lastMessageCursor: null,
        }
      : undefined,
  };
}
