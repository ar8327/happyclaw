/**
 * Codex Archive Manager — token-threshold-based conversation archival.
 *
 * Since Codex has no PreCompact hook, we archive based on cumulative
 * token usage between turns.
 */

import fs from 'fs';
import path from 'path';
import { writeIpcFile } from 'happyclaw-agent-runner-core';
import type { UsageInfo } from '../../runner-interface.js';

const ARCHIVE_TOKEN_THRESHOLD = parseInt(
  process.env.HAPPYCLAW_CODEX_ARCHIVE_THRESHOLD
    || process.env.CODEX_ARCHIVE_THRESHOLD
    || '100000',
  10,
);

const WORKSPACE_GROUP = process.env.HAPPYCLAW_WORKSPACE_GROUP || '/workspace/group';
const WORKSPACE_IPC = process.env.HAPPYCLAW_WORKSPACE_IPC || '/workspace/ipc';

function log(message: string): void {
  console.error(`[codex-archive] ${message}`);
}

export class CodexArchiveManager {
  private cumulativeInputTokens = 0;
  private cumulativeOutputTokens = 0;
  private turnCount = 0;
  private conversationLines: string[] = [];

  hydrate(snapshot?: {
    cumulativeInputTokens?: unknown;
    cumulativeOutputTokens?: unknown;
    turnCount?: unknown;
    conversationLines?: unknown;
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
      typeof snapshot.turnCount === 'number' && Number.isFinite(snapshot.turnCount)
        ? snapshot.turnCount
        : 0;
    this.conversationLines = Array.isArray(snapshot.conversationLines)
      ? snapshot.conversationLines.filter((line): line is string => typeof line === 'string')
      : [];
  }

  snapshot(): {
    cumulativeInputTokens: number;
    cumulativeOutputTokens: number;
    turnCount: number;
    conversationLines: string[];
  } {
    return {
      cumulativeInputTokens: this.cumulativeInputTokens,
      cumulativeOutputTokens: this.cumulativeOutputTokens,
      turnCount: this.turnCount,
      conversationLines: [...this.conversationLines],
    };
  }

  /**
   * Record a completed turn's usage and final text.
   */
  recordTurn(usage: UsageInfo | undefined, finalText: string | null): void {
    this.turnCount++;
    if (usage) {
      this.cumulativeInputTokens += usage.inputTokens;
      this.cumulativeOutputTokens += usage.outputTokens;
    }
    if (finalText) {
      this.conversationLines.push(`**Assistant**: ${finalText.slice(0, 2000)}${finalText.length > 2000 ? '...' : ''}`);
    }
  }

  /**
   * Record a user prompt for the conversation log.
   */
  recordUserMessage(prompt: string): void {
    this.conversationLines.push(`**User**: ${prompt.slice(0, 2000)}${prompt.length > 2000 ? '...' : ''}`);
  }

  /**
   * Check if we should archive based on cumulative tokens.
   */
  shouldArchive(): boolean {
    return (this.cumulativeInputTokens + this.cumulativeOutputTokens) >= ARCHIVE_TOKEN_THRESHOLD;
  }

  /**
   * Archive the conversation and reset counters.
   */
  async archive(groupFolder: string, userId?: string): Promise<void> {
    if (this.conversationLines.length === 0) return;

    try {
      const conversationsDir = path.join(WORKSPACE_GROUP, 'conversations');
      fs.mkdirSync(conversationsDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const time = new Date().toISOString().split('T')[1].replace(/[:.]/g, '-').slice(0, 8);
      const filename = `${date}-codex-${time}.md`;
      const filePath = path.join(conversationsDir, filename);

      const header = [
        `# Codex Conversation`,
        '',
        `Archived: ${new Date().toLocaleString()}`,
        `Turns: ${this.turnCount}`,
        `Tokens: ${this.cumulativeInputTokens} in / ${this.cumulativeOutputTokens} out`,
        '',
        '---',
        '',
      ].join('\n');

      fs.writeFileSync(filePath, header + this.conversationLines.join('\n\n') + '\n');
      log(`Archived conversation to ${filePath} (${this.turnCount} turns, ${this.cumulativeInputTokens + this.cumulativeOutputTokens} tokens)`);

      // Signal session_wrapup for memory system
      if (userId) {
        const tasksDir = path.join(WORKSPACE_IPC, 'tasks');
        writeIpcFile(tasksDir, {
          type: 'session_wrapup',
          workspaceFolder: groupFolder,
          groupFolder,
          userId,
          timestamp: new Date().toISOString(),
        });
        log(`Sent session_wrapup IPC signal for ${groupFolder}`);
      }
    } catch (err) {
      log(`Archive failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Reset
    this.cumulativeInputTokens = 0;
    this.cumulativeOutputTokens = 0;
    this.turnCount = 0;
    this.conversationLines = [];
  }

  /**
   * Force archive on runner cleanup (exit).
   */
  async forceArchive(groupFolder: string, userId?: string): Promise<void> {
    if (this.conversationLines.length > 0) {
      await this.archive(groupFolder, userId);
    }
  }
}
