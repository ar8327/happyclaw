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
    const disableMcp =
      process.env.HAPPYCLAW_TRAEX_DISABLE_MCP === '1' ||
      ctx.containerInput.runnerConfig?.config?.disableMcp === true;
    return new CodexRunner({
      ...ctx,
      model: configuredModel(ctx.containerInput.runnerConfig?.model),
      modelProvider: ctx.containerInput.runnerConfig?.modelProvider,
      thinkingEffort:
        ctx.containerInput.runnerConfig?.thinkingEffort || ctx.thinkingEffort,
      modelBackendVariant: ctx.containerInput.runnerConfig?.modelBackendVariant,
      command: configuredCommand(ctx.containerInput.runnerConfig?.command),
      commandDefault: 'traex',
      runnerId: 'traex',
      runnerLabel: 'TraeX',
      instructionsMode: 'developer_instructions',
      includeWebSearchMode: false,
      mcpServersMode: 'none',
      aliasBuiltinMcpServer: false,
      useDynamicTools: !disableMcp,
      supportsMidQueryPush: true,
      includeSteerClientUserMessageId: false,
      builtinMcpServerName: undefined,
    });
  },
  healthCheck: (ctx) =>
    descriptorHealthCheck(RUNNER_DESCRIPTORS.traex, ctx.env),
  listModels: async () => descriptorModels(RUNNER_DESCRIPTORS.traex),
};

export default traexManifest;
