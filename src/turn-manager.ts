/**
 * Turn Manager: routes incoming messages into turns by Session ownership.
 *
 * A Turn is a batch of messages handled by the same Session runtime. Source
 * channels remain delivery metadata, but never split execution inside a Session.
 */

import crypto from 'crypto';
import { insertTurn, updateTurn, type TurnRow } from './db.js';
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

    // Active turn exists — every message bound to this Session stays with its
    // runtime, regardless of whether it came from Web, IM, or a scheduled task.
    // Reply routing is carried independently by each delivery.
    const now = Date.now();
    active.lastInjectedAt = now;
    active.messageIds.push(...messageIds);

    try {
      updateTurn(active.id, {
        message_ids: JSON.stringify(active.messageIds),
      });
    } catch (err) {
      logger.warn({ err, turnId: active.id }, 'Failed to update turn in DB');
    }

    return { action: 'inject', turnId: active.id };
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
   * Keep an unfinished turn resumable across either a graceful restart or a
   * retryable runtime failure. Unlike failTurn(), this does not set a terminal
   * completion timestamp.
   */
  markRecoverable(folder: string, detail?: string): void {
    const active = this.activeTurns.get(folder);
    if (!active) return;
    try {
      updateTurn(active.id, {
        status: 'recoverable',
        summary: detail?.slice(0, 200),
      });
    } catch (err) {
      logger.warn(
        { err, turnId: active.id },
        'Failed to mark turn recoverable',
      );
    }
  }

  /** Restore a persisted non-terminal turn into the in-memory router. */
  restoreTurn(row: TurnRow): ActiveTurn {
    const messageIds = (() => {
      try {
        const parsed = JSON.parse(row.message_ids || '[]');
        return Array.isArray(parsed)
          ? parsed.filter((id): id is string => typeof id === 'string')
          : [];
      } catch {
        return [];
      }
    })();
    const startedAt = Date.parse(row.started_at) || Date.now();
    const restored: ActiveTurn = {
      id: row.id,
      folder: row.group_folder,
      chatJid: row.chat_jid,
      channel: row.channel || row.chat_jid,
      messageIds,
      startedAt,
      lastInjectedAt: startedAt,
    };
    this.activeTurns.set(row.group_folder, restored);
    this.handoffInFlight.delete(row.group_folder);
    try {
      updateTurn(row.id, { status: 'running' });
    } catch (err) {
      logger.warn({ err, turnId: row.id }, 'Failed to restore turn status');
    }
    return restored;
  }

  /** Persist every live turn as resumable before processes are stopped. */
  suspendForRestart(): void {
    for (const folder of this.activeTurns.keys()) {
      this.markRecoverable(folder, '服务重启，等待按投递 ACK 恢复');
    }
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

  getActiveTurns(): ActiveTurn[] {
    return [...this.activeTurns.values()];
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

  /** Startup recovery begins from persisted non-terminal turns. */
  recoverOnStartup(): void {
    this.activeTurns.clear();
    this.pendingQueue.clear();
    this.handoffInFlight.clear();
  }
}
