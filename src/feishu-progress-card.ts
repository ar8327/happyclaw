/**
 * Feishu Progress Card Controller
 *
 * Shows real-time Agent execution progress in Feishu via a card that
 * gets updated using the im.message.patch API. Tracks tool calls,
 * reasoning status, and elapsed time from StreamEvent data.
 *
 * Throttle: updates every ~2s to respect Feishu API rate limits.
 */
import * as lark from '@larksuiteoapi/node-sdk';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'node:crypto';
import { DATA_DIR } from './config.js';
import { logger } from './logger.js';
import { shouldReplyInFeishuThread } from './feishu-conversation-mode.js';
import type { StreamEvent } from './stream-event.types.js';
import {
  buildProgressCard,
  type ProgressCardRenderData,
} from './feishu-card-builder.js';

// ─── Persistent Card Store ───────────────────────────────────
// Tracks active and pending-cleanup card messageIds on disk so a restart can
// remove cards that would otherwise remain stuck in the conversation.

const CARD_STORE_PATH = path.join(DATA_DIR, 'state', 'progress-cards.json');

interface CardStoreEntry {
  folder?: string;
  sourceChannel?: string;
  chatId: string;
  messageId: string;
  createdAt: number;
  replyToMsgId?: string;
  threadId?: string;
  replyInThread?: boolean;
}

function loadCardStore(): CardStoreEntry[] {
  try {
    const data = fs.readFileSync(CARD_STORE_PATH, 'utf-8');
    const parsed = JSON.parse(data);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveCardStore(entries: CardStoreEntry[]): void {
  try {
    const dir = path.dirname(CARD_STORE_PATH);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CARD_STORE_PATH, JSON.stringify(entries), 'utf-8');
  } catch (err) {
    logger.warn({ err }, 'Progress card: failed to save card store');
  }
}

function addToCardStore(entry: CardStoreEntry): void {
  // One Session can briefly have a completed card waiting for deletion while
  // its next Turn already owns a fresh active card. Keep both entries until
  // their individual cleanup finishes.
  const entries = loadCardStore().filter(
    (candidate) => candidate.messageId !== entry.messageId,
  );
  entries.push(entry);
  saveCardStore(entries);
}

function removeFromCardStore(messageId: string): void {
  const entries = loadCardStore().filter((e) => e.messageId !== messageId);
  saveCardStore(entries);
}

function isMissingProgressCardError(err: unknown): boolean {
  const text = (() => {
    if (err instanceof Error) {
      return `${err.message} ${err.stack || ''}`;
    }
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  })().toLowerCase();
  return (
    text.includes('message not found') ||
    text.includes('message has been deleted') ||
    text.includes('230001') ||
    text.includes('230011')
  );
}

interface ProgressCardErrorSummary {
  message: string;
  code?: string;
  status?: number;
  larkCode?: number;
  larkMessage?: string;
}

/** Keep SDK request headers and bearer tokens out of application logs. */
function summarizeProgressCardError(err: unknown): ProgressCardErrorSummary {
  const candidate =
    err && typeof err === 'object'
      ? (err as {
          message?: unknown;
          code?: unknown;
          response?: {
            status?: unknown;
            data?: { code?: unknown; msg?: unknown };
          };
        })
      : null;
  const status = candidate?.response?.status;
  const larkCode = candidate?.response?.data?.code;
  const larkMessage = candidate?.response?.data?.msg;
  return {
    message:
      typeof candidate?.message === 'string'
        ? candidate.message
        : err instanceof Error
          ? err.message
          : String(err),
    ...(typeof candidate?.code === 'string' ? { code: candidate.code } : {}),
    ...(typeof status === 'number' ? { status } : {}),
    ...(typeof larkCode === 'number' ? { larkCode } : {}),
    ...(typeof larkMessage === 'string' ? { larkMessage } : {}),
  };
}

function isTransientProgressCardError(err: unknown): boolean {
  const summary = summarizeProgressCardError(err);
  if (summary.status !== undefined) {
    return (
      summary.status === 408 || summary.status === 429 || summary.status >= 500
    );
  }
  return (
    summary.message === 'No Lark client available' ||
    summary.code === 'ECONNRESET' ||
    summary.code === 'ECONNREFUSED' ||
    summary.code === 'ETIMEDOUT' ||
    summary.code === 'EAI_AGAIN' ||
    summary.code === 'ERR_NETWORK' ||
    summary.code === 'ERR_BAD_RESPONSE'
  );
}

/** Delete progress cards left behind by an interrupted process. */
export async function cleanupStaleProgressCards(
  clientResolver: () => lark.Client | undefined,
): Promise<void> {
  const entries = loadCardStore();
  if (entries.length === 0) return;

  const client = clientResolver();
  if (!client) {
    logger.warn('Progress card: no lark client for stale card cleanup');
    return;
  }

  const remaining: CardStoreEntry[] = [];
  for (const entry of entries) {
    try {
      await client.im.v1.message.delete({
        path: { message_id: entry.messageId },
      });
      logger.info(
        `Progress card: deleted stale card | chatId=${entry.chatId} messageId=${entry.messageId}`,
      );
    } catch (err) {
      if (!isMissingProgressCardError(err)) remaining.push(entry);
    }
  }
  saveCardStore(remaining);
  logger.info(
    { deleted: entries.length - remaining.length, remaining: remaining.length },
    'Progress card: stale cleanup completed',
  );
}

// ─── Types ────────────────────────────────────────────────────

type ProgressState =
  | 'idle'
  | 'creating'
  | 'active'
  | 'completed'
  | 'aborted'
  | 'failed'
  | 'error';
type ProgressDisplayState = 'active' | 'completed' | 'aborted' | 'failed';

export interface ProgressCardOptions {
  /** Pre-resolved client (used by im-channel adapter) */
  client?: lark.Client;
  /** Lazy client resolver — called when the card is actually created, avoiding race
   *  conditions when Feishu WebSocket hasn't reconnected yet after a restart. */
  clientResolver?: () => lark.Client | undefined;
  chatId: string;
  replyToMsgId?: string;
  threadId?: string;
  replyInThread?: boolean;
  title?: string;
  modelLabel?: string;
  /** Stop handler exposed through the Feishu persistent-connection callback. */
  onStop?: () => boolean | Promise<boolean>;
  /** Session ownership recorded for crash cleanup and Session deletion. */
  anchorFolder?: string;
  anchorSourceChannel?: string;
  /** Delay before a successful Turn card is withdrawn. Defaults to 15 seconds. */
  completionDeleteDelayMs?: number;
  /** Initial delay for transient create retries. Defaults to 1 second. */
  createRetryBaseDelayMs?: number;
  /** Total create attempts, including the initial request. Defaults to 4. */
  maxCreateAttempts?: number;
}

interface ActiveTool {
  toolName: string;
  startTime: number;
  inputSummary?: string;
  skillName?: string;
}

interface CompletedTool {
  toolName: string;
  duration: number;
  inputSummary?: string;
  skillName?: string;
}

interface ActiveSubAgent {
  taskId: string;
  description: string;
  startTime: number;
  isBackground: boolean;
  isTeammate: boolean;
  agentType?: string;
  agentName?: string;
}

interface CompletedSubAgent {
  taskId: string;
  description: string;
  duration: number;
  summary: string;
  agentType?: string;
  agentName?: string;
}

// ─── Stop-action capability registry ───────────────────────────

interface StopActionEntry {
  expiresAt: number;
  run: () => boolean | Promise<boolean>;
}

const stopActions = new Map<string, StopActionEntry>();
const STOP_ACTION_TTL_MS = 6 * 60 * 60 * 1000;

export type ProgressCardActionResult =
  | 'stopped'
  | 'already_finished'
  | 'invalid';

export async function handleProgressCardAction(
  value: unknown,
): Promise<ProgressCardActionResult> {
  if (!value || typeof value !== 'object') return 'invalid';
  const action = value as Record<string, unknown>;
  if (action.action !== 'stop_turn' || typeof action.action_id !== 'string') {
    return 'invalid';
  }

  const entry = stopActions.get(action.action_id);
  if (!entry || entry.expiresAt < Date.now()) {
    stopActions.delete(action.action_id);
    return 'already_finished';
  }

  // One-time capability: delete before invoking so retries/double-clicks cannot
  // interrupt a later turn that happens to share the same chat.
  stopActions.delete(action.action_id);
  return (await entry.run()) ? 'stopped' : 'already_finished';
}

// ─── Progress Card Controller ─────────────────────────────────

export class ProgressCardController {
  private state: ProgressState = 'idle';
  private messageId: string | null = null;
  private startedAt = Date.now();
  private activeTools = new Map<string, ActiveTool>();
  private completedTools: CompletedTool[] = [];
  private activeSubAgents = new Map<string, ActiveSubAgent>();
  private completedSubAgents: CompletedSubAgent[] = [];
  private isThinking = false;
  private thinkingText = '';
  private latestCommentary = '';
  private dirty = false;
  private abortReason?: string;
  private failureDetail?: string;
  private runnerError?: {
    message: string;
    detail?: string;
    willRetry: boolean;
  };
  private patchFailCount = 0;
  private readonly maxPatchFailures = 3;
  private createAttemptCount = 0;
  private createUuid = randomUUID();

  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private deleteTimer: ReturnType<typeof setTimeout> | null = null;
  private createRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFlushTime = 0;
  private readonly flushInterval = 2000; // 2s throttle

  private client: lark.Client | undefined;
  private readonly clientResolver?: () => lark.Client | undefined;
  private readonly chatId: string;
  private readonly replyToMsgId?: string;
  private readonly threadId?: string;
  private readonly replyInThread?: boolean;
  private readonly title?: string;
  private readonly modelLabel?: string;
  private readonly onStop?: () => boolean | Promise<boolean>;
  private readonly anchorFolder?: string;
  private readonly anchorSourceChannel?: string;
  private readonly completionDeleteDelayMs: number;
  private readonly createRetryBaseDelayMs: number;
  private readonly maxCreateAttempts: number;
  private stopActionId?: string;

  constructor(opts: ProgressCardOptions) {
    this.client = opts.client;
    this.clientResolver = opts.clientResolver;
    this.chatId = opts.chatId;
    this.replyToMsgId = opts.replyToMsgId;
    this.threadId = opts.threadId;
    this.replyInThread = opts.replyInThread;
    this.title = opts.title;
    this.modelLabel = opts.modelLabel;
    this.onStop = opts.onStop;
    this.anchorFolder = opts.anchorFolder;
    this.anchorSourceChannel = opts.anchorSourceChannel;
    this.completionDeleteDelayMs = opts.completionDeleteDelayMs ?? 15_000;
    this.createRetryBaseDelayMs = Math.max(
      0,
      opts.createRetryBaseDelayMs ?? 1_000,
    );
    this.maxCreateAttempts = Math.max(1, opts.maxCreateAttempts ?? 4);
    this.registerStopAction();
  }

  private registerStopAction(): void {
    if (!this.onStop || this.stopActionId) return;
    const actionId = randomUUID();
    stopActions.set(actionId, {
      expiresAt: Date.now() + STOP_ACTION_TTL_MS,
      run: this.onStop,
    });
    this.stopActionId = actionId;
  }

  private clearStopAction(): void {
    if (!this.stopActionId) return;
    stopActions.delete(this.stopActionId);
    this.stopActionId = undefined;
  }

  /** Resolve the lark client lazily — allows creation before Feishu connection is ready. */
  private resolveClient(): lark.Client | undefined {
    if (this.client) return this.client;
    if (this.clientResolver) {
      this.client = this.clientResolver();
    }
    return this.client;
  }

  isActive(): boolean {
    return this.state === 'active' || this.state === 'creating';
  }

  /**
   * Feed a StreamEvent into the progress card.
   * Creates the card lazily on first thinking or tool_use_start event.
   */
  feedEvent(event: StreamEvent): void {
    const type = event.eventType;

    if (
      this.state === 'completed' ||
      this.state === 'aborted' ||
      this.state === 'failed'
    ) {
      return;
    }

    if (event.runnerError) {
      const next = event.runnerError;
      const previous = this.runnerError;
      const previousLength = (previous?.detail || previous?.message || '')
        .length;
      const nextLength = (next.detail || next.message).length;
      if (
        !previous ||
        previous.willRetry !== next.willRetry ||
        nextLength >= previousLength
      ) {
        this.runnerError = { ...next };
      }
      this.dirty = true;
    } else if (
      this.runnerError?.willRetry &&
      (type === 'thinking_delta' ||
        type === 'text_delta' ||
        type === 'tool_use_start' ||
        type === 'tool_use_end' ||
        type === 'tool_progress' ||
        type === 'hook_started' ||
        type === 'hook_progress' ||
        type === 'hook_response' ||
        type === 'task_start' ||
        type === 'task_notification' ||
        type === 'todo_update')
    ) {
      // A retryable runner error is transient. Once the provider emits fresh
      // execution progress, the retry has recovered and the orange error state
      // must not remain pinned while tools and reasoning continue to update.
      this.runnerError = undefined;
      this.dirty = true;
    }

    if (type === 'thinking_delta') {
      this.isThinking = true;
      if (event.text) this.thinkingText += event.text;
      this.dirty = true;
    } else if (type === 'text_delta') {
      this.isThinking = false;
      this.thinkingText = '';
      this.dirty = true;
    } else if (type === 'tool_use_start' && event.toolUseId && event.toolName) {
      this.isThinking = false;
      this.thinkingText = '';
      this.activeTools.set(event.toolUseId, {
        toolName: event.toolName,
        startTime: Date.now(),
        inputSummary: event.toolInputSummary,
        skillName: event.skillName,
      });
      this.dirty = true;
    } else if (type === 'tool_use_end' && event.toolUseId) {
      const active = this.activeTools.get(event.toolUseId);
      if (active) {
        this.activeTools.delete(event.toolUseId);
        this.completedTools.push({
          toolName: active.toolName,
          duration: Date.now() - active.startTime,
          inputSummary: active.inputSummary,
          skillName: active.skillName,
        });
        this.dirty = true;
      }
    } else if (type === 'tool_progress' && event.toolUseId) {
      const active = this.activeTools.get(event.toolUseId);
      if (active) {
        if (event.toolInputSummary)
          active.inputSummary = event.toolInputSummary;
        if (event.skillName) active.skillName = event.skillName;
        this.dirty = true;
      }
    } else if (type === 'task_start' && event.toolUseId) {
      // Sub-agent (Task) started
      this.activeSubAgents.set(event.toolUseId, {
        taskId: event.toolUseId,
        description: event.taskDescription || 'Sub-Agent',
        startTime: Date.now(),
        isBackground: event.isBackground ?? false,
        isTeammate: event.isTeammate ?? false,
        agentType: event.taskAgentType,
        agentName: event.taskAgentName,
      });
      this.dirty = true;
    } else if (type === 'task_notification' && event.taskId) {
      // Sub-agent completed/failed
      const active = this.activeSubAgents.get(event.taskId);
      if (active) {
        this.activeSubAgents.delete(event.taskId);
        this.completedSubAgents.push({
          taskId: active.taskId,
          description: active.description,
          duration: Date.now() - active.startTime,
          summary: event.taskSummary || '',
          agentType: active.agentType,
          agentName: active.agentName,
        });
        this.dirty = true;
      }
    }

    // Lazy creation: create the Session card on its first meaningful event.
    if (this.dirty && (this.state === 'idle' || this.state === 'error')) {
      this.registerStopAction();
      if (this.messageId) {
        this.state = 'active';
        this.scheduleFlush();
      } else {
        this.startCardCreation();
      }
    }

    if (this.dirty && this.state === 'active') {
      this.scheduleFlush();
    }
  }

  /** Mark the current Turn completed, then withdraw its card after a delay. */
  async complete(): Promise<void> {
    const prevState = this.state;
    if (
      prevState !== 'active' &&
      prevState !== 'creating' &&
      prevState !== 'aborted' &&
      prevState !== 'error'
    ) {
      logger.info(
        `Progress card: complete() skipped | chatId=${this.chatId} state=${prevState}`,
      );
      return;
    }
    this.state = 'completed';
    this.abortReason = undefined; // Clear any abort reason since we're completing successfully
    if (this.runnerError?.willRetry) {
      this.runnerError = undefined;
    }
    this.clearFlushTimer();
    this.clearCreateRetryTimer();
    this.clearStopAction();

    if (this.messageId) {
      try {
        await this.patchCard('completed');
        logger.info(
          `Progress card: patched to completed | chatId=${this.chatId} messageId=${this.messageId}`,
        );
        this.scheduleDelete(this.messageId);
      } catch (err) {
        logger.warn(
          { error: summarizeProgressCardError(err) },
          `Progress card: failed to patch completed | chatId=${this.chatId} messageId=${this.messageId}`,
        );
      }
    } else if (prevState === 'error') {
      await this.recoverTerminalCard('completed');
    } else {
      logger.info(
        `Progress card: complete() called but no messageId | chatId=${this.chatId} prevState=${prevState}`,
      );
    }
  }

  /**
   * Abort the progress card.
   */
  async abort(reason?: string): Promise<void> {
    if (
      this.state === 'completed' ||
      this.state === 'aborted' ||
      this.state === 'failed'
    )
      return;
    const previousState = this.state;
    this.state = 'aborted';
    this.abortReason = reason;
    this.clearFlushTimer();
    this.clearCreateRetryTimer();
    this.clearStopAction();

    if (this.messageId) {
      try {
        await this.patchCard('aborted');
        // Keep the user-visible interruption record, but do not let a later
        // Turn or restart treat it as an active card.
        removeFromCardStore(this.messageId);
        logger.info(
          `Progress card: patched to aborted | chatId=${this.chatId} reason=${reason}`,
        );
      } catch (err) {
        logger.warn(
          { error: summarizeProgressCardError(err) },
          `Progress card: failed to patch aborted | chatId=${this.chatId}`,
        );
      }
    } else if (previousState === 'error') {
      await this.recoverTerminalCard('aborted');
    }
  }

  /** Finalize the current Turn as a visible, non-reusable failure diagnostic. */
  async fail(detail?: string): Promise<void> {
    if (this.state === 'completed' || this.state === 'failed') return;
    const previousState = this.state;
    this.state = 'failed';
    this.failureDetail =
      detail?.trim() ||
      this.runnerError?.detail ||
      this.runnerError?.message ||
      'Runner 未返回具体错误信息';
    this.clearFlushTimer();
    this.clearCreateRetryTimer();
    this.clearStopAction();

    if (this.messageId) {
      try {
        await this.patchCard('failed');
        // Failure diagnostics intentionally remain visible in Feishu. Stop
        // tracking them as stale active cards so a later service restart does
        // not withdraw the diagnostic.
        removeFromCardStore(this.messageId);
        logger.info(
          {
            chatId: this.chatId,
            messageId: this.messageId,
            error: this.failureDetail,
          },
          'Progress card: patched to failed',
        );
      } catch (err) {
        logger.warn(
          {
            error: summarizeProgressCardError(err),
            chatId: this.chatId,
            messageId: this.messageId,
          },
          'Progress card: failed to patch runner error',
        );
      }
      return;
    }

    // Errors can happen before the first thinking/tool event. Create a terminal
    // card directly so startup and protocol failures are still visible.
    if (previousState === 'idle' || previousState === 'error') {
      await this.recoverTerminalCard('failed');
    }
    // If creation is already in flight, createCard() observes state='failed'
    // and patches the newly created card in its race-resolution path.
  }

  /** Force cleanup during shutdown or Session deletion. */
  async forceCleanup(_reason: string): Promise<void> {
    this.clearFlushTimer();
    this.clearCreateRetryTimer();
    this.clearStopAction();
    this.clearDeleteTimer();
    if (!this.messageId) return;

    // Just delete the card silently — no need to show "服务维护中" to the user
    try {
      await this.deleteCard();
      logger.info(
        `Progress card: force cleanup (deleted) | chatId=${this.chatId}`,
      );
    } catch (err) {
      logger.warn(
        { error: summarizeProgressCardError(err) },
        `Progress card: force cleanup failed | chatId=${this.chatId}`,
      );
    }
  }

  /** Complete the current Turn. The registry releases this controller. */
  async completeAndReset(): Promise<void> {
    await this.complete();
  }

  /** Dispose active-update timers while preserving delayed success cleanup. */
  dispose(): void {
    this.clearFlushTimer();
    this.clearCreateRetryTimer();
    this.clearStopAction();
  }

  /**
   * Update the commentary text shown in the progress card.
   * Called by im-commentary instead of creating a new IM message.
   */
  addCommentary(text: string): void {
    this.latestCommentary = text;
    this.dirty = true;
    if (this.state === 'active') {
      this.scheduleFlush();
    } else if (this.state === 'idle' || this.state === 'error') {
      this.startCardCreation();
    }
  }

  /** Build a presentation-only snapshot for the shared JSON 2.0 builder. */
  private getCardData(state: ProgressDisplayState): ProgressCardRenderData {
    return {
      title: this.title,
      modelLabel: this.modelLabel,
      activeTools: Array.from(this.activeTools.values()),
      completedTools: this.completedTools,
      isThinking: this.isThinking,
      thinkingText: this.thinkingText,
      elapsedMs: Date.now() - this.startedAt,
      state,
      abortReason: this.abortReason,
      failureDetail: this.failureDetail,
      runnerError: this.runnerError,
      activeSubAgents: Array.from(this.activeSubAgents.values()),
      completedSubAgents: this.completedSubAgents,
      latestCommentary: this.latestCommentary || undefined,
      stopActionId: state === 'active' ? this.stopActionId : undefined,
    };
  }

  // ─── Internal ───────────────────────────────────────────

  private async sendCard(displayState: ProgressDisplayState): Promise<void> {
    const client = this.resolveClient();
    if (!client) {
      throw new Error('No Lark client available');
    }

    const card = buildProgressCard(this.getCardData(displayState));
    const content = JSON.stringify(card);
    let resp: any;
    if (this.replyToMsgId) {
      resp = await client.im.message.reply({
        path: { message_id: this.replyToMsgId },
        data: {
          content,
          msg_type: 'interactive',
          uuid: this.createUuid,
          reply_in_thread: shouldReplyInFeishuThread({
            threadId: this.threadId,
            replyInThread: this.replyInThread,
          }),
        },
      });
    } else {
      resp = await client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: this.chatId,
          msg_type: 'interactive',
          content,
          uuid: this.createUuid,
        },
      });
    }

    this.messageId = resp?.data?.message_id || null;
    if (!this.messageId) throw new Error('No message_id in response');
    this.persistAnchor();
  }

  private async createCard(): Promise<void> {
    try {
      await this.sendCard('active');

      // State may have changed during await (complete/abort called while creating)
      if (this.state !== 'creating') {
        const finalState = this.state as Exclude<
          ProgressDisplayState,
          'active'
        >;
        logger.info(
          { chatId: this.chatId, finalState, messageId: this.messageId },
          'Progress card: state changed during creation, patching to final state',
        );
        try {
          await this.patchCard(finalState);
          if (finalState === 'completed' && this.messageId) {
            this.scheduleDelete(this.messageId);
          } else if (
            (finalState === 'aborted' || finalState === 'failed') &&
            this.messageId
          ) {
            removeFromCardStore(this.messageId);
          }
        } catch (err) {
          logger.warn(
            {
              error: summarizeProgressCardError(err),
              chatId: this.chatId,
              finalState,
            },
            'Progress card: failed to patch final state after creation race',
          );
        }
        return;
      }

      this.state = 'active';
      this.createAttemptCount = 0;
      this.clearCreateRetryTimer();
      logger.info(
        { chatId: this.chatId, messageId: this.messageId },
        'Progress card created',
      );

      if (this.dirty) this.scheduleFlush();
    } catch (err) {
      // Do not overwrite a terminal state chosen while the request was in
      // flight. handleCreateFailure() will reconcile a transient timeout with
      // that terminal state using the same idempotency UUID.
      if (this.state === 'creating') this.state = 'error';
      throw err;
    }
  }

  private startCardCreation(): void {
    if (
      this.messageId ||
      this.createRetryTimer ||
      this.state === 'creating' ||
      this.state === 'active' ||
      this.state === 'completed' ||
      this.state === 'aborted' ||
      this.state === 'failed' ||
      this.createAttemptCount >= this.maxCreateAttempts
    ) {
      return;
    }
    this.state = 'creating';
    this.createAttemptCount++;
    void this.createCard().catch((err) => this.handleCreateFailure(err));
  }

  private handleCreateFailure(err: unknown): void {
    if (
      this.state === 'completed' ||
      this.state === 'aborted' ||
      this.state === 'failed'
    ) {
      if (isTransientProgressCardError(err)) {
        void this.recoverTerminalCard(this.state);
      }
      return;
    }
    this.state = 'error';
    const willRetry =
      isTransientProgressCardError(err) &&
      this.createAttemptCount < this.maxCreateAttempts;
    const delayMs = willRetry
      ? this.createRetryBaseDelayMs *
        Math.pow(2, Math.max(0, this.createAttemptCount - 1))
      : undefined;
    logger.warn(
      {
        error: summarizeProgressCardError(err),
        chatId: this.chatId,
        attempt: this.createAttemptCount,
        maxAttempts: this.maxCreateAttempts,
        willRetry,
        delayMs,
      },
      'Progress card: create failed',
    );
    if (!willRetry || delayMs === undefined) return;
    this.createRetryTimer = setTimeout(() => {
      this.createRetryTimer = null;
      this.startCardCreation();
    }, delayMs);
    this.createRetryTimer.unref?.();
  }

  /**
   * Reuse the create UUID once more after a timed-out create so a terminal
   * Turn can recover the message ID and close a card that Lark may already
   * have accepted behind a gateway timeout.
   */
  private async recoverTerminalCard(
    displayState: Exclude<ProgressDisplayState, 'active'>,
  ): Promise<void> {
    try {
      await this.sendCard(displayState);
      if (!this.messageId) return;
      // An idempotent retry may return the card created by the original active
      // request, so patch explicitly to guarantee the terminal presentation.
      await this.patchCard(displayState);
      if (displayState === 'completed') {
        this.scheduleDelete(this.messageId);
      } else {
        removeFromCardStore(this.messageId);
      }
      logger.info(
        { chatId: this.chatId, messageId: this.messageId, displayState },
        'Progress card: recovered terminal card after create failure',
      );
    } catch (err) {
      logger.warn(
        {
          error: summarizeProgressCardError(err),
          chatId: this.chatId,
          displayState,
        },
        'Progress card: failed to recover terminal card',
      );
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return; // already scheduled
    if (this.patchFailCount >= this.maxPatchFailures) return;

    const elapsed = Date.now() - this.lastFlushTime;
    const delay = Math.max(0, this.flushInterval - elapsed);

    this.flushTimer = setTimeout(async () => {
      this.flushTimer = null;
      if (this.state !== 'active' || !this.messageId) return;

      this.dirty = false;
      try {
        await this.patchCard('active');
        this.lastFlushTime = Date.now();
        this.patchFailCount = 0;
      } catch (err) {
        this.patchFailCount++;
        logger.debug(
          {
            error: summarizeProgressCardError(err),
            chatId: this.chatId,
            failCount: this.patchFailCount,
          },
          'Progress card: patch failed',
        );
      }

      // If more events arrived during flush, schedule again
      if (this.dirty && this.state === 'active') {
        this.scheduleFlush();
      }
    }, delay);
  }

  private async patchCard(displayState: ProgressDisplayState): Promise<void> {
    if (!this.messageId) return;
    const client = this.resolveClient();
    if (!client) return;

    const card = buildProgressCard(this.getCardData(displayState));
    const content = JSON.stringify(card);

    try {
      await client.im.v1.message.patch({
        path: { message_id: this.messageId },
        data: { content },
      });
    } catch (err) {
      if (isMissingProgressCardError(err)) {
        const missingMessageId = this.messageId;
        this.messageId = null;
        removeFromCardStore(missingMessageId);
        // A genuinely missing/deleted message needs a new idempotency scope;
        // transient retries of one create attempt keep the previous UUID.
        this.createUuid = randomUUID();
        await this.sendCard(displayState);
        return;
      }
      throw err;
    }
  }

  private async deleteCard(): Promise<void> {
    if (!this.messageId) return;
    await this.deleteCardById(this.messageId);
  }

  private async deleteCardById(messageId: string): Promise<void> {
    const client = this.resolveClient();
    if (client) {
      try {
        await client.im.v1.message.delete({
          path: { message_id: messageId },
        });
        logger.info(
          `Progress card: deleted | chatId=${this.chatId} messageId=${messageId}`,
        );
      } catch {
        // Deletion is best-effort, but the local Session anchor must still go.
      }
    }
    removeFromCardStore(messageId);
    if (this.messageId === messageId) this.messageId = null;
  }

  private scheduleDelete(messageId: string): void {
    this.clearDeleteTimer();
    this.deleteTimer = setTimeout(() => {
      this.deleteTimer = null;
      void this.deleteCardById(messageId);
    }, this.completionDeleteDelayMs);
    this.deleteTimer.unref?.();
  }

  private persistAnchor(): void {
    if (!this.messageId || !this.anchorFolder || !this.anchorSourceChannel) {
      return;
    }
    addToCardStore({
      folder: this.anchorFolder,
      sourceChannel: this.anchorSourceChannel,
      chatId: this.chatId,
      messageId: this.messageId,
      createdAt: Date.now(),
      replyToMsgId: this.replyToMsgId,
      threadId: this.threadId,
      replyInThread: this.replyInThread,
    });
  }

  private clearFlushTimer(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private clearDeleteTimer(): void {
    if (this.deleteTimer) {
      clearTimeout(this.deleteTimer);
      this.deleteTimer = null;
    }
  }

  private clearCreateRetryTimer(): void {
    if (this.createRetryTimer) {
      clearTimeout(this.createRetryTimer);
      this.createRetryTimer = null;
    }
  }
}

// ─── Progress Card Session Registry ──────────────────────────

interface ProgressSessionEntry {
  session: ProgressCardController;
  folder: string;
  sourceChannel: string;
}

const activeProgressSessions = new Map<string, ProgressSessionEntry>();

/**
 * Atomically claim the one progress-card slot for a Session. Claim before any
 * asynchronous Feishu call so simultaneous messages cannot create two cards.
 */
export function claimProgressSession(
  sourceChannel: string,
  session: ProgressCardController,
  folder: string,
): boolean {
  if (activeProgressSessions.has(folder)) {
    return false;
  }
  activeProgressSessions.set(folder, { session, folder, sourceChannel });
  return true;
}

function unregisterProgressSession(folder: string): void {
  activeProgressSessions.delete(folder);
}

/**
 * Feed the active Turn's single card, wherever its first Feishu message
 * anchored it. Source channels affect replies, not execution ownership.
 */
export function feedProgressSessionsForFolder(
  folder: string,
  event: StreamEvent,
): void {
  activeProgressSessions.get(folder)?.session.feedEvent(event);
}

/**
 * Keep the current Turn card alive while the host replaces a runtime that
 * exited before acknowledging all accepted IPC deliveries.
 */
export function markProgressSessionRecoveringForFolder(
  folder: string,
  detail = '运行时中断，正在恢复任务…',
): void {
  activeProgressSessions.get(folder)?.session.addCommentary(detail);
}

/**
 * Complete the active Turn card and release its registry slot immediately.
 * The completed message remains visible until its delayed cleanup runs, while
 * a following Turn can already claim a fresh card next to its trigger message.
 */
export async function completeAndResetProgressSessionsForFolder(
  folder: string,
): Promise<void> {
  const entry = activeProgressSessions.get(folder);
  if (entry) {
    unregisterProgressSession(folder);
    await entry.session.completeAndReset().catch(() => {});
    entry.session.dispose();
  }
}

/** Finalize the active Turn card and release it before the next Turn starts. */
export async function finalizeProgressSessionsForFolder(
  folder: string,
  mode: 'complete' | 'abort' | 'fail',
  detail?: string,
): Promise<void> {
  const entry = activeProgressSessions.get(folder);
  if (!entry) return;
  unregisterProgressSession(folder);
  if (mode === 'abort') {
    await entry.session.abort(detail).catch(() => {});
  } else if (mode === 'fail') {
    await entry.session.fail(detail).catch(() => {});
  } else {
    await entry.session.complete().catch(() => {});
  }
  entry.session.dispose();
}

/**
 * Check if an active progress session exists for a chatJid.
 */
export function hasProgressSession(folder: string): boolean {
  return activeProgressSessions.has(folder);
}

/** Delete every active or pending-cleanup card owned by the Session. */
export async function deleteProgressSession(
  folder: string,
  clientResolver?: () => lark.Client | undefined,
): Promise<void> {
  const entry = activeProgressSessions.get(folder);
  if (entry) {
    await entry.session.forceCleanup('Session 已删除');
  }
  for (const stored of loadCardStore().filter(
    (candidate) => candidate.folder === folder,
  )) {
    try {
      await clientResolver?.()?.im.v1.message.delete({
        path: { message_id: stored.messageId },
      });
    } catch {
      // The Session is being deleted, so a missing/unreachable card is fine.
    }
    removeFromCardStore(stored.messageId);
  }
  unregisterProgressSession(folder);
}

export async function abortAllProgressSessions(
  reason = '服务维护中',
): Promise<void> {
  const cleanups = [...activeProgressSessions.entries()].map(
    ([folder, entry]) =>
      entry.session.forceCleanup(reason).catch((err) => {
        logger.debug({ err, folder }, 'Failed to clean up progress session');
      }),
  );
  await Promise.allSettled(cleanups);
  activeProgressSessions.clear();
}
