import { execFile } from 'child_process';
import { promisify } from 'util';

import { RUNNER_DESCRIPTORS } from '../../runner-descriptor.types.js';
import { logger } from '../../logger.js';
import { buildRunnerHealth, modelsForDescriptor } from '../../runner-health.js';
import type { RunnerModel } from '../../types.js';
import type { RunnerServerManifest } from '../types.js';

const execFileAsync = promisify(execFile);
const MODEL_CATALOG_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const MODEL_CATALOG_TIMEOUT_MS = 5_000;
const MODEL_CATALOG_MAX_OUTPUT_BYTES = 5 * 1024 * 1024;

interface TraexCliModel {
  name?: unknown;
  real_name?: unknown;
  provider?: unknown;
  description?: unknown;
}

interface ModelCatalogState {
  lastRefreshAttemptAt: number;
  models?: RunnerModel[];
  refreshInFlight?: Promise<RunnerModel[]>;
}

const catalogStates = new Map<string, ModelCatalogState>();

function catalogStateKey(
  command: string,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): string {
  return JSON.stringify([command, env.TRAE_HOME || '', env.HOME || '']);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function normalizeTraexCliModels(
  stdout: string,
  cachedModels: RunnerModel[] = [],
): RunnerModel[] {
  const parsed = JSON.parse(stdout) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('TraeX models output is not an array');
  }

  const cachedByName = new Map<string, RunnerModel>();
  for (const model of cachedModels) {
    cachedByName.set(model.id.toLowerCase(), model);
    if (model.label) cachedByName.set(model.label.toLowerCase(), model);
  }

  const models: RunnerModel[] = [];
  const seen = new Set<string>();
  for (const raw of parsed) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const model = raw as TraexCliModel;
    const id = stringValue(model.name);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const realName = stringValue(model.real_name);
    const cached = cachedByName.get((realName || id).toLowerCase());
    models.push({
      id,
      label: realName || cached?.label || id,
      description: stringValue(model.description) || cached?.description,
      ...(stringValue(model.provider) || cached?.modelProvider
        ? {
            modelProvider: stringValue(model.provider) || cached?.modelProvider,
          }
        : {}),
      ...(cached?.supportedThinkingEfforts
        ? { supportedThinkingEfforts: cached.supportedThinkingEfforts }
        : {}),
      ...(cached?.backendVariants
        ? { backendVariants: cached.backendVariants }
        : {}),
    });
  }
  if (models.length === 0) {
    throw new Error('TraeX models output did not contain any models');
  }
  return models;
}

export async function listTraexModels(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
  options: { force?: boolean } = {},
): Promise<RunnerModel[]> {
  const command = env.HAPPYCLAW_TRAEX_COMMAND?.trim() || 'traex';
  const stateKey = catalogStateKey(command, env);
  const state = catalogStates.get(stateKey) || { lastRefreshAttemptAt: 0 };
  catalogStates.set(stateKey, state);
  const now = Date.now();
  if (
    !options.force &&
    state.models &&
    now - state.lastRefreshAttemptAt < MODEL_CATALOG_REFRESH_INTERVAL_MS
  ) {
    return state.models;
  }
  if (state.refreshInFlight) return state.refreshInFlight;

  state.lastRefreshAttemptAt = now;
  state.refreshInFlight = (async () => {
    try {
      const { stdout } = await execFileAsync(command, ['models', '--json'], {
        env: { ...process.env, ...env },
        timeout: MODEL_CATALOG_TIMEOUT_MS,
        maxBuffer: MODEL_CATALOG_MAX_OUTPUT_BYTES,
        windowsHide: true,
      });
      const cachedModels = modelsForDescriptor(RUNNER_DESCRIPTORS.traex, env);
      state.models = normalizeTraexCliModels(stdout, cachedModels);
      return state.models;
    } catch (err) {
      logger.warn(
        { command, err },
        'Failed to refresh TraeX model catalog; using cached models',
      );
      state.models =
        state.models || modelsForDescriptor(RUNNER_DESCRIPTORS.traex, env);
      return state.models;
    }
  })().finally(() => {
    state.refreshInFlight = undefined;
  });
  return state.refreshInFlight;
}

export const traexServerManifest: RunnerServerManifest = {
  descriptor: RUNNER_DESCRIPTORS.traex,
  healthCheck: () => buildRunnerHealth(RUNNER_DESCRIPTORS.traex),
  listModels: listTraexModels,
  profileSchema: () => RUNNER_DESCRIPTORS.traex.profileSchema || null,
};

export default traexServerManifest;
