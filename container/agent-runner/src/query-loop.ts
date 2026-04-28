/**
 * Generic query loop — provider-agnostic orchestration.
 *
 * Consumes AgentRunner.runQuery() AsyncGenerator, handles:
 * - NormalizedMessage dispatch (stream_event → writeOutput)
 * - Unified IPC poller (sentinels + message handling)
 * - Activity watchdog (5 min no-event timeout + 20 min tool hard timeout)
 * - Overflow retries, interrupt recovery, drain/close exit
 * - Between-query cleanup and IPC wait
 */

import fs from 'fs';
import { buildChannelRoutingReminder } from 'happyclaw-agent-runner-core';
import type {
  AgentRunner,
  QueryConfig,
  QueryResult,
  NormalizedMessage,
} from './runner-interface.js';
import type { ContainerOutput } from './types.js';
import type { SessionState } from './session-state.js';
import {
  IPC_POLL_MS,
  buildIpcAckStreamEvent,
  shouldClose,
  shouldDrain,
  shouldInterrupt,
  drainIpcInput,
  waitForIpcMessage,
  type IpcMessage,
  type IpcPaths,
  type LogFn,
  type WriteOutputFn,
} from './ipc-handler.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QueryLoopConfig {
  runner: AgentRunner;
  buildSystemPrompt: (prompt: string) => string;
  initialPrompt: string;
  initialImages?: Array<{ data: string; mimeType?: string }>;
  sessionRecordId: string;
  sessionId?: string;
  initialResumeAnchor?: string;
  ephemeralSession?: boolean;
  state: SessionState;
  ipcPaths: IpcPaths;
  imChannelsFile: string;
  log: LogFn;
  writeOutput: WriteOutputFn;
  maxOverflowRetries?: number; // default 3
}

// ---------------------------------------------------------------------------
// Unified IPC Poller
// ---------------------------------------------------------------------------

interface IpcPollerState {
  isActive: boolean;
  closedDuringQuery: boolean;
  interruptedDuringQuery: boolean;
  drainDetectedDuringQuery: boolean;
  stop(): void;
}

interface IpcPollerOptions {
  runner: AgentRunner;
  state: SessionState;
  ipcPaths: IpcPaths;
  log: LogFn;
  writeOutput: WriteOutputFn;
  imChannelsFile: string;
  sessionRecordId: string;
  onMessage: (msg: IpcMessage) => void;
  onModeChange?: (mode: string) => void;
}

function createUnifiedIpcPoller(opts: IpcPollerOptions): IpcPollerState {
  const pollerState: IpcPollerState = {
    isActive: true,
    closedDuringQuery: false,
    interruptedDuringQuery: false,
    drainDetectedDuringQuery: false,
    stop() { this.isActive = false; },
  };

  const poll = () => {
    if (!pollerState.isActive) return;

    // 1. Close sentinel
    if (shouldClose(opts.ipcPaths)) {
      opts.log('Close sentinel detected during query');
      pollerState.closedDuringQuery = true;
      opts.runner.interrupt().catch(() => {});
      pollerState.stop();
      return;
    }

    // 2. Drain sentinel (detect but don't stop query)
    if (!pollerState.drainDetectedDuringQuery && shouldDrain(opts.ipcPaths)) {
      opts.log('Drain sentinel detected during query');
      pollerState.drainDetectedDuringQuery = true;
    }

    // 3. Interrupt sentinel
    if (shouldInterrupt(opts.ipcPaths)) {
      opts.log('Interrupt sentinel detected');
      pollerState.interruptedDuringQuery = true;
      opts.state.markInterruptRequested();
      opts.runner.interrupt().catch(() => {});
      pollerState.stop();
      return;
    }

    // 4. Messages and mode changes
    const { messages, modeChange } = drainIpcInput(opts.ipcPaths, opts.log);
    if (modeChange) {
      opts.state.currentPermissionMode = modeChange;
      opts.log(`Mode change via IPC: ${modeChange}`);
      opts.onModeChange?.(modeChange);
    }
    for (const msg of messages) {
      opts.log(`IPC message (${msg.text.length} chars, ${msg.images?.length || 0} images)`);
      opts.state.extractSourceChannels(msg.text, opts.imChannelsFile);
      opts.writeOutput({
        status: 'stream',
        result: null,
        streamEvent: buildIpcAckStreamEvent(opts.sessionRecordId, msg),
      });
      opts.onMessage(msg);
    }

    setTimeout(poll, IPC_POLL_MS);
  };
  setTimeout(poll, IPC_POLL_MS);

  return pollerState;
}

// ---------------------------------------------------------------------------
// Stream consumer (with activity watchdog)
// ---------------------------------------------------------------------------

async function consumeQueryStream(
  runner: AgentRunner,
  config: QueryConfig,
  state: SessionState,
  poller: IpcPollerState,
  log: LogFn,
  writeOutput: WriteOutputFn,
): Promise<QueryResult> {
  const ACTIVITY_TIMEOUT_MS = parseInt(
    process.env.HAPPYCLAW_QUERY_ACTIVITY_TIMEOUT_MS || '300000',
    10,
  );
  const TOOL_HARD_TIMEOUT_MS = parseInt(
    process.env.HAPPYCLAW_TOOL_CALL_HARD_TIMEOUT_MS
      || process.env.TOOL_CALL_HARD_TIMEOUT_MS
      || '1200000',
    10,
  ); // 20 minutes

  const gen = runner.runQuery(config);
  let activityTimer: ReturnType<typeof setTimeout> | null = null;
  // Codex already emits usage as a stream_event on turn completion. Keep the
  // result-level fallback only for providers that do not stream usage.
  let sawUsageStreamEvent = false;

  const resetActivityTimer = () => {
    if (activityTimer) clearTimeout(activityTimer);
    activityTimer = setTimeout(async () => {
      if (!poller.isActive) return; // query already ended

      const report = runner.getActivityReport?.() ?? {
        hasActiveToolCall: false,
        activeToolDurationMs: 0,
        hasPendingBackgroundTasks: false,
      };

      if (report.hasPendingBackgroundTasks) {
        log('Activity timeout skipped: background tasks pending, extending');
        resetActivityTimer();
        return;
      }

      if (report.hasActiveToolCall) {
        if (report.activeToolDurationMs < TOOL_HARD_TIMEOUT_MS) {
          log(`Activity timeout skipped: tool call in progress (${Math.round(report.activeToolDurationMs / 1000)}s)`);
          resetActivityTimer();
          return;
        }
        log(`Tool call hard timeout: ${Math.round(report.activeToolDurationMs / 1000)}s exceeds ${TOOL_HARD_TIMEOUT_MS / 1000}s`);
      } else {
        log(`Activity timeout: no events for ${ACTIVITY_TIMEOUT_MS}ms`);
      }

      await runner.interrupt();
      poller.stop();
    }, ACTIVITY_TIMEOUT_MS);
  };
  resetActivityTimer();

  // Manual iteration to get generator return value
  let newSessionId: string | undefined;
  let resumeAnchor: string | undefined = config.resumeAt;

  let iterResult: IteratorResult<NormalizedMessage, QueryResult>;
  while (!(iterResult = await gen.next()).done) {
    resetActivityTimer();
    const msg = iterResult.value;

    switch (msg.kind) {
      case 'stream_event':
        if (msg.event.eventType === 'usage') {
          sawUsageStreamEvent = true;
        }
        if (
          msg.event.eventType === 'lifecycle' &&
          msg.event.phase === 'compact_completed'
        ) {
          state.setPendingRoutingRecentImChannels(
            msg.event.repairHints?.recentImChannels ?? [],
          );
        }
        if (msg.event.eventType === 'mode_change') {
          emitRuntimeState(writeOutput, runner, state, {
            providerSessionId: newSessionId,
            resumeAnchor,
          });
        }
        writeOutput({ status: 'stream', result: null, streamEvent: msg.event });
        break;

      case 'session_init':
        newSessionId = msg.sessionId;
        log(`Session initialized: ${newSessionId}`);
        emitRuntimeState(writeOutput, runner, state, {
          providerSessionId: newSessionId,
          resumeAnchor,
        });
        break;

      case 'resume_anchor':
        resumeAnchor = msg.anchor;
        emitRuntimeState(writeOutput, runner, state, {
          providerSessionId: newSessionId,
          resumeAnchor,
        });
        break;

      case 'result':
        emitRuntimeState(writeOutput, runner, state, {
          providerSessionId: newSessionId,
          resumeAnchor,
        });
        writeOutput({ status: 'success', result: msg.text, newSessionId });
        if (msg.usage && !sawUsageStreamEvent) {
          writeOutput({
            status: 'stream', result: null,
            streamEvent: { eventType: 'usage', usage: msg.usage },
          });
        }
        break;

      case 'error':
        log(`Query error: ${msg.message} (${msg.errorType || 'generic'})`);
        break;
    }
  }

  if (activityTimer) clearTimeout(activityTimer);

  const queryResult = iterResult.value;
  if (newSessionId && !queryResult.newSessionId) {
    queryResult.newSessionId = newSessionId;
  }
  if (resumeAnchor && !queryResult.resumeAnchor) {
    queryResult.resumeAnchor = resumeAnchor;
  }
  return queryResult;
}

// ---------------------------------------------------------------------------
// Main query loop
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function mergeMessages(messages: IpcMessage[]): string {
  return messages.map(m => m.text).join('\n');
}

function mergeImages(messages: IpcMessage[]): Array<{ data: string; mimeType?: string }> | undefined {
  const all = messages.flatMap(m => m.images || []);
  return all.length > 0 ? all : undefined;
}

function emitRuntimeState(
  writeOutput: WriteOutputFn,
  runner: AgentRunner,
  state: SessionState,
  overrides?: {
    providerSessionId?: string;
    resumeAnchor?: string;
    providerState?: Record<string, unknown>;
    lastMessageCursor?: string | null;
  },
): void {
  const runtimeSnapshot: {
    providerState?: Record<string, unknown>;
    lastMessageCursor?: string | null;
  } = {};
  const providerSnapshot = runner.getRuntimePersistenceSnapshot?.();
  if (overrides && Object.prototype.hasOwnProperty.call(overrides, 'providerState')) {
    runtimeSnapshot.providerState = overrides.providerState;
  } else if (
    providerSnapshot
    && Object.prototype.hasOwnProperty.call(providerSnapshot, 'providerState')
  ) {
    runtimeSnapshot.providerState = providerSnapshot.providerState;
  }
  if (overrides && Object.prototype.hasOwnProperty.call(overrides, 'lastMessageCursor')) {
    runtimeSnapshot.lastMessageCursor = overrides.lastMessageCursor;
  } else if (
    providerSnapshot
    && Object.prototype.hasOwnProperty.call(providerSnapshot, 'lastMessageCursor')
  ) {
    runtimeSnapshot.lastMessageCursor = providerSnapshot.lastMessageCursor ?? null;
  }
  state.applyRuntimeSnapshot(runtimeSnapshot);
  writeOutput({
    status: 'stream',
    result: null,
    runtimeState: state.snapshot({
      ...overrides,
      ...(Object.prototype.hasOwnProperty.call(runtimeSnapshot, 'providerState')
        ? { providerState: runtimeSnapshot.providerState }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(runtimeSnapshot, 'lastMessageCursor')
        ? { lastMessageCursor: runtimeSnapshot.lastMessageCursor }
        : {}),
    }),
  });
}

function shouldClearProviderSession(runner: AgentRunner): boolean {
  const providerState = runner.getRuntimePersistenceSnapshot?.().providerState;
  if (!providerState || typeof providerState !== 'object') return false;
  if (providerState.startFreshOnNextTurn !== true) return false;
  return Object.prototype.hasOwnProperty.call(providerState, 'activeThreadId')
    && providerState.activeThreadId == null;
}

export async function runQueryLoop(config: QueryLoopConfig): Promise<void> {
  const { runner, state, ipcPaths, log, writeOutput } = config;
  const MAX_RETRIES = config.maxOverflowRetries ?? 3;

  let prompt = config.initialPrompt;
  let images = config.initialImages;
  let sessionId = config.ephemeralSession ? undefined : config.sessionId;
  let resumeAnchor: string | undefined = config.ephemeralSession
    ? undefined
    : config.initialResumeAnchor;
  let overflowRetryCount = 0;
  let pendingMessages: IpcMessage[] = [];
  const handleIdleDrain = async (): Promise<void> => {
    await runner.cleanup?.();
    emitRuntimeState(writeOutput, runner, state, {
      providerSessionId: sessionId,
      resumeAnchor,
    });
  };

  while (true) {
    // Clear stale interrupt sentinel
    try { fs.unlinkSync(ipcPaths.interruptSentinel); } catch { /* ignore */ }
    state.clearInterruptRequested();
    log(`Starting query (session: ${sessionId || 'new'})...`);

    // Start IPC poller
    const poller = createUnifiedIpcPoller({
      runner,
      state,
      ipcPaths,
      log,
      writeOutput,
      imChannelsFile: config.imChannelsFile,
      sessionRecordId: config.sessionRecordId,
      onMessage: runner.ipcCapabilities.supportsMidQueryPush
        ? (msg) => {
            const rejected = runner.pushMessage(msg.text, msg.images);
            for (const reason of rejected) {
              writeOutput({ status: 'success', result: `⚠️ ${reason}`, newSessionId: undefined });
            }
          }
        : (msg) => pendingMessages.push(msg),
      onModeChange: runner.ipcCapabilities.supportsRuntimeModeSwitch
        ? (mode) => runner.setPermissionMode?.(mode)
        : undefined,
    });

    // Execute query
    const pendingRoutingRecentImChannels =
      state.takePendingRoutingRecentImChannels();
    const effectivePrompt =
      pendingRoutingRecentImChannels !== null
        ? `${buildChannelRoutingReminder(pendingRoutingRecentImChannels)}\n\n${prompt}`
        : prompt;
    const queryConfig: QueryConfig = {
      prompt: effectivePrompt,
      systemPrompt: config.buildSystemPrompt(prompt),
      sessionId: config.ephemeralSession ? undefined : sessionId,
      resumeAt: config.ephemeralSession ? undefined : resumeAnchor,
      images,
      permissionMode: state.currentPermissionMode,
    };

    let result: QueryResult;
    try {
      result = await consumeQueryStream(
        runner,
        queryConfig,
        state,
        poller,
        log,
        writeOutput,
      );
    } catch (err) {
      poller.stop();
      throw err;
    }
    poller.stop();

    // Merge poller state into result
    if (poller.closedDuringQuery) result.closedDuringQuery = true;
    if (poller.interruptedDuringQuery) result.interruptedDuringQuery = true;
    if (poller.drainDetectedDuringQuery) result.drainDetectedDuringQuery = true;

    // Update session state
    if (config.ephemeralSession || shouldClearProviderSession(runner)) {
      sessionId = undefined;
      resumeAnchor = undefined;
    } else {
      if (result.newSessionId) sessionId = result.newSessionId;
      if (result.resumeAnchor) resumeAnchor = result.resumeAnchor;
    }
    emitRuntimeState(writeOutput, runner, state, {
      providerSessionId: sessionId,
      resumeAnchor,
    });
    await runner.betweenQueries?.();

    // Error recovery
    if (result.sessionResumeFailed) {
      log('Session resume failed, retrying with fresh session');
      sessionId = undefined;
      resumeAnchor = undefined;
      continue;
    }
    if (result.unrecoverableTranscriptError) {
      writeOutput({
        status: 'error', result: null,
        error: 'unrecoverable_transcript: 会话历史包含无法处理的数据，需要重置',
        newSessionId: sessionId,
      });
      process.exit(1);
    }
    if (result.contextOverflow) {
      if (++overflowRetryCount >= MAX_RETRIES) {
        writeOutput({
          status: 'error', result: null,
          error: `context_overflow: 已重试 ${MAX_RETRIES} 次仍失败`,
        });
        process.exit(1);
      }
      log(`Context overflow, retry ${overflowRetryCount}/${MAX_RETRIES}`);
      await sleep(3000);
      continue;
    }
    overflowRetryCount = 0;

    // Control signals
    if (result.closedDuringQuery) {
      writeOutput({ status: 'closed', result: null });
      break;
    }
    if (result.interruptedDuringQuery) {
      writeOutput({
        status: 'stream', result: null,
        streamEvent: { eventType: 'status', statusText: 'interrupted' },
      });
      try { fs.unlinkSync(ipcPaths.interruptSentinel); } catch { /* ignore */ }
      if (pendingMessages.length > 0) {
        prompt = mergeMessages(pendingMessages);
        images = mergeImages(pendingMessages);
        pendingMessages = [];
        continue;
      }
      const next = await waitForIpcMessage(
        ipcPaths,
        log,
        writeOutput,
        state,
        config.imChannelsFile,
        config.sessionRecordId,
        handleIdleDrain,
      );
      if (!next) break;
      state.clearInterruptRequested();
      prompt = next.text;
      images = next.images;
      continue;
    }
    if (result.drainDetectedDuringQuery || shouldDrain(ipcPaths)) {
      await runner.cleanup?.();
      emitRuntimeState(writeOutput, runner, state, {
        providerSessionId: sessionId,
        resumeAnchor,
      });
      writeOutput({ status: 'drained', result: null, newSessionId: sessionId });
      process.exit(0);
    }

    if (config.ephemeralSession) {
      await runner.cleanup?.();
      emitRuntimeState(writeOutput, runner, state, {
        providerSessionId: sessionId,
        resumeAnchor,
      });
      writeOutput({ status: 'success', result: null, newSessionId: sessionId });
      return;
    }

    // Runners without mid-query push may have already drained follow-up IPC
    // messages into pendingMessages while the current turn was still running.
    // In that case start the next turn immediately instead of blocking for yet
    // another IPC file and effectively swallowing the first follow-up message.
    if (pendingMessages.length > 0) {
      prompt = mergeMessages(pendingMessages);
      images = mergeImages(pendingMessages);
      pendingMessages = [];
      log('Query ended with buffered IPC follow-ups, starting next turn immediately');
      continue;
    }

    // Wait for next message
    emitRuntimeState(writeOutput, runner, state, {
      providerSessionId: sessionId,
      resumeAnchor,
    });
    writeOutput({ status: 'success', result: null, newSessionId: sessionId });
    log('Query ended, waiting for next IPC message...');

    const nextMsg = await waitForIpcMessage(
      ipcPaths,
      log,
      writeOutput,
      state,
      config.imChannelsFile,
      config.sessionRecordId,
      handleIdleDrain,
    );
    if (!nextMsg) {
      await runner.cleanup?.();
      break;
    }

    // Merge pending messages (accumulated during Codex turns)
    if (pendingMessages.length > 0) {
      prompt = mergeMessages([...pendingMessages, nextMsg]);
      images = mergeImages([...pendingMessages, nextMsg]);
      pendingMessages = [];
    } else {
      prompt = nextMsg.text;
      images = nextMsg.images;
    }
  }
}
