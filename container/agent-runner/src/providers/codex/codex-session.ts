/**
 * CodexSession — encapsulates the Codex SDK Thread lifecycle.
 *
 * Manages the Codex instance, thread creation/resumption, and turn execution.
 */

import {
  Codex,
  type Thread,
  type ThreadEvent,
  type ThreadOptions,
  type CodexOptions,
} from '@openai/codex-sdk';

export interface CodexSessionConfig {
  model?: string;
  workingDirectory: string;
  additionalDirectories?: string[];
  /** Path to MCP server entry point for HappyClaw tools. */
  mcpServerPath?: string;
  /** Environment variables for the MCP server process. */
  mcpServerEnv?: Record<string, string>;
  /** Path to model instructions file. */
  modelInstructionsFile?: string;
}

export class CodexSession {
  private codex: Codex;
  private thread: Thread | null = null;
  private abortController: AbortController | null = null;
  private threadId: string | null = null;
  private config: CodexSessionConfig;

  constructor(config: CodexSessionConfig, codexOptions?: CodexOptions) {
    this.config = config;

    // Build Codex config with MCP server
    const codexConfig: CodexOptions = {
      ...codexOptions,
      config: {
        ...(codexOptions?.config || {}),
        ...(config.modelInstructionsFile
          ? { model_instructions_file: config.modelInstructionsFile }
          : {}),
        ...(config.mcpServerPath
          ? {
              mcp_servers: {
                happyclaw: {
                  command: 'node',
                  args: [config.mcpServerPath],
                  env: config.mcpServerEnv || {},
                },
              },
            }
          : {}),
      },
    };
    this.codex = new Codex(codexConfig);
  }

  /**
   * Start a new thread or resume an existing one.
   */
  startOrResume(threadId?: string): void {
    const threadOpts: ThreadOptions = {
      model: this.config.model,
      workingDirectory: this.config.workingDirectory,
      additionalDirectories: this.config.additionalDirectories,
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
      webSearchMode: 'live',
      skipGitRepoCheck: true,
    };

    if (threadId) {
      this.thread = this.codex.resumeThread(threadId, threadOpts);
      this.threadId = threadId;
    } else {
      this.thread = this.codex.startThread(threadOpts);
    }
  }

  /**
   * Run a turn and yield ThreadEvents.
   */
  async *runTurn(
    prompt: string,
    imagePaths?: string[],
  ): AsyncGenerator<ThreadEvent> {
    if (!this.thread) {
      throw new Error('CodexSession: thread not started');
    }

    // Build input
    const input = imagePaths && imagePaths.length > 0
      ? [
          { type: 'text' as const, text: prompt },
          ...imagePaths.map(p => ({ type: 'local_image' as const, path: p })),
        ]
      : prompt;

    this.abortController = new AbortController();
    const result = await this.thread.runStreamed(input, {
      signal: this.abortController.signal,
    });

    for await (const event of result.events) {
      // Capture thread ID from thread.started event
      if (event.type === 'thread.started') {
        this.threadId = event.thread_id;
      }
      yield event;
    }
  }

  getThreadId(): string | null {
    return this.threadId;
  }

  interrupt(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }
}
