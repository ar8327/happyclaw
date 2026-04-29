import type { RunnerManifest } from '../types.js';
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
  descriptor: {
    id: 'codex',
    label: 'Codex',
    description: 'Codex CLI runner with instruction-file prompt injection.',
    defaultModel: 'gpt-5.4',
    modelPatterns: ['^gpt-[a-z0-9._-]+$', '^o[1-9](?:$|[-._])'],
    capabilities: {
      sessionResume: 'weak',
      interrupt: 'weak',
      imageInput: true,
      usage: 'approx',
      midQueryPush: false,
      runtimeModeSwitch: false,
      toolStreaming: 'coarse',
      backgroundTasks: false,
      subAgent: 'tool-only',
      customTools: 'mcp',
      mcpTransport: ['stdio'],
      skills: ['tool-loader'],
      ephemeralSession: true,
      filesystemAccess: true,
    },
    lifecycle: {
      turnBoundary: 'native',
      archivalTrigger: ['turn_threshold', 'cleanup_only'],
      contextShrinkTrigger: 'synthetic',
      beforeToolExecutionGuard: 'sandbox_only',
      hookStreaming: 'none',
      postCompactRepair: 'synthetic',
    },
    promptContract: {
      mode: 'instructions_file',
      dynamicContextReload: 'turn',
    },
    runtimeContract: {
      requiredNodePackages: ['@openai/codex-sdk'],
      requiredCommands: ['codex'],
      auth: 'external_cli',
    },
    toolContract: {
      mode: 'mcp_stdio',
      supportsUserMcp: true,
      userMcpSources: ['happyclaw', 'codex_config', 'profile'],
      builtinServerName: 'happyclaw',
    },
    compatibility: {
      chat: 'full',
      im: 'degraded',
      observability: 'degraded',
    },
  },
  createRunner: async (ctx) => {
    const { CodexRunner } =
      await import('../../providers/codex/codex-runner.js');
    return new CodexRunner({
      ...ctx,
      model: configuredModel(ctx.containerInput.runnerConfig?.model),
      thinkingEffort:
        ctx.containerInput.runnerConfig?.thinkingEffort || ctx.thinkingEffort,
    });
  },
  createOneShotInvoker: (ctx) => {
    const defaultModel =
      ctx.env.HAPPYCLAW_CODEX_MODEL || ctx.env.OPENAI_MODEL || 'gpt-5.4';
    return hasCodexOneShotAuth(ctx.env)
      ? {
          runnerId: 'codex',
          label: 'Codex',
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
