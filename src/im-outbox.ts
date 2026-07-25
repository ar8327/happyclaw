import {
  claimReadyImOutbox,
  countFailedImOutbox,
  enqueueImOutbox,
  failImOutbox,
  markImOutboxDelivered,
  rescheduleImOutbox,
  type ImOutboxKind,
  type ImOutboxRecord,
} from './db.js';
import { imManager } from './im-manager.js';
import type { IMSendOptions } from './im-channel.js';
import { logger } from './logger.js';
import { getImFeishuConfig } from './runtime-config.js';

export type ImDeliveryPayload =
  | {
      text: string;
      localImagePaths?: string[];
      options?: IMSendOptions;
    }
  | {
      imageBase64: string;
      mimeType: string;
      caption?: string;
      fileName?: string;
      replyToMsgId?: string;
      threadId?: string;
      replyInThread?: boolean;
    }
  | {
      filePath: string;
      fileName: string;
      options?: IMSendOptions;
    };

const RETRY_DELAYS_MS = [
  1_000,
  5_000,
  30_000,
  2 * 60_000,
  10 * 60_000,
  30 * 60_000,
];

let wakeWorker: (() => void) | null = null;
let wakePending = false;
let running = false;
let stopRequested = false;

function notifyWorker(): void {
  wakePending = true;
  wakeWorker?.();
}

function waitForWork(ms: number): Promise<void> {
  if (wakePending) {
    wakePending = false;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      wakeWorker = null;
      resolve();
    }, ms);
    wakeWorker = () => {
      clearTimeout(timer);
      wakeWorker = null;
      wakePending = false;
      resolve();
    };
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPermanentFailure(error: unknown): boolean {
  const candidate = error as {
    response?: { status?: number; data?: { code?: number } };
    status?: number;
  };
  const status = candidate.response?.status ?? candidate.status;
  if (status === 429 || (status !== undefined && status >= 500)) return false;
  if (status !== undefined && status >= 400) return true;
  const message = errorText(error);
  return /invalid (chat|user|channel)|not authorized|permission denied|forbidden|unsupported channel|file not found/i.test(
    message,
  );
}

async function deliver(record: ImOutboxRecord): Promise<string | undefined> {
  const payload = JSON.parse(record.payload_json) as Record<string, unknown>;
  if (record.kind === 'text') {
    const options = (payload.options || {}) as IMSendOptions;
    const localImagePaths = Array.isArray(payload.localImagePaths)
      ? (payload.localImagePaths as string[])
      : undefined;
    const useStreamingCard =
      record.target_jid.startsWith('feishu:') &&
      getImFeishuConfig()?.streamingCard === true &&
      !localImagePaths?.length &&
      !options.urgent &&
      !options.cardExtraElements?.length;
    if (useStreamingCard) {
      const session = imManager.createStreamingSession(record.target_jid, {
        replyToMsgId: options.replyToMsgId,
        threadId: options.threadId,
        replyInThread: options.replyInThread,
        idempotencyKey: record.id,
        cardKit: true,
      });
      if (session) {
        return session.complete(String(payload.text || ''));
      }
    }
    return imManager.sendMessage(
      record.target_jid,
      String(payload.text || ''),
      localImagePaths,
      { ...options, idempotencyKey: record.id },
    );
  }
  if (record.kind === 'image') {
    await imManager.sendImage(
      record.target_jid,
      Buffer.from(String(payload.imageBase64 || ''), 'base64'),
      String(payload.mimeType || 'image/png'),
      typeof payload.caption === 'string' ? payload.caption : undefined,
      typeof payload.fileName === 'string' ? payload.fileName : undefined,
      typeof payload.replyToMsgId === 'string'
        ? payload.replyToMsgId
        : undefined,
      typeof payload.threadId === 'string' ? payload.threadId : undefined,
      record.id,
      payload.replyInThread === true,
    );
    return undefined;
  }
  if (record.kind === 'file') {
    await imManager.sendFile(
      record.target_jid,
      String(payload.filePath || ''),
      String(payload.fileName || ''),
      {
        ...((payload.options || {}) as IMSendOptions),
        idempotencyKey: record.id,
      },
    );
    return undefined;
  }
  throw new Error(`Unsupported IM outbox kind: ${record.kind}`);
}

export function enqueueImDelivery(input: {
  id: string;
  sourceChatJid: string;
  targetJid: string;
  kind: ImOutboxKind;
  payload: ImDeliveryPayload;
}): ImOutboxRecord {
  const record = enqueueImOutbox({
    id: input.id,
    sourceChatJid: input.sourceChatJid,
    targetJid: input.targetJid,
    kind: input.kind,
    payload: input.payload as unknown as Record<string, unknown>,
  });
  notifyWorker();
  return record;
}

export function startImOutboxWorker(options?: {
  onDelivered?: (record: ImOutboxRecord, externalId?: string) => void;
  onPermanentFailure?: (record: ImOutboxRecord, error: string) => void;
}): void {
  if (running) return;
  running = true;
  stopRequested = false;

  const failedAtStartup = countFailedImOutbox();
  if (failedAtStartup > 0) {
    logger.warn(
      { failedAtStartup },
      'IM outbox contains permanently failed deliveries',
    );
  }

  void (async () => {
    while (!stopRequested) {
      const records = claimReadyImOutbox(10);
      if (records.length === 0) {
        await waitForWork(500);
        continue;
      }
      await Promise.all(
        records.map(async (record) => {
          try {
            const externalId = await deliver(record);
            markImOutboxDelivered(record.id, externalId);
            options?.onDelivered?.(record, externalId);
          } catch (error) {
            const attempts = record.attempts + 1;
            const message = errorText(error);
            const permanent =
              isPermanentFailure(error) || attempts > RETRY_DELAYS_MS.length;
            if (permanent) {
              failImOutbox(record.id, attempts, message);
              logger.error(
                {
                  outboxId: record.id,
                  targetJid: record.target_jid,
                  attempts,
                  error: message,
                },
                'IM outbox delivery failed permanently',
              );
              options?.onPermanentFailure?.(record, message);
              return;
            }
            const delay =
              RETRY_DELAYS_MS[
                Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)
              ];
            rescheduleImOutbox(
              record.id,
              attempts,
              Date.now() + delay,
              message,
            );
            logger.warn(
              {
                outboxId: record.id,
                targetJid: record.target_jid,
                attempts,
                delay,
                error: message,
              },
              'IM outbox delivery scheduled for retry',
            );
          }
        }),
      );
    }
    running = false;
  })();
}

export function stopImOutboxWorker(): void {
  stopRequested = true;
  notifyWorker();
}
