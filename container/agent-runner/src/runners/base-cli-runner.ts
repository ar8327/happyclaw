import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from 'child_process';
import readline from 'readline';

import type {
  ActivityReport,
  AgentRunner,
  IpcCapabilities,
  NormalizedMessage,
  QueryConfig,
  QueryResult,
  RenderedRunnerContext,
  PushMessageResult,
} from '../runner-interface.js';
import { combineRenderedContext } from '../runner-interface.js';

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
  private renderedContext: RenderedRunnerContext | null = null;
  private stdinOperation: Promise<void> = Promise.resolve();
  private stdinEnding = false;

  async initialize(): Promise<void> {
    // CLI runners usually do not need eager initialization.
  }

  async applyContext(context: RenderedRunnerContext): Promise<void> {
    this.renderedContext = context;
  }

  async pushMessage(
    _text: string,
    _images?: Array<{ data: string; mimeType?: string }>,
    _deliveryId?: string,
  ): Promise<PushMessageResult> {
    return {
      status: 'buffer',
      reason: '当前 runner 不支持运行中追加消息',
    };
  }

  /**
   * Serialize writes against stdin.end().  Writable.write(false) means
   * backpressure, not rejection, so success is determined by the callback.
   */
  protected writeStdinLine(line: string): Promise<boolean> {
    const proc = this.activeProcess;
    if (
      !proc ||
      proc.killed ||
      this.stdinEnding ||
      !proc.stdin.writable ||
      proc.stdin.destroyed
    ) {
      return Promise.resolve(false);
    }

    let resolveResult: (value: boolean) => void = () => {};
    const result = new Promise<boolean>((resolve) => {
      resolveResult = resolve;
    });
    this.stdinOperation = this.stdinOperation
      .catch(() => {})
      .then(
        () =>
          new Promise<void>((resolve) => {
            if (
              this.activeProcess !== proc ||
              proc.killed ||
              this.stdinEnding ||
              !proc.stdin.writable ||
              proc.stdin.destroyed
            ) {
              resolveResult(false);
              resolve();
              return;
            }
            proc.stdin.write(line, (error) => {
              resolveResult(!error);
              resolve();
            });
          }),
      );
    return result;
  }

  protected endStdin(): Promise<void> {
    const proc = this.activeProcess;
    if (!proc || this.stdinEnding) return this.stdinOperation;
    this.stdinEnding = true;
    this.stdinOperation = this.stdinOperation
      .catch(() => {})
      .then(
        () =>
          new Promise<void>((resolve) => {
            if (
              this.activeProcess !== proc ||
              proc.stdin.destroyed ||
              !proc.stdin.writable
            ) {
              resolve();
              return;
            }
            proc.stdin.end(() => resolve());
          }),
      );
    return this.stdinOperation;
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
    const effectiveConfig = this.renderedContext
      ? {
          ...config,
          systemPrompt: combineRenderedContext(this.renderedContext),
        }
      : config;
    const command = this.adapter.buildCommand(effectiveConfig);
    const input = this.adapter.buildInput(effectiveConfig);
    const proc = spawn(command.command, command.args || [], {
      cwd: command.cwd,
      env: command.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...command.spawnOptions,
    });
    this.activeProcess = proc;
    this.activeStartedAt = Date.now();
    this.interrupted = false;
    this.stdinOperation = Promise.resolve();
    this.stdinEnding = false;

    const queue = new AsyncMessageQueue<NormalizedMessage>();
    let exitErrorMessage: string | null = null;
    let resumeAnchor: string | undefined = effectiveConfig.resumeAt;
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
        if (message.kind === 'result' || message.kind === 'error') {
          void this.endStdin();
        }
      }
    };
    enqueue(this.adapter.beforeRun?.(effectiveConfig) || []);

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

    for (const chunk of input.stdinChunks || []) {
      if (!(await this.writeStdinLine(chunk))) {
        throw new Error('CLI stdin became unavailable during initial input');
      }
    }
    if (input.stdin && !(await this.writeStdinLine(input.stdin))) {
      throw new Error('CLI stdin became unavailable during initial input');
    }
    if (input.endStdin !== false) await this.endStdin();

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
      this.activeProcess = null;
      this.activeStartedAt = 0;
      this.interrupted = false;
      this.stdinEnding = false;
      this.stdinOperation = Promise.resolve();
    }
  }
}
