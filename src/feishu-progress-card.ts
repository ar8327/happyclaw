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
  chatId: string;
  messageId: string;
  createdAt: number;
}

function loadCardStore(): CardStoreEntry[] {
  try {
    const data = fs.readFileSync(CARD_STORE_PATH, 'utf-8');
    return JSON.parse(data);
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

function addToCardStore(chatId: string, messageId: string): void {
  const entries = loadCardStore().filter((e) => e.chatId !== chatId);
  entries.push({ chatId, messageId, createdAt: Date.now() });
  saveCardStore(entries);
}

function removeFromCardStore(messageId: string): void {
  const entries = loadCardStore().filter((e) => e.messageId !== messageId);
  saveCardStore(entries);
}

/**
 * Clean up stale progress cards from a previous process.
 * Call this on startup after Feishu connections are established.
 */
export async function cleanupStaleProgressCards(
  clientResolver: () => lark.Client | undefined,
): Promise<void> {
  const entries = loadCardStore();
  if (entries.length === 0) return;

  logger.info(
    `Progress card: cleaning up ${entries.length} stale card(s) from previous process`,
  );
  const client = clientResolver();
  if (!client) {
    logger.warn('Progress card: no lark client for stale card cleanup');
    return;
  }

  for (const entry of entries) {
    try {
      await client.im.v1.message.delete({
        path: { message_id: entry.messageId },
      });
      logger.info(
        `Progress card: deleted stale card | chatId=${entry.chatId} messageId=${entry.messageId}`,
      );
    } catch {
      // Card may already be deleted — that's fine
    }
  }
  saveCardStore([]);
}

// ─── Types ────────────────────────────────────────────────────

type ProgressState =
  | 'idle'
  | 'creating'
  | 'active'
  | 'completed'
  | 'aborted'
  | 'error';

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
  private patchFailCount = 0;
  private readonly maxPatchFailures = 3;

  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private deleteTimer: ReturnType<typeof setTimeout> | null = null;
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

  /** Whether this session can still receive events (idle, creating, or active). */
  canReceiveEvents(): boolean {
    return this.state !== 'error' && this.state !== 'aborted';
  }

  /**
   * Feed a StreamEvent into the progress card.
   * Creates the card lazily on first thinking or tool_use_start event.
   */
  feedEvent(event: StreamEvent): void {
    const type = event.eventType;

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

    // Lazy creation: create card on first thinking or tool event
    if (this.dirty && this.state === 'idle') {
      this.state = 'creating';
      this.createCard().catch((err) => {
        logger.warn(
          { err, chatId: this.chatId },
          'Progress card: create failed',
        );
        this.state = 'error';
      });
    }

    if (this.dirty && this.state === 'active') {
      this.scheduleFlush();
    }
  }

  /**
   * Complete the progress card — patch to final "completed" state, then delete after delay.
   */
  async complete(): Promise<void> {
    const prevState = this.state;
    // Allow completion from 'aborted' state — the abort may have been triggered by
    // registerProgressSession when a new run starts for the same chatJid, but the
    // owning processGroupMessages still needs to finalize the card properly.
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
    this.clearFlushTimer();
    this.clearStopAction();

    if (this.messageId) {
      try {
        await this.patchCard('completed');
        logger.info(
          `Progress card: patched to completed | chatId=${this.chatId} messageId=${this.messageId}`,
        );
        // Delete after 15s so user can see the "完成" state.
        // Capture messageId in closure — completeAndReset() nulls this.messageId.
        const msgId = this.messageId;
        this.deleteTimer = setTimeout(() => this.deleteCardById(msgId), 15000);
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
    if (this.state === 'completed' || this.state === 'aborted') return;
    this.state = 'aborted';
    this.abortReason = reason;
    this.clearFlushTimer();
    this.clearStopAction();

    // Don't patch the card to "aborted" — let the owning process decide the final
    // state via complete() or a real abort. The abort from registerProgressSession
    // is just a state marker, not a user-visible transition.
    if (this.messageId && reason !== '新的执行已开始') {
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
   * Force cleanup during shutdown — deletes the card regardless of current state.
   * Used by abortAllProgressSessions when the process is shutting down.
   */
  async forceCleanup(_reason: string): Promise<void> {
    this.clearFlushTimer();
    this.clearStopAction();
    if (this.deleteTimer) {
      clearTimeout(this.deleteTimer);
      this.deleteTimer = null;
    }

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
   * Complete the current card and reset state so the controller can create a
   * fresh card on the next feedEvent().  Used between turns when the agent
   * stays alive via IPC — each turn gets its own card lifecycle.
   */
  async completeAndReset(): Promise<void> {
    await this.complete();
    // Reset tracking state so next feedEvent() starts a new card
    this.state = 'idle';
    this.messageId = null;
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
    this.patchFailCount = 0;
    this.registerStopAction();
    // Don't clear deleteTimer — let the completed card be deleted on its own schedule
  }

  /**
   * Dispose of active timers. The delete timer (post-completion cleanup)
   * is intentionally preserved so the card gets deleted after the delay.
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
  private getCardData(
    state: 'active' | 'completed' | 'aborted',
  ): ProgressCardRenderData {
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
      activeSubAgents: Array.from(this.activeSubAgents.values()),
      completedSubAgents: this.completedSubAgents,
      latestCommentary: this.latestCommentary || undefined,
      stopActionId: state === 'active' ? this.stopActionId : undefined,
    };
  }

  // ─── Internal ───────────────────────────────────────────

  private async createCard(): Promise<void> {
    const client = this.resolveClient();
    if (!client) {
      logger.warn(
        { chatId: this.chatId },
        'Progress card: no lark client available (connection not ready?)',
      );
      this.state = 'error';
      return;
    }

    const card = buildProgressCard(this.getCardData('active'));
    const content = JSON.stringify(card);

    try {
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

      // Persist to disk so it can be cleaned up after restart
      addToCardStore(this.chatId, this.messageId);

      // State may have changed during await (complete/abort called while creating)
      if (this.state !== 'creating') {
        const finalState = this.state as 'completed' | 'aborted';
        logger.info(
          { chatId: this.chatId, finalState, messageId: this.messageId },
          'Progress card: state changed during creation, patching to final state',
        );
        try {
          await this.patchCard(finalState);
          if (finalState === 'completed') {
            this.deleteTimer = setTimeout(() => this.deleteCard(), 15000);
          }
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
      this.state = 'error';
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

  private async patchCard(
    displayState: 'active' | 'completed' | 'aborted',
  ): Promise<void> {
    if (!this.messageId) return;
    const client = this.resolveClient();
    if (!client) return;

    const card = buildProgressCard(this.getCardData(displayState));
    const content = JSON.stringify(card);

    await client.im.v1.message.patch({
      path: { message_id: this.messageId },
      data: { content },
    });
  }

  private async deleteCard(): Promise<void> {
    if (!this.messageId) return;
    await this.deleteCardById(this.messageId);
  }

  private async deleteCardById(messageId: string): Promise<void> {
    const client = this.resolveClient();
    if (!client) return;
    try {
      await client.im.v1.message.delete({
        path: { message_id: messageId },
      });
      logger.info(
        `Progress card: deleted | chatId=${this.chatId} messageId=${messageId}`,
      );
    } catch {
      // Deletion is best-effort
    }
    removeFromCardStore(messageId);
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
}

const activeProgressSessions = new Map<string, ProgressSessionEntry>();

export function registerProgressSession(
  chatJid: string,
  session: ProgressCardController,
  folder: string,
): void {
  const existing = activeProgressSessions.get(chatJid);
  if (existing?.session.isActive()) {
    existing.session.abort('新的执行已开始').catch(() => {});
  }
  activeProgressSessions.set(chatJid, { session, folder });
}

export function unregisterProgressSession(chatJid: string): void {
  activeProgressSessions.delete(chatJid);
}

/**
 * Feed a stream event to ALL active progress sessions for the given folder.
 * Used so that IPC-injected Feishu chats also see progress while the agent runs.
 */
export function feedProgressSessionsForFolder(
  folder: string,
  event: StreamEvent,
): void {
  for (const entry of activeProgressSessions.values()) {
    // Use canReceiveEvents() instead of isActive() — feedEvent() is what
    // transitions from 'idle' to 'creating' (lazy init), so we must allow
    // events to reach idle cards, not just active ones.
    if (entry.folder === folder && entry.session.canReceiveEvents()) {
      entry.session.feedEvent(event);
    }
  }
}

/**
 * Complete and reset all active progress sessions for the given folder.
 * Used between turns when the agent stays alive via IPC.
 */
export async function completeAndResetProgressSessionsForFolder(
  folder: string,
): Promise<void> {
  for (const entry of activeProgressSessions.values()) {
    if (entry.folder === folder && entry.session.isActive()) {
      await entry.session.completeAndReset().catch(() => {});
    }
  }
}

/**
 * Complete or abort all progress sessions for a folder, then unregister them.
 * Called when the agent process exits.
 */
export async function finalizeProgressSessionsForFolder(
  folder: string,
  mode: 'complete' | 'abort',
  reason?: string,
): Promise<void> {
  const toRemove: string[] = [];
  for (const [chatJid, entry] of activeProgressSessions.entries()) {
    if (entry.folder !== folder) continue;
    if (mode === 'abort') {
      await entry.session.abort(reason).catch(() => {});
    } else {
      await entry.session.complete().catch(() => {});
    }
    entry.session.dispose();
    toRemove.push(chatJid);
  }
  for (const jid of toRemove) {
    activeProgressSessions.delete(jid);
  }
}

/**
 * Check if an active progress session exists for a chatJid.
 */
export function hasActiveProgressSession(chatJid: string): boolean {
  const entry = activeProgressSessions.get(chatJid);
  return !!entry?.session.isActive();
}

export async function abortAllProgressSessions(
  reason = '服务维护中',
): Promise<void> {
  const promises: Promise<void>[] = [];
  for (const [chatJid, entry] of activeProgressSessions.entries()) {
    // Force cleanup ALL sessions during shutdown, regardless of current state.
    // Sessions may be in 'aborted' state (from registry replacement) but their
    // Feishu card is still showing "执行中" and needs to be cleaned up.
    promises.push(
      entry.session.forceCleanup(reason).catch((err) => {
        logger.debug({ err, chatJid }, 'Failed to cleanup progress session');
      }),
    );
  }
  await Promise.allSettled(promises);
  activeProgressSessions.clear();
}
