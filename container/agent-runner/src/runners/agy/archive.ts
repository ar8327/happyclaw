/**
 * agy 合成压缩归档管理器。
 *
 * agy 无原生 compact（print 模式下 /compact 只会被当成普通用户消息），
 * 由 runner 在上下文估算超过阈值时主动触发：session_wrapup 归档 →
 * 拿 continuationSummary → 丢弃 resume 锚点开新会话并注入摘要。
 */

import {
  enqueueSessionWrapupTask,
  waitForSessionWrapupResponse,
  type SessionWrapupResponse,
} from '../../session-wrapup-ipc.js';

function log(message: string): void {
  console.error(`[agy-archive] ${message}`);
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export class AgyArchiveManager {
  private turnCount = 0;
  private lastEstimatedTokens = 0;
  private lastCompactedAt: string | null = null;
  private syntheticCompactCount = 0;

  hydrate(snapshot?: {
    turnCount?: unknown;
    lastEstimatedTokens?: unknown;
    lastCompactedAt?: unknown;
    syntheticCompactCount?: unknown;
  }): void {
    if (!snapshot || typeof snapshot !== 'object') return;
    this.turnCount = numberOrZero(snapshot.turnCount);
    this.lastEstimatedTokens = numberOrZero(snapshot.lastEstimatedTokens);
    this.lastCompactedAt =
      typeof snapshot.lastCompactedAt === 'string' &&
      snapshot.lastCompactedAt.trim().length > 0
        ? snapshot.lastCompactedAt
        : null;
    this.syntheticCompactCount = numberOrZero(snapshot.syntheticCompactCount);
  }

  snapshot(): {
    turnCount: number;
    lastEstimatedTokens: number;
    lastCompactedAt: string | null;
    syntheticCompactCount: number;
  } {
    return {
      turnCount: this.turnCount,
      lastEstimatedTokens: this.lastEstimatedTokens,
      lastCompactedAt: this.lastCompactedAt,
      syntheticCompactCount: this.syntheticCompactCount,
    };
  }

  recordTurn(estimatedTokens?: number | null): void {
    this.turnCount++;
    if (typeof estimatedTokens === 'number' && estimatedTokens > 0) {
      this.lastEstimatedTokens = estimatedTokens;
    }
  }

  getLastEstimatedTokens(): number {
    return this.lastEstimatedTokens;
  }

  async archiveForCompact(
    groupFolder: string,
    userId?: string,
  ): Promise<SessionWrapupResponse | null> {
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
          `Sent session_wrapup request ${requestId} for ${groupFolder} (${this.turnCount} turns, ~${this.lastEstimatedTokens} tokens)`,
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
      log(
        `Archive failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (response?.success) {
      if (markAsCompact) {
        this.lastCompactedAt = new Date().toISOString();
        this.syntheticCompactCount++;
      }
      this.turnCount = 0;
      this.lastEstimatedTokens = 0;
    } else {
      log(
        `Preserving archive state for ${groupFolder}; conversation will not reset until session_wrapup succeeds`,
      );
    }
    return response;
  }
}
