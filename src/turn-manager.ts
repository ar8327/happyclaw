/**
 * Turn Manager: routes incoming messages into Turns based on channel + time window.
 *
 * A Turn is a batch of messages from the same channel + the Agent's processing/reply.
 * Messages from different channels queue up and wait for the current Turn to complete.
 */

import crypto from 'crypto';
import { insertTurn, updateTurn, markStaleTurnsAsError } from './db.js';
import { getSystemSettings } from './runtime-config.js';
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

    // Active turn exists — check if same channel and within window
    const now = Date.now();
    const settings = getSystemSettings();
    const batchWindow = settings.turnBatchWindowMs;
    const maxBatch = settings.turnMaxBatchMs;

    const sameChannel = active.channel === channel;
    const withinWindow = now - active.lastInjectedAt < batchWindow;
    const withinMax = now - active.startedAt < maxBatch;

    if (sameChannel && withinWindow && withinMax) {
      // Same channel, within time window → inject into current turn
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

    // Different channel or outside window → queue
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

    // needsDrain: only if the active turn is from a different channel or window expired
    // This signals the caller to write a _drain sentinel
    const needsDrain = !sameChannel || !withinWindow || !withinMax;
    return { action: 'queue', needsDrain };
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
