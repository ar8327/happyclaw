import path from 'path';
import type { ContextManager } from 'happyclaw-agent-runner-core';
import { buildChannelRoutingReminder, normalizeHomeFlags } from 'happyclaw-agent-runner-core';

import type {
  AgentRunner,
  IpcCapabilities,
  QueryConfig,
  QueryResult,
  NormalizedMessage,
  ActivityReport,
} from '../../runner-interface.js';
import type { ContainerInput, ContainerOutput } from '../../types.js';
import { StreamEventProcessor } from './claude-stream-processor.js';
import {
  ClaudeSession,
  type ClaudePermissionMode,
  type ClaudeSessionConfig,
} from './claude-session.js';
import { createContextManager } from '../../context-manager-factory.js';
import { DEFAULT_ALLOWED_TOOLS, DEFAULT_CLAUDE_BUILTIN_TOOLS } from './claude-config.js';
import type { SessionState } from '../../session-state.js';
import type { IpcPaths } from '../../ipc-handler.js';

export interface ClaudeRunnerOptions {
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
}

function isContextOverflowError(msg: string): boolean {
  return [
    /prompt is too long/i,
    /maximum context length/i,
    /context.*too large/i,
    /exceeds.*token limit/i,
    /context window.*exceeded/i,
  ].some((pattern) => pattern.test(msg));
}

function isImageMimeMismatchError(msg: string): boolean {
  return (
    /image\s+was\s+specified\s+using\s+the\s+image\/[a-z0-9.+-]+\s+media\s+type,\s+but\s+the\s+image\s+appears\s+to\s+be\s+(?:an?\s+)?image\/[a-z0-9.+-]+\s+image/i.test(msg) ||
    /image\/[a-z0-9.+-]+\s+media\s+type.*appears\s+to\s+be.*image\/[a-z0-9.+-]+/i.test(msg)
  );
}

function isUnrecoverableTranscriptError(msg: string): boolean {
  const isImageSizeError =
    /image.*dimensions?\s+exceed/i.test(msg) ||
    /max\s+allowed\s+size.*pixels/i.test(msg);
  const isMimeMismatch = isImageMimeMismatchError(msg);
  const isApiReject = /invalid_request_error/i.test(msg);
  return isApiReject && (isImageSizeError || isMimeMismatch);
}

function extractResultText(message: Record<string, unknown>): string | null {
  const result = message.result;
  return typeof result === 'string' ? result : null;
}

function isInterruptedResult(message: Record<string, unknown>, session: ClaudeSession): boolean {
  const subtype = typeof message.subtype === 'string' ? message.subtype : '';
  const stopReason = typeof message.stop_reason === 'string' ? message.stop_reason : '';
  const resultText = extractResultText(message) || '';
  const looksLikeRejectedToolUse =
    /tool use was rejected/i.test(resultText) ||
    /user doesn't want to proceed with this tool use/i.test(resultText);

  return session.wasInterrupted()
    && subtype === 'error_during_execution'
    && (stopReason === 'tool_use' || looksLikeRejectedToolUse);
}

export class ClaudeRunner implements AgentRunner {
  readonly ipcCapabilities: IpcCapabilities = {
    supportsMidQueryPush: false,
    supportsRuntimeModeSwitch: false,
  };

  private session!: ClaudeSession;
  private processor: StreamEventProcessor | null = null;
  private ctxMgr!: ContextManager;
  private mcpServerPath!: string;
  private mcpServerEnv!: Record<string, string>;
  private readonly opts: ClaudeRunnerOptions;
  private toolCallStartedAt: number | null = null;
  private pendingRoutingReminder: string | null = null;

  constructor(opts: ClaudeRunnerOptions) {
    this.opts = opts;
  }

  async initialize(): Promise<void> {
    const { containerInput, groupDir, globalDir, memoryDir } = this.opts;
    const { isHome, isAdminHome } = normalizeHomeFlags(containerInput);

    const projectSkillsDir = process.env.HAPPYCLAW_PROJECT_SKILLS_DIR || '/workspace/project-skills';
    const userSkillsDir = this.opts.skillsDir;
    const skillsDirs = [projectSkillsDir, userSkillsDir].filter(Boolean);

    this.ctxMgr = createContextManager({
      chatJid: containerInput.chatJid,
      groupFolder: containerInput.groupFolder,
      isHome,
      isAdminHome,
      workspaceIpc: this.opts.ipcPaths.inputDir.replace('/input', ''),
      workspaceGroup: groupDir,
      workspaceGlobal: globalDir,
      workspaceMemory: memoryDir,
      userId: containerInput.userId,
      skillsDirs,
    }, { nativeCapabilities: ['skills'] });

    this.mcpServerPath = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      '../../happyclaw-mcp-server.js',
    );
    this.mcpServerEnv = {
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
      HAPPYCLAW_SKILLS_DIR: this.opts.skillsDir,
      HAPPYCLAW_PROJECT_SKILLS_DIR: projectSkillsDir,
    };

    this.session = new ClaudeSession(this.opts.log);
  }

  private createProcessor(streamEventQueue: NormalizedMessage[]): StreamEventProcessor {
    const { state } = this.opts;
    return new StreamEventProcessor((output) => {
      if (output.streamEvent) {
        streamEventQueue.push({ kind: 'stream_event', event: output.streamEvent });
      }
    }, this.opts.log, (newMode) => {
      state.currentPermissionMode = newMode;
    });
  }

  private buildSessionConfig(config: QueryConfig, prompt: string): ClaudeSessionConfig {
    const { opts } = this;
    const { isHome, isAdminHome } = normalizeHomeFlags(opts.containerInput);

    opts.state.extractSourceChannels(prompt, opts.imChannelsFile);
    this.ctxMgr.updateDynamicContext({
      recentImChannels: opts.state.recentImChannels,
      contextSummary: opts.containerInput.contextSummary,
    });

    return {
      sessionId: config.sessionId,
      resumeAt: config.resumeAt,
      cwd: opts.groupDir,
      additionalDirectories: [opts.globalDir, opts.memoryDir],
      model: opts.model,
      thinkingEffort: opts.thinkingEffort,
      permissionMode: (config.permissionMode ?? opts.state.currentPermissionMode) as ClaudePermissionMode,
      builtinTools: DEFAULT_CLAUDE_BUILTIN_TOOLS,
      allowedTools: DEFAULT_ALLOWED_TOOLS,
      systemPromptAppend: this.ctxMgr.buildAppendPrompt(),
      isHostMode: process.env.HAPPYCLAW_HOST_MODE === '1',
      isHome,
      isAdminHome,
      groupFolder: opts.containerInput.groupFolder,
      userId: opts.containerInput.userId,
      mcpServerPath: this.mcpServerPath,
      mcpServerEnv: this.mcpServerEnv,
      disableSlashCommands: true,
    };
  }

  private async consumeCompactEvents(
    events: Array<Record<string, unknown>>,
    processor: StreamEventProcessor,
    streamEventQueue: NormalizedMessage[],
    state: SessionState,
  ): Promise<void> {
    for (const event of events) {
      if (event.type === 'stream_event') {
        processor.processStreamEvent(event as any);
      } else if (event.type === 'tool_progress') {
        processor.processToolProgress(event as any);
      } else if (event.type === 'tool_use_summary') {
        processor.processToolUseSummary(event as any);
      } else if (event.type === 'system') {
        if ((event as any).subtype === 'compact_boundary') {
          const channels = [...state.recentImChannels];
          this.pendingRoutingReminder = buildChannelRoutingReminder(channels);
        } else {
          processor.processSystemMessage(event as any);
        }
      } else if (event.type === 'assistant') {
        processor.processAssistantMessage(event as any);
      } else if (event.type === 'user') {
        processor.processSubAgentMessage(event as any);
      }

      while (streamEventQueue.length > 0) {
        streamEventQueue.shift();
      }
    }
  }

  async *runQuery(config: QueryConfig): AsyncGenerator<NormalizedMessage, QueryResult> {
    const { opts } = this;
    const { state, log } = opts;
    const streamEventQueue: NormalizedMessage[] = [];
    this.processor = this.createProcessor(streamEventQueue);

    const composedPrompt = this.pendingRoutingReminder
      ? `${this.pendingRoutingReminder}\n\n${config.prompt}`
      : config.prompt;
    this.pendingRoutingReminder = null;

    const sessionConfig = this.buildSessionConfig(config, composedPrompt);
    const mcpServers = opts.loadUserMcpServers();

    let attempt = 0;
    while (attempt < 2) {
      attempt += 1;
      let newSessionId: string | undefined;
      let lastResumeUuid: string | undefined;
      let toolCallStartedAt: number | null = null;

      try {
        const messageGen = this.session.run(sessionConfig, mcpServers);
        const rejected = this.session.pushMessage(composedPrompt, config.images);
        for (const reason of rejected) {
          yield { kind: 'stream_event', event: { eventType: 'status', statusText: `⚠️ ${reason}` } };
        }

        for await (const message of messageGen) {
          if (this.processor.hasActiveToolCall && toolCallStartedAt === null) {
            toolCallStartedAt = Date.now();
            this.toolCallStartedAt = toolCallStartedAt;
          } else if (!this.processor.hasActiveToolCall) {
            toolCallStartedAt = null;
            this.toolCallStartedAt = null;
          }

          if (message.type === 'stream_event') {
            this.processor.processStreamEvent(message as any);
            while (streamEventQueue.length > 0) yield streamEventQueue.shift()!;
            continue;
          }
          if (message.type === 'tool_progress') {
            this.processor.processToolProgress(message as any);
            while (streamEventQueue.length > 0) yield streamEventQueue.shift()!;
            continue;
          }
          if (message.type === 'tool_use_summary') {
            this.processor.processToolUseSummary(message as any);
            while (streamEventQueue.length > 0) yield streamEventQueue.shift()!;
            continue;
          }

          if (message.type === 'system') {
            const subtype = (message as any).subtype;
            if (subtype === 'init') {
              const observedSessionId = typeof (message as any).session_id === 'string'
                ? (message as any).session_id as string
                : this.session.getCurrentSessionId();
              if (observedSessionId && observedSessionId !== newSessionId) {
                newSessionId = observedSessionId;
                yield { kind: 'session_init', sessionId: observedSessionId };
              }
              continue;
            }
            if (subtype === 'compact_boundary') {
              const channels = [...state.recentImChannels];
              log(channels.length > 0
                ? `Context compacted, staging routing reminder for channels: ${channels.join(', ')}`
                : 'Context compacted, no IM channels tracked');
              this.pendingRoutingReminder = buildChannelRoutingReminder(channels);
              continue;
            }
            if (subtype === 'task_notification') {
              this.processor.processTaskNotification(message as any);
              while (streamEventQueue.length > 0) yield streamEventQueue.shift()!;
              continue;
            }
            if (subtype === 'api_retry') {
              const attemptNum = (message as any).attempt;
              const maxRetries = (message as any).max_retries;
              yield {
                kind: 'stream_event',
                event: { eventType: 'status', statusText: `api_retry:${attemptNum}/${maxRetries}` },
              };
              continue;
            }
            if (this.processor.processSystemMessage(message as any)) {
              while (streamEventQueue.length > 0) yield streamEventQueue.shift()!;
              continue;
            }
          }

          if (message.type === 'user' && !(message as any).parent_tool_use_id) {
            const userContent = (message as any).message?.content;
            if (Array.isArray(userContent)) {
              for (const block of userContent) {
                if (block.type === 'tool_result' && block.tool_use_id && Array.isArray(block.content)) {
                  const text = block.content.map((b: { text?: string }) => b.text || '').join('');
                  const agentIdMatch = text.match(/agentId:\s*([a-f0-9]+)/);
                  if (agentIdMatch && this.processor.isBackgroundTask(block.tool_use_id)) {
                    this.processor.registerSdkTaskId(agentIdMatch[1], block.tool_use_id);
                  }
                }
              }
            }
          }

          this.processor.processSubAgentMessage(message as any);
          while (streamEventQueue.length > 0) yield streamEventQueue.shift()!;

          if (message.type === 'assistant' && 'uuid' in message) {
            const content = (message as any).message?.content;
            const hasText = Array.isArray(content)
              ? content.some((block: { type: string }) => block.type === 'text')
              : typeof content === 'string';
            if (hasText) {
              lastResumeUuid = (message as any).uuid as string;
              yield { kind: 'resume_anchor', anchor: lastResumeUuid };
            }
            this.processor.processAssistantMessage(message as any);
            while (streamEventQueue.length > 0) yield streamEventQueue.shift()!;
          }

          if (message.type === 'user' && 'uuid' in message) {
            const content = (message as any).message?.content;
            const hasToolResult = Array.isArray(content)
              && content.some((block: { type: string }) => block.type === 'tool_result');
            if (hasToolResult) {
              lastResumeUuid = (message as any).uuid as string;
              yield { kind: 'resume_anchor', anchor: lastResumeUuid };
            }
          }

          if (message.type === 'result') {
            const resultMessage = message as Record<string, unknown>;
            const textResult = extractResultText(resultMessage);
            const resultSubtype = typeof resultMessage.subtype === 'string'
              ? resultMessage.subtype
              : undefined;
            const isCliError = resultMessage.is_error === true || !!(resultSubtype && resultSubtype.startsWith('error'));

            if (isInterruptedResult(resultMessage, this.session)) {
              this.processor.cleanup();
              return {
                newSessionId: newSessionId || this.session.getCurrentSessionId(),
                resumeAnchor: lastResumeUuid,
                closedDuringQuery: false,
                interruptedDuringQuery: false,
                drainDetectedDuringQuery: false,
              };
            }

            if (isCliError) {
              const detail = textResult?.trim() || `Claude Code execution failed (${resultSubtype || 'unknown'})`;
              if (!newSessionId) {
                yield {
                  kind: 'error',
                  message: `Session resume failed: ${detail}`,
                  recoverable: false,
                  errorType: 'session_resume_failed',
                };
                this.processor.cleanup();
                return {
                  newSessionId,
                  resumeAnchor: lastResumeUuid,
                  closedDuringQuery: false,
                  interruptedDuringQuery: false,
                  drainDetectedDuringQuery: false,
                  sessionResumeFailed: true,
                };
              }
              if (isContextOverflowError(detail)) {
                const compactEvents = await this.session.compact();
                await this.consumeCompactEvents(compactEvents, this.processor, streamEventQueue, state);
                this.processor.resetFullTextAccumulator();
                yield {
                  kind: 'error',
                  message: detail,
                  recoverable: true,
                  errorType: 'context_overflow',
                };
                this.processor.cleanup();
                return {
                  newSessionId,
                  resumeAnchor: lastResumeUuid,
                  closedDuringQuery: false,
                  interruptedDuringQuery: false,
                  drainDetectedDuringQuery: false,
                  contextOverflow: true,
                };
              }
              if (isUnrecoverableTranscriptError(detail)) {
                this.processor.resetFullTextAccumulator();
                yield {
                  kind: 'error',
                  message: detail,
                  recoverable: false,
                  errorType: 'unrecoverable_transcript',
                };
                this.processor.cleanup();
                return {
                  newSessionId,
                  resumeAnchor: lastResumeUuid,
                  closedDuringQuery: false,
                  interruptedDuringQuery: false,
                  drainDetectedDuringQuery: false,
                  unrecoverableTranscriptError: true,
                };
              }
              throw new Error(detail);
            }

            if (textResult && isContextOverflowError(textResult)) {
              const compactEvents = await this.session.compact();
              await this.consumeCompactEvents(compactEvents, this.processor, streamEventQueue, state);
              this.processor.resetFullTextAccumulator();
              yield {
                kind: 'error',
                message: textResult,
                recoverable: true,
                errorType: 'context_overflow',
              };
              this.processor.cleanup();
              return {
                newSessionId,
                resumeAnchor: lastResumeUuid,
                closedDuringQuery: false,
                interruptedDuringQuery: false,
                drainDetectedDuringQuery: false,
                contextOverflow: true,
              };
            }
            if (textResult && isUnrecoverableTranscriptError(textResult)) {
              this.processor.resetFullTextAccumulator();
              yield {
                kind: 'error',
                message: textResult,
                recoverable: false,
                errorType: 'unrecoverable_transcript',
              };
              this.processor.cleanup();
              return {
                newSessionId,
                resumeAnchor: lastResumeUuid,
                closedDuringQuery: false,
                interruptedDuringQuery: false,
                drainDetectedDuringQuery: false,
                unrecoverableTranscriptError: true,
              };
            }

            const { effectiveResult } = this.processor.processResult(textResult);
            while (streamEventQueue.length > 0) yield streamEventQueue.shift()!;

            const cliUsage = resultMessage.usage as Record<string, number> | undefined;
            const cliModelUsage = resultMessage.modelUsage as Record<string, Record<string, number>> | undefined;
            let usageInfo = undefined;
            if (cliUsage) {
              const modelUsageSummary: Record<string, { inputTokens: number; outputTokens: number; costUSD: number }> = {};
              if (cliModelUsage && Object.keys(cliModelUsage).length > 0) {
                for (const [modelName, usage] of Object.entries(cliModelUsage)) {
                  modelUsageSummary[modelName] = {
                    inputTokens: usage.inputTokens || 0,
                    outputTokens: usage.outputTokens || 0,
                    costUSD: usage.costUSD || 0,
                  };
                }
              } else {
                modelUsageSummary[opts.model] = {
                  inputTokens: cliUsage.input_tokens || 0,
                  outputTokens: cliUsage.output_tokens || 0,
                  costUSD: (resultMessage.total_cost_usd as number) || 0,
                };
              }
              usageInfo = {
                inputTokens: cliUsage.input_tokens || 0,
                outputTokens: cliUsage.output_tokens || 0,
                cacheReadInputTokens: cliUsage.cache_read_input_tokens || 0,
                cacheCreationInputTokens: cliUsage.cache_creation_input_tokens || 0,
                costUSD: (resultMessage.total_cost_usd as number) || 0,
                durationMs: (resultMessage.duration_ms as number) || 0,
                numTurns: (resultMessage.num_turns as number) || 0,
                modelUsage: Object.keys(modelUsageSummary).length > 0 ? modelUsageSummary : undefined,
              };
            }

            yield { kind: 'result', text: effectiveResult, usage: usageInfo };

            if (this.processor.pendingBackgroundTaskCount > 0) {
              log(`Result received but ${this.processor.pendingBackgroundTaskCount} background task(s) pending`);
              continue;
            }
            this.processor.cleanup();
            return {
              newSessionId: newSessionId || this.session.getCurrentSessionId(),
              resumeAnchor: lastResumeUuid,
              closedDuringQuery: false,
              interruptedDuringQuery: false,
              drainDetectedDuringQuery: false,
            };
          }
        }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        if (err instanceof Error && err.name === 'ClaudeSessionExitError' && attempt < 2) {
          log(`Claude subprocess exited during turn, retrying once with transcript fallback: ${errorMessage}`);
          this.session.markProcessLost();
          this.processor.resetFullTextAccumulator();
          streamEventQueue.length = 0;
          continue;
        }
        if (isContextOverflowError(errorMessage)) {
          yield { kind: 'error', message: errorMessage, recoverable: true, errorType: 'context_overflow' };
          this.processor.cleanup();
          return {
            newSessionId: this.session.getCurrentSessionId(),
            resumeAnchor: undefined,
            closedDuringQuery: false,
            interruptedDuringQuery: false,
            drainDetectedDuringQuery: false,
            contextOverflow: true,
          };
        }
        if (isUnrecoverableTranscriptError(errorMessage)) {
          yield { kind: 'error', message: errorMessage, recoverable: false, errorType: 'unrecoverable_transcript' };
          this.processor.cleanup();
          return {
            newSessionId: this.session.getCurrentSessionId(),
            resumeAnchor: undefined,
            closedDuringQuery: false,
            interruptedDuringQuery: false,
            drainDetectedDuringQuery: false,
            unrecoverableTranscriptError: true,
          };
        }
        throw err;
      }
    }

    this.processor.cleanup();
    return {
      newSessionId: this.session.getCurrentSessionId(),
      resumeAnchor: undefined,
      closedDuringQuery: false,
      interruptedDuringQuery: false,
      drainDetectedDuringQuery: false,
      sessionResumeFailed: true,
    };
  }

  pushMessage(text: string, images?: Array<{ data: string; mimeType?: string }>): string[] {
    return this.session.pushMessage(text, images);
  }

  async interrupt(): Promise<void> {
    await this.session.interrupt();
  }

  getActivityReport(): ActivityReport {
    const hasActive = this.processor?.hasActiveToolCall ?? false;
    return {
      hasActiveToolCall: hasActive,
      activeToolDurationMs: hasActive && this.toolCallStartedAt
        ? Date.now() - this.toolCallStartedAt
        : 0,
      hasPendingBackgroundTasks: (this.processor?.pendingBackgroundTaskCount ?? 0) > 0,
    };
  }

  async cleanup(): Promise<void> {
    this.session.end();
  }
}
