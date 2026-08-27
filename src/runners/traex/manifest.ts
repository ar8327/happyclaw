import { RUNNER_DESCRIPTORS } from '../../runner-descriptor.types.js';
import { buildRunnerHealth } from '../../runner-health.js';
import type { RunnerModel } from '../../types.js';
import { createCliModelCatalog } from '../cli-model-catalog.js';
import type { RunnerServerManifest } from '../types.js';

interface TraexCliModel {
  name?: unknown;
  real_name?: unknown;
  provider?: unknown;
  description?: unknown;
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

export const listTraexModels = createCliModelCatalog({
  descriptor: RUNNER_DESCRIPTORS.traex,
  command: 'traex',
  commandEnv: 'HAPPYCLAW_TRAEX_COMMAND',
  args: ['models', '--json'],
  parse: normalizeTraexCliModels,
  stateEnvKeys: ['TRAE_HOME'],
});

export const traexServerManifest: RunnerServerManifest = {
  descriptor: RUNNER_DESCRIPTORS.traex,
  healthCheck: () => buildRunnerHealth(RUNNER_DESCRIPTORS.traex),
  listModels: () => listTraexModels(),
  profileSchema: () => RUNNER_DESCRIPTORS.traex.profileSchema || null,
};

export default traexServerManifest;
