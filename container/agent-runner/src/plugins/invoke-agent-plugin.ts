/**
 * InvokeAgentPlugin — invoke_agent tool for cross-provider agent calls.
 *
 * Allows a running agent (Claude or Codex) to synchronously call another
 * agent provider for a one-shot task. The sub-agent gets basic code/file
 * tools but no HappyClaw MCP tools (no send_message, schedule_task, etc.).
 *
 * Safety: recursive calls are blocked via HAPPYCLAW_INVOKE_DEPTH env var.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { Codex, type ModelReasoningEffort } from '@openai/codex-sdk';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { ContextPlugin, PluginContext, ToolDefinition, ToolResult } from 'happyclaw-agent-runner-core';

const INVOKE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

const CLAUDE_ALLOWED_TOOLS = [
  'Read', 'Write', 'Edit', 'Glob', 'Grep',
  'Bash', 'WebSearch', 'WebFetch',
];

type ClaudeEffort = 'low' | 'medium' | 'high' | 'max';

// ─── Provider availability detection ────────────────────────

interface ProviderInfo {
  available: boolean;
  defaultModel: string;
  models: string[];  // known/suggested models
  label: string;
}

function detectProviders(): { claude: ProviderInfo; codex: ProviderInfo } {
  // Claude: available if we have API key, OAuth token, or container-runner flagged it
  const hasClaudeKey = !!(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY);
  const isClaudeCode = !!process.env.CLAUDE_CODE;
  const hasClaudeOAuth = !!process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const flaggedAvailable = process.env.HAPPYCLAW_CLAUDE_AVAILABLE === '1';
  const claudeAvailable = hasClaudeKey || isClaudeCode || hasClaudeOAuth || flaggedAvailable;
  const claudeDefault = process.env.HAPPYCLAW_MODEL || 'sonnet';

  // Codex: available via API key, CLI login credentials, or container-runner flag
  const hasOpenAIKey = !!(process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY);
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  let hasCodexCliAuth = false;
  try { hasCodexCliAuth = fs.existsSync(path.join(codexHome, 'auth.json')); } catch {}
  const flaggedCodexAvailable = process.env.HAPPYCLAW_CODEX_AVAILABLE === '1';
  const codexAvailable = hasOpenAIKey || hasCodexCliAuth || flaggedCodexAvailable;
  const codexDefault = process.env.HAPPYCLAW_CODEX_MODEL || 'gpt-5.4';

  return {
    claude: {
      available: claudeAvailable,
      defaultModel: claudeDefault,
      models: ['haiku', 'sonnet', 'opus'],
      label: 'Claude (Anthropic)',
    },
    codex: {
      available: codexAvailable,
      defaultModel: codexDefault,
      models: [codexDefault],
      label: 'Codex (OpenAI)',
    },
  };
}

function buildDescription(providers: ReturnType<typeof detectProviders>): string {
  const lines = [
    'Call another AI agent to perform a one-shot task synchronously.',
    '',
    'The sub-agent has access to file/code tools (Read, Write, Bash, etc.) in the current workspace,',
    'but NOT to HappyClaw tools (send_message, memory, tasks, etc.).',
    '',
  ];

  // When-to-use guidance (only when both providers available)
  if (providers.claude.available && providers.codex.available) {
    lines.push(
      'When to choose a provider:',
      '• Use Codex (OpenAI GPT) for fast, focused code generation or edits',
      '• Use Claude for deep analysis, reasoning, or nuanced writing',
      '• Don\'t use for simple tasks you can handle yourself — the overhead isn\'t worth it',
      '',
    );
  }

  lines.push('Available providers:');

  if (providers.claude.available) {
    const p = providers.claude;
    lines.push(`• provider="claude" — ${p.label}. Models: ${p.models.join(', ')}. Default: ${p.defaultModel}`);
  }
  if (providers.codex.available) {
    const p = providers.codex;
    lines.push(`• provider="codex" — OpenAI GPT models. Default: ${p.defaultModel}`);
  }
  if (!providers.claude.available && !providers.codex.available) {
    lines.push('• (none — no credentials configured)');
  }

  lines.push(
    '',
    'Constraints:',
    '• 5 minute timeout — design prompts for focused, bounded tasks',
    '• No HappyClaw tools — sub-agent cannot send messages, schedule tasks, or access memory',
    '• No recursion — sub-agent cannot call invoke_agent again',
    '• No session — each call is independent, no context preserved',
    '• Write clear, self-contained prompts — the sub-agent has no knowledge of your conversation',
  );

  return lines.join('\n');
}

// ─── Effort normalization ───────────────────────────────────

function toCodexEffort(effort: string): ModelReasoningEffort {
  const map: Record<string, ModelReasoningEffort> = {
    low: 'low', medium: 'medium', high: 'high', max: 'xhigh',
  };
  return map[effort] || 'medium';
}

function toClaudeEffort(effort: string): ClaudeEffort {
  const map: Record<string, ClaudeEffort> = {
    low: 'low', medium: 'medium', high: 'high', max: 'max',
  };
  return map[effort] || 'medium';
}

// ─── Invokers ───────────────────────────────────────────────

async function invokeCodex(
  prompt: string,
  model: string,
  cwd: string,
  effort?: string,
): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  const codex = new Codex({
    ...(apiKey ? { apiKey } : {}),
    env: {
      ...process.env as Record<string, string>,
      HAPPYCLAW_INVOKE_DEPTH: '1',
    },
  });
  const thread = codex.startThread({
    model,
    workingDirectory: cwd,
    skipGitRepoCheck: true,
    sandboxMode: 'danger-full-access',
    approvalPolicy: 'never',
    ...(effort ? { modelReasoningEffort: toCodexEffort(effort) } : {}),
  });

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), INVOKE_TIMEOUT_MS);
  try {
    const result = await thread.run(prompt, { signal: abort.signal });
    return result.finalResponse;
  } finally {
    clearTimeout(timer);
  }
}

async function invokeClaude(
  prompt: string,
  model: string,
  cwd: string,
  maxTurns: number,
  effort?: string,
): Promise<string> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), INVOKE_TIMEOUT_MS);

  // Use shared home session credentials for OAuth token freshness.
  // Same pattern as memory-agent: avoids stale refresh tokens when the home
  // Claude session has already rotated the token.
  const credDir = process.env.HAPPYCLAW_CLAUDE_CREDENTIALS_DIR;
  const prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
  if (credDir) {
    process.env.CLAUDE_CONFIG_DIR = credDir;
  }

  // Clear ANTHROPIC_AUTH_TOKEN so the CLI uses OAuth from .credentials.json
  // instead of a stale third-party token inherited from the parent env.
  const prevAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.ANTHROPIC_AUTH_TOKEN;

  // ── DEBUG: credential diagnostics → write to file (MCP stderr is swallowed) ──
  const debugLines: string[] = [`[${new Date().toISOString()}] invokeClaude called`];
  const effectiveConfigDir = process.env.CLAUDE_CONFIG_DIR || '(unset)';
  const credFilePath = process.env.CLAUDE_CONFIG_DIR
    ? path.join(process.env.CLAUDE_CONFIG_DIR, '.credentials.json')
    : '(no config dir)';
  const credFileExists = credFilePath !== '(no config dir)' && fs.existsSync(credFilePath);
  let tokenPreview = '(none)';
  if (credFileExists) {
    try {
      const raw = JSON.parse(fs.readFileSync(credFilePath, 'utf-8'));
      const tok = raw?.claudeAiOauth?.accessToken;
      if (tok) tokenPreview = tok.substring(0, 25) + '…';
    } catch {}
  }
  debugLines.push(
    `  HAPPYCLAW_CLAUDE_CREDENTIALS_DIR = ${credDir ?? '(unset)'}`,
    `  CLAUDE_CONFIG_DIR (prev)         = ${prevConfigDir ?? '(unset)'}`,
    `  CLAUDE_CONFIG_DIR (now)          = ${effectiveConfigDir}`,
    `  credFile                         = ${credFilePath}`,
    `  credFileExists                   = ${credFileExists}`,
    `  tokenPreview                     = ${tokenPreview}`,
    `  ANTHROPIC_API_KEY set            = ${!!process.env.ANTHROPIC_API_KEY}`,
    `  CLAUDE_CODE_OAUTH_TOKEN set      = ${!!process.env.CLAUDE_CODE_OAUTH_TOKEN}`,
    `  HOME                             = ${process.env.HOME}`,
    `  homeCredExists                   = ${fs.existsSync(path.join(process.env.HOME || '', '.claude', '.credentials.json'))}`,
    `  cwd                              = ${model}`,
    `  model                            = ${model}`,
    `  ANTHROPIC_BASE_URL               = ${process.env.ANTHROPIC_BASE_URL ?? '(unset)'}`,
    `  ANTHROPIC_AUTH_TOKEN             = ${process.env.ANTHROPIC_AUTH_TOKEN ? 'set' : '(unset)'}`,
    `  CLAUDE_CODE_ENTRYPOINT           = ${process.env.CLAUDE_CODE_ENTRYPOINT ?? '(unset)'}`,
    `  CLAUDE_CODE                      = ${process.env.CLAUDE_CODE ?? '(unset)'}`,
    `  DEBUG_CLAUDE_AGENT_SDK           = ${process.env.DEBUG_CLAUDE_AGENT_SDK ?? '(unset)'}`,
    `  All CLAUDE_ vars                 = ${Object.keys(process.env).filter(k => k.startsWith('CLAUDE')).join(', ')}`,
    `  All ANTHROPIC_ vars              = ${Object.keys(process.env).filter(k => k.startsWith('ANTHROPIC')).join(', ')}`,
    `  All HAPPYCLAW_ vars              = ${Object.keys(process.env).filter(k => k.startsWith('HAPPYCLAW')).join(', ')}`,
  );
  // Dump full env snapshot (filter sensitive values)
  const envSnapshot: string[] = [];
  for (const [k, v] of Object.entries(process.env).sort(([a], [b]) => a.localeCompare(b))) {
    if (!v) continue;
    const isSensitive = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(k);
    envSnapshot.push(`    ${k} = ${isSensitive ? v.substring(0, 15) + '…' : v}`);
  }
  debugLines.push(`  --- FULL ENV (${envSnapshot.length} vars) ---`, ...envSnapshot);

  const debugFile = '/tmp/happyclaw-invoke-claude-debug.log';
  try { fs.appendFileSync(debugFile, debugLines.join('\n') + '\n'); } catch {}
  // ── END DEBUG ──

  try {
    const gen = query({
      prompt,
      options: {
        cwd,
        model,
        maxTurns,
        permissionMode: 'bypassPermissions' as const,
        allowedTools: CLAUDE_ALLOWED_TOOLS,
        abortController: abort,
        ...(effort ? { effort: toClaudeEffort(effort) } : {}),
      },
    });

    let resultText = '';
    for await (const msg of gen) {
      if ((msg as { type: string; result?: string }).type === 'result') {
        resultText = (msg as { result?: string }).result || '';
      }
    }
    return resultText;
  } catch (err) {
    // ── DEBUG: log the actual error to file ──
    try {
      const errMsg = err instanceof Error ? `${err.message}\n${err.stack}` : String(err);
      fs.appendFileSync(debugFile, `  ERROR: ${errMsg}\n`);
    } catch {}
    throw err;
  } finally {
    clearTimeout(timer);
    // Restore env
    if (credDir) {
      if (prevConfigDir !== undefined) {
        process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
      } else {
        delete process.env.CLAUDE_CONFIG_DIR;
      }
    }
    if (prevAuthToken !== undefined) {
      process.env.ANTHROPIC_AUTH_TOKEN = prevAuthToken;
    }
  }
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
    const providers = detectProviders();
    const availableProviders = [
      ...(providers.claude.available ? ['claude'] : []),
      ...(providers.codex.available ? ['codex'] : []),
    ];

    // No providers available — don't expose the tool
    if (availableProviders.length === 0) return [];

    return [
      {
        name: 'invoke_agent',
        description: buildDescription(providers),
        parameters: {
          type: 'object' as const,
          properties: {
            provider: {
              type: 'string',
              enum: availableProviders,
              description: `Target provider: ${availableProviders.map(p => `"${p}"`).join(' or ')}`,
            },
            prompt: {
              type: 'string',
              description: 'Complete, self-contained task description for the sub-agent',
            },
            model: {
              type: 'string',
              description: `Model override. ${providers.claude.available ? `Claude: ${providers.claude.models.join('/')} (default ${providers.claude.defaultModel})` : ''}${providers.claude.available && providers.codex.available ? '. ' : ''}${providers.codex.available ? `Codex: default ${providers.codex.defaultModel}` : ''}`,
            },
            max_turns: {
              type: 'number',
              description: 'Max tool-use turns (default 10). Only applies to Claude provider.',
            },
            thinking_effort: {
              type: 'string',
              enum: ['low', 'medium', 'high', 'max'],
              description: 'Thinking/reasoning effort level. low=fast, high=thorough, max=deepest reasoning.',
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
            let result: string;

            if (provider === 'codex') {
              if (!providers.codex.available) {
                return { content: 'Codex provider not available (no API key or CLI auth found).', isError: true };
              }
              const model = (args.model as string) || providers.codex.defaultModel;
              result = await invokeCodex(prompt, model, cwd, effort);
            } else if (provider === 'claude') {
              if (!providers.claude.available) {
                return { content: 'Claude provider not available (no API key).', isError: true };
              }
              const model = (args.model as string) || providers.claude.defaultModel;
              const maxTurns = (args.max_turns as number) || 10;
              result = await invokeClaude(prompt, model, cwd, maxTurns, effort);
            } else {
              return { content: `Unknown provider "${provider}". Use ${availableProviders.map(p => `"${p}"`).join(' or ')}.`, isError: true };
            }

            return { content: result || '(sub-agent returned empty response)' };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes('abort') || msg.includes('Abort')) {
              return { content: 'Sub-agent call timed out (5 minute limit).', isError: true };
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
