import type { RunnerManifest } from '../types.js';
import { descriptorHealthCheck, descriptorModels } from '../health.js';
import { RUNNER_DESCRIPTORS } from '../../runner-descriptor.types.js';

function configuredModel(ctxModel?: string): string | undefined {
  return (
    ctxModel?.trim() || process.env.HAPPYCLAW_TRAEX_MODEL?.trim() || undefined
  );
}

function configuredCommand(ctxCommand?: string): string {
  return (
    ctxCommand?.trim() || process.env.HAPPYCLAW_TRAEX_COMMAND?.trim() || 'traex'
  );
}

export const traexManifest: RunnerManifest = {
  descriptor: RUNNER_DESCRIPTORS.traex,
  createRunner: async (ctx) => {
    const { CodexRunner } = await import('../codex/runner.js');
    return new CodexRunner({
      ...ctx,
      model: configuredModel(ctx.containerInput.runnerConfig?.model),
      thinkingEffort:
        ctx.containerInput.runnerConfig?.thinkingEffort || ctx.thinkingEffort,
      command: configuredCommand(ctx.containerInput.runnerConfig?.command),
      commandDefault: 'traex',
      runnerId: 'traex',
      runnerLabel: 'TraeX',
      instructionsMode: 'developer_instructions',
      includeWebSearchMode: false,
      mcpServersMode: 'none',
      aliasBuiltinMcpServer: false,
      useDynamicTools: true,
      supportsMidQueryPush: false,
      builtinMcpServerName: undefined,
    });
  },
  healthCheck: (ctx) =>
    descriptorHealthCheck(RUNNER_DESCRIPTORS.traex, ctx.env),
  listModels: async () => descriptorModels(RUNNER_DESCRIPTORS.traex),
};

export default traexManifest;
