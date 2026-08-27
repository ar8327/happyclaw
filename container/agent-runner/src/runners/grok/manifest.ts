import type { RunnerManifest } from '../types.js';
import { RUNNER_DESCRIPTORS } from '../../runner-descriptor.types.js';
import { hasGrokOneShotAuth, invokeGrokOneShot } from '../one-shot-invokers.js';

function configuredModel(ctxModel?: string): string {
  return (
    ctxModel ||
    process.env.HAPPYCLAW_GROK_MODEL ||
    RUNNER_DESCRIPTORS.grok.defaultModel ||
    'grok-4.6'
  );
}

export const grokManifest: RunnerManifest = {
  descriptor: RUNNER_DESCRIPTORS.grok,
  createRunner: async (ctx) => {
    const { GrokRunner } = await import('./runner.js');
    return new GrokRunner({
      ...ctx,
      model: configuredModel(ctx.containerInput.runnerConfig?.model),
      thinkingEffort:
        ctx.containerInput.runnerConfig?.thinkingEffort || ctx.thinkingEffort,
      command: ctx.containerInput.runnerConfig?.command,
      builtinMcpServerName:
        RUNNER_DESCRIPTORS.grok.toolContract.builtinServerName,
    });
  },
  createOneShotInvoker: (ctx) => {
    if (!hasGrokOneShotAuth(ctx.env)) return null;
    const defaultModel = configuredModel();
    return {
      runnerId: 'grok',
      label: 'Grok',
      description: RUNNER_DESCRIPTORS.grok.description,
      defaultModel,
      models: [defaultModel],
      invoke: (input) =>
        invokeGrokOneShot({
          ...input,
          model: input.model || defaultModel,
        }),
    };
  },
};
