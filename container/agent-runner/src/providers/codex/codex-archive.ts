/**
 * Codex Archive Manager — token-threshold-based conversation archival.
 *
 * Since Codex has no PreCompact hook, we archive based on cumulative
 * token usage between turns.
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
  private cumulativeInputTokens = 0;
  private cumulativeOutputTokens = 0;
  private turnCount = 0;

  hydrate(snapshot?: {
    cumulativeInputTokens?: unknown;
    cumulativeOutputTokens?: unknown;
    turnCount?: unknown;
  }): void {
    if (!snapshot || typeof snapshot !== 'object') return;
    this.cumulativeInputTokens =
      typeof snapshot.cumulativeInputTokens === 'number'
      && Number.isFinite(snapshot.cumulativeInputTokens)
        ? snapshot.cumulativeInputTokens
        : 0;
    this.cumulativeOutputTokens =
      typeof snapshot.cumulativeOutputTokens === 'number'
      && Number.isFinite(snapshot.cumulativeOutputTokens)
        ? snapshot.cumulativeOutputTokens
        : 0;
    this.turnCount =
      typeof snapshot.turnCount === 'number'
      && Number.isFinite(snapshot.turnCount)
        ? snapshot.turnCount
        : 0;
  }

  snapshot(): {
    cumulativeInputTokens: number;
    cumulativeOutputTokens: number;
    turnCount: number;
  } {
    return {
      cumulativeInputTokens: this.cumulativeInputTokens,
      cumulativeOutputTokens: this.cumulativeOutputTokens,
      turnCount: this.turnCount,
    };
  }

  recordTurn(usage: UsageInfo | undefined): void {
    this.turnCount++;
    if (usage) {
      this.cumulativeInputTokens += usage.inputTokens;
      this.cumulativeOutputTokens += usage.outputTokens;
    }
  }

  shouldArchive(): boolean {
    return (
      this.cumulativeInputTokens + this.cumulativeOutputTokens
    ) >= ARCHIVE_TOKEN_THRESHOLD;
  }

  async archive(
    groupFolder: string,
    userId?: string,
  ): Promise<SessionWrapupResponse | null> {
    if (this.turnCount === 0) return null;

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
          `Sent session_wrapup request ${requestId} for ${groupFolder} (${this.turnCount} turns, ${this.cumulativeInputTokens + this.cumulativeOutputTokens} tokens)`,
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

    this.reset();
    return response;
  }

  async forceArchive(
    groupFolder: string,
    userId?: string,
  ): Promise<SessionWrapupResponse | null> {
    if (this.turnCount === 0) return null;
    return this.archive(groupFolder, userId);
  }

  private reset(): void {
    this.cumulativeInputTokens = 0;
    this.cumulativeOutputTokens = 0;
    this.turnCount = 0;
  }
}
