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
import { getChatNamesByJids, getGroupsByOwner, getTranscriptMessagesSince, getUserHomeGroup, listUsers } from './db.js';
import { GroupQueue } from './group-queue.js';
import { logger } from './logger.js';
import {
  buildContainerEnvLines,
  getClaudeProviderConfig,
  getContainerEnvConfig,
  getSystemSettings,
  getUserMemoryMode,
} from './runtime-config.js';
import type { MessageCursor } from './types.js';

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
  stderrBuffer: string[];
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
  lastSessionWrapupAt: null,
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

// --- Channel label resolution ---

/**
 * Derive a human-readable channel label from a JID and optional chat name.
 *
 * Examples:
 *   feishu:oc_xxx + "设计群" → "飞书·设计群"
 *   telegram:123  + "My Chat" → "Telegram·My Chat"
 *   qq:456        + "项目群" → "QQ·项目群"
 *   web:main                 → "Web"
 */
export function resolveChannelLabel(jid: string, name?: string): string {
  const colonIdx = jid.indexOf(':');
  const prefix = colonIdx > 0 ? jid.slice(0, colonIdx).toLowerCase() : '';
  const channelMap: Record<string, string> = {
    feishu: '飞书',
    telegram: 'Telegram',
    qq: 'QQ',
    web: 'Web',
  };
  const channelType = channelMap[prefix] || prefix || 'Unknown';
  if (channelType === 'Web') return 'Web';
  if (name && name !== jid) return `${channelType}·${name}`;
  return channelType;
}

// --- Transcript export ---

interface TranscriptMessage {
  id: string;
  chat_jid: string;
  source_jid?: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
}

function formatTranscriptMarkdown(
  messages: TranscriptMessage[],
  folder: string,
  nameMap: Map<string, string>,
): string {
  if (messages.length === 0) return '';

  const firstTs = messages[0].timestamp;
  const lastTs = messages[messages.length - 1].timestamp;
  const formatTime = (ts: string) => {
    try {
      return new Date(ts).toISOString().replace('T', ' ').slice(0, 19);
    } catch {
      return ts;
    }
  };

  // Collect unique channel labels
  const channelSet = new Set<string>();
  for (const msg of messages) {
    const effectiveJid = msg.source_jid || msg.chat_jid;
    channelSet.add(resolveChannelLabel(effectiveJid, nameMap.get(effectiveJid)));
  }
  const channels = Array.from(channelSet);
  const isMultiChannel = channels.length > 1;

  const lines: string[] = [
    `# 对话记录 — ${folder}`,
    `时间范围：${formatTime(firstTs)} ~ ${formatTime(lastTs)}`,
    `消息数：${messages.length}`,
    `涉及渠道：${channels.join('、')}`,
    '',
    '---',
    '',
  ];

  for (const msg of messages) {
    const role = msg.is_from_me ? 'Agent' : msg.sender_name || 'User';
    const time = formatTime(msg.timestamp);
    const content =
      msg.content.length > 2000
        ? msg.content.slice(0, 2000) + '\n\n[...内容截断...]'
        : msg.content;
    // Only tag per-message channel when transcript spans multiple channels
    if (isMultiChannel && !msg.is_from_me) {
      const effectiveJid = msg.source_jid || msg.chat_jid;
      const label = resolveChannelLabel(effectiveJid, nameMap.get(effectiveJid));
      lines.push(`**${role}** (${time}) [${label}]: ${content}`, '');
    } else {
      lines.push(`**${role}** (${time}): ${content}`, '');
    }
  }

  return lines.join('\n');
}

/**
 * Export transcripts for a user's home group and trigger session_wrapup.
 * Extracted from index.ts so it can be called from both container exit listener and manual trigger.
 */
export function exportTranscriptsForUser(
  userId: string,
  folder: string,
  chatJids: string[],
  memoryAgentManager: MemoryAgentManager,
): void {
  try {
    const memDir = ensureMemoryDir(userId);
    const state = readMemoryState(userId);
    const wrapups = (state.lastSessionWrapups || {}) as Record<
      string,
      MessageCursor
    >;
    const defaultCursor: MessageCursor = {
      timestamp: '1970-01-01T00:00:00Z',
      id: '',
    };

    // Collect all messages from all associated chatJids
    const allMessages: TranscriptMessage[] = [];
    for (const jid of chatJids) {
      const cursor = wrapups[jid] || defaultCursor;
      const msgs = getTranscriptMessagesSince(jid, cursor);
      allMessages.push(
        ...msgs.map((m) => ({
          id: m.id,
          chat_jid: m.chat_jid,
          source_jid: m.source_jid,
          sender_name: m.sender_name,
          content: m.content,
          timestamp: m.timestamp,
          is_from_me: !!m.is_from_me,
        })),
      );
    }

    if (allMessages.length === 0) {
      logger.debug({ userId, folder }, 'No new messages for transcript export');
      return;
    }

    // Sort by time, then by id for stable ordering
    allMessages.sort(
      (a, b) =>
        a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id),
    );

    // Resolve channel names for all effective JIDs
    const effectiveJids = new Set<string>();
    for (const msg of allMessages) {
      effectiveJids.add(msg.source_jid || msg.chat_jid);
    }
    const nameMap = getChatNamesByJids(Array.from(effectiveJids));
    const md = formatTranscriptMarkdown(allMessages, folder, nameMap);
    const dateStr = new Date().toISOString().slice(0, 10);
    const filename = `${folder}-${Date.now()}.md`;
    const transcriptRelPath = path.join('transcripts', dateStr, filename);
    const fullPath = path.join(memDir, transcriptRelPath);

    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    // Atomic write
    const tmp = `${fullPath}.tmp`;
    fs.writeFileSync(tmp, md, 'utf-8');
    fs.renameSync(tmp, fullPath);

    logger.info(
      {
        userId,
        folder,
        messageCount: allMessages.length,
        path: transcriptRelPath,
      },
      'Exported transcript for Memory Agent',
    );

    // Update cursors for all chatJids to the last message
    const lastMsg = allMessages[allMessages.length - 1];
    for (const jid of chatJids) {
      wrapups[jid] = { timestamp: lastMsg.timestamp, id: lastMsg.id };
    }
    state.lastSessionWrapups = wrapups;
    state.lastSessionWrapupAt = new Date().toISOString();
    // Track pending wrapups for global_sleep scheduling
    const pending = (state.pendingWrapups || []) as string[];
    if (!pending.includes(folder)) {
      pending.push(folder);
      state.pendingWrapups = pending;
    }
    writeMemoryState(userId, state);

    // Trigger session_wrapup (fire-and-forget, don't block container exit)
    memoryAgentManager
      .send(userId, {
        type: 'session_wrapup',
        transcriptFile: transcriptRelPath,
        groupFolder: folder,
        chatJids,
      })
      .catch((err) => {
        logger.warn(
          { userId, folder, err },
          'Memory Agent session_wrapup failed (non-blocking)',
        );
      });
  } catch (err) {
    logger.error(
      { userId, folder, err },
      'Failed to export transcript for Memory Agent',
    );
  }
}

/**
 * Write a memory agent execution log to the user's home group logs directory.
 */
function writeMemoryLog(
  userId: string,
  opts: {
    type: string;
    startTime: number;
    status: 'success' | 'error' | 'timeout';
    exitCode: number;
    response?: string;
    stderr: string[];
    error?: string;
  },
): void {
  try {
    const homeGroup = getUserHomeGroup(userId);
    if (!homeGroup) {
      logger.warn({ userId }, 'Cannot write memory log: no home group found');
      return;
    }

    const logsDir = path.join(GROUPS_DIR, homeGroup.folder, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });

    const duration = Date.now() - opts.startTime;
    const timestamp = new Date(opts.startTime).toISOString();
    const filename = `memory-${opts.startTime}.log`;

    const lines: string[] = [
      '=== Memory Agent Run Log ===',
      `Timestamp: ${timestamp}`,
      `Duration: ${duration}ms`,
      `Exit Code: ${opts.exitCode}`,
      `Type: ${opts.type}`,
      `Status: ${opts.status}`,
      '',
      '=== Response ===',
      opts.response || opts.error || '(no response)',
      '',
      '=== Stderr ===',
      opts.stderr.join('\n') || '(empty)',
      '',
    ];

    const content = lines.join('\n');
    const filePath = path.join(logsDir, filename);
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, content, 'utf-8');
    fs.renameSync(tmp, filePath);

    logger.info(
      { userId, filename, type: opts.type, status: opts.status, duration },
      'Wrote memory agent log',
    );
  } catch (err) {
    logger.error({ userId, err }, 'Failed to write memory agent log');
  }
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

    // Build Claude auth env vars (same as host-mode agent)
    const globalConfig = getClaudeProviderConfig();
    const containerOverride = getContainerEnvConfig('memory-agent');
    const envLines = buildContainerEnvLines(globalConfig, containerOverride);
    const claudeEnv: Record<string, string> = {};
    for (const line of envLines) {
      const eqIdx = line.indexOf('=');
      if (eqIdx > 0) {
        claudeEnv[line.slice(0, eqIdx)] = line.slice(eqIdx + 1);
      }
    }

    // Share the user's home agent session dir so OAuth credentials (auto-refreshed
    // by the SDK) are shared between the main agent and the memory agent.
    // This avoids stale refresh tokens — the main agent refreshes on startup and
    // the memory agent picks up the fresh credentials from the same file.
    const homeGroup = getUserHomeGroup(userId);
    const homeFolder = homeGroup?.folder ?? 'main';
    const configDir = path.join(DATA_DIR, 'sessions', homeFolder, '.claude');
    fs.mkdirSync(configDir, { recursive: true });

    const proc = spawn('node', [MEMORY_AGENT_DIST], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...claudeEnv,
        HAPPYCLAW_MEMORY_DIR: memDir,
        HAPPYCLAW_MODEL: 'sonnet',
        CLAUDE_CONFIG_DIR: configDir,
      },
      cwd: memDir,
    });

    const entry: AgentEntry = {
      proc,
      pendingQueries: new Map(),
      lastActivity: Date.now(),
      stderrBuffer: [],
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

    // Log stderr and buffer for log files
    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) {
        logger.debug({ userId }, `[memory-agent:${userId}] ${text}`);
        entry.stderrBuffer.push(text);
        if (entry.stderrBuffer.length > 2000) {
          entry.stderrBuffer.splice(0, entry.stderrBuffer.length - 2000);
        }
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
    options: {
      query: string;
      context?: string;
      chatJid?: string;
      groupFolder?: string;
      channelLabel?: string;
    },
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
        query: options.query,
        context: options.context,
        chatJid: options.chatJid,
        groupFolder: options.groupFolder,
        channelLabel: options.channelLabel,
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

    const settings = getSystemSettings();
    const timeoutMs = message.type === 'global_sleep'
      ? settings.memoryGlobalSleepTimeout
      : settings.memorySendTimeout;

    const msgType = String(message.type || 'unknown');
    const shouldLog = msgType === 'global_sleep' || msgType === 'session_wrapup';
    const startTime = Date.now();
    const stderrStart = entry.stderrBuffer.length;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        entry.pendingQueries.delete(requestId);
        const err = new Error('Memory Agent send timeout');
        if (shouldLog) {
          writeMemoryLog(userId, {
            type: msgType,
            startTime,
            status: 'timeout',
            exitCode: -1,
            stderr: entry.stderrBuffer.slice(stderrStart),
            error: err.message,
          });
          if (entry.pendingQueries.size === 0) entry.stderrBuffer.length = 0;
        }
        reject(err);
      }, timeoutMs);

      const wrappedResolve = (resp: MemoryAgentResponse) => {
        if (shouldLog) {
          writeMemoryLog(userId, {
            type: msgType,
            startTime,
            status: resp.success ? 'success' : 'error',
            exitCode: resp.success ? 0 : 1,
            response: resp.response,
            stderr: entry.stderrBuffer.slice(stderrStart),
            error: resp.error,
          });
          if (entry.pendingQueries.size === 0) entry.stderrBuffer.length = 0;
        }
        resolve(resp);
      };

      const wrappedReject = (reason: Error) => {
        if (shouldLog) {
          writeMemoryLog(userId, {
            type: msgType,
            startTime,
            status: 'error',
            exitCode: 1,
            stderr: entry.stderrBuffer.slice(stderrStart),
            error: reason.message,
          });
          if (entry.pendingQueries.size === 0) entry.stderrBuffer.length = 0;
        }
        reject(reason);
      };

      entry.pendingQueries.set(requestId, { resolve: wrappedResolve, reject: wrappedReject, timeout });

      entry.proc.stdin!.write(JSON.stringify(payload) + '\n', (err) => {
        if (err) {
          clearTimeout(timeout);
          entry.pendingQueries.delete(requestId);
          wrappedReject(
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
 *   2. lastGlobalSleep > 6 hours ago (or never)
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

      // 2. lastGlobalSleep > 6 hours ago (or never run)
      const lastSleep = state.lastGlobalSleep as string | null;
      if (lastSleep) {
        const hoursSince =
          (now - new Date(lastSleep).getTime()) / (1000 * 60 * 60);
        if (hoursSince < 6) continue;
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
