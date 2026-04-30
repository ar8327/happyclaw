import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';

import type {
  ActivityReport,
  AgentRunner,
  IpcCapabilities,
  NormalizedMessage,
  QueryConfig,
  QueryResult,
} from '../runner-interface.js';

function buildPromptEnv(config: QueryConfig): {
  env: Record<string, string>;
  cleanupDir?: string;
} | null {
  const contract = config.promptContract;
  if (
    contract?.mode !== 'env' &&
    contract?.mode !== 'instructions_file'
  ) {
    return null;
  }

  const env: Record<string, string> = {};
  if (contract.mode === 'env') {
    const envVar = contract.envVar || 'AGENTDOCK_SYSTEM_PROMPT';
    env[envVar] = config.systemPrompt;
    if (envVar !== 'AGENTDOCK_SYSTEM_PROMPT') {
      env.AGENTDOCK_SYSTEM_PROMPT = config.systemPrompt;
    }
    env.HAPPYCLAW_SYSTEM_PROMPT = config.systemPrompt;
  }

  let cleanupDir: string | undefined;
  const fileEnvVar =
    contract.fileEnvVar ||
    (contract.mode === 'instructions_file'
      ? 'AGENTDOCK_SYSTEM_PROMPT_FILE'
      : undefined);
  if (fileEnvVar) {
    cleanupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdock-prompt-'));
    const promptFile = path.join(cleanupDir, 'system-prompt.md');
    fs.writeFileSync(promptFile, config.systemPrompt, 'utf-8');
    env[fileEnvVar] = promptFile;
    if (fileEnvVar !== 'AGENTDOCK_SYSTEM_PROMPT_FILE') {
      env.AGENTDOCK_SYSTEM_PROMPT_FILE = promptFile;
    }
  }

  return { env, cleanupDir };
}

export interface CliCommand {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  spawnOptions?: Omit<SpawnOptionsWithoutStdio, 'cwd' | 'env' | 'stdio'>;
}

export interface CliInput {
  stdin?: string;
  stdinChunks?: string[];
  endStdin?: boolean;
}

export interface RunnerError {
  message: string;
  recoverable: boolean;
  errorType?:
    | 'context_overflow'
    | 'unrecoverable_transcript'
    | 'session_resume_failed';
}

export interface CliRunnerAdapter {
  buildCommand(query: QueryConfig): CliCommand;
  buildInput(query: QueryConfig): CliInput;
  beforeRun?(query: QueryConfig): NormalizedMessage[];
  parseStdoutLine?(line: string): NormalizedMessage[];
  parseStdoutChunk?(chunk: string): NormalizedMessage[];
  parseStderrChunk?(chunk: string): NormalizedMessage[];
  detectRecoverableError?(eventOrText: unknown): RunnerError | null;
  getResumeAnchor?(eventOrText: unknown): string | null;
  interrupt?(process: ChildProcessWithoutNullStreams): Promise<void>;
}

class AsyncMessageQueue<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<{
    resolve: (value: IteratorResult<T>) => void;
    reject: (reason?: unknown) => void;
  }> = [];
  private closed = false;
  private failure: unknown = null;

  push(item: T): void {
    if (this.closed || this.failure) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ done: false, value: item });
      return;
    }
    this.items.push(item);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.resolve({ done: true, value: undefined });
    }
  }

  fail(err: unknown): void {
    if (this.failure) return;
    this.failure = err;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.reject(err);
    }
  }

  next(): Promise<IteratorResult<T>> {
    if (this.items.length > 0) {
      return Promise.resolve({ done: false, value: this.items.shift()! });
    }
    if (this.failure) {
      return Promise.reject(this.failure);
    }
    if (this.closed) {
      return Promise.resolve({ done: true, value: undefined });
    }
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }
}

export abstract class BaseCliRunner implements AgentRunner {
  abstract readonly ipcCapabilities: IpcCapabilities;
  protected abstract readonly adapter: CliRunnerAdapter;
  private activeProcess: ChildProcessWithoutNullStreams | null = null;
  private activeStartedAt = 0;
  private interrupted = false;

  async initialize(): Promise<void> {
    // CLI runners usually do not need eager initialization.
  }

  pushMessage(): string[] {
    return ['当前 runner 不支持运行中追加消息'];
  }

  async interrupt(): Promise<void> {
    const proc = this.activeProcess;
    if (!proc) return;
    this.interrupted = true;
    if (this.adapter.interrupt) {
      await this.adapter.interrupt(proc);
      return;
    }
    proc.kill('SIGTERM');
  }

  getActivityReport(): ActivityReport {
    return {
      hasActiveToolCall: false,
      activeToolDurationMs:
        this.activeStartedAt > 0 ? Date.now() - this.activeStartedAt : 0,
      hasPendingBackgroundTasks: this.activeProcess !== null,
    };
  }

  async *runQuery(
    config: QueryConfig,
  ): AsyncGenerator<NormalizedMessage, QueryResult> {
    const command = this.adapter.buildCommand(config);
    const input = this.adapter.buildInput(config);
    const promptEnv = buildPromptEnv(config);
    const proc = spawn(command.command, command.args || [], {
      cwd: command.cwd,
      env: promptEnv
        ? {
            ...(process.env as Record<string, string>),
            ...(command.env || {}),
            ...promptEnv.env,
          }
        : command.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...command.spawnOptions,
    });
    this.activeProcess = proc;
    this.activeStartedAt = Date.now();
    this.interrupted = false;

    const queue = new AsyncMessageQueue<NormalizedMessage>();
    let exitErrorMessage: string | null = null;
    let resumeAnchor: string | undefined = config.resumeAt;
    let contextOverflow = false;
    let unrecoverableTranscriptError = false;
    let sessionResumeFailed = false;
    let genericError: string | undefined;
    let closeCode: number | null = null;
    let closeSignal: NodeJS.Signals | null = null;

    const enqueue = (messages: NormalizedMessage[]) => {
      for (const message of messages) {
        if (message.kind === 'resume_anchor') {
          resumeAnchor = message.anchor;
        } else if (message.kind === 'error') {
          if (message.errorType === 'context_overflow') contextOverflow = true;
          if (message.errorType === 'unrecoverable_transcript') {
            unrecoverableTranscriptError = true;
          }
          if (message.errorType === 'session_resume_failed') {
            sessionResumeFailed = true;
          }
          if (!message.recoverable && !message.errorType && !genericError) {
            genericError = message.message;
          }
        }
        queue.push(message);
      }
    };
    enqueue(this.adapter.beforeRun?.(config) || []);

    const enqueueDetectedError = (detected: RunnerError | null | undefined) => {
      if (!detected) return;
      enqueue([
        {
          kind: 'error',
          message: detected.message,
          recoverable: detected.recoverable,
          errorType: detected.errorType,
        },
      ]);
    };

    const callAdapter = <T>(
      fn: (() => T) | undefined,
      fallback: T,
      source: 'stdout' | 'stderr',
    ): T => {
      if (!fn) return fallback;
      try {
        return fn();
      } catch (err) {
        enqueue([
          {
            kind: 'error',
            message: `${source} parse error: ${
              err instanceof Error ? err.message : String(err)
            }`,
            recoverable: false,
          },
        ]);
        return fallback;
      }
    };

    const stdoutLines = this.adapter.parseStdoutChunk
      ? null
      : readline.createInterface({ input: proc.stdout });
    stdoutLines?.on('line', (line) => {
      enqueue(
        callAdapter(
          () => this.adapter.parseStdoutLine?.(line) || [],
          [],
          'stdout',
        ),
      );
      const anchor = callAdapter(
        () => this.adapter.getResumeAnchor?.(line) || null,
        null,
        'stdout',
      );
      if (anchor) enqueue([{ kind: 'resume_anchor', anchor }]);
      enqueueDetectedError(
        callAdapter(
          () => this.adapter.detectRecoverableError?.(line) || null,
          null,
          'stdout',
        ),
      );
    });
    if (this.adapter.parseStdoutChunk) {
      proc.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf-8');
        enqueue(
          callAdapter(
            () => this.adapter.parseStdoutChunk?.(text) || [],
            [],
            'stdout',
          ),
        );
        enqueueDetectedError(
          callAdapter(
            () => this.adapter.detectRecoverableError?.(text) || null,
            null,
            'stdout',
          ),
        );
      });
    }
    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      enqueue(
        callAdapter(
          () => this.adapter.parseStderrChunk?.(text) || [],
          [],
          'stderr',
        ),
      );
      enqueueDetectedError(
        callAdapter(
          () => this.adapter.detectRecoverableError?.(text) || null,
          null,
          'stderr',
        ),
      );
    });
    proc.once('error', (err) => {
      exitErrorMessage = err.message;
      queue.close();
    });
    proc.once('close', (code, signal) => {
      closeCode = code;
      closeSignal = signal;
      if (code && code !== 0) {
        exitErrorMessage = `CLI exited with code=${code} signal=${signal || 'none'}`;
      }
      queue.close();
    });

    for (const chunk of input.stdinChunks || []) proc.stdin.write(chunk);
    if (input.stdin) proc.stdin.write(input.stdin);
    if (input.endStdin !== false) proc.stdin.end();

    try {
      while (true) {
        const next = await queue.next();
        if (next.done) break;
        yield next.value;
      }
      if (exitErrorMessage && !this.interrupted) {
        yield {
          kind: 'error',
          message: exitErrorMessage,
          recoverable: false,
        };
      }
      return {
        resumeAnchor,
        closedDuringQuery: false,
        interruptedDuringQuery:
          this.interrupted ||
          closeSignal === 'SIGINT' ||
          closeSignal === 'SIGTERM',
        drainDetectedDuringQuery: false,
        contextOverflow: contextOverflow || closeCode === 42,
        unrecoverableTranscriptError,
        sessionResumeFailed,
        genericError,
      };
    } finally {
      stdoutLines?.close();
      queue.close();
      if (promptEnv?.cleanupDir) {
        fs.rmSync(promptEnv.cleanupDir, { recursive: true, force: true });
      }
      this.activeProcess = null;
      this.activeStartedAt = 0;
      this.interrupted = false;
    }
  }
}
