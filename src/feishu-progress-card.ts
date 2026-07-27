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
// Tracks active card messageIds on disk so they survive restarts.

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

interface RestorableCardStoreEntry extends CardStoreEntry {
  folder: string;
  sourceChannel: string;
}

function isRestorableCardStoreEntry(
  entry: CardStoreEntry,
): entry is RestorableCardStoreEntry {
  return Boolean(entry.folder && entry.sourceChannel);
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
  // A logical Session owns at most one progress card. The first Feishu source
  // claims the anchor; later messages from any channel keep patching it.
  const entries = loadCardStore().filter(
    (candidate) =>
      candidate.messageId !== entry.messageId &&
      (!entry.folder || candidate.folder !== entry.folder),
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

/** Restore the one persisted progress-card anchor per Session after restart. */
export async function restoreProgressCardSessions(
  clientResolver: () => lark.Client | undefined,
): Promise<void> {
  const entries = loadCardStore();
  if (entries.length === 0) return;

  const restored = new Map<string, RestorableCardStoreEntry>();
  for (const entry of entries.sort((a, b) => a.createdAt - b.createdAt)) {
    if (!isRestorableCardStoreEntry(entry)) {
      // Legacy stores did not record Session ownership and therefore cannot be
      // restored safely. Best-effort delete only those pre-migration cards.
      try {
        await clientResolver()?.im.v1.message.delete({
          path: { message_id: entry.messageId },
        });
      } catch {
        // It may already be gone.
      }
      continue;
    }
    const previous = restored.get(entry.folder);
    if (previous) {
      try {
        await clientResolver()?.im.v1.message.delete({
          path: { message_id: previous.messageId },
        });
      } catch {
        // Keep the newest persisted anchor even if an older duplicate is gone.
      }
      removeFromCardStore(previous.messageId);
    }
    restored.set(entry.folder, entry);
  }
  for (const entry of restored.values()) {
    restoreProgressSessionFromStore(entry, clientResolver);
  }
  saveCardStore([...restored.values()]);
  logger.info(
    { restored: restored.size },
    'Progress card: restored persisted Session anchors',
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
  /** Existing card restored from the Session anchor store. */
  existingMessageId?: string;
  /** Session ownership used to persist the single-card anchor. */
  anchorFolder?: string;
  anchorSourceChannel?: string;
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

  private flushTimer: ReturnType<typeof setTimeout> | null = null;
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
    this.messageId = opts.existingMessageId ?? null;
    this.anchorFolder = opts.anchorFolder;
    this.anchorSourceChannel = opts.anchorSourceChannel;
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
      this.state === 'failed' ||
      this.state === 'error'
    ) {
      this.beginNextTurn();
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
    if (this.dirty && this.state === 'idle') {
      this.registerStopAction();
      if (this.messageId) {
        this.state = 'active';
        this.scheduleFlush();
      } else {
        this.state = 'creating';
        this.createCard().catch((err) => {
          logger.warn(
            { err, chatId: this.chatId },
            'Progress card: create failed',
          );
          this.state = 'error';
        });
      }
    }

    if (this.dirty && this.state === 'active') {
      this.scheduleFlush();
    }
  }

  /**
   * Mark the current turn completed while keeping the Session card anchored.
   */
  async complete(): Promise<void> {
    const prevState = this.state;
    if (
      prevState !== 'active' &&
      prevState !== 'creating' &&
      prevState !== 'aborted'
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
    this.clearStopAction();

    if (this.messageId) {
      try {
        await this.patchCard('completed');
        logger.info(
          `Progress card: patched to completed | chatId=${this.chatId} messageId=${this.messageId}`,
        );
      } catch (err) {
        logger.warn(
          { err },
          `Progress card: failed to patch completed | chatId=${this.chatId} messageId=${this.messageId}`,
        );
      }
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
    this.state = 'aborted';
    this.abortReason = reason;
    this.clearFlushTimer();
    this.clearStopAction();

    if (this.messageId) {
      try {
        await this.patchCard('aborted');
        logger.info(
          `Progress card: patched to aborted | chatId=${this.chatId} reason=${reason}`,
        );
      } catch (err) {
        logger.warn(
          { err },
          `Progress card: failed to patch aborted | chatId=${this.chatId}`,
        );
      }
    }
  }

  /**
   * Finalize the current turn as a runner failure. The diagnostic stays on the
   * Session card until the next turn reuses that same anchored message.
   */
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
    this.clearStopAction();

    if (this.messageId) {
      try {
        await this.patchCard('failed');
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
          { err, chatId: this.chatId, messageId: this.messageId },
          'Progress card: failed to patch runner error',
        );
      }
      return;
    }

    // Errors can happen before the first thinking/tool event. Create a terminal
    // card directly so startup and protocol failures are still visible.
    if (previousState === 'idle' || previousState === 'error') {
      try {
        await this.sendCard('failed');
        logger.info(
          { chatId: this.chatId, messageId: this.messageId },
          'Progress card: created failed card',
        );
      } catch (err) {
        logger.warn(
          { err, chatId: this.chatId },
          'Progress card: failed to create runner error card',
        );
      }
    }
    // If creation is already in flight, createCard() observes state='failed'
    // and patches the newly created card in its race-resolution path.
  }

  /**
   * Force cleanup during shutdown — deletes the card regardless of current state.
   * Used by abortAllProgressSessions when the process is shutting down.
   */
  async forceCleanup(_reason: string): Promise<void> {
    this.clearFlushTimer();
    this.clearStopAction();
    if (!this.messageId) return;

    // Just delete the card silently — no need to show "服务维护中" to the user
    try {
      await this.deleteCard();
      logger.info(
        `Progress card: force cleanup (deleted) | chatId=${this.chatId}`,
      );
    } catch (err) {
      logger.warn(
        { err },
        `Progress card: force cleanup failed | chatId=${this.chatId}`,
      );
    }
  }

  /**
   * Complete the current turn while preserving the Session card anchor. The
   * next event resets transient data and re-arms the stop action before patching.
   */
  async completeAndReset(): Promise<void> {
    await this.complete();
  }

  private beginNextTurn(): void {
    this.state = 'idle';
    this.resetTurnData();
  }

  private resetTurnData(): void {
    this.startedAt = Date.now();
    this.activeTools.clear();
    this.completedTools = [];
    this.activeSubAgents.clear();
    this.completedSubAgents = [];
    this.isThinking = false;
    this.thinkingText = '';
    this.latestCommentary = '';
    this.dirty = false;
    this.abortReason = undefined;
    this.failureDetail = undefined;
    this.runnerError = undefined;
    this.patchFailCount = 0;
    this.registerStopAction();
  }

  /**
   * Dispose of active timers without deleting the persistent Session anchor.
   */
  dispose(): void {
    this.clearFlushTimer();
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
          reply_in_thread: shouldReplyInFeishuThread({
            threadId: this.threadId,
            replyInThread: this.replyInThread,
          }),
        },
      });
    } else {
      resp = await client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: this.chatId, msg_type: 'interactive', content },
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
        } catch (err) {
          logger.warn(
            { err, chatId: this.chatId, finalState },
            'Progress card: failed to patch final state after creation race',
          );
        }
        return;
      }

      this.state = 'active';
      logger.info(
        { chatId: this.chatId, messageId: this.messageId },
        'Progress card created',
      );

      if (this.dirty) this.scheduleFlush();
    } catch (err) {
      if (this.state !== 'failed') this.state = 'error';
      throw err;
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
          { err, chatId: this.chatId, failCount: this.patchFailCount },
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
}

// ─── Progress Card Session Registry ──────────────────────────

interface ProgressSessionEntry {
  session: ProgressCardController;
  folder: string;
  sourceChannel: string;
}

const activeProgressSessions = new Map<string, ProgressSessionEntry>();

function restoreProgressSessionFromStore(
  stored: RestorableCardStoreEntry,
  clientResolver: () => lark.Client | undefined,
): void {
  const controller = new ProgressCardController({
    clientResolver,
    chatId: stored.chatId,
    replyToMsgId: stored.replyToMsgId,
    threadId: stored.threadId,
    replyInThread: stored.replyInThread,
    existingMessageId: stored.messageId,
    anchorFolder: stored.folder,
    anchorSourceChannel: stored.sourceChannel,
  });
  activeProgressSessions.set(stored.folder, {
    session: controller,
    folder: stored.folder,
    sourceChannel: stored.sourceChannel,
  });
}

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
 * Feed the Session's single card, wherever its first Feishu message anchored
 * it. Source channels affect replies, not execution progress ownership.
 */
export function feedProgressSessionsForFolder(
  folder: string,
  event: StreamEvent,
): void {
  activeProgressSessions.get(folder)?.session.feedEvent(event);
}

/**
 * Complete and reset all active progress sessions for the given folder.
 * Used between turns when the agent stays alive via IPC.
 */
export async function completeAndResetProgressSessionsForFolder(
  folder: string,
): Promise<void> {
  const entry = activeProgressSessions.get(folder);
  if (entry?.session.isActive()) {
    await entry.session.completeAndReset().catch(() => {});
  }
}

/**
 * Finalize the Session card without releasing its anchor. A later runtime for
 * the same Session reuses the same message.
 */
export async function finalizeProgressSessionsForFolder(
  folder: string,
  mode: 'complete' | 'abort' | 'fail',
  detail?: string,
): Promise<void> {
  const entry = activeProgressSessions.get(folder);
  if (!entry) return;
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

/** Delete the persistent Session card only when the Session itself is deleted. */
export async function deleteProgressSession(
  folder: string,
  clientResolver?: () => lark.Client | undefined,
): Promise<void> {
  const entry = activeProgressSessions.get(folder);
  if (entry) {
    await entry.session.forceCleanup('Session 已删除');
  } else {
    const stored = loadCardStore().find(
      (candidate) => candidate.folder === folder,
    );
    if (stored) {
      try {
        await clientResolver?.()?.im.v1.message.delete({
          path: { message_id: stored.messageId },
        });
      } catch {
        // The Session is being deleted, so a missing/unreachable card is fine.
      }
      removeFromCardStore(stored.messageId);
    }
  }
  unregisterProgressSession(folder);
}

export async function abortAllProgressSessions(
  reason = '服务维护中',
): Promise<void> {
  const aborts = [...activeProgressSessions.entries()].map(([folder, entry]) =>
    entry.session.abort(reason).catch((err) => {
      logger.debug({ err, folder }, 'Failed to suspend progress session');
    }),
  );
  await Promise.allSettled(aborts);
  // Shutdown releases in-memory controllers but preserves every persisted
  // anchor so restart can resume patching the same Feishu message.
  for (const entry of activeProgressSessions.values()) entry.session.dispose();
  activeProgressSessions.clear();
}
