/**
 * MemoryAgentManager — per-user Memory Agent process management.
 *
 * Each user gets at most one Memory Agent child process. The manager handles:
 *   - Lazy process startup on first query
 *   - stdin/stdout JSON-line communication with Promise routing
 *   - Idle timeout cleanup (10 minutes)
 *   - Crash recovery (auto-restart on next query)
 *   - Concurrency limiting (MAX_CONCURRENT_MEMORY_AGENTS)
 */

import { ChildProcess, spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import readline from 'readline';

import { DATA_DIR, GROUPS_DIR, TIMEZONE } from './config.js';
import { getGroupsByOwner, listUsers } from './db.js';
import { GroupQueue } from './group-queue.js';
import { logger } from './logger.js';
import { getSystemSettings, getUserMemoryMode } from './runtime-config.js';

// Memory Agent binary location (compiled TypeScript)
const MEMORY_AGENT_DIST = path.join(
  process.cwd(),
  'container',
  'memory-agent',
  'dist',
  'index.js',
);

// Limits
const MAX_CONCURRENT_MEMORY_AGENTS = 3;
const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_QUERY_TIMEOUT_MS = 60_000; // 60 seconds per query (configurable via Web UI)
const IDLE_CHECK_INTERVAL_MS = 60_000; // Check idle agents every minute

interface PendingQuery {
  resolve: (value: MemoryAgentResponse) => void;
  reject: (reason: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface AgentEntry {
  proc: ChildProcess;
  pendingQueries: Map<string, PendingQuery>;
  lastActivity: number;
}

export interface MemoryAgentResponse {
  requestId: string;
  success: boolean;
  response?: string;
  error?: string;
}

// --- Storage directory initialization ---

const INDEX_MD_TEMPLATE = `# 随身索引

> 本文件是记忆系统的随身索引，主 Agent 每次对话自动加载。
> 只放索引条目，不放具体内容。超限时 compact，不丢弃。

## 关于用户 (~30)

（暂无记录）

## 活跃话题 (~50)

（暂无记录）

## 重要提醒 (~20)

（暂无记录）

## 近期上下文 (~50)

（暂无记录）

## 备用 (~50)

（暂无记录）
`;

const INITIAL_STATE: Record<string, unknown> = {
  lastGlobalSleep: null,
  lastSessionWrapups: {},
  pendingWrapups: [],
  indexVersion: 0,
  totalImpressions: 0,
  totalKnowledgeFiles: 0,
};

/**
 * Ensure the memory directory for a user has the full structure.
 * Safe to call multiple times (idempotent).
 */
export function ensureMemoryDir(userId: string): string {
  const memDir = path.join(DATA_DIR, 'memory', userId);

  // Create subdirectories
  for (const subdir of ['knowledge', 'impressions', 'transcripts']) {
    fs.mkdirSync(path.join(memDir, subdir), { recursive: true });
  }

  // Create index.md if missing
  const indexPath = path.join(memDir, 'index.md');
  if (!fs.existsSync(indexPath)) {
    fs.writeFileSync(indexPath, INDEX_MD_TEMPLATE, 'utf-8');
    logger.info({ userId }, 'Created initial index.md for memory');
  }

  // Create state.json if missing
  const statePath = path.join(memDir, 'state.json');
  if (!fs.existsSync(statePath)) {
    fs.writeFileSync(
      statePath,
      JSON.stringify(INITIAL_STATE, null, 2) + '\n',
      'utf-8',
    );
    logger.info({ userId }, 'Created initial state.json for memory');
  }

  return memDir;
}

/**
 * Read the memory state.json for a user.
 */
export function readMemoryState(
  userId: string,
): Record<string, unknown> {
  const statePath = path.join(DATA_DIR, 'memory', userId, 'state.json');
  try {
    if (fs.existsSync(statePath)) {
      return JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    }
  } catch {
    /* ignore parse errors */
  }
  return { ...INITIAL_STATE };
}

/**
 * Write the memory state.json for a user (atomic write).
 */
export function writeMemoryState(
  userId: string,
  state: Record<string, unknown>,
): void {
  const statePath = path.join(DATA_DIR, 'memory', userId, 'state.json');
  const tmp = `${statePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, statePath);
}

// --- Legacy data import ---

export interface LegacyImportResult {
  imported: string[];
  skipped: string[];
  errors: string[];
}

/**
 * Import legacy memory data into the new agent memory structure.
 * Idempotent: skips files that already exist in the target location.
 *
 * Sources:
 *   data/groups/user-global/{userId}/CLAUDE.md → knowledge/user-profile.md
 *   data/groups/user-global/{userId}/daily-summary/*.md → impressions/
 *
 * After import, triggers a global_sleep via the manager (if provided)
 * so the Memory Agent can organize the imported data and update index.md.
 */
export function importLegacyMemoryData(userId: string): LegacyImportResult {
  const result: LegacyImportResult = {
    imported: [],
    skipped: [],
    errors: [],
  };

  const memDir = ensureMemoryDir(userId);
  const userGlobalDir = path.join(GROUPS_DIR, 'user-global', userId);

  // 1. Import CLAUDE.md → knowledge/user-profile.md
  const claudeMdPath = path.join(userGlobalDir, 'CLAUDE.md');
  const targetProfile = path.join(memDir, 'knowledge', 'user-profile.md');

  if (fs.existsSync(claudeMdPath)) {
    if (fs.existsSync(targetProfile) && fs.statSync(targetProfile).size > 0) {
      result.skipped.push('CLAUDE.md → knowledge/user-profile.md (already exists)');
    } else {
      try {
        const content = fs.readFileSync(claudeMdPath, 'utf-8');
        if (content.trim()) {
          const header = `# 用户档案（从旧记忆系统导入）\n\n> 导入时间: ${new Date().toISOString()}\n> 来源: CLAUDE.md\n\n---\n\n`;
          atomicWrite(targetProfile, header + content);
          result.imported.push('CLAUDE.md → knowledge/user-profile.md');
        } else {
          result.skipped.push('CLAUDE.md (empty)');
        }
      } catch (err) {
        result.errors.push(
          `CLAUDE.md: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // 2. Import daily-summary/*.md → impressions/
  const summaryDir = path.join(userGlobalDir, 'daily-summary');
  if (fs.existsSync(summaryDir)) {
    try {
      const summaryFiles = fs
        .readdirSync(summaryDir)
        .filter((f) => f.endsWith('.md'))
        .sort();

      for (const file of summaryFiles) {
        const dateLabel = file.replace(/\.md$/, '');
        const targetImpression = path.join(
          memDir,
          'impressions',
          `${dateLabel}-daily-summary.md`,
        );

        if (fs.existsSync(targetImpression)) {
          result.skipped.push(`daily-summary/${file} (already imported)`);
          continue;
        }

        try {
          const content = fs.readFileSync(
            path.join(summaryDir, file),
            'utf-8',
          );
          if (!content.trim()) {
            result.skipped.push(`daily-summary/${file} (empty)`);
            continue;
          }

          const header = `# 每日汇总 — ${dateLabel}（旧系统导入）\n\n> 导入时间: ${new Date().toISOString()}\n> 来源: daily-summary/${file}\n\n---\n\n`;
          atomicWrite(targetImpression, header + content);
          result.imported.push(`daily-summary/${file} → impressions/${dateLabel}-daily-summary.md`);
        } catch (err) {
          result.errors.push(
            `daily-summary/${file}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } catch (err) {
      result.errors.push(
        `daily-summary/: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Mark import in state.json
  if (result.imported.length > 0) {
    const state = readMemoryState(userId);
    state.legacyImportedAt = new Date().toISOString();
    state.legacyImportedFiles = result.imported.length;
    // Mark as needing maintenance so global_sleep will organize the data
    const pending = (state.pendingWrapups || []) as string[];
    if (!pending.includes('legacy-import')) {
      pending.push('legacy-import');
      state.pendingWrapups = pending;
    }
    writeMemoryState(userId, state);
  }

  return result;
}

function atomicWrite(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, content, 'utf-8');
  fs.renameSync(tmp, filePath);
}

export class MemoryAgentManager {
  private agents: Map<string, AgentEntry> = new Map();
  private idleCheckTimer: ReturnType<typeof setInterval> | null = null;

  /** Start periodic idle checks. Call once at startup. */
  startIdleChecks(): void {
    if (this.idleCheckTimer) return;
    this.idleCheckTimer = setInterval(() => {
      this.checkIdleAgents();
    }, IDLE_CHECK_INTERVAL_MS);
    // Don't prevent process exit
    this.idleCheckTimer.unref();
  }

  /** Stop periodic idle checks. */
  stopIdleChecks(): void {
    if (this.idleCheckTimer) {
      clearInterval(this.idleCheckTimer);
      this.idleCheckTimer = null;
    }
  }

  /** Get or start a Memory Agent for the given user. */
  private ensureAgent(userId: string): AgentEntry {
    const existing = this.agents.get(userId);
    if (existing) {
      existing.lastActivity = Date.now();
      return existing;
    }

    // Enforce concurrency limit — reject if at capacity
    if (this.agents.size >= MAX_CONCURRENT_MEMORY_AGENTS) {
      throw new Error(
        `Memory Agent concurrency limit reached (${MAX_CONCURRENT_MEMORY_AGENTS})`,
      );
    }

    return this.startAgent(userId);
  }

  private startAgent(userId: string): AgentEntry {
    const memDir = ensureMemoryDir(userId);

    // Ensure the memory-agent dist exists
    if (!fs.existsSync(MEMORY_AGENT_DIST)) {
      throw new Error(
        `Memory Agent not compiled. Run: npm --prefix container/memory-agent install && npm --prefix container/memory-agent run build`,
      );
    }

    logger.info({ userId, memDir }, 'Starting Memory Agent process');

    const proc = spawn('node', [MEMORY_AGENT_DIST], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HAPPYCLAW_MEMORY_DIR: memDir,
        HAPPYCLAW_MODEL: 'sonnet',
      },
      cwd: memDir,
    });

    const entry: AgentEntry = {
      proc,
      pendingQueries: new Map(),
      lastActivity: Date.now(),
    };

    this.agents.set(userId, entry);

    // Parse stdout line by line → route responses to pending promises
    const rl = readline.createInterface({ input: proc.stdout! });
    rl.on('line', (line) => {
      try {
        const msg = JSON.parse(line) as MemoryAgentResponse;
        const pending = entry.pendingQueries.get(msg.requestId);
        if (pending) {
          clearTimeout(pending.timeout);
          pending.resolve(msg);
          entry.pendingQueries.delete(msg.requestId);
        }
      } catch (err) {
        logger.warn(
          { userId, line: line.slice(0, 200) },
          'Memory Agent stdout parse error',
        );
      }
    });

    // Log stderr
    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) {
        logger.debug({ userId }, `[memory-agent:${userId}] ${text}`);
      }
    });

    // Process exit → reject all pending queries, clean up
    proc.on('exit', (code, signal) => {
      logger.info(
        { userId, code, signal },
        'Memory Agent process exited',
      );

      const currentEntry = this.agents.get(userId);
      if (currentEntry === entry) {
        // Reject all pending queries
        for (const [id, pending] of currentEntry.pendingQueries) {
          clearTimeout(pending.timeout);
          pending.reject(
            new Error(`Memory Agent exited (code ${code}, signal ${signal})`),
          );
        }
        this.agents.delete(userId);
      }
    });

    proc.on('error', (err) => {
      logger.error({ userId, err }, 'Memory Agent process error');
    });

    return entry;
  }

  /**
   * Send a synchronous query to the user's Memory Agent.
   * Returns a Promise that resolves when the agent responds.
   */
  async query(
    userId: string,
    queryText: string,
    context?: string,
  ): Promise<MemoryAgentResponse> {
    const entry = this.ensureAgent(userId);
    const requestId = crypto.randomUUID();

    return new Promise((resolve, reject) => {
      const queryTimeoutMs = getSystemSettings().memoryQueryTimeout || DEFAULT_QUERY_TIMEOUT_MS;
      const timeout = setTimeout(() => {
        entry.pendingQueries.delete(requestId);
        reject(new Error('Memory query timeout'));
      }, queryTimeoutMs);

      entry.pendingQueries.set(requestId, { resolve, reject, timeout });

      const message = JSON.stringify({
        requestId,
        type: 'query',
        query: queryText,
        context,
      });

      entry.proc.stdin!.write(message + '\n', (err) => {
        if (err) {
          clearTimeout(timeout);
          entry.pendingQueries.delete(requestId);
          reject(new Error(`Failed to write to Memory Agent stdin: ${err.message}`));
        }
      });
    });
  }

  /**
   * Send a fire-and-forget message to the user's Memory Agent.
   * Used for remember, session_wrapup, global_sleep.
   */
  async send(
    userId: string,
    message: Record<string, unknown>,
  ): Promise<MemoryAgentResponse> {
    const entry = this.ensureAgent(userId);
    const requestId = crypto.randomUUID();

    // Even fire-and-forget gets a requestId for tracking
    const payload = { ...message, requestId };

    // global_sleep needs more time (up to 5 minutes) due to deep maintenance
    const timeoutMs = message.type === 'global_sleep' ? 300_000 : 120_000;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        entry.pendingQueries.delete(requestId);
        reject(new Error('Memory Agent send timeout'));
      }, timeoutMs);

      entry.pendingQueries.set(requestId, { resolve, reject, timeout });

      entry.proc.stdin!.write(JSON.stringify(payload) + '\n', (err) => {
        if (err) {
          clearTimeout(timeout);
          entry.pendingQueries.delete(requestId);
          reject(
            new Error(`Failed to write to Memory Agent stdin: ${err.message}`),
          );
        }
      });

      entry.lastActivity = Date.now();
    });
  }

  /** Close idle agents that haven't been active for IDLE_TIMEOUT_MS. */
  checkIdleAgents(): void {
    const now = Date.now();
    for (const [userId, entry] of this.agents) {
      if (
        now - entry.lastActivity > IDLE_TIMEOUT_MS &&
        entry.pendingQueries.size === 0
      ) {
        logger.info({ userId }, 'Closing idle Memory Agent');
        try {
          entry.proc.stdin!.end(); // Graceful close
        } catch {
          entry.proc.kill();
        }
        this.agents.delete(userId);
      }
    }
  }

  /** Gracefully shut down all Memory Agent processes. */
  async shutdownAll(): Promise<void> {
    this.stopIdleChecks();

    const promises: Promise<void>[] = [];

    for (const [userId, entry] of this.agents) {
      promises.push(
        new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            entry.proc.kill();
            resolve();
          }, 5000);

          entry.proc.on('exit', () => {
            clearTimeout(timer);
            resolve();
          });

          // Reject all pending queries
          for (const [, pending] of entry.pendingQueries) {
            clearTimeout(pending.timeout);
            pending.reject(new Error('Memory Agent shutting down'));
          }
          entry.pendingQueries.clear();

          try {
            entry.proc.stdin!.end();
          } catch {
            entry.proc.kill();
            clearTimeout(timer);
            resolve();
          }

          logger.info({ userId }, 'Shutting down Memory Agent');
        }),
      );
    }

    await Promise.all(promises);
    this.agents.clear();
  }

  /** Get the number of active Memory Agent processes. */
  get activeCount(): number {
    return this.agents.size;
  }

  /** Check if a specific user has an active Memory Agent. */
  hasAgent(userId: string): boolean {
    return this.agents.has(userId);
  }
}

// --- Global sleep scheduling ---

export interface GlobalSleepDeps {
  manager: MemoryAgentManager;
  queue: GroupQueue;
}

let lastGlobalSleepCheck = 0;
const GLOBAL_SLEEP_CHECK_INTERVAL_MS = 55 * 60 * 1000; // 55 minutes

function getLocalHour(timestampMs: number): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    hour12: false,
    timeZone: TIMEZONE,
  });
  return parseInt(formatter.format(new Date(timestampMs)), 10);
}

/**
 * Check and trigger Memory Agent global_sleep for eligible users.
 * Called from the scheduler loop every 60s, but actually executes at most
 * once per ~55 minutes, and only between 2:00-3:00 AM local time
 * (right after daily summary runs).
 *
 * Conditions per user:
 *   1. memoryMode === 'agent'
 *   2. lastGlobalSleep > 20 hours ago (or never)
 *   3. No active sessions for this user
 *   4. Has pending wrapups (session_wrapup triggered since last global_sleep)
 */
export function runMemoryGlobalSleepIfNeeded(deps: GlobalSleepDeps): void {
  const now = Date.now();

  // Throttle: skip if checked less than 55 minutes ago
  if (now - lastGlobalSleepCheck < GLOBAL_SLEEP_CHECK_INTERVAL_MS) return;
  lastGlobalSleepCheck = now;

  // Only run between 2:00-3:00 AM in the configured timezone
  const localHour = getLocalHour(now);
  if (localHour < 2 || localHour >= 3) return;

  logger.info('Memory global_sleep: checking eligible users');

  // Build set of active group JIDs for quick lookup
  const queueStatus = deps.queue.getStatus();
  const activeJids = new Set(
    queueStatus.groups.filter((g) => g.active).map((g) => g.jid),
  );

  // Iterate all active users
  let page = 1;
  let triggered = 0;
  while (true) {
    const result = listUsers({ status: 'active', page, pageSize: 200 });
    for (const user of result.users) {
      // 1. Must be using agent memory mode
      if (getUserMemoryMode(user.id) !== 'agent') continue;

      const state = readMemoryState(user.id);

      // 2. lastGlobalSleep > 20 hours ago (or never run)
      const lastSleep = state.lastGlobalSleep as string | null;
      if (lastSleep) {
        const hoursSince =
          (now - new Date(lastSleep).getTime()) / (1000 * 60 * 60);
        if (hoursSince < 20) continue;
      }

      // 3. No active sessions for this user
      const userGroups = getGroupsByOwner(user.id);
      const hasActiveSession = userGroups.some((g) => activeJids.has(g.jid));
      if (hasActiveSession) continue;

      // 4. Has pending wrapups
      const pendingWrapups = (state.pendingWrapups || []) as string[];
      if (pendingWrapups.length === 0) continue;

      // All conditions met — trigger global_sleep
      logger.info({ userId: user.id }, 'Triggering Memory Agent global_sleep');
      deps.manager
        .send(user.id, { type: 'global_sleep' })
        .then(() => {
          logger.info(
            { userId: user.id },
            'Memory Agent global_sleep completed',
          );
        })
        .catch((err) => {
          logger.warn(
            { userId: user.id, err },
            'Memory Agent global_sleep failed',
          );
        });
      triggered++;
    }

    if (
      result.users.length < result.pageSize ||
      page * result.pageSize >= result.total
    )
      break;
    page++;
  }

  if (triggered > 0) {
    logger.info({ triggered }, 'Memory global_sleep: triggered for users');
  }
}
