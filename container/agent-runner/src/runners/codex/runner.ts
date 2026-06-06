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
import {
  normalizeHomeFlags,
} from 'agentdock-agent-runner-core';

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
import {
  CodexSession,
  type CodexItemType,
  type CodexSessionConfig,
  type CodexThreadEvent,
} from './session.js';
import { convertThreadEvent } from './event-adapter.js';
import { saveImagesToTempFiles } from './image-utils.js';
import { CodexArchiveManager } from './archive.js';

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
  command?: string;
  loadUserMcpServers: () => Record<string, unknown>;
  skillsDir: string;
  disableSyntheticArchive?: boolean;
  builtinMcpServerName?: string;
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

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function usageFromCodexTokenCount(event: CodexThreadEvent): UsageInfo | null {
  if (event.type !== 'token_count') return null;
  return {
    inputTokens: numberOrZero(event.usage.input_tokens),
    outputTokens: numberOrZero(event.usage.output_tokens),
    cacheReadInputTokens: numberOrZero(event.usage.cached_input_tokens),
    cacheCreationInputTokens: 0,
    costUSD: 0,
    durationMs: 0,
    numTurns: 1,
  };
}

function usageFromCodexTurnCompleted(event: CodexThreadEvent): UsageInfo | null {
  if (event.type !== 'turn.completed') return null;
  return {
    inputTokens: event.usage.input_tokens,
    outputTokens: event.usage.output_tokens,
    cacheReadInputTokens: event.usage.cached_input_tokens,
    cacheCreationInputTokens: 0,
    costUSD: 0,
    durationMs: 0,
    numTurns: 1,
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function readUsageSnapshot(value: unknown): UsageInfo | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const usage = value as Record<string, unknown>;
  if (
    !isFiniteNumber(usage.inputTokens) ||
    !isFiniteNumber(usage.outputTokens) ||
    !isFiniteNumber(usage.cacheReadInputTokens)
  ) {
    return null;
  }
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadInputTokens: usage.cacheReadInputTokens,
    cacheCreationInputTokens: isFiniteNumber(usage.cacheCreationInputTokens)
      ? usage.cacheCreationInputTokens
      : 0,
    costUSD: isFiniteNumber(usage.costUSD) ? usage.costUSD : 0,
    durationMs: isFiniteNumber(usage.durationMs) ? usage.durationMs : 0,
    numTurns: isFiniteNumber(usage.numTurns) ? usage.numTurns : 1,
  };
}

function subtractUsage(current: UsageInfo, previous: UsageInfo): UsageInfo {
  const delta = (now: number, before: number): number =>
    now >= before ? now - before : now;
  return {
    inputTokens: delta(current.inputTokens, previous.inputTokens),
    outputTokens: delta(current.outputTokens, previous.outputTokens),
    cacheReadInputTokens: delta(
      current.cacheReadInputTokens,
      previous.cacheReadInputTokens,
    ),
    cacheCreationInputTokens: delta(
      current.cacheCreationInputTokens,
      previous.cacheCreationInputTokens,
    ),
    costUSD: 0,
    durationMs: current.durationMs,
    numTurns: 1,
  };
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
  private providerCumulativeUsage: UsageInfo | null = null;
  private activeToolCalls = new Map<string, number>();
  private pendingPostCompact = false;
  private seenCompactKeys = new Set<string>();
  private readonly opts: CodexRunnerOptions;

  constructor(opts: CodexRunnerOptions) {
    this.opts = opts;
  }

  async initialize(): Promise<void> {
    const { containerInput, groupDir, globalDir, memoryDir } = this.opts;
    const { isHome, isAdminHome } = normalizeHomeFlags(containerInput);
    const persistedState = this.opts.state.getProviderState<{
      archiveState?: {
        lastInputTokens?: unknown;
        lastOutputTokens?: unknown;
        lastCacheReadInputTokens?: unknown;
        cumulativeInputTokens?: unknown;
        cumulativeOutputTokens?: unknown;
        turnCount?: unknown;
        conversationLines?: unknown;
      };
      providerCumulativeUsage?: unknown;
      activeThreadId?: unknown;
    }>();
    if (!this.opts.disableSyntheticArchive) {
      this.archiveMgr.hydrate(persistedState?.archiveState);
      this.providerCumulativeUsage = readUsageSnapshot(
        persistedState?.providerCumulativeUsage,
      );
      if (!this.providerCumulativeUsage && persistedState?.activeThreadId) {
        this.providerCumulativeUsage = readUsageSnapshot({
          inputTokens: persistedState.archiveState?.lastInputTokens,
          outputTokens: persistedState.archiveState?.lastOutputTokens,
          cacheReadInputTokens:
            persistedState.archiveState?.lastCacheReadInputTokens,
        });
      }
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
      builtinMcpServerName: this.opts.builtinMcpServerName,
      userMcpServers,
    };

    this.session = new CodexSession(sessionConfig, {
      codexPathOverride: this.opts.command,
      apiKey: process.env.OPENAI_API_KEY,
    });
  }

  private buildCompactStartedMessage(): NormalizedMessage {
    return {
      kind: 'stream_event',
      event: {
        eventType: 'lifecycle',
        phase: 'compact_started',
        trigger: 'native',
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
      'Continue the existing AgentDock conversation thread.',
      'Follow the system, workspace, memory, and routing instructions already established earlier in this thread.',
      'Focus on the latest user message. Do not repeat old replies.',
      'Your stdout is only visible in the Web UI. For every latest user message from an IM channel, call send_message with the channel from that message source attribute. This also applies to greetings, thanks, acknowledgements, and short confirmations; do not only output "Done".',
      activeChannels.length > 0
        ? `Recently active IM channels: ${activeChannels.join(', ')}.`
        : '',
      'If exact long-term memory is needed, call memory_query instead of guessing.',
    ].filter(Boolean).join('\n');
  }

  private normalizeProviderUsage(cumulativeUsage: UsageInfo): UsageInfo {
    const previous = this.providerCumulativeUsage;
    this.providerCumulativeUsage = cumulativeUsage;
    if (!previous) return cumulativeUsage;
    return subtractUsage(cumulativeUsage, previous);
  }

  private buildArchiveCompletedMessage(
    archiveResult: Awaited<ReturnType<CodexArchiveManager['archiveAfterNativeCompact']>>,
    statusText: string,
  ): NormalizedMessage {
    return {
      kind: 'stream_event',
      event: {
        eventType: 'lifecycle',
        phase: 'archive_completed',
        statusText,
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

  private async injectPostCompactContextWithRetry(
    continuationSummary?: string,
  ): Promise<boolean> {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.session.injectPostCompactContext({
          continuationSummary,
          activeChannels: this.opts.state.getActiveImChannels(),
        });
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.opts.log(`Codex post-compact context injection failed (${attempt}/${maxAttempts}): ${msg}`);
        if (attempt < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
        }
      }
    }
    return false;
  }

  private async runPostCompactArchive(): Promise<{
    archiveResult: Awaited<ReturnType<CodexArchiveManager['archiveAfterNativeCompact']>>;
    statusText: string;
  }> {
    this.pendingPostCompact = true;
    try {
      const archiveResult = await this.archiveMgr.archiveAfterNativeCompact(
        this.opts.containerInput.groupFolder,
        this.opts.containerInput.userId || undefined,
      );
      if (!archiveResult?.success) {
        return { archiveResult, statusText: 'session_wrapup_failed' };
      }
      const summary = archiveResult.continuationSummary?.trim();
      const injected = await this.injectPostCompactContextWithRetry(summary);
      return {
        archiveResult,
        statusText: injected
          ? summary
            ? 'session_wrapup_completed_post_compact_context_injected'
            : 'session_wrapup_completed_post_compact_context_injected_no_summary'
          : 'session_wrapup_completed_post_compact_context_injection_failed',
      };
    } finally {
      this.pendingPostCompact = false;
    }
  }

  async *runQuery(config: QueryConfig): AsyncGenerator<NormalizedMessage, QueryResult> {
    const { opts } = this;
    const { log } = opts;

    const composedPrompt = config.prompt;
    const isManualCompact = composedPrompt.trim() === '/compact';
    const resumeTarget = config.resumeAt || config.sessionId || undefined;
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
    await this.session.startOrResume(resumeTarget);
    if (!resumeTarget) {
      this.providerCumulativeUsage = null;
    }

    // Run turn and convert events
    let usage: UsageInfo | undefined;
    let fallbackUsage: UsageInfo | undefined;
    let finalText: string | null = null;
    let threadId: string | null = null;
    const compactKeysThisTurn: string[] = [];
    this.activeToolCalls.clear();

    try {
      const eventStream = isManualCompact
        ? this.session.runCompact()
        : this.session.runTurn(composedPrompt, imagePaths);
      for await (const event of eventStream) {
        this.trackActivityEvent(event);

        const tokenCountUsage = usageFromCodexTokenCount(event);
        if (tokenCountUsage) {
          usage = tokenCountUsage;
        }

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

        const turnCompletedUsage = usageFromCodexTurnCompleted(event);
        if (turnCompletedUsage) {
          fallbackUsage = this.normalizeProviderUsage(turnCompletedUsage);
        }

        if (event.type === 'compact.completed') {
          const compactKey = `${event.thread_id}:${event.turn_id}`;
          if (!this.seenCompactKeys.has(compactKey)) {
            this.seenCompactKeys.add(compactKey);
            compactKeysThisTurn.push(compactKey);
            yield this.buildCompactStartedMessage();
          }
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

    usage = usage || fallbackUsage;
    if (usage) {
      yield { kind: 'stream_event', event: { eventType: 'usage', usage } };
    }

    // Emit result
    yield { kind: 'result', text: finalText, usage };

    if (!this.opts.disableSyntheticArchive) {
      this.archiveMgr.recordTurn(usage);
    }

    // Emit resume anchor (thread ID) before post-compact work so the runtime
    // can persist the native Codex thread id even if wrapup fails.
    const currentThreadId = threadId || this.session.getThreadId();
    if (currentThreadId) {
      yield { kind: 'resume_anchor', anchor: currentThreadId };
    }

    if (!this.opts.disableSyntheticArchive && compactKeysThisTurn.length > 0) {
      yield {
        kind: 'stream_event',
        event: {
          eventType: 'lifecycle',
          phase: 'archive_started',
        },
      };
      const { archiveResult, statusText } = await this.runPostCompactArchive();
      yield this.buildCompactCompletedMessage();
      yield this.buildArchiveCompletedMessage(archiveResult, statusText);
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
    await this.session.interrupt();
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
      hasPendingBackgroundTasks: this.pendingPostCompact,
    };
  }

  getRuntimePersistenceSnapshot(): RuntimePersistenceSnapshot {
    const currentThreadId = this.session?.getThreadId?.() || null;
    const providerState: Record<string, unknown> = {
      activeThreadId: currentThreadId,
    };
    if (!this.opts.disableSyntheticArchive) {
      providerState.archiveState = this.archiveMgr.snapshot();
      if (this.providerCumulativeUsage) {
        providerState.providerCumulativeUsage = this.providerCumulativeUsage;
      }
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
    await this.session.close();
    // Clean up temp directory
    try {
      fs.rmSync(this.tmpDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  }

  private trackActivityEvent(event: CodexThreadEvent): void {
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

  private isToolLikeItem(itemType: CodexItemType): boolean {
    return itemType === 'command_execution'
      || itemType === 'mcp_tool_call'
      || itemType === 'file_change'
      || itemType === 'web_search';
  }
}
