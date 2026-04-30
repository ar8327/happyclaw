import type { RunnerManifest } from '../types.js';
import { RUNNER_DESCRIPTORS } from '../../runner-descriptor.types.js';
import { descriptorHealthCheck, descriptorModels } from '../health.js';
import {
  hasCodexOneShotAuth,
  invokeCodexOneShot,
} from '../one-shot-invokers.js';

function configuredModel(ctxModel?: string): string {
  return (
    ctxModel ||
    process.env.HAPPYCLAW_CODEX_MODEL ||
    process.env.OPENAI_MODEL ||
    'gpt-5.4'
  );
}

export const codexManifest: RunnerManifest = {
  descriptor: RUNNER_DESCRIPTORS.codex,
  createRunner: async (ctx) => {
    const { CodexRunner } = await import('./runner.js');
    return new CodexRunner({
      ...ctx,
      model: configuredModel(ctx.containerInput.runnerConfig?.model),
      thinkingEffort:
        ctx.containerInput.runnerConfig?.thinkingEffort || ctx.thinkingEffort,
      command: ctx.containerInput.runnerConfig?.command,
      builtinMcpServerName:
        RUNNER_DESCRIPTORS.codex.toolContract.builtinServerName,
    });
  },
  healthCheck: (ctx) =>
    descriptorHealthCheck(RUNNER_DESCRIPTORS.codex, ctx.env),
  listModels: async () => descriptorModels(RUNNER_DESCRIPTORS.codex),
  createOneShotInvoker: (ctx) => {
    const defaultModel =
      ctx.env.HAPPYCLAW_CODEX_MODEL || ctx.env.OPENAI_MODEL || 'gpt-5.4';
    return hasCodexOneShotAuth(ctx.env)
      ? {
          runnerId: 'codex',
          label: 'Codex',
          description: RUNNER_DESCRIPTORS.codex.description,
          defaultModel,
          models: [defaultModel],
          invoke: (input) =>
            invokeCodexOneShot({
              ...input,
              model: input.model || defaultModel,
            }),
        }
      : null;
  },
};
