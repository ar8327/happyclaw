import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import readline from 'readline';

import type {
  ActivityReport,
  AgentRunner,
  IpcCapabilities,
  NormalizedMessage,
  QueryConfig,
  QueryResult,
} from '../runner-interface.js';

export interface CliCommand {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface CliInput {
  stdin?: string;
  endStdin?: boolean;
}

export interface RunnerError {
  message: string;
  recoverable: boolean;
  errorType?: 'context_overflow' | 'unrecoverable_transcript' | 'session_resume_failed';
}

export interface CliRunnerAdapter {
  buildCommand(query: QueryConfig): CliCommand;
  buildInput(query: QueryConfig): CliInput;
  parseStdoutLine?(line: string): NormalizedMessage[];
  parseStdoutChunk?(chunk: string): NormalizedMessage[];
  parseStderrChunk?(chunk: string): NormalizedMessage[];
  detectRecoverableError?(eventOrText: unknown): RunnerError | null;
  getResumeAnchor?(eventOrText: unknown): string | null;
  interrupt?(process: ChildProcessWithoutNullStreams): Promise<void>;
}

export abstract class BaseCliRunner implements AgentRunner {
  abstract readonly ipcCapabilities: IpcCapabilities;
  protected abstract readonly adapter: CliRunnerAdapter;
  private activeProcess: ChildProcessWithoutNullStreams | null = null;
  private activeStartedAt = 0;

  async initialize(): Promise<void> {
    // CLI runners usually do not need eager initialization.
  }

  pushMessage(): string[] {
    return ['当前 runner 不支持运行中追加消息'];
  }

  async interrupt(): Promise<void> {
    const proc = this.activeProcess;
    if (!proc) return;
    if (this.adapter.interrupt) {
      await this.adapter.interrupt(proc);
      return;
    }
    proc.kill('SIGTERM');
  }

  getActivityReport(): ActivityReport {
    return {
      hasActiveToolCall: false,
      activeToolDurationMs: this.activeStartedAt > 0
        ? Date.now() - this.activeStartedAt
        : 0,
      hasPendingBackgroundTasks: this.activeProcess !== null,
    };
  }

  async *runQuery(config: QueryConfig): AsyncGenerator<NormalizedMessage, QueryResult> {
    const command = this.adapter.buildCommand(config);
    const input = this.adapter.buildInput(config);
    const proc = spawn(command.command, command.args || [], {
      cwd: command.cwd,
      env: command.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.activeProcess = proc;
    this.activeStartedAt = Date.now();

    const queue: NormalizedMessage[] = [];
    let done = false;
    let exitErrorMessage: string | null = null;
    let resumeAnchor: string | undefined = config.resumeAt;

    const enqueue = (messages: NormalizedMessage[]) => {
      for (const message of messages) {
        if (message.kind === 'resume_anchor') {
          resumeAnchor = message.anchor;
        }
        queue.push(message);
      }
    };

    const stdoutLines = readline.createInterface({ input: proc.stdout });
    stdoutLines.on('line', (line) => {
      enqueue(this.adapter.parseStdoutLine?.(line) || []);
      const anchor = this.adapter.getResumeAnchor?.(line);
      if (anchor) queue.push({ kind: 'resume_anchor', anchor });
    });
    proc.stdout.on('data', (chunk: Buffer) => {
      enqueue(this.adapter.parseStdoutChunk?.(chunk.toString('utf-8')) || []);
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      enqueue(this.adapter.parseStderrChunk?.(text) || []);
      const detected = this.adapter.detectRecoverableError?.(text);
      if (detected) {
        queue.push({
          kind: 'error',
          message: detected.message,
          recoverable: detected.recoverable,
          errorType: detected.errorType,
        });
      }
    });
    proc.once('error', (err) => {
      exitErrorMessage = err.message;
      done = true;
    });
    proc.once('close', (code, signal) => {
      if (code && code !== 0) {
        exitErrorMessage = `CLI exited with code=${code} signal=${signal || 'none'}`;
      }
      done = true;
    });

    if (input.stdin) proc.stdin.write(input.stdin);
    if (input.endStdin !== false) proc.stdin.end();

    try {
      while (!done || queue.length > 0) {
        const next = queue.shift();
        if (next) {
          yield next;
          continue;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      if (exitErrorMessage) {
        yield {
          kind: 'error',
          message: exitErrorMessage,
          recoverable: false,
        };
      }
      return {
        resumeAnchor,
        closedDuringQuery: false,
        interruptedDuringQuery: false,
        drainDetectedDuringQuery: false,
      };
    } finally {
      stdoutLines.close();
      this.activeProcess = null;
      this.activeStartedAt = 0;
    }
  }
}
