/**
 * Turn trace persistence: save and load turn execution traces.
 */

import fs from 'fs';
import path from 'path';
import { DATA_DIR } from './config.js';
import { logger } from './logger.js';
import type { StreamingBlock } from './streaming-blocks.js';

const TRACES_DIR = path.join(DATA_DIR, 'traces');

export interface TurnTrace {
  turnId: string;
  chatJid: string;
  channel: string;
  folder: string;
  messageIds: string[];
  startedAt: string;
  completedAt: string;
  status: string;
  blocks: StreamingBlock[];
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    costUSD: number;
    durationMs: number;
  };
}

/**
 * Save a turn trace to disk.
 * Returns the relative path from DATA_DIR.
 */
export function saveTurnTrace(trace: TurnTrace): string {
  const date = trace.startedAt.slice(0, 10); // YYYY-MM-DD
  const dir = path.join(TRACES_DIR, trace.folder, date);
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${trace.turnId}.json`;
  const filepath = path.join(dir, filename);
  const tempPath = `${filepath}.tmp`;

  fs.writeFileSync(tempPath, JSON.stringify(trace), 'utf-8');
  fs.renameSync(tempPath, filepath);

  // Return relative path for DB storage
  return path.relative(DATA_DIR, filepath);
}

/**
 * Load a turn trace from a relative path (stored in DB).
 */
export function loadTurnTrace(relativePath: string): TurnTrace | null {
  const filepath = path.join(DATA_DIR, relativePath);
  try {
    if (!fs.existsSync(filepath)) return null;
    return JSON.parse(fs.readFileSync(filepath, 'utf-8')) as TurnTrace;
  } catch (err) {
    logger.warn({ err, path: filepath }, 'Failed to load turn trace');
    return null;
  }
}

/**
 * Clean up trace files older than maxAgeDays.
 * Returns the number of deleted files.
 */
export function cleanupOldTraces(maxAgeDays: number): number {
  let deleted = 0;
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

  try {
    if (!fs.existsSync(TRACES_DIR)) return 0;

    // Iterate folder → date directories
    for (const folder of fs.readdirSync(TRACES_DIR)) {
      const folderDir = path.join(TRACES_DIR, folder);
      if (!fs.statSync(folderDir).isDirectory()) continue;

      for (const dateDir of fs.readdirSync(folderDir)) {
        const datePath = path.join(folderDir, dateDir);
        if (!fs.statSync(datePath).isDirectory()) continue;

        // Parse date from directory name (YYYY-MM-DD)
        const dirDate = new Date(dateDir).getTime();
        if (Number.isNaN(dirDate) || dirDate >= cutoff) continue;

        // Delete all files in this date directory
        for (const file of fs.readdirSync(datePath)) {
          try {
            fs.unlinkSync(path.join(datePath, file));
            deleted++;
          } catch {
            /* ignore */
          }
        }

        // Try to remove the empty date directory
        try {
          fs.rmdirSync(datePath);
        } catch {
          /* ignore */
        }
      }

      // Try to remove empty folder directory
      try {
        fs.rmdirSync(folderDir);
      } catch {
        /* ignore */
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Error during trace cleanup');
  }

  if (deleted > 0) {
    logger.info({ deleted, maxAgeDays }, 'Cleaned up old turn traces');
  }
  return deleted;
}
