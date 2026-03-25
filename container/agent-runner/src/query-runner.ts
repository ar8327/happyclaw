/**
 * Query Runner — orchestrates a single Claude query lifecycle.
 *
 * Extracted from index.ts to keep the main entry point focused on
 * the outer session loop (stdin parsing, IPC waiting between queries,
 * overflow retries, drain/close handling).
 *
 * Three exported functions:
 *  - runQuery()       — top-level orchestration
 *  - processMessages() — the for-await message loop + activity watchdog
 *  - createIpcPoller() — IPC polling closure during a query
 */

import type { PermissionMode, McpServerConfig } from '@anthropic-ai/claude-agent-sdk';

import type { ContainerInput, ContainerOutput } from './types.js';
import { StreamEventProcessor } from './stream-processor.js';
import { ClaudeSession, type ClaudeSessionConfig } from './claude-session.js';
import { SessionState } from './session-state.js';
import { buildSystemPromptAppend, buildChannelRoutingReminder, normalizeHomeFlags } from './context-builder.js';
import {
  IPC_POLL_MS,
  shouldClose,
  shouldDrain,
  shouldInterrupt,
  drainIpcInput,
  type IpcPaths,
} from './ipc-handler.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LogFn = (message: string) => void;
export type WriteOutputFn = (output: ContainerOutput) => void;

export interface QueryResult {
  newSessionId?: string;
  lastAssistantUuid?: string;
  lastResumeUuid?: string;
  closedDuringQuery: boolean;
  contextOverflow?: boolean;
  unrecoverableTranscriptError?: boolean;
  interruptedDuringQuery: boolean;
  sessionResumeFailed?: boolean;
  drainDetectedDuringQuery?: boolean;
}

// ---------------------------------------------------------------------------
// Error detection helpers (private to this module)
// ---------------------------------------------------------------------------

/** 检测是否为上下文溢出错误 */
function isContextOverflowError(msg: string): boolean {
  const patterns: RegExp[] = [
    /prompt is too long/i,
    /maximum context length/i,
    /context.*too large/i,
    /exceeds.*token limit/i,
    /context window.*exceeded/i,
  ];
  return patterns.some(pattern => pattern.test(msg));
}

/**
 * 检测会话转录中不可恢复的请求错误（400 invalid_request_error）。
 * 这类错误被固化在会话历史中，每次 resume 都会重放导致永久失败。
 * 例如：图片尺寸超过 8000px 限制、图片 MIME 声明与真实内容不一致等。
 *
 * 判定条件：必须同时满足「图片特征」+「API 拒绝」，避免对通用 400 错误误判导致会话丢失。
 */
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

// ---------------------------------------------------------------------------
// IPC poller — polls for sentinels and follow-up messages during a query
// ---------------------------------------------------------------------------

interface IpcPollerState {
  ipcPolling: boolean;
  closedDuringQuery: boolean;
  interruptedDuringQuery: boolean;
  drainDetectedDuringQuery: boolean;
  waitingForBackgroundTasks: boolean;
}

/**
 * Creates the IPC polling closure that runs on a timer during a query.
 * Returns the mutable state object so the caller can read/write flags.
 */
export function createIpcPoller(
  state: SessionState,
  session: ClaudeSession,
  processor: StreamEventProcessor,
  ipcPaths: IpcPaths,
  log: LogFn,
  emit: (output: ContainerOutput) => void,
  imChannelsFile: string,
): IpcPollerState {
  const pollerState: IpcPollerState = {
    ipcPolling: true,
    closedDuringQuery: false,
    interruptedDuringQuery: false,
    drainDetectedDuringQuery: false,
    waitingForBackgroundTasks: false,
  };

  const poll = () => {
    if (!pollerState.ipcPolling) return;
    if (shouldClose(ipcPaths)) {
      log('Close sentinel detected during query, ending stream');
      pollerState.closedDuringQuery = true;
      session.end();
      pollerState.ipcPolling = false;
      return;
    }
    // Check for _drain during query: consume the sentinel immediately so it
    // isn't lost to a filesystem race, but let the current query finish.
    if (!pollerState.drainDetectedDuringQuery && shouldDrain(ipcPaths)) {
      log('Drain sentinel detected during query, will exit after query completes');
      pollerState.drainDetectedDuringQuery = true;
      // Don't end the stream or stop polling — let the query finish naturally.
    }
    if (shouldInterrupt(ipcPaths)) {
      log('Interrupt sentinel detected, interrupting current query');
      pollerState.interruptedDuringQuery = true;
      state.markInterruptRequested();
      session.interrupt().catch((err: unknown) => log(`Interrupt call failed: ${err}`));
      session.end();
      pollerState.ipcPolling = false;
      return;
    }
    const { messages, modeChange } = drainIpcInput(ipcPaths, log);
    if (modeChange) {
      state.currentPermissionMode = modeChange as PermissionMode;
      log(`Mode change via IPC: ${modeChange}`);
      session.setPermissionMode(modeChange as PermissionMode).catch((err: unknown) =>
        log(`setPermissionMode failed: ${err}`),
      );
    }
    for (const msg of messages) {
      log(`Piping IPC message into active query (${msg.text.length} chars, ${msg.images?.length || 0} images)`);
      // Track IM channels for post-compaction routing reminder
      state.extractSourceChannels(msg.text, imChannelsFile);
      // Emit acknowledgement so host can track IPC delivery
      emit({ status: 'stream', result: null, streamEvent: { eventType: 'status', statusText: 'ipc_message_received' } });
      const rejected = session.pushMessage(msg.text, msg.images);
      for (const reason of rejected) {
        emit({ status: 'success', result: `\u26a0\ufe0f ${reason}`, newSessionId: undefined });
      }
    }
    setTimeout(poll, IPC_POLL_MS);
  };
  setTimeout(poll, IPC_POLL_MS);

  return pollerState;
}

// ---------------------------------------------------------------------------
// Message processing loop — the for-await over SDK messages
// ---------------------------------------------------------------------------

/**
 * Processes the SDK message stream (for-await loop).
 * Handles stream events, tool progress, system messages, assistant/user
 * messages, task notifications, results, and the activity watchdog.
 *
 * Returns partial QueryResult fields populated during iteration.
 */
export async function processMessages(
  messageStream: AsyncIterable<any>,
  processor: StreamEventProcessor,
  state: SessionState,
  session: ClaudeSession,
  ipcPaths: IpcPaths,
  log: LogFn,
  emit: (output: ContainerOutput) => void,
  emitOutput: boolean,
  pollerState: IpcPollerState,
  imChannelsFile: string,
  model: string,
): Promise<QueryResult> {
  // Activity watchdog constants
  const QUERY_ACTIVITY_TIMEOUT_MS = 300_000;
  const TOOL_CALL_HARD_TIMEOUT_MS = parseInt(
    process.env.TOOL_CALL_HARD_TIMEOUT_MS || '1200000', 10,
  );
  let toolCallStartedAt: number | null = null;
  let lastEventAt = Date.now();
  let queryActivityTimer: ReturnType<typeof setTimeout> | null = null;

  const resetQueryActivityTimer = () => {
    lastEventAt = Date.now();
    if (queryActivityTimer) clearTimeout(queryActivityTimer);
    queryActivityTimer = setTimeout(() => {
      if (!pollerState.ipcPolling && !pollerState.waitingForBackgroundTasks) return; // query already ended
      // Don't interrupt while background sub-agents are still running
      if (processor.pendingBackgroundTaskCount > 0) {
        log(`Activity timeout skipped: ${processor.pendingBackgroundTaskCount} background task(s) still running, extending timer`);
        resetQueryActivityTimer();
        return;
      }
      // Allow active tool calls to continue, but enforce a hard timeout
      if (processor.hasActiveToolCall) {
        const elapsed = toolCallStartedAt ? Date.now() - toolCallStartedAt : 0;
        if (elapsed < TOOL_CALL_HARD_TIMEOUT_MS) {
          log(`Activity timeout skipped: tool call in progress (${Math.round(elapsed / 1000)}s), extending timer`);
          resetQueryActivityTimer();
          return;
        }
        log(`Tool call hard timeout: tool has been running for ${Math.round(elapsed / 1000)}s (limit ${TOOL_CALL_HARD_TIMEOUT_MS / 1000}s), forcing interrupt`);
      } else {
        log(`Query activity timeout: no SDK events for ${QUERY_ACTIVITY_TIMEOUT_MS}ms, forcing interrupt`);
      }
      pollerState.interruptedDuringQuery = true;
      pollerState.waitingForBackgroundTasks = false;
      session.interrupt().catch((err: unknown) => log(`Activity timeout interrupt failed: ${err}`));
      session.end();
      pollerState.ipcPolling = false;
    }, QUERY_ACTIVITY_TIMEOUT_MS);
  };
  resetQueryActivityTimer();

  let newSessionId: string | undefined;
  let lastAssistantUuid: string | undefined;
  let lastResumeUuid: string | undefined;
  let messageCount = 0;
  let resultCount = 0;

  for await (const message of messageStream) {
    // Reset activity watchdog on every SDK event
    resetQueryActivityTimer();
    // Track tool call start time for hard timeout enforcement
    if (processor.hasActiveToolCall && toolCallStartedAt === null) {
      toolCallStartedAt = Date.now();
    } else if (!processor.hasActiveToolCall) {
      toolCallStartedAt = null;
    }

    // 流式事件处理
    if (message.type === 'stream_event') {
      processor.processStreamEvent(message as any);
      continue;
    }

    if (message.type === 'tool_progress') {
      processor.processToolProgress(message as any);
      continue;
    }

    if (message.type === 'tool_use_summary') {
      processor.processToolUseSummary(message as any);
      continue;
    }

    // Hook 事件
    if (message.type === 'system') {
      const sys = message as any;
      if (processor.processSystemMessage(sys)) {
        continue;
      }
    }

    messageCount++;
    const msgType = message.type === 'system' ? `system/${(message as { subtype?: string }).subtype}` : message.type;
    const msgParentToolUseId = (message as any).parent_tool_use_id ?? null;
    // 诊断：对所有 assistant/user 消息打印 parent_tool_use_id 和内容块类型
    if (message.type === 'assistant' || message.type === 'user') {
      const rawParent = (message as any).parent_tool_use_id;
      const contentTypes = (Array.isArray((message as any).message?.content)
        ? ((message as any).message.content as Array<{ type: string }>).map(b => b.type).join(',')
        : typeof (message as any).message?.content === 'string' ? 'string' : 'none');
      log(`[msg #${messageCount}] type=${msgType} parent_tool_use_id=${rawParent === undefined ? 'UNDEFINED' : rawParent === null ? 'NULL' : rawParent} content_types=[${contentTypes}] keys=[${Object.keys(message).join(',')}]`);
    } else {
      log(`[msg #${messageCount}] type=${msgType}${msgParentToolUseId ? ` parent=${msgParentToolUseId.slice(0, 12)}` : ''}`);
    }

    // ── Extract SDK task_id from background Task tool_results ──
    if (message.type === 'user' && !msgParentToolUseId) {
      const userContent = (message as any).message?.content;
      if (Array.isArray(userContent)) {
        for (const block of userContent) {
          if (block.type === 'tool_result' && block.tool_use_id && Array.isArray(block.content)) {
            const text = block.content.map((b: { text?: string }) => b.text || '').join('');
            const agentIdMatch = text.match(/agentId:\s*([a-f0-9]+)/);
            if (agentIdMatch && processor.isBackgroundTask(block.tool_use_id)) {
              processor.registerSdkTaskId(agentIdMatch[1], block.tool_use_id);
            }
          }
        }
      }
    }

    // ── 子 Agent 消息转 StreamEvent ──
    processor.processSubAgentMessage(message as any);

    if (message.type === 'assistant' && 'uuid' in message) {
      // Only update lastAssistantUuid for assistant messages that contain text
      const assistantContent = (message as any).message?.content;
      const hasTextContent = Array.isArray(assistantContent)
        ? assistantContent.some((b: { type: string }) => b.type === 'text')
        : typeof assistantContent === 'string';
      if (hasTextContent) {
        lastAssistantUuid = (message as { uuid: string }).uuid;
        lastResumeUuid = lastAssistantUuid;
      }
      processor.processAssistantMessage(message as any);
    }

    // Track user(tool_result) UUIDs as resume points.
    if (message.type === 'user' && 'uuid' in message) {
      const userContent = (message as any).message?.content;
      const hasToolResult = Array.isArray(userContent)
        && userContent.some((b: { type: string }) => b.type === 'tool_result');
      if (hasToolResult) {
        lastResumeUuid = (message as { uuid: string }).uuid;
      }
    }

    if (message.type === 'system' && message.subtype === 'init') {
      newSessionId = message.session_id;
      log(`Session initialized: ${newSessionId}`);
    }

    // After context compaction, inject a routing reminder
    if (message.type === 'system' && (message as { subtype?: string }).subtype === 'compact_boundary') {
      const channels = [...state.recentImChannels];
      if (channels.length > 0) {
        log(`Context compacted, injecting routing reminder for channels: ${channels.join(', ')}`);
      } else {
        log('Context compacted, no IM channels tracked');
      }
      session.pushMessage(buildChannelRoutingReminder(channels));
    }

    if (message.type === 'system' && (message as { subtype?: string }).subtype === 'task_notification') {
      const tn = message as unknown as { task_id: string; tool_use_id?: string; status: string; summary: string };
      processor.processTaskNotification(tn);
    }

    if (message.type === 'result') {
      resultCount++;
      const textResult = 'result' in message ? (message as { result?: string }).result : null;
      const resultSubtype = message.subtype;
      log(`Result #${resultCount}: subtype=${resultSubtype}${textResult ? ` text=${textResult.slice(0, 200)}` : ''}`);

      // ── Error results: always end the stream immediately ──

      if (typeof resultSubtype === 'string' && (resultSubtype === 'error_during_execution' || resultSubtype.startsWith('error'))) {
        if (queryActivityTimer) clearTimeout(queryActivityTimer);
        pollerState.waitingForBackgroundTasks = false;
        pollerState.ipcPolling = false;
        session.end();
        if (!newSessionId) {
          log(`Session resume failed (no init): ${resultSubtype}`);
          return {
            newSessionId, lastAssistantUuid,
            closedDuringQuery: pollerState.closedDuringQuery,
            interruptedDuringQuery: pollerState.interruptedDuringQuery,
            sessionResumeFailed: true,
          };
        }
        const detail = textResult?.trim()
          ? textResult.trim()
          : `Claude Code execution failed (${resultSubtype})`;
        throw new Error(detail);
      }

      // SDK 将某些 API 错误包装为 subtype=success 的 result（不抛异常）
      if (textResult && isContextOverflowError(textResult)) {
        if (queryActivityTimer) clearTimeout(queryActivityTimer);
        pollerState.waitingForBackgroundTasks = false;
        pollerState.ipcPolling = false;
        session.end();
        log(`Context overflow detected in result: ${textResult.slice(0, 100)}`);
        processor.resetFullTextAccumulator();
        return {
          newSessionId, lastAssistantUuid,
          closedDuringQuery: pollerState.closedDuringQuery,
          contextOverflow: true,
          interruptedDuringQuery: pollerState.interruptedDuringQuery,
        };
      }
      if (textResult && isUnrecoverableTranscriptError(textResult)) {
        if (queryActivityTimer) clearTimeout(queryActivityTimer);
        pollerState.waitingForBackgroundTasks = false;
        pollerState.ipcPolling = false;
        session.end();
        log(`Unrecoverable transcript error in result: ${textResult.slice(0, 200)}`);
        processor.resetFullTextAccumulator();
        return {
          newSessionId, lastAssistantUuid,
          closedDuringQuery: pollerState.closedDuringQuery,
          unrecoverableTranscriptError: true,
          interruptedDuringQuery: pollerState.interruptedDuringQuery,
        };
      }

      // ── Successful result: check for pending background tasks ──

      if (processor.pendingBackgroundTaskCount > 0) {
        log(`Result received but ${processor.pendingBackgroundTaskCount} background task(s) pending, keeping query alive`);
        pollerState.waitingForBackgroundTasks = true;
        resetQueryActivityTimer();
      } else {
        if (queryActivityTimer) clearTimeout(queryActivityTimer);
        pollerState.waitingForBackgroundTasks = false;
        pollerState.ipcPolling = false;
        session.end();
      }

      const { effectiveResult } = processor.processResult(textResult);
      if (!effectiveResult && resultCount > 0) {
        log(`Warning: query produced empty result (no text, no tool output). Result #${resultCount}, messages: ${messageCount}`);
      }
      emit({
        status: 'success',
        result: effectiveResult,
        newSessionId
      });

      // Emit usage stream event with token counts and cost
      const resultMsg = message as Record<string, unknown>;
      const sdkUsage = resultMsg.usage as Record<string, number> | undefined;
      const sdkModelUsage = resultMsg.modelUsage as Record<string, Record<string, number>> | undefined;
      if (sdkUsage) {
        const modelUsageSummary: Record<string, { inputTokens: number; outputTokens: number; costUSD: number }> = {};
        if (sdkModelUsage && Object.keys(sdkModelUsage).length > 0) {
          for (const [mdl, mu] of Object.entries(sdkModelUsage)) {
            modelUsageSummary[mdl] = {
              inputTokens: mu.inputTokens || 0,
              outputTokens: mu.outputTokens || 0,
              costUSD: mu.costUSD || 0,
            };
          }
        } else {
          // Fallback: use session-level model name when SDK doesn't provide per-model breakdown
          modelUsageSummary[model] = {
            inputTokens: sdkUsage.input_tokens || 0,
            outputTokens: sdkUsage.output_tokens || 0,
            costUSD: (resultMsg.total_cost_usd as number) || 0,
          };
        }
        emit({
          status: 'stream',
          result: null,
          streamEvent: {
            eventType: 'usage',
            usage: {
              inputTokens: sdkUsage.input_tokens || 0,
              outputTokens: sdkUsage.output_tokens || 0,
              cacheReadInputTokens: sdkUsage.cache_read_input_tokens || 0,
              cacheCreationInputTokens: sdkUsage.cache_creation_input_tokens || 0,
              costUSD: (resultMsg.total_cost_usd as number) || 0,
              durationMs: (resultMsg.duration_ms as number) || 0,
              numTurns: (resultMsg.num_turns as number) || 0,
              modelUsage: Object.keys(modelUsageSummary).length > 0 ? modelUsageSummary : undefined,
            },
          },
        });
        log(`Usage: input=${sdkUsage.input_tokens} output=${sdkUsage.output_tokens} cost=$${resultMsg.total_cost_usd} turns=${resultMsg.num_turns}`);
      }
    }
  }

  // Cleanup residual state
  processor.cleanup();

  pollerState.ipcPolling = false;
  if (queryActivityTimer) clearTimeout(queryActivityTimer);
  log(`Query done. Messages: ${messageCount}, results: ${resultCount}, lastAssistantUuid: ${lastAssistantUuid || 'none'}, lastResumeUuid: ${lastResumeUuid || 'none'}, closedDuringQuery: ${pollerState.closedDuringQuery}, interruptedDuringQuery: ${pollerState.interruptedDuringQuery}, drainDetectedDuringQuery: ${pollerState.drainDetectedDuringQuery}`);
  return {
    newSessionId,
    lastAssistantUuid,
    lastResumeUuid,
    closedDuringQuery: pollerState.closedDuringQuery,
    interruptedDuringQuery: pollerState.interruptedDuringQuery,
    drainDetectedDuringQuery: pollerState.drainDetectedDuringQuery,
  };
}

// ---------------------------------------------------------------------------
// Top-level query orchestration
// ---------------------------------------------------------------------------

/**
 * Run a single query and stream results via emit/writeOutput.
 * Delegates SDK lifecycle to ClaudeSession (message stream, query(), hooks).
 * Also pipes IPC messages into the session during the query.
 */
export async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerConfig: McpServerConfig,
  containerInput: ContainerInput,
  session: ClaudeSession,
  state: SessionState,
  ipcPaths: IpcPaths,
  log: LogFn,
  writeOutput: WriteOutputFn,
  imChannelsFile: string,
  groupDir: string,
  globalDir: string,
  memoryDir: string,
  model: string,
  loadUserMcpServers: () => Record<string, unknown>,
  resumeAt?: string,
  emitOutput = true,
  allowedTools: string[] = [],
  disallowedTools?: string[],
  images?: Array<{ data: string; mimeType?: string }>,
): Promise<QueryResult> {
  // Track IM channels from initial prompt
  state.extractSourceChannels(prompt, imChannelsFile);
  const emit = (output: ContainerOutput): void => {
    if (emitOutput) writeOutput(output);
  };

  // Create the StreamEventProcessor with mode change callback
  const processor = new StreamEventProcessor(emit, log, (newMode) => {
    state.currentPermissionMode = newMode as PermissionMode;
    log(`Auto mode switch on ${newMode === 'plan' ? 'EnterPlanMode' : 'ExitPlanMode'} detection`);
    session.setPermissionMode(newMode as PermissionMode).catch((err: unknown) =>
      log(`setPermissionMode failed: ${err}`),
    );
  });

  // Build system prompt from context-builder
  const { isHome, isAdminHome } = normalizeHomeFlags(containerInput);
  const systemPromptAppend = buildSystemPromptAppend({
    state,
    containerInput,
    groupDir,
    globalDir,
    memoryDir,
  });

  // All containers can access global and memory directories via additionalDirectories.
  const extraDirs = [globalDir, memoryDir];

  // Default poller state for error paths where createIpcPoller hasn't run yet
  let pollerState: IpcPollerState = {
    ipcPolling: false,
    closedDuringQuery: false,
    interruptedDuringQuery: false,
    drainDetectedDuringQuery: false,
    waitingForBackgroundTasks: false,
  };

  try {
    // Assemble session config
    const sessionConfig: ClaudeSessionConfig = {
      sessionId,
      resumeAt,
      cwd: groupDir,
      additionalDirectories: extraDirs,
      model,
      permissionMode: state.currentPermissionMode,
      allowedTools,
      disallowedTools,
      systemPromptAppend,
      isHostMode: process.env.HAPPYCLAW_HOST_MODE === '1',
      isHome,
      isAdminHome,
      groupFolder: containerInput.groupFolder,
      userId: containerInput.userId,
    };
    const mcpServers: Record<string, McpServerConfig> = {
      ...loadUserMcpServers() as Record<string, McpServerConfig>,
      happyclaw: mcpServerConfig,
    };

    // Start session — creates MessageStream eagerly so pushMessage() works
    // before the generator is iterated by processMessages().
    const messageGen = session.run(sessionConfig, mcpServers);

    // Push initial prompt into the freshly created stream
    const initialRejected = session.pushMessage(prompt, images);
    for (const reason of initialRejected) {
      emit({ status: 'success', result: `\u26a0\ufe0f ${reason}`, newSessionId: undefined });
    }

    // Set up IPC polling — safe because stream already exists
    pollerState = createIpcPoller(state, session, processor, ipcPaths, log, emit, imChannelsFile);

    const result = await processMessages(
      messageGen,
      processor,
      state,
      session,
      ipcPaths,
      log,
      emit,
      emitOutput,
      pollerState,
      imChannelsFile,
      model,
    );
    return result;
  } catch (err) {
    pollerState.ipcPolling = false;
    const errorMessage = err instanceof Error ? err.message : String(err);

    // 检测上下文溢出错误
    if (isContextOverflowError(errorMessage)) {
      log(`Context overflow detected: ${errorMessage}`);
      return {
        newSessionId: undefined,
        lastAssistantUuid: undefined,
        closedDuringQuery: pollerState.closedDuringQuery,
        contextOverflow: true,
        interruptedDuringQuery: pollerState.interruptedDuringQuery,
      };
    }

    // 检测不可恢复的转录错误
    if (isUnrecoverableTranscriptError(errorMessage)) {
      log(`Unrecoverable transcript error: ${errorMessage}`);
      return {
        newSessionId: undefined,
        lastAssistantUuid: undefined,
        closedDuringQuery: pollerState.closedDuringQuery,
        unrecoverableTranscriptError: true,
        interruptedDuringQuery: pollerState.interruptedDuringQuery,
      };
    }

    // 中断导致的 SDK 错误（error_during_execution 等）：正常返回，不抛出
    if (pollerState.interruptedDuringQuery) {
      log(`runQuery error during interrupt (non-fatal): ${errorMessage}`);
      return {
        newSessionId: undefined,
        lastAssistantUuid: undefined,
        closedDuringQuery: pollerState.closedDuringQuery,
        interruptedDuringQuery: pollerState.interruptedDuringQuery,
      };
    }

    // 其他错误：记录完整堆栈后继续抛出
    log(`runQuery error [${(err as NodeJS.ErrnoException).code ?? 'unknown'}]: ${errorMessage}`);
    if (err instanceof Error && err.stack) {
      log(`runQuery error stack:\n${err.stack}`);
    }
    throw err;
  }
}
