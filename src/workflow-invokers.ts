import { spawn, spawnSync, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

export interface WorkflowInvokeInput {
  prompt: string;
  cwd: string;
  provider?: string;
  model?: string;
  thinkingEffort?: string;
  timeoutMs: number;
  maxTurns?: number;
  signal?: AbortSignal;
}

export interface WorkflowInvokeResult {
  provider: string;
  model: string | null;
  output: string;
  stdout: string;
  stderr: string;
}

export interface WorkflowProviderInfo {
  id: string;
  label: string;
  available: boolean;
  defaultModel?: string;
  description?: string;
}

function commandExists(command: string, args = ['--version']): boolean {
  const result = spawnSync(command, args, {
    stdio: 'ignore',
    timeout: 3000,
    windowsHide: true,
  });
  return (result.error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT';
}

function sanitizedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('HAPPYCLAW_') || key.startsWith('AGENTDOCK_')) {
      delete env[key];
    }
  }
  env.HAPPYCLAW_WORKFLOW_NODE = '1';
  env.HAPPYCLAW_INVOKE_DEPTH = '1';
  return env;
}

function collectProcess(child: ChildProcess, timeoutMs: number, signal?: AbortSignal): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let killedByTimeout = false;

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });

    const kill = (reason: string) => {
      if (settled) return;
      killedByTimeout = reason === 'timeout';
      try {
        if (child.pid) process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
      setTimeout(() => {
        if (settled) return;
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }, 1500).unref();
    };

    const timer = setTimeout(() => kill('timeout'), timeoutMs);
    timer.unref();

    const abortHandler = () => kill('abort');
    signal?.addEventListener('abort', abortHandler, { once: true });

    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abortHandler);
      reject(err);
    });

    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abortHandler);
      if (signal?.aborted) {
        reject(new Error('Workflow node cancelled'));
        return;
      }
      if (killedByTimeout) {
        reject(new Error(`Workflow node timed out after ${timeoutMs}ms`));
        return;
      }
      resolve({ code: code ?? 0, stdout, stderr });
    });
  });
}

async function invokeCodex(input: WorkflowInvokeInput): Promise<WorkflowInvokeResult> {
  const model = input.model || process.env.HAPPYCLAW_CODEX_MODEL || process.env.OPENAI_MODEL || 'gpt-5.4';
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdock-workflow-codex-'));
  const outFile = path.join(tmpDir, 'last-message.txt');
  const args = [
    'exec',
    '--skip-git-repo-check',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--dangerously-bypass-approvals-and-sandbox',
    '--cd',
    input.cwd,
    '--model',
    model,
    '--output-last-message',
    outFile,
    '-',
  ];
  const child = spawn('codex', args, {
    cwd: input.cwd,
    env: sanitizedEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });
  child.stdin?.end(input.prompt);
  const result = await collectProcess(child, input.timeoutMs, input.signal);
  try {
    const output = fs.existsSync(outFile)
      ? fs.readFileSync(outFile, 'utf8')
      : result.stdout.trim();
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || output || `codex exited with ${result.code}`);
    }
    return {
      provider: 'codex',
      model,
      output: output.trim(),
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function invokeClaude(input: WorkflowInvokeInput): Promise<WorkflowInvokeResult> {
  const model = input.model || process.env.HAPPYCLAW_MODEL || process.env.ANTHROPIC_MODEL || 'sonnet';
  const prompt = [
    `You must complete this task within at most ${input.maxTurns || 10} tool-use turns.`,
    '',
    input.prompt,
  ].join('\n');
  const args = [
    '-p',
    '--output-format',
    'json',
    '--model',
    model,
    '--permission-mode',
    'bypassPermissions',
    '--allow-dangerously-skip-permissions',
    '--allowedTools',
    'Read,Write,Edit,Glob,Grep,Bash,WebSearch,WebFetch',
    prompt,
  ];
  const child = spawn('claude', args, {
    cwd: input.cwd,
    env: sanitizedEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  const result = await collectProcess(child, input.timeoutMs, input.signal);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `claude exited with ${result.code}`);
  }
  const parsed = JSON.parse(result.stdout || '{}') as { result?: string; is_error?: boolean };
  if (parsed.is_error) throw new Error(parsed.result || 'Claude returned an error');
  return {
    provider: 'claude',
    model,
    output: (parsed.result || '').trim(),
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function invokeEcho(input: WorkflowInvokeInput): Promise<WorkflowInvokeResult> {
  return {
    provider: 'echo',
    model: input.model || null,
    output: `Echo workflow node result:\n${input.prompt}`,
    stdout: '',
    stderr: '',
  };
}

export function listWorkflowProviders(): WorkflowProviderInfo[] {
  return [
    {
      id: 'codex',
      label: 'Codex CLI',
      available: commandExists('codex'),
      defaultModel: process.env.HAPPYCLAW_CODEX_MODEL || process.env.OPENAI_MODEL || 'gpt-5.4',
      description: 'Runs `codex exec` with no AgentDock MCP tools injected.',
    },
    {
      id: 'claude',
      label: 'Claude CLI',
      available: commandExists('claude'),
      defaultModel: process.env.HAPPYCLAW_MODEL || process.env.ANTHROPIC_MODEL || 'sonnet',
      description: 'Runs `claude -p` with code/file tools only.',
    },
    {
      id: 'echo',
      label: 'Echo test provider',
      available: true,
      defaultModel: 'echo',
      description: 'Local no-token provider for workflow smoke tests.',
    },
  ];
}

export async function invokeWorkflowNode(input: WorkflowInvokeInput): Promise<WorkflowInvokeResult> {
  const provider = input.provider || (commandExists('codex') ? 'codex' : 'echo');
  if (provider === 'codex') {
    if (!commandExists('codex')) throw new Error('codex CLI is not available');
    return invokeCodex(input);
  }
  if (provider === 'claude') {
    if (!commandExists('claude')) throw new Error('claude CLI is not available');
    return invokeClaude(input);
  }
  if (provider === 'echo') return invokeEcho(input);
  throw new Error(`Unknown workflow provider "${provider}"`);
}
