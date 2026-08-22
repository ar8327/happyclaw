import type { RunnerManifest } from '../types.js';
import { RUNNER_DESCRIPTORS } from '../../runner-descriptor.types.js';
import { hasAgyOneShotAuth, invokeAgyOneShot } from '../one-shot-invokers.js';

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
