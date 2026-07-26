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
import crypto from 'crypto';
import path from 'path';
import os from 'os';
import {
  normalizeHomeFlags,
  type ContextSection,
} from 'agentdock-agent-runner-core';

import type {
  AgentRunner,
  IpcCapabilities,
  QueryConfig,
  QueryResult,
  NormalizedMessage,
  ActivityReport,
  RuntimePersistenceSnapshot,
  RenderedRunnerContext,
  UsageInfo,
  PushMessageResult,
} from '../../runner-interface.js';
import { combineRenderedContext } from '../../runner-interface.js';
import type { ContainerInput, ContainerOutput } from '../../types.js';
import type { SessionState } from '../../session-state.js';
import type { IpcPaths } from '../../ipc-handler.js';
import {
  CodexSession,
  type CodexItemType,
  type CodexSessionConfig,
  type CodexThreadEvent,
  formatCodexAppServerError,
} from './session.js';
import { convertThreadEvent } from './event-adapter.js';
import { saveImagesToTempFiles } from './image-utils.js';
import { CodexArchiveManager } from './archive.js';
import { createContextManager } from '../../context-manager-factory.js';

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
  model?: string;
  modelProvider?: string;
  thinkingEffort?: string;
  modelBackendVariant?: string;
  command?: string;
  commandDefault?: string;
  runnerId?: string;
  runnerLabel?: string;
  instructionsMode?: CodexSessionConfig['instructionsMode'];
  includeWebSearchMode?: boolean;
  mcpServersMode?: CodexSessionConfig['mcpServersMode'];
  aliasBuiltinMcpServer?: boolean;
  useDynamicTools?: boolean;
  supportsMidQueryPush?: boolean;
  /** TraeX supports turn/steer but not Codex's clientUserMessageId extension. */
  includeSteerClientUserMessageId?: boolean;
  loadUserMcpServers: () => Record<string, unknown>;
  skillsDir: string;
  disableSyntheticArchive?: boolean;
  builtinMcpServerName?: string;
  toolScope?: 'default' | 'isolated' | 'read-only';
}

function resolveAdditionalDirectories(defaultDirs: string[]): string[] {
  const raw = process.env.HAPPYCLAW_ADDITIONAL_DIRECTORIES;
  if (!raw) return defaultDirs;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return defaultDirs;
    return parsed.filter(
      (entry): entry is string => typeof entry === 'string' && entry.length > 0,
    );
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

function usageFromCodexTurnCompleted(
  event: CodexThreadEvent,
): UsageInfo | null {
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

export function isCodexSessionResumeFailedError(message: string): boolean {
  return [
    /thread.*not found/i,
    /unknown.*thread/i,
    /invalid.*thread/i,
    /thread.*does not exist/i,
    /failed to (?:load|resume).*thread/i,
    /conversation.*not found/i,
    /no rollout found for thread id/i,
  ].some((pattern) => pattern.test(message));
}

export function planCodexContextInjection(
  previousHashes: ReadonlyMap<string, string>,
  sections: ContextSection[],
  options: {
    threadChanged: boolean;
    freshThread: boolean;
  },
): {
  changed: Array<{ id: string; content: string }>;
  nextHashes: Map<string, string>;
} {
  const nextHashes = new Map<string, string>(
    sections.map((section) => [
      section.id,
      crypto.createHash('sha256').update(section.content).digest('hex'),
    ]),
  );
  const changed: Array<{ id: string; content: string }> = sections
    .filter((section) => {
      if (
        options.freshThread &&
        options.threadChanged &&
        section.stability !== 'turn'
      ) {
        return false;
      }
      return (
        options.threadChanged ||
        previousHashes.get(section.id) !== nextHashes.get(section.id)
      );
    })
    .map((section) => ({
      id: section.id,
      content: section.content,
    }));
  if (!options.freshThread) {
    for (const previousId of previousHashes.keys()) {
      if (nextHashes.has(previousId)) continue;
      changed.push({
        id: previousId,
        content: `The previous HappyClaw context section "${previousId}" no longer applies. Ignore its earlier content.`,
      });
    }
  }
  return { changed, nextHashes };
}

// ---------------------------------------------------------------------------
// CodexRunner
// ---------------------------------------------------------------------------

export class CodexRunner implements AgentRunner {
  readonly ipcCapabilities: IpcCapabilities;

  private session!: CodexSession;
  private instructionsFile!: string;
  private mcpServerPath!: string;
  private tmpDir!: string;
  private archiveMgr = new CodexArchiveManager();
  private providerCumulativeUsage: UsageInfo | null = null;
  private activeToolCalls = new Map<string, number>();
  private renderedContext: RenderedRunnerContext | null = null;
  private contextHashes = new Map<string, string>();
  private contextThreadId: string | null = null;
  private pendingPostCompact = false;
  private seenCompactKeys = new Set<string>();
  private dynamicTools: CodexSessionConfig['dynamicTools'];
  private dynamicToolHandler: CodexSessionConfig['dynamicToolHandler'];
  private readonly opts: CodexRunnerOptions;

  constructor(opts: CodexRunnerOptions) {
    this.opts = opts;
    this.ipcCapabilities = {
      supportsMidQueryPush: opts.supportsMidQueryPush ?? true,
      supportsRuntimeModeSwitch: false,
    };
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
    const tempPrefix = (this.opts.runnerId || 'codex').replace(
      /[^a-z0-9_-]/gi,
      '-',
    );
    this.tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), `happyclaw-${tempPrefix}-`),
    );

    this.instructionsFile = path.join(this.tmpDir, 'instructions.md');
    fs.writeFileSync(this.instructionsFile, '', 'utf-8');

    // Resolve MCP server path (compiled JS entry point)
    this.mcpServerPath = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      '../../happyclaw-mcp-server.js',
    );

    // Build MCP server environment
    const mcpEnv: Record<string, string> = {
      ...(process.env as Record<string, string>),
      HAPPYCLAW_WORKSPACE_GROUP: groupDir,
      HAPPYCLAW_WORKSPACE_GLOBAL: globalDir,
      HAPPYCLAW_WORKSPACE_MEMORY: memoryDir,
      HAPPYCLAW_WORKSPACE_IPC: this.opts.ipcPaths.inputDir.replace(
        '/input',
        '',
      ),
      HAPPYCLAW_GROUP_FOLDER: containerInput.groupFolder,
      HAPPYCLAW_CHAT_JID: containerInput.chatJid,
      HAPPYCLAW_USER_ID: containerInput.userId || '',
      HAPPYCLAW_IS_HOME: isHome ? '1' : '0',
      HAPPYCLAW_IS_ADMIN_HOME: isAdminHome ? '1' : '0',
    };

    // Load user MCP servers (stdio only — SSE/HTTP not supported by Codex CLI)
    const userMcpServers = this.opts.loadUserMcpServers();
    if (this.opts.useDynamicTools) {
      this.initializeDynamicTools(isHome, isAdminHome);
    }

    // Initialize CodexSession
    const sessionConfig: CodexSessionConfig = {
      model: this.opts.model,
      modelProvider: this.opts.modelProvider,
      thinkingEffort: this.opts.thinkingEffort,
      modelBackendVariant: this.opts.modelBackendVariant,
      workingDirectory: groupDir,
      additionalDirectories: resolveAdditionalDirectories([
        globalDir,
        memoryDir,
      ]),
      mcpServerPath: this.mcpServerPath,
      mcpServerEnv: mcpEnv,
      modelInstructionsFile: this.instructionsFile,
      instructionsMode: this.opts.instructionsMode,
      includeWebSearchMode: this.opts.includeWebSearchMode,
      builtinMcpServerName: this.opts.builtinMcpServerName,
      aliasBuiltinMcpServer: this.opts.aliasBuiltinMcpServer,
      userMcpServers,
      mcpServersMode: this.opts.mcpServersMode,
      dynamicTools: this.dynamicTools,
      dynamicToolHandler: this.dynamicToolHandler,
      readOnly: this.opts.toolScope === 'read-only',
    };

    this.session = new CodexSession(sessionConfig, {
      codexPathOverride: this.opts.command,
      commandDefault: this.opts.commandDefault,
      displayName: this.opts.runnerLabel,
      apiKey: process.env.OPENAI_API_KEY,
    });
  }

  private initializeDynamicTools(isHome: boolean, isAdminHome: boolean): void {
    const { containerInput, groupDir, globalDir, memoryDir } = this.opts;
    const contextManager = createContextManager({
      chatJid: containerInput.chatJid,
      groupFolder: containerInput.groupFolder,
      isHome,
      isAdminHome,
      workspaceIpc: this.opts.ipcPaths.inputDir.replace('/input', ''),
      workspaceGroup: groupDir,
      workspaceGlobal: globalDir,
      workspaceMemory: memoryDir,
      userId: containerInput.userId || undefined,
      skillsDirs: [
        process.env.HAPPYCLAW_PROJECT_SKILLS_DIR || '/workspace/project-skills',
        this.opts.skillsDir,
      ].filter(Boolean),
    });
    const tools = contextManager.getActiveTools();
    const toolMap = new Map(tools.map((tool) => [tool.name, tool]));
    this.dynamicTools = tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters,
      deferLoading: false,
    }));
    this.dynamicToolHandler = async (toolName, args) => {
      const tool = toolMap.get(toolName);
      if (!tool) {
        return { success: false, content: `Unknown tool: ${toolName}` };
      }
      const result = await tool.execute(
        args && typeof args === 'object' && !Array.isArray(args)
          ? (args as Record<string, unknown>)
          : {},
      );
      return { success: !result.isError, content: result.content };
    };
  }

  async applyContext(context: RenderedRunnerContext): Promise<void> {
    this.renderedContext = context;
  }

  private async injectChangedContext(isFreshThread: boolean): Promise<void> {
    if (!this.renderedContext) return;
    const threadId = this.session.getThreadId();
    if (!threadId) return;
    const threadChanged = this.contextThreadId !== threadId;
    const plan = planCodexContextInjection(
      this.contextHashes,
      this.renderedContext.sections,
      {
        threadChanged,
        freshThread: isFreshThread,
      },
    );
    if (plan.changed.length > 0) {
      await this.session.injectContextSections(plan.changed);
    }
    this.contextHashes = plan.nextHashes;
    this.contextThreadId = threadId;
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

  private normalizeProviderUsage(cumulativeUsage: UsageInfo): UsageInfo {
    const previous = this.providerCumulativeUsage;
    this.providerCumulativeUsage = cumulativeUsage;
    if (!previous) return cumulativeUsage;
    return subtractUsage(cumulativeUsage, previous);
  }

  private buildArchiveCompletedMessage(
    archiveResult: Awaited<
      ReturnType<CodexArchiveManager['archiveAfterNativeCompact']>
    >,
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

  private async runPostCompactArchive(): Promise<{
    archiveResult: Awaited<
      ReturnType<CodexArchiveManager['archiveAfterNativeCompact']>
    >;
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
      this.opts.state.setContextSummary(summary);
      return {
        archiveResult,
        statusText: summary
          ? 'session_wrapup_queued_context_ready_for_next_turn'
          : 'session_wrapup_queued_without_summary',
      };
    } finally {
      this.pendingPostCompact = false;
    }
  }

  async *runQuery(
    config: QueryConfig,
  ): AsyncGenerator<NormalizedMessage, QueryResult> {
    const { opts } = this;
    const { log } = opts;

    const composedPrompt = config.prompt;
    const isManualCompact = composedPrompt.trim() === '/compact';
    const resumeTarget = config.resumeAt || config.sessionId || undefined;
    const systemPrompt = this.renderedContext
      ? this.renderedContext.sessionStatic
      : config.systemPrompt;

    fs.writeFileSync(this.instructionsFile, systemPrompt, 'utf-8');
    log(
      `Codex instructions prepared: mode=session-static, chars=${systemPrompt.length}, promptChars=${composedPrompt.length}`,
    );

    // Prepare images (base64 → temp files)
    let imagePaths: string[] | undefined;
    if (config.images && config.images.length > 0) {
      imagePaths = saveImagesToTempFiles(config.images, this.tmpDir);
    }

    // Start or resume thread
    try {
      await this.session.startOrResume(resumeTarget);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (resumeTarget && isCodexSessionResumeFailedError(message)) {
        log(`Codex thread resume failed, rebuilding session: ${message}`);
        this.session.resetThread();
        yield {
          kind: 'error',
          message,
          recoverable: true,
          errorType: 'session_resume_failed',
        };
        return {
          closedDuringQuery: false,
          interruptedDuringQuery: false,
          drainDetectedDuringQuery: false,
          sessionResumeFailed: true,
        };
      }
      throw err;
    }
    await this.injectChangedContext(!resumeTarget);
    if (!resumeTarget) {
      this.providerCumulativeUsage = null;
    }

    // Run turn and convert events
    let usage: UsageInfo | undefined;
    let fallbackUsage: UsageInfo | undefined;
    let finalText: string | null = null;
    let threadId: string | null = null;
    let fatalError: string | undefined;
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
        if (
          event.type === 'item.completed' &&
          event.item.type === 'agent_message'
        ) {
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
        if (event.type === 'turn.failed' && !fatalError) {
          fatalError = event.error.message;
          yield {
            kind: 'error',
            message: fatalError,
            recoverable: false,
          };
        }
        if (event.type === 'error') {
          const detail = formatCodexAppServerError(event);
          if (event.willRetry) {
            log(`Codex app-server error, retrying current turn: ${detail}`);
          } else {
            const firstFatalError = fatalError === undefined;
            if (!fatalError || detail.length > fatalError.length) {
              fatalError = detail;
            }
            if (firstFatalError) {
              yield {
                kind: 'error',
                message: fatalError,
                recoverable: false,
              };
            }
          }
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

    // A fatal app-server error can be followed by turn/completed(status=failed).
    // Do not emit a misleading success result before query-loop reports failure.
    if (!fatalError) {
      yield { kind: 'result', text: finalText, usage };
    }

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
      ...(fatalError ? { genericError: fatalError } : {}),
    };
  }

  async pushMessage(
    text: string,
    images?: Array<{ data: string; mimeType?: string }>,
    deliveryId?: string,
  ): Promise<PushMessageResult> {
    if (!this.ipcCapabilities.supportsMidQueryPush) {
      return {
        status: 'buffer',
        reason: `${this.opts.runnerLabel || 'Runner'} 不支持 turn 内消息推送`,
      };
    }
    const imagePaths =
      images && images.length > 0
        ? saveImagesToTempFiles(images, this.tmpDir)
        : [];
    const input: Array<Record<string, unknown>> = [
      { type: 'text', text, text_elements: [] },
      ...imagePaths.map((imagePath) => ({
        type: 'localImage',
        path: imagePath,
      })),
    ];
    try {
      await this.session.steer(
        input,
        this.opts.includeSteerClientUserMessageId === false
          ? undefined
          : deliveryId,
      );
      return { status: 'accepted' };
    } catch (err) {
      return {
        status: 'buffer',
        reason: `Codex turn/steer 失败: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
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
      activeToolDurationMs:
        oldestStartedAt > 0 ? Date.now() - oldestStartedAt : 0,
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
    } catch {
      /* ignore */
    }
  }

  private trackActivityEvent(event: CodexThreadEvent): void {
    if (event.type === 'item.started' && this.isToolLikeItem(event.item.type)) {
      this.activeToolCalls.set(event.item.id, Date.now());
      return;
    }
    if (
      event.type === 'item.completed' &&
      this.isToolLikeItem(event.item.type)
    ) {
      this.activeToolCalls.delete(event.item.id);
      return;
    }
    if (
      event.type === 'turn.completed' ||
      event.type === 'turn.failed' ||
      event.type === 'error'
    ) {
      this.activeToolCalls.clear();
    }
  }

  private isToolLikeItem(itemType: CodexItemType): boolean {
    return (
      itemType === 'command_execution' ||
      itemType === 'mcp_tool_call' ||
      itemType === 'file_change' ||
      itemType === 'web_search'
    );
  }
}
