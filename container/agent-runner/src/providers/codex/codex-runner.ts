/**
 * CodexRunner — implements AgentRunner interface for the Codex provider.
 *
 * Key differences from ClaudeRunner:
 * - Turn-based model (no mid-query push)
 * - No runtime permission mode switching
 * - Uses model_instructions_file for system prompt
 * - External MCP server process for tools
 * - No incremental text deltas (item-level completions)
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import type { ContextManager } from 'happyclaw-agent-runner-core';
import {
  normalizeHomeFlags,
  MessagingPlugin,
  TasksPlugin,
  GroupsPlugin,
  MemoryPlugin,
  FeishuDocsPlugin,
} from 'happyclaw-agent-runner-core';
import { ContextManager as ContextManagerClass } from 'happyclaw-agent-runner-core';

import type {
  AgentRunner,
  IpcCapabilities,
  QueryConfig,
  QueryResult,
  NormalizedMessage,
  ActivityReport,
  UsageInfo,
} from '../../runner-interface.js';
import type { ContainerInput, ContainerOutput } from '../../types.js';
import type { SessionState } from '../../session-state.js';
import type { IpcPaths } from '../../ipc-handler.js';
import { CodexSession, type CodexSessionConfig } from './codex-session.js';
import { convertThreadEvent } from './codex-event-adapter.js';
import { saveImagesToTempFiles } from './codex-image-utils.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface CodexRunnerOptions {
  containerInput: ContainerInput;
  state: SessionState;
  ipcPaths: IpcPaths;
  log: (msg: string) => void;
  writeOutput: (output: ContainerOutput) => void;
  imChannelsFile: string;
  groupDir: string;
  globalDir: string;
  memoryDir: string;
  model: string;
}

// ---------------------------------------------------------------------------
// CodexRunner
// ---------------------------------------------------------------------------

export class CodexRunner implements AgentRunner {
  readonly ipcCapabilities: IpcCapabilities = {
    supportsMidQueryPush: false,  // Codex turns are independent processes
    supportsRuntimeModeSwitch: false,
  };

  private session!: CodexSession;
  private ctxMgr!: ContextManager;
  private instructionsFile!: string;
  private mcpServerPath!: string;
  private tmpDir!: string;
  private readonly opts: CodexRunnerOptions;

  constructor(opts: CodexRunnerOptions) {
    this.opts = opts;
  }

  async initialize(): Promise<void> {
    const { containerInput, groupDir, globalDir, memoryDir } = this.opts;
    const { isHome, isAdminHome } = normalizeHomeFlags(containerInput);

    // Create temp directory for instructions file and images
    this.tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-codex-'));

    // Create ContextManager with all plugins
    const pluginCtx = {
      chatJid: containerInput.chatJid,
      groupFolder: containerInput.groupFolder,
      isHome,
      isAdminHome,
      workspaceIpc: this.opts.ipcPaths.inputDir.replace('/input', ''),
      workspaceGroup: groupDir,
      workspaceGlobal: globalDir,
      workspaceMemory: memoryDir,
      userId: containerInput.userId,
    };
    this.ctxMgr = new ContextManagerClass(pluginCtx);

    // Register plugins
    this.ctxMgr.register(new MessagingPlugin());
    this.ctxMgr.register(new TasksPlugin());
    this.ctxMgr.register(new GroupsPlugin());

    const apiUrl = process.env.HAPPYCLAW_API_URL || 'http://localhost:3000';
    const apiToken = process.env.HAPPYCLAW_API_TOKEN || '';

    if (containerInput.userId) {
      this.ctxMgr.register(new MemoryPlugin({
        apiUrl,
        apiToken,
        queryTimeoutMs: parseInt(process.env.HAPPYCLAW_MEMORY_QUERY_TIMEOUT || '60000', 10),
        sendTimeoutMs: parseInt(process.env.HAPPYCLAW_MEMORY_SEND_TIMEOUT || '120000', 10),
      }));
    }

    if (apiUrl && apiToken) {
      this.ctxMgr.register(new FeishuDocsPlugin({
        apiUrl,
        apiToken,
      }));
    }

    // Write initial instructions file
    this.instructionsFile = path.join(this.tmpDir, 'instructions.md');
    this.ctxMgr.writeFullPromptToFile(this.instructionsFile);

    // Resolve MCP server path (compiled JS entry point)
    this.mcpServerPath = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      'codex-mcp-server.js',
    );

    // Build MCP server environment
    const mcpEnv: Record<string, string> = {
      ...process.env as Record<string, string>,
      HAPPYCLAW_WORKSPACE_GROUP: groupDir,
      HAPPYCLAW_WORKSPACE_GLOBAL: globalDir,
      HAPPYCLAW_WORKSPACE_MEMORY: memoryDir,
      HAPPYCLAW_WORKSPACE_IPC: this.opts.ipcPaths.inputDir.replace('/input', ''),
      HAPPYCLAW_GROUP_FOLDER: containerInput.groupFolder,
      HAPPYCLAW_CHAT_JID: containerInput.chatJid,
      HAPPYCLAW_USER_ID: containerInput.userId || '',
      HAPPYCLAW_IS_HOME: isHome ? '1' : '0',
      HAPPYCLAW_IS_ADMIN_HOME: isAdminHome ? '1' : '0',
    };

    // Initialize CodexSession
    const sessionConfig: CodexSessionConfig = {
      model: this.opts.model,
      workingDirectory: groupDir,
      additionalDirectories: [globalDir, memoryDir],
      mcpServerPath: this.mcpServerPath,
      mcpServerEnv: mcpEnv,
      modelInstructionsFile: this.instructionsFile,
    };

    this.session = new CodexSession(sessionConfig, {
      apiKey: process.env.OPENAI_API_KEY,
    });
  }

  async *runQuery(config: QueryConfig): AsyncGenerator<NormalizedMessage, QueryResult> {
    const { opts } = this;
    const { log } = opts;

    // Update instructions file each turn (dynamic content may change)
    this.ctxMgr.updateDynamicContext({
      recentImChannels: opts.state.recentImChannels,
      contextSummary: opts.containerInput.contextSummary,
    });
    this.ctxMgr.writeFullPromptToFile(this.instructionsFile);

    // Prepare images (base64 → temp files)
    let imagePaths: string[] | undefined;
    if (config.images && config.images.length > 0) {
      imagePaths = saveImagesToTempFiles(config.images, this.tmpDir);
    }

    // Start or resume thread
    this.session.startOrResume(config.resumeAt || undefined);

    // Run turn and convert events
    let usage: UsageInfo | undefined;
    let finalText: string | null = null;
    let threadId: string | null = null;

    try {
      for await (const event of this.session.runTurn(config.prompt, imagePaths)) {
        // Convert to StreamEvents
        const streamEvents = convertThreadEvent(event);
        for (const se of streamEvents) {
          yield { kind: 'stream_event', event: se };
        }

        // Track thread ID
        if (event.type === 'thread.started') {
          threadId = event.thread_id;
          yield { kind: 'session_init', sessionId: threadId };
        }

        // Extract final response text from agent_message items
        if (event.type === 'item.completed' && event.item.type === 'agent_message') {
          finalText = event.item.text;
        }

        // Extract usage from turn.completed
        if (event.type === 'turn.completed') {
          usage = {
            inputTokens: event.usage.input_tokens,
            outputTokens: event.usage.output_tokens,
            cacheReadInputTokens: event.usage.cached_input_tokens,
            cacheCreationInputTokens: 0,
            costUSD: 0,
            durationMs: 0,
            numTurns: 1,
          };
        }

        // Handle errors
        if (event.type === 'turn.failed') {
          yield {
            kind: 'error',
            message: event.error.message,
            recoverable: false,
          };
        }
        if (event.type === 'error') {
          yield {
            kind: 'error',
            message: event.message,
            recoverable: false,
          };
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof Error && err.name === 'AbortError') {
        log('Codex turn aborted');
      } else {
        log(`Codex turn error: ${msg}`);
        throw err;
      }
    }

    // Emit result
    yield { kind: 'result', text: finalText, usage };

    // Emit resume anchor (thread ID)
    const currentThreadId = threadId || this.session.getThreadId();
    if (currentThreadId) {
      yield { kind: 'resume_anchor', anchor: currentThreadId };
    }

    return {
      newSessionId: currentThreadId || undefined,
      resumeAnchor: currentThreadId || undefined,
      closedDuringQuery: false,
      interruptedDuringQuery: false,
      drainDetectedDuringQuery: false,
    };
  }

  pushMessage(_text: string, _images?: Array<{ data: string; mimeType?: string }>): string[] {
    // Codex doesn't support mid-query push.
    // query-loop handles this via pendingMessages accumulation.
    return [];
  }

  async interrupt(): Promise<void> {
    this.session.interrupt();
  }

  // Codex turns are short, no need for custom activity report
  // query-loop uses default values

  async cleanup(): Promise<void> {
    // Clean up temp directory
    try {
      fs.rmSync(this.tmpDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  }
}
