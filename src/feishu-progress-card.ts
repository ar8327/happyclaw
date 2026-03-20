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
import { DATA_DIR } from './config.js';
import { logger } from './logger.js';
import type { StreamEvent } from './stream-event.types.js';

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

  logger.info(`Progress card: cleaning up ${entries.length} stale card(s) from previous process`);
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
      logger.info(`Progress card: deleted stale card | chatId=${entry.chatId} messageId=${entry.messageId}`);
    } catch {
      // Card may already be deleted — that's fine
    }
  }
  saveCardStore([]);
}

// ─── Types ────────────────────────────────────────────────────

type ProgressState = 'idle' | 'creating' | 'active' | 'completed' | 'aborted' | 'error';

export interface ProgressCardOptions {
  /** Pre-resolved client (used by im-channel adapter) */
  client?: lark.Client;
  /** Lazy client resolver — called when the card is actually created, avoiding race
   *  conditions when Feishu WebSocket hasn't reconnected yet after a restart. */
  clientResolver?: () => lark.Client | undefined;
  chatId: string;
  replyToMsgId?: string;
  /** Lazy resolver for reply-to message ID (may change between creation and first event) */
  replyToMsgIdResolver?: () => string | undefined;
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

// ─── Card Builder ─────────────────────────────────────────────

const MAX_LOG_ENTRIES = 15;

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${s % 60}s`;
}

function toolDisplayName(tool: { toolName: string; skillName?: string }): string {
  if (tool.skillName) return `技能 ${tool.skillName}`;
  return tool.toolName;
}

function formatAgentLabel(agent: { description: string; agentType?: string; agentName?: string }): string {
  const parts: string[] = [];
  // Show name or type as prefix if available
  if (agent.agentName) {
    parts.push(`[${agent.agentName}]`);
  } else if (agent.agentType) {
    parts.push(`[${agent.agentType}]`);
  }
  parts.push(agent.description.slice(0, 50));
  return parts.join(' ');
}

/** Format thinking text for display in the Feishu card.
 *  Shows the full text with blockquote formatting, preserving paragraph structure. */
function formatThinking(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  // Preserve paragraph breaks but collapse excessive whitespace
  return trimmed
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

interface CardData {
  activeTools: ActiveTool[];
  completedTools: CompletedTool[];
  isThinking: boolean;
  thinkingText: string;
  elapsedMs: number;
  state: 'active' | 'completed' | 'aborted';
  abortReason?: string;
  activeSubAgents: ActiveSubAgent[];
  completedSubAgents: CompletedSubAgent[];
}

function buildProgressCard(data: CardData): object {
  const {
    activeTools, completedTools, isThinking, thinkingText,
    elapsedMs, state, abortReason, activeSubAgents, completedSubAgents,
  } = data;
  const elements: Array<Record<string, unknown>> = [];

  // Elapsed time
  const statusEmoji = state === 'active' ? '⚡' : state === 'completed' ? '✅' : '⚠️';
  const statusLabel = state === 'active' ? '执行中' : state === 'completed' ? '完成' : (abortReason || '已中断');
  elements.push({
    tag: 'markdown',
    content: `${statusEmoji} **${statusLabel}** · ⏱ ${formatElapsed(elapsedMs)}`,
  });

  // Thinking indicator with full content
  if (isThinking && state === 'active') {
    const formatted = formatThinking(thinkingText);
    const thinkingContent = formatted
      ? `💭 正在思考...\n${formatted}`
      : '💭 正在思考...';
    elements.push({
      tag: 'markdown',
      content: thinkingContent,
    });
  }

  // Sub-agent section
  const agentLines: string[] = [];
  for (const a of completedSubAgents) {
    const label = formatAgentLabel(a);
    const summary = a.summary ? `: ${a.summary.slice(0, 60)}` : '';
    agentLines.push(`✅ 🤖 ${label}${summary} (${formatElapsed(a.duration)})`);
  }
  for (const a of activeSubAgents) {
    const label = formatAgentLabel(a);
    const elapsed = formatElapsed(Date.now() - a.startTime);
    const bgLabel = a.isBackground ? ' [后台]' : '';
    agentLines.push(`🔄 🤖 ${label}${bgLabel} (${elapsed})`);
  }

  if (agentLines.length > 0) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'markdown',
      content: '**子 Agent**\n' + agentLines.join('\n'),
    });
  }

  // Tool traces
  const traceLines: string[] = [];

  // Completed tools (last N)
  const recentCompleted = completedTools.slice(-MAX_LOG_ENTRIES);
  for (const t of recentCompleted) {
    const name = toolDisplayName(t);
    const summary = t.inputSummary ? ` \`${t.inputSummary.slice(0, 60)}\`` : '';
    traceLines.push(`✅ ${name}${summary} (${formatElapsed(t.duration)})`);
  }

  // Active tools
  for (const t of activeTools) {
    const name = toolDisplayName(t);
    const summary = t.inputSummary ? ` \`${t.inputSummary.slice(0, 60)}\`` : '';
    const elapsed = formatElapsed(Date.now() - t.startTime);
    traceLines.push(`🔧 ${name}${summary} (${elapsed})`);
  }

  if (traceLines.length > 0) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'markdown',
      content: traceLines.join('\n'),
    });
  }

  const headerTemplate = {
    active: 'wathet',
    completed: 'green',
    aborted: 'orange',
  };

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `${statusEmoji} Agent ${statusLabel}` },
      template: headerTemplate[state],
    },
    elements,
  };
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
  private readonly replyToMsgIdResolver?: () => string | undefined;

  constructor(opts: ProgressCardOptions) {
    this.client = opts.client;
    this.clientResolver = opts.clientResolver;
    this.chatId = opts.chatId;
    this.replyToMsgId = opts.replyToMsgId;
    this.replyToMsgIdResolver = opts.replyToMsgIdResolver;
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
        if (event.toolInputSummary) active.inputSummary = event.toolInputSummary;
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
        logger.warn({ err, chatId: this.chatId }, 'Progress card: create failed');
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
    if (prevState !== 'active' && prevState !== 'creating' && prevState !== 'aborted') {
      logger.info(`Progress card: complete() skipped | chatId=${this.chatId} state=${prevState}`);
      return;
    }
    this.state = 'completed';
    this.abortReason = undefined; // Clear any abort reason since we're completing successfully
    this.clearFlushTimer();

    if (this.messageId) {
      try {
        await this.patchCard('completed');
        logger.info(`Progress card: patched to completed | chatId=${this.chatId} messageId=${this.messageId}`);
        // Delete after 15s so user can see the "完成" state.
        // Capture messageId in closure — completeAndReset() nulls this.messageId.
        const msgId = this.messageId;
        this.deleteTimer = setTimeout(() => this.deleteCardById(msgId), 15000);
      } catch (err) {
        logger.warn({ err }, `Progress card: failed to patch completed | chatId=${this.chatId} messageId=${this.messageId}`);
      }
    } else {
      logger.info(`Progress card: complete() called but no messageId | chatId=${this.chatId} prevState=${prevState}`);
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

    // Don't patch the card to "aborted" — let the owning process decide the final
    // state via complete() or a real abort. The abort from registerProgressSession
    // is just a state marker, not a user-visible transition.
    if (this.messageId && reason !== '新的执行已开始') {
      try {
        await this.patchCard('aborted');
        logger.info(`Progress card: patched to aborted | chatId=${this.chatId} reason=${reason}`);
      } catch (err) {
        logger.warn({ err }, `Progress card: failed to patch aborted | chatId=${this.chatId}`);
      }
    }
  }

  /**
   * Force cleanup during shutdown — deletes the card regardless of current state.
   * Used by abortAllProgressSessions when the process is shutting down.
   */
  async forceCleanup(_reason: string): Promise<void> {
    this.clearFlushTimer();
    if (this.deleteTimer) {
      clearTimeout(this.deleteTimer);
      this.deleteTimer = null;
    }

    if (!this.messageId) return;

    // Just delete the card silently — no need to show "服务维护中" to the user
    try {
      await this.deleteCard();
      logger.info(`Progress card: force cleanup (deleted) | chatId=${this.chatId}`);
    } catch (err) {
      logger.warn({ err }, `Progress card: force cleanup failed | chatId=${this.chatId}`);
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
    this.dirty = false;
    this.abortReason = undefined;
    this.patchFailCount = 0;
    // Don't clear deleteTimer — let the completed card be deleted on its own schedule
  }

  /**
   * Dispose of active timers. The delete timer (post-completion cleanup)
   * is intentionally preserved so the card gets deleted after the delay.
   */
  dispose(): void {
    this.clearFlushTimer();
  }

  /** Build CardData snapshot for buildProgressCard. */
  private getCardData(state: 'active' | 'completed' | 'aborted'): CardData {
    return {
      activeTools: Array.from(this.activeTools.values()),
      completedTools: this.completedTools,
      isThinking: this.isThinking,
      thinkingText: this.thinkingText,
      elapsedMs: Date.now() - this.startedAt,
      state,
      abortReason: this.abortReason,
      activeSubAgents: Array.from(this.activeSubAgents.values()),
      completedSubAgents: this.completedSubAgents,
    };
  }

  // ─── Internal ───────────────────────────────────────────

  private async createCard(): Promise<void> {
    const client = this.resolveClient();
    if (!client) {
      logger.warn({ chatId: this.chatId }, 'Progress card: no lark client available (connection not ready?)');
      this.state = 'error';
      return;
    }

    const card = buildProgressCard(this.getCardData('active'));
    const content = JSON.stringify(card);

    try {
      const replyTo = this.replyToMsgId || this.replyToMsgIdResolver?.();
      let resp: any;
      if (replyTo) {
        resp = await client.im.message.reply({
          path: { message_id: replyTo },
          data: { content, msg_type: 'interactive' },
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
        logger.info({ chatId: this.chatId, finalState, messageId: this.messageId }, 'Progress card: state changed during creation, patching to final state');
        try {
          await this.patchCard(finalState);
          if (finalState === 'completed') {
            this.deleteTimer = setTimeout(() => this.deleteCard(), 15000);
          }
        } catch (err) {
          logger.warn({ err, chatId: this.chatId, finalState }, 'Progress card: failed to patch final state after creation race');
        }
        return;
      }

      this.state = 'active';
      logger.info({ chatId: this.chatId, messageId: this.messageId }, 'Progress card created');

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
        logger.debug({ err, chatId: this.chatId, failCount: this.patchFailCount }, 'Progress card: patch failed');
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

    const card = buildProgressCard(
      this.getCardData(displayState),
    );
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
      logger.info(`Progress card: deleted | chatId=${this.chatId} messageId=${messageId}`);
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
    if (entry.folder === folder && entry.session.isActive()) {
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
