import type { RunnerManifest } from '../types.js';
import { RUNNER_DESCRIPTORS } from '../../runner-descriptor.types.js';
import { descriptorHealthCheck, descriptorModels } from '../health.js';
import {
  hasClaudeOneShotAuth,
  invokeClaudeOneShot,
} from '../one-shot-invokers.js';

function configuredModel(ctxModel?: string): string {
  return (
    ctxModel ||
    process.env.HAPPYCLAW_MODEL ||
    process.env.ANTHROPIC_MODEL ||
    'opus'
  );
}

export const claudeManifest: RunnerManifest = {
  descriptor: RUNNER_DESCRIPTORS.claude,
  createRunner: async (ctx) => {
    const { ClaudeRunner } = await import('./runner.js');
    return new ClaudeRunner({
      ...ctx,
      model: configuredModel(ctx.containerInput.runnerConfig?.model),
      thinkingEffort:
        ctx.containerInput.runnerConfig?.thinkingEffort || ctx.thinkingEffort,
      command: ctx.containerInput.runnerConfig?.command,
      builtinMcpServerName:
        RUNNER_DESCRIPTORS.claude.toolContract.builtinServerName,
    });
  },
  healthCheck: (ctx) =>
    descriptorHealthCheck(RUNNER_DESCRIPTORS.claude, ctx.env),
  listModels: async () => descriptorModels(RUNNER_DESCRIPTORS.claude),
  createOneShotInvoker: (ctx) =>
    hasClaudeOneShotAuth(ctx.env)
      ? {
          runnerId: 'claude',
          label: 'Claude',
          description: RUNNER_DESCRIPTORS.claude.description,
          defaultModel: ctx.env.HAPPYCLAW_MODEL || 'sonnet',
          models: ['haiku', 'sonnet', 'opus'],
          invoke: (input) =>
            invokeClaudeOneShot({
              ...input,
              model: input.model || ctx.env.HAPPYCLAW_MODEL || 'sonnet',
            }),
        }
      : null,
};
