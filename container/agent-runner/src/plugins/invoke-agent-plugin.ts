/**
 * InvokeAgentPlugin — invoke_agent tool for cross-provider agent calls.
 *
 * Allows a running agent to synchronously call another runner for a one-shot
 * task. The sub-agent gets basic code/file
 * tools but no AgentDock MCP tools (no send_message, schedule_task, etc.).
 *
 * Safety: recursive calls are blocked via HAPPYCLAW_INVOKE_DEPTH env var.
 */

import type {
  ContextPlugin,
  PluginContext,
  ToolDefinition,
  ToolResult,
} from 'agentdock-agent-runner-core';
import { listRunnerManifests } from '../runners/index.js';
import type { OneShotInvoker } from '../runners/types.js';

const INVOKE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

function listAvailableOneShotInvokers(cwd: string): OneShotInvoker[] {
  return listRunnerManifests()
    .map(
      (manifest) =>
        manifest.createOneShotInvoker?.({
          env: process.env,
          cwd,
        }) || null,
    )
    .filter((invoker): invoker is OneShotInvoker => !!invoker);
}

function buildRegistryDescription(invokers: OneShotInvoker[]): string {
  const lines = [
    'Call another AI agent to perform a one-shot task synchronously.',
    '',
    'The sub-agent has access to file/code tools (Read, Write, Bash, etc.) in the current workspace,',
    'but NOT to AgentDock tools (send_message, memory, tasks, etc.).',
    '',
  ];

  lines.push('Available providers:');

  for (const invoker of invokers) {
    lines.push(
      `• provider="${invoker.runnerId}" — ${invoker.label}. Models: ${(invoker.models || []).join(', ') || 'unspecified'}. Default: ${invoker.defaultModel || 'provider default'}`,
    );
    if (invoker.description) {
      lines.push(`  ${invoker.description}`);
    }
  }
  if (invokers.length === 0) {
    lines.push('• (none — no credentials configured)');
  }

  lines.push(
    '',
    'Constraints:',
    '• 5 minute timeout — design prompts for focused, bounded tasks',
    '• No AgentDock tools — sub-agent cannot send messages, schedule tasks, or access memory',
    '• No recursion — sub-agent cannot call invoke_agent again',
    '• No session — each call is independent, no context preserved',
    '• Write clear, self-contained prompts — the sub-agent has no knowledge of your conversation',
  );

  return lines.join('\n');
}

// ─── Plugin ─────────────────────────────────────────────────

export class InvokeAgentPlugin implements ContextPlugin {
  readonly name = 'invoke-agent';

  isEnabled(_ctx: PluginContext): boolean {
    // Disable in sub-agent calls to prevent recursion
    return !process.env.HAPPYCLAW_INVOKE_DEPTH;
  }

  getTools(ctx: PluginContext): ToolDefinition[] {
    const cwd = ctx.workspaceGroup;
    const invokers = listAvailableOneShotInvokers(cwd);
    const availableProviders = invokers.map((invoker) => invoker.runnerId);

    // No providers available — don't expose the tool
    if (availableProviders.length === 0) return [];

    return [
      {
        name: 'invoke_agent',
        description: buildRegistryDescription(invokers),
        parameters: {
          type: 'object' as const,
          properties: {
            provider: {
              type: 'string',
              enum: availableProviders,
              description: `Target provider: ${availableProviders.map((p) => `"${p}"`).join(' or ')}`,
            },
            prompt: {
              type: 'string',
              description:
                'Complete, self-contained task description for the sub-agent',
            },
            model: {
              type: 'string',
              description: `Model override. ${invokers.map((invoker) => `${invoker.label}: default ${invoker.defaultModel || 'provider default'}`).join('. ')}`,
            },
            max_turns: {
              type: 'number',
              description:
                'Max tool-use turns (default 10). Runners that do not support this option may ignore it.',
            },
            thinking_effort: {
              type: 'string',
              enum: ['low', 'medium', 'high', 'max'],
              description:
                'Thinking/reasoning effort level. low=fast, high=thorough, max=deepest reasoning.',
            },
          },
          required: ['provider', 'prompt'],
        },
        execute: async (args: Record<string, unknown>): Promise<ToolResult> => {
          const provider = args.provider as string;
          const prompt = args.prompt as string;
          const effort = args.thinking_effort as string | undefined;

          if (!prompt?.trim()) {
            return { content: 'prompt is required', isError: true };
          }

          try {
            const invoker = invokers.find((item) => item.runnerId === provider);
            if (!invoker) {
              return {
                content: `Unknown provider "${provider}". Use ${availableProviders.map((p) => `"${p}"`).join(' or ')}.`,
                isError: true,
              };
            }
            const result = await invoker.invoke({
              prompt,
              cwd,
              model: args.model as string | undefined,
              thinkingEffort: effort,
              timeoutMs: INVOKE_TIMEOUT_MS,
              maxTurns: (args.max_turns as number) || 10,
            });

            return { content: result || '(sub-agent returned empty response)' };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes('abort') || msg.includes('Abort')) {
              return {
                content: 'Sub-agent call timed out (5 minute limit).',
                isError: true,
              };
            }
            return { content: `Sub-agent error: ${msg}`, isError: true };
          }
        },
      },
    ];
  }

  getSystemPromptSection(_ctx: PluginContext): string {
    return '';
  }
}
