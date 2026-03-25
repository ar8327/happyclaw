/**
 * HappyClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF, like before)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per agent teams result).
 *   Final marker after loop ends signals completion.
 */

import fs from 'fs';
import path from 'path';
import { query, createSdkMcpServer, PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import { createSafetyLiteHook } from './safety-lite.js';
import { createPreCompactHook } from './transcript-archive.js';
import { resolveImageMimeType, filterOversizedImages } from './image-utils.js';

import type {
  ContainerInput,
  ContainerOutput,
  SDKUserMessage,
} from './types.js';
export type { StreamEventType, StreamEvent } from './types.js';

import { StreamEventProcessor } from './stream-processor.js';
import { PREDEFINED_AGENTS } from './agent-definitions.js';
import { createContextManager, coreToolsToSdkTools } from './mcp-adapter.js';
import { SessionState } from './session-state.js';
import { buildSystemPromptAppend, buildChannelRoutingReminder, normalizeHomeFlags } from './context-builder.js';
import {
  buildIpcPaths,
  IPC_POLL_MS,
  shouldClose,
  shouldDrain,
  shouldInterrupt,
  drainIpcInput,
  waitForIpcMessage,
  isInterruptRelatedError,
} from './ipc-handler.js';

// 路径解析：优先读取环境变量，降级到容器内默认路径（保持向后兼容）
const WORKSPACE_GROUP = process.env.HAPPYCLAW_WORKSPACE_GROUP || '/workspace/group';
const WORKSPACE_GLOBAL = process.env.HAPPYCLAW_WORKSPACE_GLOBAL || '/workspace/global';
const WORKSPACE_MEMORY = process.env.HAPPYCLAW_WORKSPACE_MEMORY || '/workspace/memory';
const WORKSPACE_IPC = process.env.HAPPYCLAW_WORKSPACE_IPC || '/workspace/ipc';
const WORKSPACE_SKILLS = process.env.HAPPYCLAW_SKILLS_DIR || '/workspace/user-skills';

// 模型配置：支持别名（opus/sonnet/haiku）或完整模型 ID
// 别名自动解析为最新版本，如 opus → Opus 4.6
const CLAUDE_MODEL = process.env.HAPPYCLAW_MODEL || process.env.ANTHROPIC_MODEL || 'opus';

const ipcPaths = buildIpcPaths(WORKSPACE_IPC);

// IM channels file path — stays in index.ts because it depends on WORKSPACE_IPC
const IM_CHANNELS_FILE = path.join(WORKSPACE_IPC, '.recent-im-channels.json');

// Session state: replaces scattered module-level variables with explicit state object.
// Module-level because process event handlers (uncaughtException, unhandledRejection)
// need access to interrupt grace window state.
const state = new SessionState();

const DEFAULT_ALLOWED_TOOLS = [
  'Bash',
  'Read', 'Write', 'Edit', 'Glob', 'Grep',
  'WebSearch', 'WebFetch',
  'Task', 'TaskOutput', 'TaskStop',
  'TeamCreate', 'TeamDelete', 'SendMessage',
  'TodoWrite', 'ToolSearch', 'Skill',
  'NotebookEdit',
  'mcp__happyclaw__*'
];

/**
 * Push-based async iterable for streaming user messages to the SDK.
 * Keeps the iterable alive until end() is called, preventing isSingleUserTurn.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string, images?: Array<{ data: string; mimeType?: string }>): string[] {
    const rejectedReasons: string[] = [];
    let filteredImages = images;

    // 过滤超限图片，在发送给 SDK 之前拦截
    if (filteredImages && filteredImages.length > 0) {
      const { valid, rejected } = filterOversizedImages(filteredImages, log);
      rejectedReasons.push(...rejected);
      filteredImages = valid.length > 0 ? valid : undefined;
    }

    let content:
      | string
      | Array<{ type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }>;

    if (filteredImages && filteredImages.length > 0) {
      // 多模态消息：text + images
      content = [
        { type: 'text', text },
        ...filteredImages.map((img) => ({
          type: 'image' as const,
          source: {
            type: 'base64' as const,
            media_type: resolveImageMimeType(img, log),
            data: img.data,
          },
        })),
      ];
    } else {
      // 纯文本消息
      content = text;
    }

    this.queue.push({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
    return rejectedReasons;
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>(r => { this.waiting = r; });
      this.waiting = null;
    }
  }
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const OUTPUT_START_MARKER = '---HAPPYCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---HAPPYCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

/**
 * 检测是否为上下文溢出错误
 */
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


/** 从 settings.json 读取用户配置的 MCP servers（stdio/http/sse 类型） */
function loadUserMcpServers(): Record<string, unknown> {
  const configDir = process.env.CLAUDE_CONFIG_DIR
    || path.join(process.env.HOME || '/home/node', '.claude');
  const settingsFile = path.join(configDir, 'settings.json');
  try {
    if (fs.existsSync(settingsFile)) {
      const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
      if (settings.mcpServers && typeof settings.mcpServers === 'object') {
        return settings.mcpServers;
      }
    }
  } catch { /* ignore parse errors */ }
  return {};
}

/**
 * Run a single query and stream results via writeOutput.
 * Uses MessageStream (AsyncIterable) to keep isSingleUserTurn=false,
 * allowing agent teams subagents to run to completion.
 * Also pipes IPC messages into the stream during the query.
 */
async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerConfig: ReturnType<typeof createSdkMcpServer>,
  containerInput: ContainerInput,
  resumeAt?: string,
  emitOutput = true,
  allowedTools: string[] = DEFAULT_ALLOWED_TOOLS,
  disallowedTools?: string[],
  images?: Array<{ data: string; mimeType?: string }>,
): Promise<{ newSessionId?: string; lastAssistantUuid?: string; lastResumeUuid?: string; closedDuringQuery: boolean; contextOverflow?: boolean; unrecoverableTranscriptError?: boolean; interruptedDuringQuery: boolean; sessionResumeFailed?: boolean; drainDetectedDuringQuery?: boolean }> {
  const stream = new MessageStream();
  // Track IM channels from initial prompt
  state.extractSourceChannels(prompt, IM_CHANNELS_FILE);
  const initialRejected = stream.push(prompt, images);
  const emit = (output: ContainerOutput): void => {
    if (emitOutput) writeOutput(output);
  };

  // 如果有图片被拒绝，立即通知用户
  for (const reason of initialRejected) {
    emit({ status: 'success', result: `\u26a0\ufe0f ${reason}`, newSessionId: undefined });
  }

  // Poll IPC for follow-up messages and _close/_interrupt sentinel during the query
  let ipcPolling = true;
  let closedDuringQuery = false;
  let interruptedDuringQuery = false;
  // When true, the main result has been emitted but we're waiting for background
  // tasks to finish.  IPC polling is stopped (to avoid push-after-close crashes)
  // but the for-await loop stays alive to receive task_notifications.
  let waitingForBackgroundTasks = false;

  // Query activity watchdog: if the SDK for-await loop yields no events for
  // QUERY_ACTIVITY_TIMEOUT_MS, the API call is likely hung.  Force an interrupt
  // so the session loop can retry with the same prompt.
  const QUERY_ACTIVITY_TIMEOUT_MS = 300_000;
  // Hard timeout for a single tool call — if a tool (e.g. Bash running npx)
  // blocks for longer than this, force interrupt regardless.  This prevents
  // hung subprocesses (npx download stalls, unresponsive APIs) from freezing
  // the entire agent indefinitely.
  // Default 20 minutes: generous enough for long-running tools (complex builds,
  // large file operations) but catches truly stuck processes (npx download stalls).
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
      if (!ipcPolling && !waitingForBackgroundTasks) return; // query already ended
      // Don't interrupt while background sub-agents are still running —
      // they won't produce events on the main iterator but are doing real work.
      if (processor.pendingBackgroundTaskCount > 0) {
        log(`Activity timeout skipped: ${processor.pendingBackgroundTaskCount} background task(s) still running, extending timer`);
        resetQueryActivityTimer();
        return;
      }
      // Allow active tool calls to continue, but enforce a hard timeout to
      // prevent indefinite hangs (e.g. npx stuck downloading packages).
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
      interruptedDuringQuery = true;
      waitingForBackgroundTasks = false;
      queryRef?.interrupt().catch((err: unknown) => log(`Activity timeout interrupt failed: ${err}`));
      stream.end();
      ipcPolling = false;
    }, QUERY_ACTIVITY_TIMEOUT_MS);
  };
  resetQueryActivityTimer();
  // queryRef is set just before the for-await loop so pollIpcDuringQuery can call interrupt()
  let queryRef: { interrupt(): Promise<void>; setPermissionMode(mode: PermissionMode): Promise<void> } | null = null;
  // Track drain detection during query: if _drain appears while the SDK query
  // is still running, we set this flag and let the query finish naturally.
  // The main loop will check this flag after the for-await loop exits.
  let drainDetectedDuringQuery = false;

  const pollIpcDuringQuery = () => {
    if (!ipcPolling) return;
    if (shouldClose(ipcPaths)) {
      log('Close sentinel detected during query, ending stream');
      closedDuringQuery = true;
      stream.end();
      ipcPolling = false;
      return;
    }
    // Check for _drain during query: consume the sentinel immediately so it
    // isn't lost to a filesystem race, but let the current query finish.
    if (!drainDetectedDuringQuery && shouldDrain(ipcPaths)) {
      log('Drain sentinel detected during query, will exit after query completes');
      drainDetectedDuringQuery = true;
      // Don't end the stream or stop polling — let the query finish naturally.
      // The flag is checked in the main loop after the for-await exits.
    }
    if (shouldInterrupt(ipcPaths)) {
      log('Interrupt sentinel detected, interrupting current query');
      interruptedDuringQuery = true;
      state.markInterruptRequested();
      queryRef?.interrupt().catch((err: unknown) => log(`Interrupt call failed: ${err}`));
      stream.end();
      ipcPolling = false;
      return;
    }
    const { messages, modeChange } = drainIpcInput(ipcPaths, log);
    if (modeChange) {
      state.currentPermissionMode = modeChange as PermissionMode;
      log(`Mode change via IPC: ${modeChange}`);
      queryRef?.setPermissionMode(modeChange as PermissionMode).catch((err: unknown) =>
        log(`setPermissionMode failed: ${err}`),
      );
    }
    for (const msg of messages) {
      log(`Piping IPC message into active query (${msg.text.length} chars, ${msg.images?.length || 0} images)`);
      // Track IM channels for post-compaction routing reminder
      state.extractSourceChannels(msg.text, IM_CHANNELS_FILE);
      // Emit acknowledgement so host can track IPC delivery
      emit({ status: 'stream', result: null, streamEvent: { eventType: 'status', statusText: 'ipc_message_received' } });
      const rejected = stream.push(msg.text, msg.images);
      for (const reason of rejected) {
        emit({ status: 'success', result: `\u26a0\ufe0f ${reason}`, newSessionId: undefined });
      }
    }
    setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
  };
  setTimeout(pollIpcDuringQuery, IPC_POLL_MS);

  // Create the StreamEventProcessor with mode change callback
  const processor = new StreamEventProcessor(emit, log, (newMode) => {
    state.currentPermissionMode = newMode as PermissionMode;
    log(`Auto mode switch on ${newMode === 'plan' ? 'EnterPlanMode' : 'ExitPlanMode'} detection`);
    queryRef?.setPermissionMode(newMode as PermissionMode).catch((err: unknown) =>
      log(`setPermissionMode failed: ${err}`),
    );
  });

  let newSessionId: string | undefined;
  let lastAssistantUuid: string | undefined;
  // Track the latest safe resume point across ALL message types (assistant/text
  // and user/tool_result). This prevents the fan-out branch problem: when the
  // agent's final response in a query is tool_use-only (no text output),
  // lastAssistantUuid stays stuck at an earlier text message. Without advancing,
  // all subsequent queries branch from the same node and lose visibility of each
  // other's turns — causing repeated/lost context (e.g. resending reports).
  // By tracking the last tool_result UUID, we ensure the session advances
  // linearly, preserving the full tool_use→tool_result pair in the next resume.
  let lastResumeUuid: string | undefined;
  let messageCount = 0;
  let resultCount = 0;

  // Build system prompt from context-builder
  const { isHome, isAdminHome } = normalizeHomeFlags(containerInput);
  const systemPromptAppend = buildSystemPromptAppend({
    state,
    containerInput,
    groupDir: WORKSPACE_GROUP,
    globalDir: WORKSPACE_GLOBAL,
    memoryDir: WORKSPACE_MEMORY,
  });

  // All containers can access global and memory directories via additionalDirectories.
  // Home containers additionally inject global CLAUDE.md into systemPrompt for immediate context.
  // Non-home containers discover it via filesystem (readonly mount) without systemPrompt injection.
  const extraDirs = [WORKSPACE_GLOBAL, WORKSPACE_MEMORY];

  try {
    const q = query({
    prompt: stream,
    options: {
      model: CLAUDE_MODEL,
      cwd: WORKSPACE_GROUP,
      additionalDirectories: extraDirs,
      resume: sessionId,
      resumeSessionAt: resumeAt,
      systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const, append: systemPromptAppend },
      allowedTools,
      ...(disallowedTools && { disallowedTools }),
      maxThinkingTokens: 16384,
      permissionMode: state.currentPermissionMode,
      allowDangerouslySkipPermissions: true,
      settingSources: ['project', 'user'],
      includePartialMessages: true,
      mcpServers: {
        ...loadUserMcpServers(),     // 用户配置的 MCP（stdio/http/sse），SDK 原生支持
        happyclaw: mcpServerConfig,  // 内置 SDK MCP 放最后，确保不被同名覆盖
      },
      hooks: {
        PreCompact: [{ hooks: [createPreCompactHook(isHome, isAdminHome, containerInput.groupFolder, containerInput.userId)] }],
        ...(process.env.HAPPYCLAW_HOST_MODE === '1' ? { PreToolUse: [{ hooks: [createSafetyLiteHook()] }] } : {}),
      },
      agents: PREDEFINED_AGENTS,
    }
  });
    queryRef = q;
    for await (const message of q) {
    // Reset activity watchdog on every SDK event
    resetQueryActivityTimer();
    // Track tool call start time for hard timeout enforcement:
    // update timestamp when a tool call becomes active, clear when it ends.
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
    // The SDK assigns its own short-hash task_id (e.g. "a68ac00") to background tasks,
    // which differs from the tool_use block's id. We parse the tool_result to build
    // a mapping so processTaskNotification can resolve IDs correctly.
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
      // (not tool_use-only messages). Resuming at a tool_use assistant node
      // causes the subsequent user(tool_result) to be missing, triggering
      // ensureToolResultPairing repairs and potential session instability.
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
    // When the agent ends a turn with only tool_use (e.g. send_message with no
    // stdout text), lastAssistantUuid stays stuck at the earlier text message.
    // Using the tool_result UUID preserves the full tool_use→tool_result pair
    // in the resumed session, preventing the fan-out branch problem.
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

    // After context compaction, inject a routing reminder so the agent
    // doesn't forget to use send_message for IM channels.
    // The reminder arrives as a user message in the NEXT turn.
    if (message.type === 'system' && (message as { subtype?: string }).subtype === 'compact_boundary') {
      const channels = [...state.recentImChannels];
      if (channels.length > 0) {
        log(`Context compacted, injecting routing reminder for channels: ${channels.join(', ')}`);
      } else {
        log('Context compacted, no IM channels tracked');
      }
      stream.push(buildChannelRoutingReminder(channels));
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
      // These paths return/throw, so stream must be closed before exiting.

      // SDK 在某些失败场景会返回 error_* subtype 且不抛异常。
      // 匹配策略：显式枚举已知的 error subtype，并用 startsWith('error') 兜底。
      if (typeof resultSubtype === 'string' && (resultSubtype === 'error_during_execution' || resultSubtype.startsWith('error'))) {
        if (queryActivityTimer) clearTimeout(queryActivityTimer);
        waitingForBackgroundTasks = false;
        ipcPolling = false;
        stream.end();
        if (!newSessionId) {
          log(`Session resume failed (no init): ${resultSubtype}`);
          return { newSessionId, lastAssistantUuid, closedDuringQuery, interruptedDuringQuery, sessionResumeFailed: true };
        }
        const detail = textResult?.trim()
          ? textResult.trim()
          : `Claude Code execution failed (${resultSubtype})`;
        throw new Error(detail);
      }

      // SDK 将某些 API 错误包装为 subtype=success 的 result（不抛异常）
      if (textResult && isContextOverflowError(textResult)) {
        if (queryActivityTimer) clearTimeout(queryActivityTimer);
        waitingForBackgroundTasks = false;
        ipcPolling = false;
        stream.end();
        log(`Context overflow detected in result: ${textResult.slice(0, 100)}`);
        processor.resetFullTextAccumulator();
        return { newSessionId, lastAssistantUuid, closedDuringQuery, contextOverflow: true, interruptedDuringQuery };
      }
      if (textResult && isUnrecoverableTranscriptError(textResult)) {
        if (queryActivityTimer) clearTimeout(queryActivityTimer);
        waitingForBackgroundTasks = false;
        ipcPolling = false;
        stream.end();
        log(`Unrecoverable transcript error in result: ${textResult.slice(0, 200)}`);
        processor.resetFullTextAccumulator();
        return { newSessionId, lastAssistantUuid, closedDuringQuery, unrecoverableTranscriptError: true, interruptedDuringQuery };
      }

      // ── Successful result: check for pending background tasks ──

      if (processor.pendingBackgroundTaskCount > 0) {
        // Background tasks still running — keep the for-await loop alive so we
        // receive task_notification messages.  The SDK will re-invoke the model
        // when a background task completes, producing another result.
        // IPC polling stays active so new user messages and _close sentinels
        // can still be received while waiting for background tasks.
        log(`Result received but ${processor.pendingBackgroundTaskCount} background task(s) pending, keeping query alive`);
        waitingForBackgroundTasks = true;
        resetQueryActivityTimer();
      } else {
        // No background tasks — safe to end the stream and stop IPC polling.
        // IPC polling must stop before stream.end() to avoid push-after-close
        // crashes on ProcessTransport (see commit c6b5086).
        if (queryActivityTimer) clearTimeout(queryActivityTimer);
        waitingForBackgroundTasks = false;
        ipcPolling = false;
        stream.end();
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
          for (const [model, mu] of Object.entries(sdkModelUsage)) {
            modelUsageSummary[model] = {
              inputTokens: mu.inputTokens || 0,
              outputTokens: mu.outputTokens || 0,
              costUSD: mu.costUSD || 0,
            };
          }
        } else {
          // Fallback: use session-level model name when SDK doesn't provide per-model breakdown
          modelUsageSummary[CLAUDE_MODEL] = {
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

  ipcPolling = false;
  if (queryActivityTimer) clearTimeout(queryActivityTimer);
  log(`Query done. Messages: ${messageCount}, results: ${resultCount}, lastAssistantUuid: ${lastAssistantUuid || 'none'}, lastResumeUuid: ${lastResumeUuid || 'none'}, closedDuringQuery: ${closedDuringQuery}, interruptedDuringQuery: ${interruptedDuringQuery}, drainDetectedDuringQuery: ${drainDetectedDuringQuery}`);
  return { newSessionId, lastAssistantUuid, lastResumeUuid, closedDuringQuery, interruptedDuringQuery, drainDetectedDuringQuery };
  } catch (err) {
    ipcPolling = false;
    if (queryActivityTimer) clearTimeout(queryActivityTimer);
    const errorMessage = err instanceof Error ? err.message : String(err);

    // 检测上下文溢出错误
    if (isContextOverflowError(errorMessage)) {
      log(`Context overflow detected: ${errorMessage}`);
      return { newSessionId, lastAssistantUuid, closedDuringQuery, contextOverflow: true, interruptedDuringQuery };
    }

    // 检测不可恢复的转录错误
    if (isUnrecoverableTranscriptError(errorMessage)) {
      log(`Unrecoverable transcript error: ${errorMessage}`);
      return { newSessionId, lastAssistantUuid, closedDuringQuery, unrecoverableTranscriptError: true, interruptedDuringQuery };
    }

    // 中断导致的 SDK 错误（error_during_execution 等）：正常返回，不抛出
    if (interruptedDuringQuery) {
      log(`runQuery error during interrupt (non-fatal): ${errorMessage}`);
      return { newSessionId, lastAssistantUuid, closedDuringQuery, interruptedDuringQuery };
    }

    // 其他错误：记录完整堆栈后继续抛出
    log(`runQuery error [${(err as NodeJS.ErrnoException).code ?? 'unknown'}]: ${errorMessage}`);
    if (err instanceof Error && err.stack) {
      log(`runQuery error stack:\n${err.stack}`);
    }
    // 继续抛出
    throw err;
  }
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  let sessionId = containerInput.sessionId;
  const { isHome, isAdminHome } = normalizeHomeFlags(containerInput);

  // Restore persisted IM channels from previous sessions
  state.loadImChannels(IM_CHANNELS_FILE);

  // Create ContextManager with all plugins, then convert to SDK tools
  const pluginCtx = {
    chatJid: containerInput.chatJid,
    groupFolder: containerInput.groupFolder,
    isHome,
    isAdminHome,
    workspaceIpc: WORKSPACE_IPC,
    workspaceGroup: WORKSPACE_GROUP,
    workspaceGlobal: WORKSPACE_GLOBAL,
    workspaceMemory: WORKSPACE_MEMORY,
    userId: containerInput.userId,
  };
  const ctxMgr = createContextManager(pluginCtx);
  const buildMcpServerConfig = () => createSdkMcpServer({
    name: 'happyclaw',
    version: '1.0.0',
    tools: coreToolsToSdkTools(ctxMgr),
  });
  let mcpServerConfig = buildMcpServerConfig();
  fs.mkdirSync(ipcPaths.inputDir, { recursive: true });

  // Clean up stale sentinels from previous container runs
  try { fs.unlinkSync(ipcPaths.closeSentinel); } catch { /* ignore */ }
  try { fs.unlinkSync(ipcPaths.drainSentinel); } catch { /* ignore */ }
  try { fs.unlinkSync(ipcPaths.interruptSentinel); } catch { /* ignore */ }

  // Build initial prompt (drain any pending IPC messages too)
  let prompt = containerInput.prompt;
  let promptImages = containerInput.images;
  const pendingDrain = drainIpcInput(ipcPaths, log);
  if (pendingDrain.modeChange) {
    state.currentPermissionMode = pendingDrain.modeChange as PermissionMode;
    log(`Initial mode change via IPC: ${pendingDrain.modeChange}`);
  }
  if (pendingDrain.messages.length > 0) {
    log(`Draining ${pendingDrain.messages.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pendingDrain.messages.map((m) => m.text).join('\n');
    const pendingImages = pendingDrain.messages.flatMap((m) => m.images || []);
    if (pendingImages.length > 0) {
      promptImages = [...(promptImages || []), ...pendingImages];
    }
  }

  // Query loop: run query -> wait for IPC message -> run new query -> repeat
  let resumeAt: string | undefined;
  let overflowRetryCount = 0;
  const MAX_OVERFLOW_RETRIES = 3;
  try {
    while (true) {
      // 清理残留的 _interrupt sentinel，防止空闲期间写入的中断信号影响下一次 query
      try { fs.unlinkSync(ipcPaths.interruptSentinel); } catch { /* ignore */ }
      state.clearInterruptRequested();

      log(`Starting query (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'})...`);

      const queryResult = await runQuery(
        prompt,
        sessionId,
        mcpServerConfig,
        containerInput,
        resumeAt,
        true,
        DEFAULT_ALLOWED_TOOLS,
        undefined,
        promptImages,
      );
      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
      }
      // Advance resumeAt to the latest safe resume point in the session.
      // lastResumeUuid tracks the latest of: assistant(text) or user(tool_result).
      // This ensures the session advances linearly even when the agent's last
      // action is a tool_use without text output (common in IM chat where the
      // agent only calls send_message). Without this, resumeAt sticks at an
      // earlier text message, creating parallel branches where each query loses
      // visibility of prior turns.
      if (queryResult.lastResumeUuid) {
        resumeAt = queryResult.lastResumeUuid;
      } else if (queryResult.lastAssistantUuid) {
        resumeAt = queryResult.lastAssistantUuid;
      }

      // Rebuild MCP server config between queries to prevent stale transport.
      // The SDK's createSdkMcpServer transport can become disconnected when the
      // internal CLI process exits between query turns. Without rebuilding, the
      // next query may get "Stream closed" errors on MCP tool calls.
      mcpServerConfig = buildMcpServerConfig();

      // Session resume 失败（SDK 无法恢复旧会话）：清除 session，以新会话重试
      if (queryResult.sessionResumeFailed) {
        log(`Session resume failed, retrying with fresh session (old: ${sessionId})`);
        sessionId = undefined;
        resumeAt = undefined;
        continue;
      }

      // 不可恢复的转录错误（如超大图片或 MIME 错配被固化在会话历史中）
      if (queryResult.unrecoverableTranscriptError) {
        const errorMsg = '会话历史中包含无法处理的数据（如超大图片或图片 MIME 错配），会话需要重置。';
        log(`Unrecoverable transcript error, signaling session reset`);
        writeOutput({
          status: 'error',
          result: null,
          error: `unrecoverable_transcript: ${errorMsg}`,
          newSessionId: sessionId,
        });
        process.exit(1);
      }

      // 检查上下文溢出
      if (queryResult.contextOverflow) {
        overflowRetryCount++;
        log(`Context overflow detected, retry ${overflowRetryCount}/${MAX_OVERFLOW_RETRIES}`);

        if (overflowRetryCount >= MAX_OVERFLOW_RETRIES) {
          const errorMsg = `上下文溢出错误：已重试 ${MAX_OVERFLOW_RETRIES} 次仍失败。请联系管理员检查 CLAUDE.md 大小或减少会话历史。`;
          log(errorMsg);
          writeOutput({
            status: 'error',
            result: null,
            error: `context_overflow: ${errorMsg}`,
            newSessionId: sessionId,
          });
          process.exit(1);
        }

        // 未超过重试次数，等待后继续下一轮循环（会触发自动压缩）
        log('Retrying query after context overflow (will trigger auto-compaction)...');
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }

      // 成功执行后重置溢出重试计数器
      overflowRetryCount = 0;

      // If _close was consumed during the query, exit immediately.
      // Don't emit a session-update marker (it would reset the host's
      // idle timer and cause a 30-min delay before the next _close).
      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        // Notify host that this exit was due to _close, not a normal completion.
        // Without this marker the host treats the exit as silent success and
        // commits the message cursor, causing the in-flight IM message to be
        // consumed without a reply (the "swallowed message" bug).
        writeOutput({ status: 'closed', result: null });
        break;
      }

      // 中断后：跳过 memory flush 和 session update，等待下一条消息
      if (queryResult.interruptedDuringQuery) {
        log('Query interrupted by user, waiting for next message');
        writeOutput({
          status: 'stream',
          result: null,
          streamEvent: { eventType: 'status', statusText: 'interrupted' },
        });
        // 清理可能残留的 _interrupt 文件
        try { fs.unlinkSync(ipcPaths.interruptSentinel); } catch { /* ignore */ }
        // 不 break，等待下一条消息
        const nextMessage = await waitForIpcMessage(ipcPaths, log, writeOutput, state, IM_CHANNELS_FILE);
        if (nextMessage === null) {
          log('Close sentinel received after interrupt, exiting');
          break;
        }
        state.clearInterruptRequested();
        prompt = nextMessage.text;
        promptImages = nextMessage.images;
        continue;
      }

      // Check for _drain sentinel: finish current query then exit for turn boundary.
      // Unlike _close (where the host sends SIGTERM), _drain requires self-exit
      // because the host is waiting for the process to terminate naturally.
      // Check both: the flag set during pollIpcDuringQuery AND the sentinel file
      // (in case it was written after the query's IPC polling stopped).
      if (queryResult.drainDetectedDuringQuery || shouldDrain(ipcPaths)) {
        log('Drain sentinel detected, exiting for turn boundary');
        writeOutput({ status: 'drained', result: null, newSessionId: sessionId });
        process.exit(0);
      }

      // Emit session update so host can track it
      writeOutput({ status: 'success', result: null, newSessionId: sessionId });

      log('Query ended, waiting for next IPC message...');

      // Wait for the next message or _close/_drain sentinel
      const nextMessage = await waitForIpcMessage(ipcPaths, log, writeOutput, state, IM_CHANNELS_FILE);
      if (nextMessage === null) {
        log('Close/drain sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.text.length} chars, ${nextMessage.images?.length || 0} images), starting new query`);
      prompt = nextMessage.text;
      promptImages = nextMessage.images;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    if (err instanceof Error && err.stack) {
      log(`Agent error stack:\n${err.stack}`);
    }
    // Log cause chain for SDK-wrapped errors (e.g. EPIPE from internal claude CLI)
    const cause = err instanceof Error ? (err as NodeJS.ErrnoException & { cause?: unknown }).cause : undefined;
    if (cause) {
      const causeMsg = cause instanceof Error ? cause.stack || cause.message : String(cause);
      log(`Agent error cause:\n${causeMsg}`);
    }
    log(`Agent error errno: ${(err as NodeJS.ErrnoException).code ?? 'none'} exitCode: ${process.exitCode ?? 'none'}`);
    // 不在 error output 中携带 sessionId：
    // 流式输出已通过 onOutput 回调传递了有效的 session 更新。
    // 如果这里携带的是 throw 前的旧 sessionId，会覆盖中间成功产生的新 session。
    writeOutput({
      status: 'error',
      result: null,
      error: errorMessage
    });
    process.exit(1);
  }
}

// 处理管道断开（EPIPE）：父进程关闭管道后仍有写入时，静默退出避免 code 1 错误输出
(process.stdout as NodeJS.WriteStream & NodeJS.EventEmitter).on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
});
(process.stderr as NodeJS.WriteStream & NodeJS.EventEmitter).on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
});

/**
 * 某些 SDK/底层 socket 会在管道断开后触发未捕获 EPIPE。
 * 这类错误通常发生在结果已输出之后，属于"收尾写入失败"，
 * 不应把整个 host query 标记为启动失败（code 1）。
 */
process.on('SIGTERM', () => {
  log('Received SIGTERM, exiting gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  log('Received SIGINT, exiting gracefully');
  process.exit(0);
});

process.on('uncaughtException', (err: unknown) => {
  const errno = err as NodeJS.ErrnoException;
  if (errno?.code === 'EPIPE') {
    process.exit(0);
  }
  if (state.isWithinInterruptGraceWindow() && isInterruptRelatedError(err)) {
    console.error('Suppressing interrupt-related uncaught exception:', err);
    process.exit(0);
  }
  console.error('Uncaught exception:', err);
  // 尝试输出结构化错误，让主进程能收到错误信息而非仅看到 exit code 1
  try { writeOutput({ status: 'error', result: null, error: String(err) }); } catch { /* ignore */ }
  process.exit(1);
});

process.on('unhandledRejection', (reason: unknown) => {
  const errno = reason as NodeJS.ErrnoException;
  if (errno?.code === 'EPIPE') {
    process.exit(0);
  }
  // ProcessTransport closed — can happen if IPC poll races with query completion.
  // The message that triggered this was already consumed from IPC and is lost,
  // but the process should not crash. The main loop will pick up subsequent messages.
  if (reason instanceof Error && /ProcessTransport is not ready/i.test(reason.message)) {
    console.error('[agent-runner] ProcessTransport not ready (non-fatal, query ended):', reason.message);
    return;
  }
  if (state.isWithinInterruptGraceWindow()) {
    console.error('Unhandled rejection during interrupt (non-fatal):', reason);
    return;
  }
  console.error('Unhandled rejection:', reason);
  process.exit(1);
});
main();
