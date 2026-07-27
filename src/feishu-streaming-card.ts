/**
 * Feishu CardKit streaming reply controller.
 *
 * CardKit receives cumulative content and computes its own delta. Every
 * CardKit mutation is serialized and uses one strictly increasing sequence.
 * If CardKit is unavailable, the controller falls back to the JSON 2.0
 * whole-card patch path so callers still get a usable reply.
 */
import * as lark from '@larksuiteoapi/node-sdk';
import { randomUUID } from 'node:crypto';
import { logger } from './logger.js';
import { shouldReplyInFeishuThread } from './feishu-conversation-mode.js';
import {
  buildCardKitStreamingCard,
  buildStaticReplyCard,
  STREAMING_CONTENT_ELEMENT_ID,
  STREAMING_PRINT_FREQUENCY_MS,
  STREAMING_PRINT_STEP,
} from './feishu-card-builder.js';

type StreamingState =
  | 'idle'
  | 'creating'
  | 'streaming'
  | 'completed'
  | 'aborted'
  | 'error';

export interface StreamingCardOptions {
  client: lark.Client;
  chatId: string;
  replyToMsgId?: string;
  threadId?: string;
  replyInThread?: boolean;
  idempotencyKey?: string;
  /** Force the whole-card JSON 2.0 patch transport. */
  cardKit?: boolean;
  onFallback?: () => void;
}

interface CardKitResponse {
  code?: number;
  msg?: string;
  data?: { card_id?: string; message_id?: string };
}

const STREAM_RENEW_MS = 100_000;

function mergeCumulativeText(previous: string, next: string): string {
  if (!next) return previous;
  if (!previous || next === previous || next.startsWith(previous)) return next;
  if (previous.startsWith(next)) return previous;
  return `${previous}${next}`;
}

function assertLarkSuccess(response: CardKitResponse, operation: string): void {
  if (typeof response.code === 'number' && response.code !== 0) {
    throw new Error(
      `${operation} failed (${response.code}): ${response.msg || 'unknown error'}`,
    );
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class StreamingCardController {
  private state: StreamingState = 'idle';
  private cardId: string | null = null;
  private messageId: string | null = null;
  private accumulatedText = '';
  private sequence = 0;
  private operationQueue: Promise<void> = Promise.resolve();
  private renewalTimer: ReturnType<typeof setTimeout> | null = null;
  private legacyPatch = false;
  private fallbackNotified = false;

  private readonly client: lark.Client;
  private readonly chatId: string;
  private readonly replyToMsgId?: string;
  private readonly threadId?: string;
  private readonly replyInThread?: boolean;
  private readonly idempotencyKey?: string;
  private readonly cardKit: boolean;
  private readonly onFallback?: () => void;

  constructor(opts: StreamingCardOptions) {
    this.client = opts.client;
    this.chatId = opts.chatId;
    this.replyToMsgId = opts.replyToMsgId;
    this.threadId = opts.threadId;
    this.replyInThread = opts.replyInThread;
    this.idempotencyKey = opts.idempotencyKey;
    this.cardKit = opts.cardKit !== false;
    this.legacyPatch = !this.cardKit;
    this.onFallback = opts.onFallback;
  }

  get currentState(): StreamingState {
    return this.state;
  }

  get externalMessageId(): string | undefined {
    return this.messageId || undefined;
  }

  isActive(): boolean {
    return this.state === 'streaming' || this.state === 'creating';
  }

  append(text: string): void {
    if (
      this.state === 'completed' ||
      this.state === 'aborted' ||
      this.state === 'error'
    ) {
      return;
    }
    this.accumulatedText = mergeCumulativeText(this.accumulatedText, text);
    void this.enqueue(async () => {
      await this.ensureCreated();
      await this.updateContent('streaming');
    }).catch((err) => this.fail(err));
  }

  /**
   * Publish final cumulative text, let native typewriter rendering catch up,
   * then close streaming mode. The wait is capped below CardKit's 120s lease;
   * a 100s close/reopen renewal covers exceptionally long content.
   */
  async complete(finalText: string): Promise<string | undefined> {
    if (this.state === 'completed') return this.externalMessageId;
    if (this.state === 'aborted') return this.externalMessageId;
    this.accumulatedText = finalText;

    await this.enqueue(async () => {
      await this.ensureCreated();
      try {
        await this.updateContent('streaming');
      } catch (err) {
        // The initial card entity already contains finalText. A failed
        // incremental refresh must not make the durable outbox resend the
        // successfully-created IM message.
        logger.warn(
          { err, chatId: this.chatId },
          'Streaming card content refresh failed; initial content is still visible',
        );
      }
    });

    if (!this.legacyPatch) {
      const estimatedPrintMs = Math.ceil(
        (Math.max(1, finalText.length) / STREAMING_PRINT_STEP) *
          STREAMING_PRINT_FREQUENCY_MS,
      );
      await wait(Math.min(110_000, Math.max(600, estimatedPrintMs + 250)));
    }

    await this.enqueue(async () => {
      try {
        if (this.legacyPatch) {
          await this.patchLegacyCard('completed');
        } else {
          await this.finalizeCardKit('completed');
        }
      } catch (err) {
        logger.warn(
          { err, chatId: this.chatId },
          'Streaming card finalization failed after visible delivery',
        );
      }
      this.state = 'completed';
      this.clearRenewalTimer();
    });
    return this.externalMessageId;
  }

  async abort(reason?: string): Promise<void> {
    if (this.state === 'completed' || this.state === 'aborted') return;
    if (reason) {
      this.accumulatedText = `${this.accumulatedText}${this.accumulatedText ? '\n\n' : ''}*${reason}*`;
    }

    await this.enqueue(async () => {
      if (this.state === 'idle' && !this.accumulatedText) {
        this.state = 'aborted';
        return;
      }
      await this.ensureCreated();
      if (this.legacyPatch) {
        await this.patchLegacyCard('aborted');
      } else {
        await this.updateCardKitContent();
        await this.finalizeCardKit('aborted');
      }
      this.state = 'aborted';
      this.clearRenewalTimer();
    }).catch((err) => this.fail(err));
  }

  dispose(): void {
    this.clearRenewalTimer();
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.operationQueue.then(operation, operation);
    this.operationQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private nextSequence(): number {
    this.sequence += 1;
    return this.sequence;
  }

  private async ensureCreated(): Promise<void> {
    if (this.messageId) return;
    this.state = 'creating';

    if (!this.legacyPatch) {
      try {
        await this.createCardKitMessage();
        this.state = 'streaming';
        this.scheduleRenewal();
        return;
      } catch (err) {
        logger.warn(
          { err, chatId: this.chatId },
          'CardKit create failed, falling back to whole-card patch transport',
        );
        this.legacyPatch = true;
        if (!this.fallbackNotified) {
          this.fallbackNotified = true;
          this.onFallback?.();
        }
      }
    }

    await this.createLegacyMessage();
    this.state = 'streaming';
  }

  private async createCardKitMessage(): Promise<void> {
    const card = buildCardKitStreamingCard(
      this.accumulatedText.trim() || '...',
    );
    const created = (await this.client.cardkit.v1.card.create({
      data: {
        type: 'card_json',
        data: JSON.stringify(card),
      },
    })) as CardKitResponse;
    assertLarkSuccess(created, 'cardkit.card.create');
    this.cardId = created.data?.card_id || null;
    if (!this.cardId) throw new Error('CardKit create returned no card_id');

    const content = JSON.stringify({
      type: 'card',
      data: { card_id: this.cardId },
    });
    const sent = await this.sendInteractiveContent(content);
    this.messageId = sent?.data?.message_id || null;
    if (!this.messageId) {
      throw new Error('Sending CardKit card returned no message_id');
    }
  }

  private async createLegacyMessage(): Promise<void> {
    const content = JSON.stringify(
      buildStaticReplyCard(this.accumulatedText || '...', 'streaming'),
    );
    const sent = await this.sendInteractiveContent(content);
    this.messageId = sent?.data?.message_id || null;
    if (!this.messageId) {
      throw new Error('Sending fallback card returned no message_id');
    }
  }

  private sendInteractiveContent(content: string): Promise<any> {
    if (this.replyToMsgId) {
      return this.client.im.message.reply({
        path: { message_id: this.replyToMsgId },
        data: {
          content,
          msg_type: 'interactive',
          uuid: this.idempotencyKey,
          reply_in_thread: shouldReplyInFeishuThread({
            threadId: this.threadId,
            replyInThread: this.replyInThread,
          }),
        },
      });
    }
    return this.client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: this.chatId,
        msg_type: 'interactive',
        content,
        uuid: this.idempotencyKey,
      },
    });
  }

  private async updateContent(
    state: 'streaming' | 'completed' | 'aborted',
  ): Promise<void> {
    if (this.legacyPatch) {
      await this.patchLegacyCard(state);
      return;
    }
    await this.updateCardKitContent();
  }

  private async updateCardKitContent(): Promise<void> {
    if (!this.cardId) return;
    const sequence = this.nextSequence();
    const response = (await this.client.cardkit.v1.cardElement.content({
      path: {
        card_id: this.cardId,
        element_id: STREAMING_CONTENT_ELEMENT_ID,
      },
      data: {
        // CardKit expects the full cumulative content and derives the delta.
        content: this.accumulatedText || '...',
        sequence,
        uuid: randomUUID(),
      },
    })) as CardKitResponse;
    assertLarkSuccess(response, 'cardkit.cardElement.content');
  }

  private async setStreamingMode(enabled: boolean): Promise<void> {
    if (!this.cardId) return;
    const sequence = this.nextSequence();
    const response = (await this.client.cardkit.v1.card.settings({
      path: { card_id: this.cardId },
      data: {
        settings: JSON.stringify({ streaming_mode: enabled }),
        sequence,
        uuid: randomUUID(),
      },
    })) as CardKitResponse;
    assertLarkSuccess(response, 'cardkit.card.settings');
  }

  /**
   * Replace the streaming entity with a final static Card 2.0 payload. Closing
   * only `streaming_mode` leaves the entity's original summary ("回复生成中")
   * behind in the chat list. A full CardKit update both closes streaming and
   * publishes the final summary/header, restoring normal forwarding behavior.
   */
  private async finalizeCardKit(state: 'completed' | 'aborted'): Promise<void> {
    if (!this.cardId) return;

    const finalCard = buildStaticReplyCard(this.accumulatedText, state);
    try {
      // CardKit documents settings(false) as the explicit end-of-stream
      // signal. Do this even though the following static payload also
      // declares streaming_mode=false so Feishu releases streaming-only
      // restrictions (notably forwarding) before we refresh the preview.
      await this.setStreamingMode(false);

      const sequence = this.nextSequence();
      const response = (await this.client.cardkit.v1.card.update({
        path: { card_id: this.cardId },
        data: {
          card: {
            type: 'card_json',
            data: JSON.stringify(finalCard),
          },
          sequence,
          uuid: randomUUID(),
        },
      })) as CardKitResponse;
      assertLarkSuccess(response, 'cardkit.card.update');
    } catch (err) {
      // The message already exists. Fall back to replacing that exact message
      // with an inline static card rather than letting the durable outbox send
      // a duplicate reply or leaving the stale "回复生成中" summary behind.
      logger.warn(
        { err, chatId: this.chatId, messageId: this.messageId },
        'CardKit final static update failed, falling back to message patch',
      );
      if (!this.messageId) throw err;
      await this.client.im.v1.message.patch({
        path: { message_id: this.messageId },
        data: { content: JSON.stringify(finalCard) },
      });
    }
  }

  private async patchLegacyCard(
    state: 'streaming' | 'completed' | 'aborted',
  ): Promise<void> {
    if (!this.messageId) return;
    await this.client.im.v1.message.patch({
      path: { message_id: this.messageId },
      data: {
        content: JSON.stringify(
          buildStaticReplyCard(this.accumulatedText, state),
        ),
      },
    });
  }

  private scheduleRenewal(): void {
    this.clearRenewalTimer();
    this.renewalTimer = setTimeout(() => {
      if (this.state !== 'streaming' || this.legacyPatch) return;
      void this.enqueue(async () => {
        // CardKit streaming leases are about 120 seconds. Close and reopen
        // before expiry using the same global sequence to continue safely.
        await this.setStreamingMode(false);
        await this.setStreamingMode(true);
        this.scheduleRenewal();
      }).catch((err) => this.fail(err));
    }, STREAM_RENEW_MS);
    this.renewalTimer.unref?.();
  }

  private clearRenewalTimer(): void {
    if (this.renewalTimer) {
      clearTimeout(this.renewalTimer);
      this.renewalTimer = null;
    }
  }

  private fail(error: unknown): void {
    this.clearRenewalTimer();
    this.state = 'error';
    logger.warn({ error, chatId: this.chatId }, 'Streaming card failed');
  }
}

const activeSessions = new Map<string, StreamingCardController>();

export function registerStreamingSession(
  chatJid: string,
  session: StreamingCardController,
): void {
  const existing = activeSessions.get(chatJid);
  if (existing?.isActive()) {
    void existing.abort('新的回复已开始');
  }
  activeSessions.set(chatJid, session);
}

export function unregisterStreamingSession(chatJid: string): void {
  activeSessions.delete(chatJid);
}

export function getStreamingSession(
  chatJid: string,
): StreamingCardController | undefined {
  return activeSessions.get(chatJid);
}

export function hasActiveStreamingSession(chatJid: string): boolean {
  return activeSessions.get(chatJid)?.isActive() ?? false;
}

export async function abortAllStreamingSessions(
  reason = '服务维护中',
): Promise<void> {
  const pending = Array.from(activeSessions.entries()).map(
    async ([chatJid, session]) => {
      try {
        await session.abort(reason);
      } catch (err) {
        logger.debug({ err, chatJid }, 'Failed to abort streaming card');
      }
    },
  );
  await Promise.allSettled(pending);
  activeSessions.clear();
}
