/**
 * Codex Archive Manager — token-threshold-based conversation archival.
 *
 * Since Codex has no PreCompact hook, we archive based on the current
 * model context-window usage reported by the latest turn.
 */

import type { UsageInfo } from '../../runner-interface.js';
import {
  enqueueSessionWrapupTask,
  waitForSessionWrapupResponse,
  type SessionWrapupResponse,
} from '../../session-wrapup-ipc.js';

const ARCHIVE_TOKEN_THRESHOLD = parseInt(
  process.env.HAPPYCLAW_CODEX_ARCHIVE_THRESHOLD
    || process.env.CODEX_ARCHIVE_THRESHOLD
    || '200000',
  10,
);

function log(message: string): void {
  console.error(`[codex-archive] ${message}`);
}

export class CodexArchiveManager {
  private lastContextWindowTokens = 0;
  private lastInputTokens = 0;
  private lastOutputTokens = 0;
  private lastCacheReadInputTokens = 0;
  private turnCount = 0;
  private lastCompactedAt: string | null = null;

  hydrate(snapshot?: {
    lastContextWindowTokens?: unknown;
    lastInputTokens?: unknown;
    lastOutputTokens?: unknown;
    lastCacheReadInputTokens?: unknown;
    cumulativeInputTokens?: unknown;
    cumulativeOutputTokens?: unknown;
    turnCount?: unknown;
    lastCompactedAt?: unknown;
  }): void {
    if (!snapshot || typeof snapshot !== 'object') return;
    this.lastContextWindowTokens =
      typeof snapshot.lastContextWindowTokens === 'number'
      && Number.isFinite(snapshot.lastContextWindowTokens)
        ? snapshot.lastContextWindowTokens
        : 0;
    this.lastInputTokens =
      typeof snapshot.lastInputTokens === 'number'
      && Number.isFinite(snapshot.lastInputTokens)
        ? snapshot.lastInputTokens
        : 0;
    this.lastOutputTokens =
      typeof snapshot.lastOutputTokens === 'number'
      && Number.isFinite(snapshot.lastOutputTokens)
        ? snapshot.lastOutputTokens
        : 0;
    this.lastCacheReadInputTokens =
      typeof snapshot.lastCacheReadInputTokens === 'number'
      && Number.isFinite(snapshot.lastCacheReadInputTokens)
        ? snapshot.lastCacheReadInputTokens
        : 0;
    this.turnCount =
      typeof snapshot.turnCount === 'number'
      && Number.isFinite(snapshot.turnCount)
        ? snapshot.turnCount
        : 0;
    this.lastCompactedAt =
      typeof snapshot.lastCompactedAt === 'string'
      && snapshot.lastCompactedAt.trim().length > 0
        ? snapshot.lastCompactedAt
        : null;
  }

  snapshot(): {
    lastContextWindowTokens: number;
    lastInputTokens: number;
    lastOutputTokens: number;
    lastCacheReadInputTokens: number;
    turnCount: number;
    lastCompactedAt: string | null;
  } {
    return {
      lastContextWindowTokens: this.lastContextWindowTokens,
      lastInputTokens: this.lastInputTokens,
      lastOutputTokens: this.lastOutputTokens,
      lastCacheReadInputTokens: this.lastCacheReadInputTokens,
      turnCount: this.turnCount,
      lastCompactedAt: this.lastCompactedAt,
    };
  }

  recordTurn(usage: UsageInfo | undefined): void {
    this.turnCount++;
    if (usage) {
      this.lastInputTokens = usage.inputTokens;
      this.lastOutputTokens = usage.outputTokens;
      this.lastCacheReadInputTokens = usage.cacheReadInputTokens;
      this.lastContextWindowTokens = usage.inputTokens + usage.outputTokens;
      log(
        `Recorded turn usage for archive: contextWindow=${this.lastContextWindowTokens}/${ARCHIVE_TOKEN_THRESHOLD}, input=${usage.inputTokens}, output=${usage.outputTokens}, cachedInput=${usage.cacheReadInputTokens}`,
      );
    }
  }

  shouldArchive(): boolean {
    return this.lastContextWindowTokens >= ARCHIVE_TOKEN_THRESHOLD;
  }

  async archive(
    groupFolder: string,
    userId?: string,
  ): Promise<SessionWrapupResponse | null> {
    if (this.turnCount === 0) return null;
    return this.executeArchive(groupFolder, userId, true);
  }

  async forceArchive(
    groupFolder: string,
    userId?: string,
  ): Promise<SessionWrapupResponse | null> {
    if (this.turnCount === 0) return null;
    return this.executeArchive(groupFolder, userId, false);
  }

  private async executeArchive(
    groupFolder: string,
    userId: string | undefined,
    markAsCompact: boolean,
  ): Promise<SessionWrapupResponse | null> {
    let response: SessionWrapupResponse | null = null;
    try {
      if (userId) {
        const requestId = enqueueSessionWrapupTask({
          workspaceFolder: groupFolder,
          groupFolder,
          userId,
          archiveConversation: true,
        });
        log(
          `Sent session_wrapup request ${requestId} for ${groupFolder} (${this.turnCount} turns, contextWindow=${this.lastContextWindowTokens} tokens)`,
        );
        response = await waitForSessionWrapupResponse(requestId);
        if (response.success) {
          log(
            `session_wrapup completed for ${groupFolder}${response.conversationArchiveFile ? ` -> ${response.conversationArchiveFile}` : ''}`,
          );
        } else {
          log(
            `session_wrapup failed for ${groupFolder}: ${response.error || 'unknown error'}`,
          );
        }
      } else {
        log(`Skipping session_wrapup for ${groupFolder}: missing userId`);
      }
    } catch (err) {
      log(`Archive failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (response?.success) {
      if (markAsCompact) {
        this.lastCompactedAt = new Date().toISOString();
      }
      this.reset();
    } else {
      log(
        `Preserving archive state for ${groupFolder}; session will not compact until session_wrapup succeeds`,
      );
    }
    return response;
  }

  private reset(): void {
    this.lastContextWindowTokens = 0;
    this.lastInputTokens = 0;
    this.lastOutputTokens = 0;
    this.lastCacheReadInputTokens = 0;
    this.turnCount = 0;
  }
}
