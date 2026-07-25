/**
 * Turn Manager: routes incoming messages into turns by channel ownership.
 *
 * A Turn is a batch of messages from the same channel + the Agent's processing/reply.
 * Messages from different channels queue up and wait for the current Turn to complete.
 */

import crypto from 'crypto';
import { insertTurn, updateTurn, markStaleTurnsAsError } from './db.js';
import { logger } from './logger.js';

export interface ActiveTurn {
  id: string;
  folder: string;
  chatJid: string;
  channel: string;
  messageIds: string[];
  startedAt: number;
  lastInjectedAt: number;
}

export interface QueuedTurnEntry {
  chatJid: string;
  channel: string;
  queuedAt: number;
}

export type RouteResult =
  | { action: 'start_new'; turnId: string }
  | { action: 'inject'; turnId: string }
  | { action: 'queue'; needsDrain: boolean }
  | { action: 'already_queued' };

export class TurnManager {
  private activeTurns = new Map<string, ActiveTurn>(); // folder → active turn
  private pendingQueue = new Map<string, QueuedTurnEntry[]>(); // folder → FIFO
  private handoffInFlight = new Set<string>();
  private readonly queueWarnLimit = 100;
  private readonly queueTtlMs = 10 * 60_000;

  /**
   * Route an incoming message to the appropriate action.
   *
   * @param folder - The group folder (serialization key)
   * @param chatJid - The chat JID for this message batch
   * @param channel - The source channel (e.g. feishu:oc_xxx, web:main)
   * @param messageIds - IDs of the messages being routed
   */
  routeMessage(
    folder: string,
    chatJid: string,
    channel: string,
    messageIds: string[],
  ): RouteResult {
    const active = this.activeTurns.get(folder);

    if (!active) {
      this.handoffInFlight.delete(folder);
      // No active turn → create new
      const turnId = crypto.randomUUID();
      const now = Date.now();
      const turn: ActiveTurn = {
        id: turnId,
        folder,
        chatJid,
        channel,
        messageIds: [...messageIds],
        startedAt: now,
        lastInjectedAt: now,
      };
      this.activeTurns.set(folder, turn);

      // Persist to DB
      try {
        insertTurn({
          id: turnId,
          chat_jid: chatJid,
          channel,
          message_ids: JSON.stringify(messageIds),
          started_at: new Date(now).toISOString(),
          status: 'running',
          group_folder: folder,
        });
      } catch (err) {
        logger.warn({ err, turnId }, 'Failed to persist turn to DB');
      }

      return { action: 'start_new', turnId };
    }

    // Active turn exists — same-channel messages stay with its runtime.
    const now = Date.now();
    const sameChannel = active.channel === channel;

    if (sameChannel) {
      // An active same-channel runtime always owns follow-up delivery.  Its
      // runner decides whether to steer immediately or buffer for the next
      // provider turn; routing must not force a process restart.
      active.lastInjectedAt = now;
      active.messageIds.push(...messageIds);

      // Update DB
      try {
        updateTurn(active.id, {
          message_ids: JSON.stringify(active.messageIds),
        });
      } catch (err) {
        logger.warn({ err, turnId: active.id }, 'Failed to update turn in DB');
      }

      return { action: 'inject', turnId: active.id };
    }

    // Different channel → queue.  Cross-channel drain preserves the explicit
    // Session routing boundary.
    const queue = this.getQueue(folder);
    const alreadyQueued = queue.some((q) => q.chatJid === chatJid);
    if (alreadyQueued) {
      return { action: 'already_queued' };
    }

    queue.push({
      chatJid,
      channel,
      queuedAt: now,
    });
    if (queue.length > this.queueWarnLimit) {
      logger.warn(
        { folder, queueLength: queue.length, limit: this.queueWarnLimit },
        'Turn pending queue exceeded warning limit',
      );
    }

    return { action: 'queue', needsDrain: true };
  }

  /**
   * Mark the current turn as completed.
   */
  completeTurn(
    folder: string,
    opts?: {
      resultMessageId?: string;
      summary?: string;
      tokenUsage?: Record<string, unknown>;
      traceFile?: string;
    },
  ): void {
    const active = this.activeTurns.get(folder);
    if (!active) return;

    try {
      updateTurn(active.id, {
        completed_at: new Date().toISOString(),
        status: 'completed',
        result_message_id: opts?.resultMessageId,
        summary: opts?.summary?.slice(0, 200),
        token_usage: opts?.tokenUsage
          ? JSON.stringify(opts.tokenUsage)
          : undefined,
        trace_file: opts?.traceFile,
      });
    } catch (err) {
      logger.warn(
        { err, turnId: active.id },
        'Failed to update turn completion in DB',
      );
    }

    this.activeTurns.delete(folder);
  }

  /**
   * Mark the current turn as failed.
   */
  failTurn(folder: string, error?: string): void {
    const active = this.activeTurns.get(folder);
    if (!active) return;

    try {
      updateTurn(active.id, {
        completed_at: new Date().toISOString(),
        status: 'error',
        summary: error?.slice(0, 200),
      });
    } catch (err) {
      logger.warn(
        { err, turnId: active.id },
        'Failed to update turn failure in DB',
      );
    }

    this.activeTurns.delete(folder);
  }

  /**
   * Mark the current turn as interrupted (e.g. user sent stop).
   */
  interruptTurn(folder: string): void {
    const active = this.activeTurns.get(folder);
    if (!active) return;

    try {
      updateTurn(active.id, {
        completed_at: new Date().toISOString(),
        status: 'interrupted',
      });
    } catch (err) {
      logger.warn(
        { err, turnId: active.id },
        'Failed to update turn interruption in DB',
      );
    }

    this.activeTurns.delete(folder);
  }

  /**
   * Get the next queued entry for a folder (FIFO).
   * Returns null if nothing is queued.
   */
  drainNext(folder: string): QueuedTurnEntry | null {
    const queue = this.pendingQueue.get(folder);
    if (!queue || queue.length === 0) return null;
    return queue.shift()!;
  }

  /**
   * Claim exactly one pending entry for the next runtime. Repeated terminal
   * callbacks are idempotent until routeMessage starts that claimed turn.
   */
  handoffNext(folder: string): QueuedTurnEntry | null {
    if (this.handoffInFlight.has(folder)) return null;
    const next = this.drainNext(folder);
    if (!next) return null;
    this.handoffInFlight.add(folder);
    if (Date.now() - next.queuedAt > this.queueTtlMs) {
      logger.warn(
        {
          folder,
          chatJid: next.chatJid,
          queuedForMs: Date.now() - next.queuedAt,
        },
        'Turn handoff exceeded pending queue TTL',
      );
    }
    return next;
  }

  hasHandoffInFlight(folder: string): boolean {
    return this.handoffInFlight.has(folder);
  }

  getPendingFolders(): string[] {
    return [...this.pendingQueue.entries()]
      .filter(([, entries]) => entries.length > 0)
      .map(([folder]) => folder);
  }

  /**
   * Get the current active turn for a folder, if any.
   */
  getActiveTurn(folder: string): ActiveTurn | null {
    return this.activeTurns.get(folder) || null;
  }

  /**
   * Get pending message counts per channel for a folder.
   */
  getPendingCounts(folder: string): Map<string, number> {
    const result = new Map<string, number>();
    const queue = this.pendingQueue.get(folder);
    if (!queue) return result;
    for (const entry of queue) {
      result.set(entry.channel, (result.get(entry.channel) || 0) + 1);
    }
    return result;
  }

  /**
   * Check if a chatJid is already in the pending queue for a folder.
   */
  isQueued(folder: string, chatJid: string): boolean {
    const queue = this.pendingQueue.get(folder);
    if (!queue) return false;
    return queue.some((q) => q.chatJid === chatJid);
  }

  /**
   * Startup recovery: clear in-memory state and mark DB turns as error.
   */
  recoverOnStartup(): void {
    this.activeTurns.clear();
    this.pendingQueue.clear();
    this.handoffInFlight.clear();
    try {
      cleanupStaleTurns();
    } catch (err) {
      logger.warn({ err }, 'Failed to recover turns on startup');
    }
  }

  private getQueue(folder: string): QueuedTurnEntry[] {
    let queue = this.pendingQueue.get(folder);
    if (!queue) {
      queue = [];
      this.pendingQueue.set(folder, queue);
    }
    return queue;
  }
}

/**
 * Mark all running turns as error (crash recovery).
 * Called from recoverOnStartup() via the DB function markStaleTurnsAsError.
 */
function cleanupStaleTurns(): void {
  try {
    markStaleTurnsAsError();
  } catch {
    // DB function may not be available yet during init
  }
}
