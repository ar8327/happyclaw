import { execFile } from 'child_process';
import { promisify } from 'util';

import { RUNNER_DESCRIPTORS } from '../../runner-descriptor.types.js';
import { logger } from '../../logger.js';
import { buildRunnerHealth } from '../../runner-health.js';
import type { RunnerModel } from '../../types.js';
import type { RunnerServerManifest } from '../types.js';

const execFileAsync = promisify(execFile);
const MODEL_CATALOG_TIMEOUT_MS = 5_000;
const MODEL_CATALOG_MAX_OUTPUT_BYTES = 5 * 1024 * 1024;

interface TraexCliModel {
  name?: unknown;
  real_name?: unknown;
  description?: unknown;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function normalizeTraexCliModels(stdout: string): RunnerModel[] {
  const parsed = JSON.parse(stdout) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('TraeX models output is not an array');
  }

  const models: RunnerModel[] = [];
  const seen = new Set<string>();
  for (const raw of parsed) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const model = raw as TraexCliModel;
    const id = stringValue(model.name);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({
      id,
      label: stringValue(model.real_name) || id,
      description: stringValue(model.description),
    });
  }
  return models;
}

export async function listTraexModels(): Promise<RunnerModel[]> {
  const command = process.env.HAPPYCLAW_TRAEX_COMMAND?.trim() || 'traex';
  try {
    const { stdout } = await execFileAsync(command, ['models', '--json'], {
      timeout: MODEL_CATALOG_TIMEOUT_MS,
      maxBuffer: MODEL_CATALOG_MAX_OUTPUT_BYTES,
      windowsHide: true,
    });
    return normalizeTraexCliModels(stdout);
  } catch (err) {
    logger.warn({ command, err }, 'Failed to load TraeX model catalog');
    return [];
  }
}

export const traexServerManifest: RunnerServerManifest = {
  descriptor: RUNNER_DESCRIPTORS.traex,
  healthCheck: () => buildRunnerHealth(RUNNER_DESCRIPTORS.traex),
  listModels: listTraexModels,
  profileSchema: () => RUNNER_DESCRIPTORS.traex.profileSchema || null,
};

export default traexServerManifest;
