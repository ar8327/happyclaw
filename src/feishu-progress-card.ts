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
import { logger } from './logger.js';
import type { StreamEvent } from './stream-event.types.js';

// ─── Types ────────────────────────────────────────────────────

type ProgressState = 'idle' | 'creating' | 'active' | 'completed' | 'aborted' | 'error';

export interface ProgressCardOptions {
  client: lark.Client;
  chatId: string;
  replyToMsgId?: string;
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

function truncateThinking(text: string, maxLen = 120): string {
  // Take the last portion of thinking text to show the most recent reasoning
  const trimmed = text.trim();
  if (!trimmed) return '';
  const lastChunk = trimmed.length > maxLen ? '...' + trimmed.slice(-maxLen) : trimmed;
  // Collapse newlines for compact display
  return lastChunk.replace(/\n+/g, ' ').trim();
}

function buildProgressCard(
  activeTools: ActiveTool[],
  completedTools: CompletedTool[],
  isThinking: boolean,
  thinkingText: string,
  elapsedMs: number,
  state: 'active' | 'completed' | 'aborted',
  abortReason?: string,
): object {
  const elements: Array<Record<string, unknown>> = [];

  // Elapsed time
  const statusEmoji = state === 'active' ? '⚡' : state === 'completed' ? '✅' : '⚠️';
  const statusLabel = state === 'active' ? '执行中' : state === 'completed' ? '完成' : (abortReason || '已中断');
  elements.push({
    tag: 'markdown',
    content: `${statusEmoji} **${statusLabel}** · ⏱ ${formatElapsed(elapsedMs)}`,
  });

  // Thinking indicator with content preview
  if (isThinking && state === 'active') {
    const preview = truncateThinking(thinkingText);
    const thinkingContent = preview
      ? `💭 正在思考...\n> ${preview}`
      : '💭 正在思考...';
    elements.push({
      tag: 'markdown',
      content: thinkingContent,
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

  private readonly client: lark.Client;
  private readonly chatId: string;
  private readonly replyToMsgId?: string;

  constructor(opts: ProgressCardOptions) {
    this.client = opts.client;
    this.chatId = opts.chatId;
    this.replyToMsgId = opts.replyToMsgId;
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
    if (this.state !== 'active' && this.state !== 'creating') return;
    this.state = 'completed';
    this.clearFlushTimer();

    if (this.messageId) {
      try {
        await this.patchCard('completed');
        // Delete after 5s to reduce clutter (the actual reply follows)
        this.deleteTimer = setTimeout(() => this.deleteCard(), 5000);
      } catch {
        // ignore
      }
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

    if (this.messageId) {
      try {
        await this.patchCard('aborted');
      } catch {
        // ignore
      }
    }
  }

  /**
   * Dispose of active timers. The delete timer (post-completion cleanup)
   * is intentionally preserved so the card gets deleted after the delay.
   */
  dispose(): void {
    this.clearFlushTimer();
  }

  // ─── Internal ───────────────────────────────────────────

  private async createCard(): Promise<void> {
    const card = buildProgressCard(
      Array.from(this.activeTools.values()),
      this.completedTools,
      this.isThinking,
      this.thinkingText,
      Date.now() - this.startedAt,
      'active',
    );
    const content = JSON.stringify(card);

    try {
      let resp: any;
      if (this.replyToMsgId) {
        resp = await this.client.im.message.reply({
          path: { message_id: this.replyToMsgId },
          data: { content, msg_type: 'interactive' },
        });
      } else {
        resp = await this.client.im.v1.message.create({
          params: { receive_id_type: 'chat_id' },
          data: { receive_id: this.chatId, msg_type: 'interactive', content },
        });
      }

      this.messageId = resp?.data?.message_id || null;
      if (!this.messageId) throw new Error('No message_id in response');

      // State may have changed during await (complete/abort called while creating)
      if (this.state !== 'creating') {
        const finalState = this.state as 'completed' | 'aborted';
        try {
          await this.patchCard(finalState);
          if (finalState === 'completed') {
            this.deleteTimer = setTimeout(() => this.deleteCard(), 5000);
          }
        } catch { /* ignore */ }
        return;
      }

      this.state = 'active';
      logger.debug({ chatId: this.chatId, messageId: this.messageId }, 'Progress card created');

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

    const card = buildProgressCard(
      Array.from(this.activeTools.values()),
      this.completedTools,
      this.isThinking,
      this.thinkingText,
      Date.now() - this.startedAt,
      displayState,
      this.abortReason,
    );
    const content = JSON.stringify(card);

    await this.client.im.v1.message.patch({
      path: { message_id: this.messageId },
      data: { content },
    });
  }

  private async deleteCard(): Promise<void> {
    if (!this.messageId) return;
    try {
      await this.client.im.v1.message.delete({
        path: { message_id: this.messageId },
      });
    } catch {
      // Deletion is best-effort
    }
  }

  private clearFlushTimer(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }
}

// ─── Progress Card Session Registry ──────────────────────────

const activeProgressSessions = new Map<string, ProgressCardController>();

export function registerProgressSession(
  chatJid: string,
  session: ProgressCardController,
): void {
  const existing = activeProgressSessions.get(chatJid);
  if (existing?.isActive()) {
    existing.abort('新的执行已开始').catch(() => {});
  }
  activeProgressSessions.set(chatJid, session);
}

export function unregisterProgressSession(chatJid: string): void {
  activeProgressSessions.delete(chatJid);
}

export async function abortAllProgressSessions(
  reason = '服务维护中',
): Promise<void> {
  const promises: Promise<void>[] = [];
  for (const [chatJid, session] of activeProgressSessions.entries()) {
    if (session.isActive()) {
      promises.push(
        session.abort(reason).catch((err) => {
          logger.debug({ err, chatJid }, 'Failed to abort progress session');
        }),
      );
    }
    session.dispose();
  }
  await Promise.allSettled(promises);
  activeProgressSessions.clear();
}
