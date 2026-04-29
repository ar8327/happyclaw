import { ClaudeRunner } from '../../providers/claude/claude-runner.js';
import type { RunnerManifest } from '../types.js';
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
  descriptor: {
    id: 'claude',
    label: 'Claude',
    description: 'Claude Code CLI runner with native turn streaming and MCP tools.',
    defaultModel: 'opus',
    modelPatterns: ['^(opus|sonnet|haiku)$', '^claude-'],
    capabilities: {
      sessionResume: 'strong',
      interrupt: 'strong',
      imageInput: true,
      usage: 'exact',
      midQueryPush: true,
      runtimeModeSwitch: false,
      toolStreaming: 'fine',
      backgroundTasks: true,
      subAgent: 'tool-only',
      customTools: 'mcp',
      mcpTransport: ['stdio'],
      skills: ['native', 'tool-loader'],
      ephemeralSession: true,
      filesystemAccess: true,
    },
    lifecycle: {
      turnBoundary: 'native',
      archivalTrigger: ['pre_compact'],
      contextShrinkTrigger: 'native_event',
      beforeToolExecutionGuard: 'native_hook',
      hookStreaming: 'progress',
      postCompactRepair: 'native',
    },
    promptContract: {
      mode: 'append',
      dynamicContextReload: 'turn',
    },
    runtimeContract: {
      requiredCommands: ['claude'],
      auth: 'external_cli',
    },
    toolContract: {
      mode: 'mcp_stdio',
      supportsUserMcp: true,
      userMcpSources: ['happyclaw', 'claude_settings', 'profile'],
      builtinServerName: 'happyclaw',
    },
    compatibility: {
      chat: 'full',
      im: 'full',
      observability: 'full',
    },
  },
  createRunner: (ctx) =>
    new ClaudeRunner({
      ...ctx,
      model: configuredModel(ctx.containerInput.runnerConfig?.model),
      thinkingEffort:
        ctx.containerInput.runnerConfig?.thinkingEffort ||
        ctx.thinkingEffort,
    }),
  createOneShotInvoker: (ctx) =>
    hasClaudeOneShotAuth(ctx.env)
      ? {
          runnerId: 'claude',
          label: 'Claude',
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
