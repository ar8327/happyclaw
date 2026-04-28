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
import type { ThreadEvent, ThreadItem } from '@openai/codex-sdk';
import {
  normalizeHomeFlags,
} from 'happyclaw-agent-runner-core';

import type {
  AgentRunner,
  IpcCapabilities,
  QueryConfig,
  QueryResult,
  NormalizedMessage,
  ActivityReport,
  RuntimePersistenceSnapshot,
  UsageInfo,
} from '../../runner-interface.js';
import type { ContainerInput, ContainerOutput } from '../../types.js';
import type { SessionState } from '../../session-state.js';
import type { IpcPaths } from '../../ipc-handler.js';
import { CodexSession, type CodexSessionConfig } from './codex-session.js';
import { convertThreadEvent } from './codex-event-adapter.js';
import { saveImagesToTempFiles } from './codex-image-utils.js';
import { CodexArchiveManager } from './codex-archive.js';

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
  thinkingEffort?: string;
  loadUserMcpServers: () => Record<string, unknown>;
  skillsDir: string;
  disableSyntheticArchive?: boolean;
}

function resolveAdditionalDirectories(defaultDirs: string[]): string[] {
  const raw = process.env.HAPPYCLAW_ADDITIONAL_DIRECTORIES;
  if (!raw) return defaultDirs;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return defaultDirs;
    return parsed.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
  } catch {
    return defaultDirs;
  }
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
  private instructionsFile!: string;
  private mcpServerPath!: string;
  private tmpDir!: string;
  private archiveMgr = new CodexArchiveManager();
  private startFreshOnNextTurn = false;
  private activeToolCalls = new Map<string, number>();
  private readonly opts: CodexRunnerOptions;

  constructor(opts: CodexRunnerOptions) {
    this.opts = opts;
  }

  async initialize(): Promise<void> {
    const { containerInput, groupDir, globalDir, memoryDir } = this.opts;
    const { isHome, isAdminHome } = normalizeHomeFlags(containerInput);
    const persistedState = this.opts.state.getProviderState<{
      startFreshOnNextTurn?: unknown;
      archiveState?: {
        cumulativeInputTokens?: unknown;
        cumulativeOutputTokens?: unknown;
        turnCount?: unknown;
        conversationLines?: unknown;
      };
    }>();
    if (!this.opts.disableSyntheticArchive) {
      this.startFreshOnNextTurn = persistedState?.startFreshOnNextTurn === true;
      this.archiveMgr.hydrate(persistedState?.archiveState);
    }

    // Create temp directory for instructions file and images
    this.tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-codex-'));

    this.instructionsFile = path.join(this.tmpDir, 'instructions.md');
    fs.writeFileSync(this.instructionsFile, '', 'utf-8');

    // Resolve MCP server path (compiled JS entry point)
    this.mcpServerPath = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      '../../happyclaw-mcp-server.js',
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

    // Load user MCP servers (stdio only — SSE/HTTP not supported by Codex CLI)
    const userMcpServers = this.opts.loadUserMcpServers();

    // Initialize CodexSession
    const sessionConfig: CodexSessionConfig = {
      model: this.opts.model,
      thinkingEffort: this.opts.thinkingEffort,
      workingDirectory: groupDir,
      additionalDirectories: resolveAdditionalDirectories([
        globalDir,
        memoryDir,
      ]),
      mcpServerPath: this.mcpServerPath,
      mcpServerEnv: mcpEnv,
      modelInstructionsFile: this.instructionsFile,
      userMcpServers,
    };

    this.session = new CodexSession(sessionConfig, {
      apiKey: process.env.OPENAI_API_KEY,
    });
  }

  private buildCompactStartedMessage(): NormalizedMessage {
    return {
      kind: 'stream_event',
      event: {
        eventType: 'lifecycle',
        phase: 'compact_started',
        trigger: 'synthetic_threshold',
      },
    };
  }

  private buildCompactCompletedMessage(): NormalizedMessage {
    return {
      kind: 'stream_event',
      event: {
        eventType: 'lifecycle',
        phase: 'compact_completed',
        repairHints: {
          recentImChannels: this.opts.state.getActiveImChannels(),
        },
      },
    };
  }

  private buildResumeInstructions(): string {
    const activeChannels = this.opts.state.getActiveImChannels();
    return [
      'Continue the existing HappyClaw conversation thread.',
      'Follow the system, workspace, memory, and routing instructions already established earlier in this thread.',
      'Focus on the latest user message. Do not repeat old replies.',
      'Your stdout is only visible in the Web UI. For IM channels, use send_message with the channel from the latest message source attribute.',
      activeChannels.length > 0
        ? `Recently active IM channels: ${activeChannels.join(', ')}.`
        : '',
      'If exact long-term memory is needed, call memory_query instead of guessing.',
    ].filter(Boolean).join('\n');
  }

  async *runQuery(config: QueryConfig): AsyncGenerator<NormalizedMessage, QueryResult> {
    const { opts } = this;
    const { log } = opts;

    const composedPrompt = config.prompt;
    const resumeTarget = this.startFreshOnNextTurn
      ? undefined
      : (config.resumeAt || config.sessionId || undefined);
    const systemPrompt = resumeTarget
      ? this.buildResumeInstructions()
      : config.systemPrompt;

    fs.writeFileSync(this.instructionsFile, systemPrompt, 'utf-8');
    log(
      `Codex instructions prepared: mode=${resumeTarget ? 'resume-minimal' : 'fresh-full'}, chars=${systemPrompt.length}, promptChars=${composedPrompt.length}`,
    );

    // Prepare images (base64 → temp files)
    let imagePaths: string[] | undefined;
    if (config.images && config.images.length > 0) {
      imagePaths = saveImagesToTempFiles(config.images, this.tmpDir);
    }

    // Start or resume thread
    this.session.startOrResume(resumeTarget);
    this.startFreshOnNextTurn = false;

    // Run turn and convert events
    let usage: UsageInfo | undefined;
    let finalText: string | null = null;
    let threadId: string | null = null;
    this.activeToolCalls.clear();

    try {
      for await (const event of this.session.runTurn(composedPrompt, imagePaths)) {
        this.trackActivityEvent(event);
        // Convert to StreamEvents
        const streamEvents = convertThreadEvent(event);
        for (const se of streamEvents) {
          yield { kind: 'stream_event', event: se };
        }

        // Track thread ID
        if (event.type === 'thread.started') {
          threadId = event.thread_id;
          if (threadId) {
            yield { kind: 'session_init', sessionId: threadId };
          }
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

    if (!this.opts.disableSyntheticArchive) {
      this.archiveMgr.recordTurn(usage);
    }

    if (!this.opts.disableSyntheticArchive && this.archiveMgr.shouldArchive()) {
      yield this.buildCompactStartedMessage();
      yield {
        kind: 'stream_event',
        event: {
          eventType: 'lifecycle',
          phase: 'archive_started',
        },
      };
      const archiveResult = await this.archiveMgr.archive(
        this.opts.containerInput.groupFolder,
        this.opts.containerInput.userId || undefined,
      );
      if (archiveResult?.success) {
        this.session.resetThread();
        this.startFreshOnNextTurn = true;
        yield this.buildCompactCompletedMessage();
      } else {
        log(
          `Skipping synthetic compact reset for ${this.opts.containerInput.groupFolder}: session_wrapup did not complete`,
        );
      }
      yield {
        kind: 'stream_event',
        event: {
          eventType: 'lifecycle',
          phase: 'archive_completed',
          statusText: archiveResult?.success
            ? 'session_wrapup_completed'
            : 'session_wrapup_failed',
          archivedFolders: [this.opts.containerInput.groupFolder],
          transcriptFiles: [
            archiveResult?.conversationArchiveFile,
            archiveResult?.transcriptFile,
          ].filter(
            (file): file is string =>
              typeof file === 'string' && file.trim().length > 0,
          ),
        },
      };
    }

    // Emit resume anchor (thread ID)
    const currentThreadId = this.startFreshOnNextTurn
      ? null
      : (threadId || this.session.getThreadId());
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

  getActivityReport(): ActivityReport {
    let oldestStartedAt = 0;
    for (const startedAt of this.activeToolCalls.values()) {
      if (oldestStartedAt === 0 || startedAt < oldestStartedAt) {
        oldestStartedAt = startedAt;
      }
    }
    return {
      hasActiveToolCall: oldestStartedAt > 0,
      activeToolDurationMs: oldestStartedAt > 0 ? Date.now() - oldestStartedAt : 0,
      hasPendingBackgroundTasks: false,
    };
  }

  getRuntimePersistenceSnapshot(): RuntimePersistenceSnapshot {
    const currentThreadId = this.session?.getThreadId?.() || null;
    const providerState: Record<string, unknown> = {
      activeThreadId: currentThreadId,
    };
    if (!this.opts.disableSyntheticArchive) {
      providerState.startFreshOnNextTurn = this.startFreshOnNextTurn;
      providerState.archiveState = this.archiveMgr.snapshot();
    }
    return {
      providerState,
      lastMessageCursor: currentThreadId,
    };
  }

  async cleanup(): Promise<void> {
    if (!this.opts.disableSyntheticArchive) {
      await this.archiveMgr.forceArchive(
        this.opts.containerInput.groupFolder,
        this.opts.containerInput.userId || undefined,
      );
    }
    if (this.startFreshOnNextTurn) {
      this.session.resetThread();
    }
    // Clean up temp directory
    try {
      fs.rmSync(this.tmpDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  }

  private trackActivityEvent(event: ThreadEvent): void {
    if (event.type === 'item.started' && this.isToolLikeItem(event.item.type)) {
      this.activeToolCalls.set(event.item.id, Date.now());
      return;
    }
    if (event.type === 'item.completed' && this.isToolLikeItem(event.item.type)) {
      this.activeToolCalls.delete(event.item.id);
      return;
    }
    if (event.type === 'turn.completed' || event.type === 'turn.failed' || event.type === 'error') {
      this.activeToolCalls.clear();
    }
  }

  private isToolLikeItem(itemType: ThreadItem['type']): boolean {
    return itemType === 'command_execution'
      || itemType === 'mcp_tool_call'
      || itemType === 'file_change'
      || itemType === 'web_search';
  }
}
