import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import type { ModelReasoningEffort } from '@openai/codex-sdk';

import { RUNNER_DESCRIPTORS } from '../runner-descriptor.types.js';
import { runnerAuthAvailable } from './health.js';

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

/**
 * one-shot 的认证判断一律走 descriptor 的 authProbe。
 *
 * 这里曾经每个 runner 手写一份「猜凭据文件路径」的检查，结果各错各的：
 * agy 探的是老 gemini-cli 的遗留文件，claude 只看环境变量、完全漏掉
 * keychain 登录。探针是单一真相源，别再在这里复制一份。
 */
export function hasClaudeOneShotAuth(env: NodeJS.ProcessEnv): boolean {
  return runnerAuthAvailable(RUNNER_DESCRIPTORS.claude, env);
}

export function hasCodexOneShotAuth(env: NodeJS.ProcessEnv): boolean {
  return runnerAuthAvailable(RUNNER_DESCRIPTORS.codex, env);
}

export function hasAgyOneShotAuth(env: NodeJS.ProcessEnv): boolean {
  return runnerAuthAvailable(RUNNER_DESCRIPTORS.agy, env);
}

export async function invokeAgyOneShot(input: {
  prompt: string;
  model: string;
  cwd: string;
  timeoutMs: number;
}): Promise<string> {
  const { prepareAgyHome } = await import('./agy/agy-env.js');
  const agyProbe = spawnSync('agy', ['--version'], { encoding: 'utf8' });
  if (agyProbe.error || agyProbe.status !== 0) {
    throw new Error(
      `Antigravity CLI not available: ${agyProbe.error?.message || agyProbe.stderr || agyProbe.stdout}`,
    );
  }

  // 一次性调用也用隔离 HOME，避免污染用户真实会话存储
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-agy-os-'));
  prepareAgyHome(homeDir);
  try {
    const child = spawn(
      'agy',
      [
        `--print=${input.prompt}`,
        '--dangerously-skip-permissions',
        '--print-timeout',
        `${Math.max(60, Math.ceil(input.timeoutMs / 1000))}s`,
        '--model',
        input.model,
      ],
      {
        cwd: input.cwd,
        env: {
          ...(process.env as Record<string, string>),
          HOME: homeDir,
          HAPPYCLAW_INVOKE_DEPTH: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
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
            `Antigravity CLI exited with code ${exitCode}`,
        );
      }
      return stdout.trim();
    } finally {
      clearTimeout(timer);
    }
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
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
      env: {
        ...(process.env as Record<string, string>),
        HAPPYCLAW_INVOKE_DEPTH: '1',
      },
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

export function hasGrokOneShotAuth(env: NodeJS.ProcessEnv): boolean {
  return runnerAuthAvailable(RUNNER_DESCRIPTORS.grok, env);
}

/** grok 的 --effort 取值域比其他 runner 宽，多出 none/minimal/xhigh。 */
function toGrokEffort(effort: string): string {
  const allowed = new Set([
    'none',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ]);
  return allowed.has(effort) ? effort : 'medium';
}

export async function invokeGrokOneShot(input: {
  prompt: string;
  model: string;
  cwd: string;
  thinkingEffort?: string;
  timeoutMs: number;
  maxTurns?: number;
}): Promise<string> {
  const { prepareGrokHome } = await import('./grok/grok-env.js');
  const grokProbe = spawnSync('grok', ['--version'], { encoding: 'utf8' });
  if (grokProbe.error || grokProbe.status !== 0) {
    throw new Error(
      `Grok CLI not available: ${grokProbe.error?.message || grokProbe.stderr || grokProbe.stdout}`,
    );
  }

  // 一次性调用也用隔离 HOME，避免污染用户真实会话存储；认证软链回真实 home
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-grok-os-'));
  prepareGrokHome(homeDir);
  try {
    const args = [
      '-p',
      input.prompt,
      '--output-format',
      'json',
      '--model',
      input.model,
      '--permission-mode',
      'bypassPermissions',
      '--no-ask-user',
    ];
    if (input.thinkingEffort) {
      args.push('--effort', toGrokEffort(input.thinkingEffort));
    }
    if (input.maxTurns) args.push('--max-turns', String(input.maxTurns));

    const child = spawn('grok', args, {
      cwd: input.cwd,
      env: {
        ...(process.env as Record<string, string>),
        GROK_HOME: homeDir,
        HAPPYCLAW_INVOKE_DEPTH: '1',
      },
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
            `Grok CLI exited with code ${exitCode}`,
        );
      }
      // 未登录等 CLI 级错误也走 stdout，形如 {"type":"error","message":"..."}
      const parsed = JSON.parse(stdout) as {
        text?: string;
        type?: string;
        message?: string;
      };
      if (parsed.type === 'error') {
        throw new Error(parsed.message || 'Grok CLI returned an error');
      }
      return (parsed.text || '').trim();
    } finally {
      clearTimeout(timer);
    }
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
}
