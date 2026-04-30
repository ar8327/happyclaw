import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import type { ModelReasoningEffort } from '@openai/codex-sdk';

type ClaudeEffort = 'low' | 'medium' | 'high' | 'max';

const CLAUDE_ALLOWED_TOOLS = [
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'Bash',
  'WebSearch',
  'WebFetch',
];

export function hasClaudeOneShotAuth(env: NodeJS.ProcessEnv): boolean {
  return !!(
    env.ANTHROPIC_API_KEY ||
    env.CLAUDE_API_KEY ||
    env.CLAUDE_CODE ||
    env.CLAUDE_CODE_OAUTH_TOKEN ||
    env.HAPPYCLAW_CLAUDE_AVAILABLE === '1'
  );
}

export function hasCodexOneShotAuth(env: NodeJS.ProcessEnv): boolean {
  if (
    env.OPENAI_API_KEY ||
    env.CODEX_API_KEY ||
    env.HAPPYCLAW_CODEX_AVAILABLE === '1'
  ) {
    return true;
  }
  const codexHome = env.CODEX_HOME || path.join(os.homedir(), '.codex');
  try {
    return fs.existsSync(path.join(codexHome, 'auth.json'));
  } catch {
    return false;
  }
}

function toCodexEffort(effort: string): ModelReasoningEffort {
  const map: Record<string, ModelReasoningEffort> = {
    low: 'low',
    medium: 'medium',
    high: 'high',
    max: 'xhigh',
  };
  return map[effort] || 'medium';
}

function toClaudeEffort(effort: string): ClaudeEffort {
  const map: Record<string, ClaudeEffort> = {
    low: 'low',
    medium: 'medium',
    high: 'high',
    max: 'max',
  };
  return map[effort] || 'medium';
}

export async function invokeCodexOneShot(input: {
  prompt: string;
  model: string;
  cwd: string;
  thinkingEffort?: string;
  timeoutMs: number;
}): Promise<string> {
  const { Codex } = await import('@openai/codex-sdk');
  const codex = new Codex({
    apiKey: process.env.OPENAI_API_KEY,
    env: {
      ...(process.env as Record<string, string>),
      HAPPYCLAW_INVOKE_DEPTH: '1',
    },
  });
  const thread = codex.startThread({
    model: input.model,
    workingDirectory: input.cwd,
    skipGitRepoCheck: true,
    sandboxMode: 'danger-full-access',
    approvalPolicy: 'never',
    ...(input.thinkingEffort
      ? { modelReasoningEffort: toCodexEffort(input.thinkingEffort) }
      : {}),
  });

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), input.timeoutMs);
  try {
    const result = await thread.run(input.prompt, { signal: abort.signal });
    return result.finalResponse;
  } finally {
    clearTimeout(timer);
  }
}

export async function invokeClaudeOneShot(input: {
  prompt: string;
  model: string;
  cwd: string;
  thinkingEffort?: string;
  timeoutMs: number;
  maxTurns?: number;
}): Promise<string> {
  const prevAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.ANTHROPIC_AUTH_TOKEN;

  try {
    const claudeProbe = spawnSync('claude', ['--version'], {
      encoding: 'utf8',
    });
    if (claudeProbe.error || claudeProbe.status !== 0) {
      throw new Error(
        `Claude CLI not available: ${claudeProbe.error?.message || claudeProbe.stderr || claudeProbe.stdout}`,
      );
    }

    const boundedPrompt = [
      `You must complete this task within at most ${input.maxTurns || 10} tool-use turns.`,
      '',
      input.prompt,
    ].join('\n');
    const args = [
      '-p',
      '--output-format',
      'json',
      '--model',
      input.model,
      '--permission-mode',
      'bypassPermissions',
      '--allow-dangerously-skip-permissions',
      '--allowedTools',
      CLAUDE_ALLOWED_TOOLS.join(','),
      boundedPrompt,
    ];
    if (input.thinkingEffort) {
      args.splice(
        args.length - 1,
        0,
        '--effort',
        toClaudeEffort(input.thinkingEffort),
      );
    }

    const child = spawn('claude', args, {
      cwd: input.cwd,
      env: process.env as Record<string, string>,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    const timer = setTimeout(() => {
      child.kill('SIGINT');
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL');
      }, 1000);
    }, input.timeoutMs);
    try {
      const exitCode = await new Promise<number>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code) => resolve(code ?? 0));
      });
      if (exitCode !== 0) {
        throw new Error(
          stderr.trim() ||
            stdout.trim() ||
            `Claude CLI exited with code ${exitCode}`,
        );
      }
      const parsed = JSON.parse(stdout) as {
        result?: string;
        is_error?: boolean;
      };
      if (parsed.is_error)
        throw new Error(parsed.result || 'Claude CLI returned an error');
      return parsed.result || '';
    } finally {
      clearTimeout(timer);
    }
  } finally {
    if (prevAuthToken !== undefined)
      process.env.ANTHROPIC_AUTH_TOKEN = prevAuthToken;
  }
}
