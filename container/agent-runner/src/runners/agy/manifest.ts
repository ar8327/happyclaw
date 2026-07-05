import { execFile } from 'child_process';
import { promisify } from 'util';

import type { RunnerManifest } from '../types.js';
import type { RunnerModel } from '../../runner-descriptor.types.js';
import { RUNNER_DESCRIPTORS } from '../../runner-descriptor.types.js';
import { descriptorHealthCheck, descriptorModels } from '../health.js';
import { hasAgyOneShotAuth, invokeAgyOneShot } from '../one-shot-invokers.js';

const execFileAsync = promisify(execFile);

function configuredModel(ctxModel?: string): string {
  return (
    ctxModel ||
    process.env.HAPPYCLAW_AGY_MODEL ||
    RUNNER_DESCRIPTORS.agy.defaultModel ||
    'Gemini 3.1 Pro (High)'
  );
}

function configuredCompactThreshold(profileValue: unknown): number | undefined {
  const candidates = [
    profileValue,
    process.env.HAPPYCLAW_AGY_COMPACT_THRESHOLD_TOKENS,
  ];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null || candidate === '') {
      continue;
    }
    const value = Number(candidate);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  return undefined;
}

/** 优先实时读取 `agy models`，失败回落到描述符静态列表。 */
async function listAgyModels(): Promise<RunnerModel[]> {
  try {
    const result = await execFileAsync('agy', ['models'], {
      timeout: 10_000,
      windowsHide: true,
    });
    const models = result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('Error'))
      .map((line) => ({ id: line, label: line }));
    if (models.length > 0) return models;
  } catch {
    /* fall through */
  }
  return descriptorModels(RUNNER_DESCRIPTORS.agy);
}

export const agyManifest: RunnerManifest = {
  descriptor: RUNNER_DESCRIPTORS.agy,
  createRunner: async (ctx) => {
    const { AgyRunner } = await import('./runner.js');
    return new AgyRunner({
      ...ctx,
      model: configuredModel(ctx.containerInput.runnerConfig?.model),
      command: ctx.containerInput.runnerConfig?.command,
      builtinMcpServerName:
        RUNNER_DESCRIPTORS.agy.toolContract.builtinServerName,
      compactThresholdTokens: configuredCompactThreshold(
        ctx.containerInput.runnerConfig?.config?.compactThresholdTokens,
      ),
    });
  },
  healthCheck: (ctx) => descriptorHealthCheck(RUNNER_DESCRIPTORS.agy, ctx.env),
  listModels: () => listAgyModels(),
  createOneShotInvoker: (ctx) => {
    if (!hasAgyOneShotAuth(ctx.env)) return null;
    const defaultModel = configuredModel();
    return {
      runnerId: 'agy',
      label: 'Antigravity',
      description: RUNNER_DESCRIPTORS.agy.description,
      defaultModel,
      models: [defaultModel],
      invoke: (input) =>
        invokeAgyOneShot({
          ...input,
          model: input.model || defaultModel,
        }),
    };
  },
};
