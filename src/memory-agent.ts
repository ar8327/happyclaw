/**
 * MemoryOrchestrator support code.
 *
 * Memory turns run through the shared session launcher so they share the same
 * runtime contract, state persistence, and runner selection as normal sessions.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from './config.js';
import type {
  RuntimeExecutionProfile,
  RuntimeInput,
  RuntimeOutput,
} from './runtime-runner.js';
import {
  getChatNamesByJids,
  getJidsByFolder,
  getPrimarySessionForOwner,
  getSessionRecord,
  getSessionRuntimeState,
  listAgentsByFolder,
  listSessionRecords,
  getTranscriptMessagesSince,
  saveSessionRecord,
  getUserById,
  upsertSessionRuntimeState,
} from './db.js';
import { SessionRuntimeManager } from './session-runtime-manager.js';
import { logger } from './logger.js';
import {
  getRunnerDescriptor,
  resolveMemoryRunnerId,
} from './runner-registry.js';
import {
  RuntimeRequestExecutor,
  type RuntimeExecutionHook,
  type RunResult,
} from './runtime-request-executor.js';
import { getSystemSettings } from './runtime-config.js';
import { runSessionAgent } from './session-launcher.js';
import type {
  MessageCursor,
  RunnerDescriptor,
  SessionRecord,
} from './types.js';
import { buildMemoryProfile } from './memory-profile.js';
import {
  getMemoryLifecycleStrategy,
  queueMemorySyntheticWrapupJobs,
  readMemorySyntheticLifecycleState,
  SyntheticArchiveLifecycleHook,
  writeMemorySyntheticLifecycleState,
  type MemorySyntheticLifecycleFollowUp,
  type MemorySyntheticLifecycleHookContext,
  type MemorySyntheticWrapupJob,
} from './memory-synthetic-lifecycle.js';

// Limits
const MAX_CONCURRENT_MEMORY_AGENTS = 3;
const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_QUERY_TIMEOUT_MS = 60_000; // 60 seconds per query (configurable via Web UI)
const IDLE_CHECK_INTERVAL_MS = 60_000; // Check idle agents every minute

interface AgentEntry {
  lastActivity: number;
  inFlight: number;
  tail: Promise<void>;
}

interface MemoryExecutionContext {
  ownerKey: string;
  memDir: string;
  primaryFolder: string;
  runtimeKey: string;
  memoryAgentId: string;
  ipcInputDir: string;
  memoryProfile: ReturnType<typeof buildMemoryProfile>;
  runnerDescriptor: RunnerDescriptor;
  runtimeInputBase: Omit<RuntimeInput, 'prompt'>;
}

interface MemoryTranscriptExport {
  transcriptFile: string;
  workspaceFolder: string;
  chatJids: string[];
  wrapupCursors: Record<string, MessageCursor>;
}

interface MemoryRunResult {
  output: RuntimeOutput;
  parsed: {
    success: boolean;
    response?: string;
    error?: string;
  };
  followUps: MemorySyntheticLifecycleFollowUp[];
}

interface MemoryRuntimeRunContext
extends MemorySyntheticLifecycleHookContext {
  requestId: string;
  request: MemoryExecutionRequest;
  executionContext: MemoryExecutionContext;
  startTime: number;
  responseText: string;
  closeRequested: boolean;
  parsed: MemoryRunResult['parsed'] | null;
  executionProfile: RuntimeExecutionProfile;
}

export interface MemoryAgentResponse {
  requestId: string;
  success: boolean;
  response?: string;
  error?: string;
  transcriptFile?: string;
  workspaceFolder?: string;
  chatJids?: string[];
}

interface MemoryExecutionRequest {
  type: 'query' | 'remember' | 'session_wrapup' | 'global_sleep';
  query?: string;
  context?: string;
  content?: string;
  importance?: 'high' | 'normal';
  transcriptFile?: string;
  workspaceFolder?: string;
  groupFolder?: string;
  chatJids?: string[];
  chatJid?: string;
  channelLabel?: string;
  source?: string;
}

function resolveRequestWorkspaceFolder(
  request: Pick<MemoryExecutionRequest, 'workspaceFolder' | 'groupFolder'>,
): string | undefined {
  return request.workspaceFolder || request.groupFolder;
}

// --- Storage directory initialization ---

const INDEX_MD_TEMPLATE = `# 随身索引

> 本文件是记忆系统的随身索引，主 Agent 每次对话自动加载。
> 只放索引条目，不放具体内容。超限时 compact，不丢弃。
> 每条索引必须以 [YYYY-MM-DD] 开头，可选标记：⚑（高重要性）、∞（永久）

## 关于用户 (~30)

（暂无记录）
<!-- 示例：[2026-03-01|∞] 后端工程师，主要用 Go 和 TypeScript -->
<!-- 示例：[2026-03-10|⚑] 近期在考虑转岗到基础设施团队 -->

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
};

const INITIAL_META: Record<string, unknown> = {
  indexVersion: 0,
  totalImpressions: 0,
  totalKnowledgeFiles: 0,
  pendingMaintenance: [],
};

/**
 * Ensure the memory directory for a user has the full structure.
 * Safe to call multiple times (idempotent).
 */
export function ensureMemoryDir(ownerKey: string): string {
  const memDir = path.join(DATA_DIR, 'memory', ownerKey);

  // Create subdirectories
  for (const subdir of ['knowledge', 'impressions', 'transcripts']) {
    fs.mkdirSync(path.join(memDir, subdir), { recursive: true });
  }

  // Create index.md if missing
  const indexPath = path.join(memDir, 'index.md');
  if (!fs.existsSync(indexPath)) {
    fs.writeFileSync(indexPath, INDEX_MD_TEMPLATE, 'utf-8');
    logger.info({ ownerKey }, 'Created initial index.md for memory');
  }

  // Create state.json if missing
  const statePath = path.join(memDir, 'state.json');
  if (!fs.existsSync(statePath)) {
    fs.writeFileSync(
      statePath,
      JSON.stringify(INITIAL_STATE, null, 2) + '\n',
      'utf-8',
    );
    logger.info({ ownerKey }, 'Created initial state.json for memory');
  }

  // Create meta.json if missing (with migration from old state.json)
  const metaPath = path.join(memDir, 'meta.json');
  if (!fs.existsSync(metaPath)) {
    // Check if state.json contains old LLM-managed fields to migrate
    let meta: Record<string, unknown> = { ...INITIAL_META };
    try {
      const existingState = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      const hasOldFields =
        'indexVersion' in existingState ||
        'totalImpressions' in existingState ||
        'totalKnowledgeFiles' in existingState;

      if (hasOldFields) {
        // Extract LLM fields into meta
        meta = {
          indexVersion: existingState.indexVersion ?? 0,
          totalImpressions: existingState.totalImpressions ?? 0,
          totalKnowledgeFiles: existingState.totalKnowledgeFiles ?? 0,
          pendingMaintenance: existingState.pendingMaintenance ?? [],
        };
        // Remove LLM fields from state.json to prevent LLM from seeing them
        delete existingState.indexVersion;
        delete existingState.totalImpressions;
        delete existingState.totalKnowledgeFiles;
        delete existingState.pendingMaintenance;
        writeMemoryState(ownerKey, existingState);
        logger.info(
          { ownerKey },
          'Migrated LLM fields from state.json to meta.json',
        );
      }
    } catch {
      /* state.json parse error — use defaults */
    }

    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n', 'utf-8');
    logger.info({ ownerKey }, 'Created meta.json for memory');
  }

  return memDir;
}

/**
 * Read the memory state.json for a user.
 */
export function readMemoryState(ownerKey: string): Record<string, unknown> {
  const statePath = path.join(DATA_DIR, 'memory', ownerKey, 'state.json');
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
  ownerKey: string,
  state: Record<string, unknown>,
): void {
  const statePath = path.join(DATA_DIR, 'memory', ownerKey, 'state.json');
  const tmp = `${statePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, statePath);
}

/**
 * Read the memory meta.json for a user (LLM-managed metadata).
 */
export function readMemoryMeta(ownerKey: string): Record<string, unknown> {
  const metaPath = path.join(DATA_DIR, 'memory', ownerKey, 'meta.json');
  try {
    if (fs.existsSync(metaPath)) {
      return JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    }
  } catch {
    /* ignore parse errors */
  }
  return { ...INITIAL_META };
}

/**
 * Write the memory meta.json for a user (atomic write).
 */
export function writeMemoryMeta(
  ownerKey: string,
  meta: Record<string, unknown>,
): void {
  const metaPath = path.join(DATA_DIR, 'memory', ownerKey, 'meta.json');
  const tmp = `${metaPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, metaPath);
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
  rowid: number;
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
    channelSet.add(
      resolveChannelLabel(effectiveJid, nameMap.get(effectiveJid)),
    );
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
      const label = resolveChannelLabel(
        effectiveJid,
        nameMap.get(effectiveJid),
      );
      lines.push(`**${role}** (${time}) [${label}]: ${content}`, '');
    } else {
      lines.push(`**${role}** (${time}): ${content}`, '');
    }
  }

  return lines.join('\n');
}

function normalizeWrapupCursors(
  rawWrapups: Record<string, unknown>,
): Record<string, MessageCursor> {
  const wrapups: Record<string, MessageCursor> = {};
  for (const [jid, raw] of Object.entries(rawWrapups)) {
    if (
      raw &&
      typeof raw === 'object' &&
      typeof (raw as { rowid?: unknown }).rowid === 'number'
    ) {
      wrapups[jid] = { rowid: (raw as { rowid: number }).rowid };
    } else if (
      raw &&
      typeof raw === 'object' &&
      typeof (raw as { timestamp?: unknown }).timestamp === 'string'
    ) {
      wrapups[jid] = { rowid: 0 };
    } else {
      wrapups[jid] = { rowid: 0 };
    }
  }
  return wrapups;
}

function commitTranscriptExportSuccess(
  ownerKey: string,
  transcript: Pick<MemoryTranscriptExport, 'workspaceFolder' | 'wrapupCursors'>,
): void {
  const state = readMemoryState(ownerKey);
  const currentWrapups = normalizeWrapupCursors(
    (state.lastSessionWrapups || {}) as Record<string, unknown>,
  );
  for (const [jid, cursor] of Object.entries(transcript.wrapupCursors)) {
    const current = currentWrapups[jid];
    if (!current || cursor.rowid > current.rowid) {
      currentWrapups[jid] = { rowid: cursor.rowid };
    }
  }
  state.lastSessionWrapups = currentWrapups;
  state.lastSessionWrapupAt = new Date().toISOString();
  const pending = (state.pendingWrapups || []) as string[];
  if (!pending.includes(transcript.workspaceFolder)) {
    pending.push(transcript.workspaceFolder);
    state.pendingWrapups = pending;
  }
  writeMemoryState(ownerKey, state);
}

function isTranscriptCommitObsolete(
  ownerKey: string,
  wrapupCursors: Record<string, MessageCursor>,
): boolean {
  const currentWrapups = normalizeWrapupCursors(
    (readMemoryState(ownerKey).lastSessionWrapups || {}) as Record<
      string,
      unknown
    >,
  );
  return Object.entries(wrapupCursors).every(([jid, cursor]) => {
    const current = currentWrapups[jid];
    return !!current && current.rowid >= cursor.rowid;
  });
}

/**
 * Export transcripts for the owner's Session folder.
 * The caller decides whether to run `session_wrapup` immediately or defer it.
 */
export function exportTranscriptSnapshotForUser(
  ownerKey: string,
  folder: string,
  chatJids: string[],
): MemoryTranscriptExport | null {
  try {
    const memDir = ensureMemoryDir(ownerKey);
    const state = readMemoryState(ownerKey);
    const wrapups = normalizeWrapupCursors(
      (state.lastSessionWrapups || {}) as Record<string, unknown>,
    );
    const defaultCursor: MessageCursor = { rowid: 0 };

    const transcriptChatJids = new Set(chatJids);
    for (const agent of listAgentsByFolder(folder)) {
      if (agent.kind === 'conversation') {
        transcriptChatJids.add(`${agent.chat_jid}#agent:${agent.id}`);
      }
    }

    // Collect all messages from all associated chatJids, including virtual
    // conversation-agent channels that are not persisted in session_channels.
    const allMessages: TranscriptMessage[] = [];
    for (const jid of transcriptChatJids) {
      const cursor = wrapups[jid] || defaultCursor;
      const msgs = getTranscriptMessagesSince(jid, cursor);
      allMessages.push(
        ...msgs.map((m) => ({
          rowid: m.rowid,
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
      logger.debug(
        { ownerKey, folder },
        'No new messages for transcript export',
      );
      return null;
    }

    // Sort by insertion order (rowid) for stable ordering
    allMessages.sort((a, b) => a.rowid - b.rowid);

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
        ownerKey,
        folder,
        messageCount: allMessages.length,
        path: transcriptRelPath,
      },
      'Exported transcript for Memory Agent',
    );

    const nextWrapupCursors: Record<string, MessageCursor> = {};
    for (const jid of transcriptChatJids) {
      const jidMsgs = allMessages.filter((m) => m.chat_jid === jid);
      if (jidMsgs.length > 0) {
        const last = jidMsgs[jidMsgs.length - 1];
        nextWrapupCursors[jid] = { rowid: last.rowid };
      }
    }
    return {
      transcriptFile: transcriptRelPath,
      workspaceFolder: folder,
      chatJids: Array.from(transcriptChatJids),
      wrapupCursors: nextWrapupCursors,
    };
  } catch (err) {
    logger.error(
      { ownerKey, folder, err },
      'Failed to export transcript for Memory Agent',
    );
    return null;
  }
}

/**
 * Export transcripts for the owner's primary Session folder and trigger session_wrapup.
 * Extracted from index.ts so it can be called from both container exit listener and manual trigger.
 */
export async function exportTranscriptsForUser(
  ownerKey: string,
  folder: string,
  chatJids: string[],
  memoryOrchestrator: MemoryOrchestrator,
): Promise<MemoryAgentResponse | null> {
  const transcript = exportTranscriptSnapshotForUser(
    ownerKey,
    folder,
    chatJids,
  );
  if (!transcript) return null;
  const response = await memoryOrchestrator.send(ownerKey, {
    type: 'session_wrapup',
    transcriptFile: transcript.transcriptFile,
    workspaceFolder: transcript.workspaceFolder,
    chatJids: transcript.chatJids,
  });
  if (response.success) {
    commitTranscriptExportSuccess(ownerKey, transcript);
  }
  return {
    ...response,
    transcriptFile: transcript.transcriptFile,
    workspaceFolder: transcript.workspaceFolder,
    chatJids: transcript.chatJids,
  };
}

/**
 * Write a memory agent execution log to the primary session logs directory.
 */
function writeMemoryLog(
  ownerKey: string,
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
    const logsDir = path.join(
      GROUPS_DIR,
      resolvePrimarySessionFolder(
        ownerKey,
        getMemorySessionConfig(ownerKey),
        getPrimarySessionForOwner(ownerKey),
      ),
      'logs',
    );
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
      { ownerKey, filename, type: opts.type, status: opts.status, duration },
      'Wrote memory agent log',
    );
  } catch (err) {
    logger.error({ ownerKey, err }, 'Failed to write memory agent log');
  }
}

const MEMORY_SESSION_ID_PREFIX = 'memory:';

const MEMORY_CORE_INSTRUCTIONS = `你现在以 HappyClaw memory agent 的身份工作。

边界要求：
- 只允许读写 memory 目录里的文件
- 不要修改 memory 目录外的任何文件
- 不要调用 remember/query 之类的 memory 工具，也不要 invoke_agent
- 优先使用 rg、read、apply_patch、shell 这类本地工具
- 只在确有必要时创建新文件
- 除非任务明确要求，否则不要改动 state.json

目录约定：
- index.md: 随身索引，只放索引条目，不放长正文
- meta.json: 记忆元数据
- knowledge/: 详细知识
- impressions/: 语义索引
- impressions/archived/: 六个月前归档索引
- transcripts/: 原始对话记录
- personality.md: 用户交互风格观察

输出要求：
- 最终回答必须是单个 JSON 对象，不能带额外解释
- JSON 结构固定为 {"success":true|false,"response":"...","touchedFiles":["..."]}
- response 用自然语言简短总结结果
- touchedFiles 只放相对 memory 根目录的路径`;

function buildMemorySessionId(ownerKey: string): string {
  return `${MEMORY_SESSION_ID_PREFIX}${ownerKey}`;
}

function resolvePrimarySessionFolder(
  ownerKey: string,
  memorySession: SessionRecord | undefined,
  primarySession?: SessionRecord,
): string {
  if (memorySession?.parent_session_id?.startsWith('main:')) {
    return memorySession.parent_session_id.slice('main:'.length);
  }
  if (primarySession?.id.startsWith('main:')) {
    return primarySession.id.slice('main:'.length);
  }
  throw new Error(`No primary session found for memory owner ${ownerKey}`);
}

function listOwnedPrimaryFolders(ownerKey: string): string[] {
  return Array.from(
    new Set(
      listSessionRecords()
        .filter(
          (session) =>
            session.owner_key === ownerKey &&
            session.id.startsWith('main:') &&
            (session.kind === 'main' || session.kind === 'workspace'),
        )
        .map((session) => session.id.slice('main:'.length)),
    ),
  );
}

function getMemorySessionConfig(ownerKey: string) {
  return getSessionRecord(buildMemorySessionId(ownerKey));
}

function ensureMemorySessionProjection(
  ownerKey: string,
  memDir: string,
  primarySession: SessionRecord | undefined,
  existing: SessionRecord | undefined,
): SessionRecord {
  if (existing) {
    const nextParentSessionId =
      existing.parent_session_id || primarySession?.id || null;
    const nextOwnerKey = existing.owner_key || ownerKey;
    const nextSession =
      nextParentSessionId !== existing.parent_session_id ||
      nextOwnerKey !== existing.owner_key
        ? {
            ...existing,
            parent_session_id: nextParentSessionId,
            owner_key: nextOwnerKey,
            updated_at: new Date().toISOString(),
          }
        : existing;
    if (nextSession !== existing) {
      saveSessionRecord(nextSession);
    }
    return nextSession;
  }
  const now = new Date().toISOString();
  const runnerId = resolveMemoryRunnerId(primarySession?.runner_id || null);
  const session: SessionRecord = {
    id: buildMemorySessionId(ownerKey),
    name: `memory:${ownerKey}`,
    kind: 'memory',
    parent_session_id: primarySession?.id ?? null,
    cwd: memDir,
    runner_id: runnerId,
    runner_profile_id:
      primarySession?.runner_id === runnerId
        ? (primarySession.runner_profile_id ?? null)
        : null,
    model:
      primarySession?.runner_id === runnerId
        ? (primarySession?.model ?? null)
        : null,
    thinking_effort:
      primarySession?.runner_id === runnerId
        ? (primarySession?.thinking_effort ?? null)
        : null,
    context_compression: primarySession?.context_compression ?? 'off',
    is_pinned: false,
    archived: false,
    owner_key: ownerKey,
    created_at: now,
    updated_at: now,
  };
  saveSessionRecord(session);
  return session;
}

function parseJsonText<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function buildMemoryExecutionProfile(
  profile: ReturnType<typeof buildMemoryProfile>,
): RuntimeExecutionProfile {
  return {
    profileId: profile.profileId,
    additionalDirectories: profile.allowedDirectories,
    disableUserMcpServers: profile.disableUserMcpServers,
    disabledPlugins: profile.disabledPlugins,
    toolScope: profile.toolScope,
  };
}

function buildMemoryPromptPreamble(
  request: MemoryExecutionRequest,
  memDir: string,
): string {
  const workspaceFolder = resolveRequestWorkspaceFolder(request);
  const lines: string[] = [MEMORY_CORE_INSTRUCTIONS];

  lines.push('', `memory 根目录: ${memDir}`, `请求类型: ${request.type}`);

  if (request.type === 'query') {
    lines.push(
      '',
      '处理要求：',
      '- 先查 index.md',
      '- 没命中再查 impressions/，必要时查 archived',
      '- 命中后按需读 knowledge/ 或 transcripts/',
      '- 找到答案后，顺手做 1 到 3 处轻量索引修复',
      '- 回答里尽量包含来源、时间、渠道',
      '',
      `查询内容: ${request.query || ''}`,
    );
    if (request.context) lines.push(`补充上下文: ${request.context}`);
    if (workspaceFolder) lines.push(`来源会话: ${workspaceFolder}`);
    if (request.chatJid) lines.push(`来源渠道 JID: ${request.chatJid}`);
    if (request.channelLabel) lines.push(`来源渠道名: ${request.channelLabel}`);
  } else if (request.type === 'remember') {
    lines.push(
      '',
      '处理要求：',
      '- 判断内容属于用户信息、偏好、项目知识还是临时提醒',
      '- 写入 knowledge/ 或其他合适文件',
      '- 更新 index.md，保证后续可检索',
      '- 如果存在冲突，保留更可信的新自述并在 response 里说明',
      '',
      `记忆内容: ${request.content || ''}`,
      `重要性: ${request.importance || 'normal'}`,
    );
    if (request.source) lines.push(`来源: ${request.source}`);
    if (workspaceFolder) lines.push(`来源会话: ${workspaceFolder}`);
    if (request.chatJid) lines.push(`来源渠道 JID: ${request.chatJid}`);
    if (request.channelLabel) lines.push(`来源渠道名: ${request.channelLabel}`);
  } else if (request.type === 'session_wrapup') {
    lines.push(
      '',
      '处理要求：',
      '- 读取 transcriptFile 指向的对话记录',
      '- 生成 impressions/ 语义索引',
      '- 提炼 knowledge/，合并而不是粗暴覆盖',
      '- 更新 index.md 的近期上下文和必要索引',
      '- 更新 meta.json 里的 totalImpressions 和 totalKnowledgeFiles',
      '- 不要修改 state.json',
      '',
      `转录文件: ${request.transcriptFile || ''}`,
      `所属会话: ${workspaceFolder || ''}`,
    );
    if (request.chatJids?.length) {
      lines.push(`涉及渠道: ${request.chatJids.join(', ')}`);
    }
  } else if (request.type === 'global_sleep') {
    lines.push(
      '',
      '处理要求：',
      '- 备份并 compact index.md',
      '- 清理过期提醒与过旧 impressions 归档',
      '- 维护 knowledge/ 的拆分、合并与 See Also',
      '- 自审索引结构',
      '- 更新 personality.md',
      '- 更新 meta.json 的 indexVersion、计数和 pendingMaintenance',
      '- 不要修改 state.json',
    );
  }

  return lines.join('\n');
}

function parseMemoryAgentResponseText(raw: string | null | undefined): {
  success: boolean;
  response?: string;
  error?: string;
} {
  const text = raw?.trim();
  if (!text) {
    return { success: false, error: 'Memory runner returned empty response' };
  }
  try {
    const parsed = JSON.parse(text) as {
      success?: boolean;
      response?: string;
      error?: string;
    };
    if (typeof parsed.success === 'boolean') {
      return {
        success: parsed.success,
        response: parsed.response,
        error: parsed.error,
      };
    }
  } catch {
    // Fall through to plain text response
  }
  return { success: true, response: text };
}

function persistMemoryRuntimeSnapshot(
  ownerKey: string,
  output: RuntimeOutput,
): void {
  if (!output.runtimeState && !output.newSessionId) return;
  const sessionId = buildMemorySessionId(ownerKey);
  const current = getSessionRuntimeState(sessionId);
  upsertSessionRuntimeState(sessionId, {
    providerSessionId:
      output.runtimeState?.providerSessionId ||
      output.newSessionId ||
      current?.provider_session_id ||
      undefined,
    resumeAnchor:
      output.runtimeState?.resumeAnchor || current?.resume_anchor || undefined,
    providerState:
      output.runtimeState?.providerState ||
      parseJsonText<Record<string, unknown>>(current?.provider_state_json, {}),
    recentImChannels:
      output.runtimeState?.recentImChannels ||
      parseJsonText<string[]>(current?.recent_im_channels_json, []),
    imChannelLastSeen:
      output.runtimeState?.imChannelLastSeen ||
      parseJsonText<Record<string, number>>(
        current?.im_channel_last_seen_json,
        {},
      ),
    currentPermissionMode:
      output.runtimeState?.currentPermissionMode ||
      current?.current_permission_mode ||
      'default',
    lastMessageCursor:
      output.runtimeState?.lastMessageCursor ??
      current?.last_message_cursor ??
      null,
  });
}

class MemoryPromptBuilderHook
implements RuntimeExecutionHook<
  MemoryRuntimeRunContext,
  MemorySyntheticLifecycleFollowUp
> {
  readonly name = 'MemoryPromptBuilderHook';

  beforeRun(ctx: MemoryRuntimeRunContext): { promptPreamble: string } {
    return {
      promptPreamble: buildMemoryPromptPreamble(
        ctx.request,
        ctx.executionContext.memDir,
      ),
    };
  }
}

class RuntimeStatePersistenceHook
implements RuntimeExecutionHook<
  MemoryRuntimeRunContext,
  MemorySyntheticLifecycleFollowUp
> {
  readonly name = 'RuntimeStatePersistenceHook';

  async onOutput(
    ctx: MemoryRuntimeRunContext,
    output: RuntimeOutput,
  ): Promise<void> {
    persistMemoryRuntimeSnapshot(ctx.executionContext.ownerKey, output);
  }

  afterRun(ctx: MemoryRuntimeRunContext, result: RunResult): void {
    if (result.output) {
      persistMemoryRuntimeSnapshot(ctx.executionContext.ownerKey, result.output);
    }
  }
}

class StreamingTextCollectorHook
implements RuntimeExecutionHook<
  MemoryRuntimeRunContext,
  MemorySyntheticLifecycleFollowUp
> {
  readonly name = 'StreamingTextCollectorHook';

  onOutput(ctx: MemoryRuntimeRunContext, output: RuntimeOutput): void {
    if (
      output.status === 'stream' &&
      output.streamEvent?.eventType === 'text_delta' &&
      output.streamEvent.text
    ) {
      ctx.responseText += output.streamEvent.text;
    }
  }
}

class OneShotCloseHook
implements RuntimeExecutionHook<
  MemoryRuntimeRunContext,
  MemorySyntheticLifecycleFollowUp
> {
  readonly name = 'OneShotCloseHook';

  onOutput(ctx: MemoryRuntimeRunContext, output: RuntimeOutput): void {
    if (
      ctx.closeRequested ||
      (output.status !== 'success' && output.status !== 'error')
    ) {
      return;
    }
    ctx.closeRequested = true;
    fs.mkdirSync(ctx.executionContext.ipcInputDir, { recursive: true });
    fs.writeFileSync(
      path.join(ctx.executionContext.ipcInputDir, '_close'),
      '',
    );
  }
}

class ResponseParserHook
implements RuntimeExecutionHook<
  MemoryRuntimeRunContext,
  MemorySyntheticLifecycleFollowUp
> {
  readonly name = 'ResponseParserHook';

  afterRun(
    ctx: MemoryRuntimeRunContext,
    result: RunResult,
  ): void {
    const parsedBase = parseMemoryAgentResponseText(
      ctx.responseText ||
        result.terminalOutput?.result ||
        result.output?.result ||
        null,
    );
    if (result.output?.status === 'error' || result.error) {
      ctx.parsed = {
        success: false,
        response: parsedBase.response,
        error:
          parsedBase.error ||
          result.output?.error ||
          result.error?.message ||
          'Memory runner exited with error',
      };
      return;
    }
    ctx.parsed = parsedBase;
  }
}

class RunLogHook
implements RuntimeExecutionHook<
  MemoryRuntimeRunContext,
  MemorySyntheticLifecycleFollowUp
> {
  readonly name = 'RunLogHook';

  afterRun(
    ctx: MemoryRuntimeRunContext,
    result: RunResult,
  ): void {
    const parsed = ctx.parsed || {
      success: false,
      error:
        result.error?.message ||
        result.output?.error ||
        'Memory runner exited with error',
    };
    writeMemoryLog(ctx.executionContext.ownerKey, {
      type: ctx.request.type,
      startTime: ctx.startTime,
      status:
        result.error && /timed out/i.test(result.error.message)
          ? 'timeout'
          : parsed.success
            ? 'success'
            : 'error',
      exitCode: parsed.success ? 0 : 1,
      response: parsed.response,
      stderr: [],
      error: parsed.error,
    });
  }
}

const MEMORY_RUNTIME_HOOKS: RuntimeExecutionHook<
  MemoryRuntimeRunContext,
  MemorySyntheticLifecycleFollowUp
>[] = [
  new MemoryPromptBuilderHook(),
  new SyntheticArchiveLifecycleHook(),
  new RuntimeStatePersistenceHook(),
  new StreamingTextCollectorHook(),
  new OneShotCloseHook(),
  new ResponseParserHook(),
  new RunLogHook(),
];

export class MemoryOrchestrator {
  private agents: Map<string, AgentEntry> = new Map();
  private idleCheckTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly requestExecutor: RuntimeRequestExecutor<
      MemoryRuntimeRunContext,
      MemorySyntheticLifecycleFollowUp
    > =
      new RuntimeRequestExecutor(MEMORY_RUNTIME_HOOKS),
  ) {}

  startIdleChecks(): void {
    if (this.idleCheckTimer) return;
    this.idleCheckTimer = setInterval(() => {
      this.checkIdleAgents();
    }, IDLE_CHECK_INTERVAL_MS);
    this.idleCheckTimer.unref();
  }

  stopIdleChecks(): void {
    if (!this.idleCheckTimer) return;
    clearInterval(this.idleCheckTimer);
    this.idleCheckTimer = null;
  }

  private ensureAgent(ownerKey: string): AgentEntry {
    const existing = this.agents.get(ownerKey);
    if (existing) {
      existing.lastActivity = Date.now();
      return existing;
    }
    if (this.agents.size >= MAX_CONCURRENT_MEMORY_AGENTS) {
      throw new Error(
        `Memory Agent concurrency limit reached (${MAX_CONCURRENT_MEMORY_AGENTS})`,
      );
    }
    const entry: AgentEntry = {
      lastActivity: Date.now(),
      inFlight: 0,
      tail: Promise.resolve(),
    };
    this.agents.set(ownerKey, entry);
    return entry;
  }

  private async runSerialized<T>(
    ownerKey: string,
    task: () => Promise<T>,
  ): Promise<T> {
    const entry = this.ensureAgent(ownerKey);
    entry.inFlight += 1;
    entry.lastActivity = Date.now();

    const previous = entry.tail;
    let release!: () => void;
    entry.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    try {
      await previous;
      return await task();
    } finally {
      entry.inFlight = Math.max(0, entry.inFlight - 1);
      entry.lastActivity = Date.now();
      release();
    }
  }

  private prepareExecutionContext(ownerKey: string): MemoryExecutionContext {
    const memorySession = getMemorySessionConfig(ownerKey);
    const primarySession = getPrimarySessionForOwner(ownerKey);
    if (!memorySession && !primarySession) {
      throw new Error(`No memory session found for ${ownerKey}`);
    }

    const memDir = ensureMemoryDir(ownerKey);
    const effectiveMemorySession = ensureMemorySessionProjection(
      ownerKey,
      memDir,
      primarySession,
      memorySession,
    );
    const runnerDescriptor = getRunnerDescriptor(
      effectiveMemorySession.runner_id,
    );
    if (!runnerDescriptor) {
      throw new Error(
        `Unknown memory runner "${effectiveMemorySession.runner_id}"`,
      );
    }

    const primaryFolder = resolvePrimarySessionFolder(
      ownerKey,
      effectiveMemorySession,
      primarySession,
    );
    const groupDir = effectiveMemorySession.cwd || memDir;
    fs.mkdirSync(groupDir, { recursive: true });
    fs.mkdirSync(path.join(GROUPS_DIR, 'user-global', ownerKey), {
      recursive: true,
    });
    fs.mkdirSync(path.join(DATA_DIR, 'skills', ownerKey), { recursive: true });

    const runtimeKey = buildMemorySessionId(ownerKey);
    const memoryAgentId = `memory-${ownerKey}`;
    const runtimeState = getSessionRuntimeState(runtimeKey);
    const ipcInputDir = path.join(
      DATA_DIR,
      'ipc',
      primaryFolder,
      'agents',
      memoryAgentId,
      'input',
    );
    fs.mkdirSync(ipcInputDir, { recursive: true });

    const user = getUserById(ownerKey);
    const memoryProfile = buildMemoryProfile({
      ownerKey,
      runtimeKey,
      primaryFolder,
      groupDir,
      memorySession: effectiveMemorySession,
    });

    return {
      ownerKey,
      memDir,
      primaryFolder,
      runtimeKey,
      memoryAgentId,
      ipcInputDir,
      memoryProfile,
      runnerDescriptor,
      runtimeInputBase: {
        sessionId: runtimeState?.provider_session_id || undefined,
        resumeAnchor: runtimeState?.resume_anchor || undefined,
        sessionRecordId: runtimeKey,
        workspaceFolder: primaryFolder,
        chatJid: runtimeKey,
        isHome: false,
        isAdminHome: user?.role === 'admin' && primaryFolder === 'main',
        agentId: memoryAgentId,
        bootstrapState: runtimeState
          ? {
              providerState: parseJsonText<Record<string, unknown>>(
                runtimeState.provider_state_json,
                {},
              ),
              recentImChannels: parseJsonText<string[]>(
                runtimeState.recent_im_channels_json,
                [],
              ),
              imChannelLastSeen: parseJsonText<Record<string, number>>(
                runtimeState.im_channel_last_seen_json,
                {},
              ),
              currentPermissionMode: runtimeState.current_permission_mode,
              lastMessageCursor: runtimeState.last_message_cursor,
            }
          : undefined,
      },
    };
  }

  private persistSyntheticState(runContext: MemoryRuntimeRunContext): void {
    const latestState = readMemoryState(runContext.executionContext.ownerKey);
    writeMemoryState(
      runContext.executionContext.ownerKey,
      writeMemorySyntheticLifecycleState(latestState, runContext.syntheticState),
    );
  }

  private buildSyntheticWrapupJobs(ownerKey: string): MemorySyntheticWrapupJob[] {
    const queuedAt = new Date().toISOString();
    const wrapupJobs: MemorySyntheticWrapupJob[] = [];
    for (const folder of listOwnedPrimaryFolders(ownerKey)) {
      const transcript = exportTranscriptSnapshotForUser(
        ownerKey,
        folder,
        getJidsByFolder(folder),
      );
      if (!transcript) continue;
      wrapupJobs.push({
        workspaceFolder: transcript.workspaceFolder,
        transcriptFile: transcript.transcriptFile,
        chatJids: transcript.chatJids,
        queuedAt,
        wrapupCursors: transcript.wrapupCursors,
      });
    }
    return wrapupJobs;
  }

  private createRunContext(
    context: MemoryExecutionContext,
    requestId: string,
    request: MemoryExecutionRequest,
  ): MemoryRuntimeRunContext {
    let runContext!: MemoryRuntimeRunContext;
    runContext = {
      requestId,
      request,
      requestType: request.type,
      executionContext: context,
      startTime: Date.now(),
      responseText: '',
      closeRequested: false,
      parsed: null,
      executionProfile: buildMemoryExecutionProfile(context.memoryProfile),
      syntheticLifecycleStrategy: getMemoryLifecycleStrategy(
        context.runnerDescriptor,
      ),
      syntheticState: readMemorySyntheticLifecycleState(
        readMemoryState(context.ownerKey),
      ),
      syntheticRepairPromptApplied: false,
      syntheticArchiveCompletion: null,
      persistSyntheticState: () => {
        this.persistSyntheticState(runContext);
      },
      flushSyntheticWrapupJobs: (jobs) =>
        this.flushSyntheticWrapupJobs(runContext, jobs),
      buildSyntheticWrapupJobs: () =>
        this.buildSyntheticWrapupJobs(context.ownerKey),
    };
    return runContext;
  }

  private async processRunFollowUps(
    runContext: MemoryRuntimeRunContext,
    followUps: MemorySyntheticLifecycleFollowUp[],
  ): Promise<void> {
    for (const followUp of followUps) {
      if (followUp.type !== 'flush_synthetic_wrapups') {
        continue;
      }
      const remaining = await runContext.flushSyntheticWrapupJobs(
        followUp.jobs,
      );
      runContext.syntheticState = {
        ...runContext.syntheticState,
        pendingWrapupJobs: remaining,
      };
      runContext.persistSyntheticState();
    }
  }

  private async runRequest(
    context: MemoryExecutionContext,
    requestId: string,
    request: MemoryExecutionRequest,
    timeoutMs: number,
    opts?: {
      onOutput?: (output: RuntimeOutput) => Promise<void> | void;
    },
  ): Promise<MemoryRunResult> {
    const runtimeState = getSessionRuntimeState(context.runtimeKey);
    const input: RuntimeInput = {
      ...context.runtimeInputBase,
      sessionId: runtimeState?.provider_session_id || undefined,
      resumeAnchor: runtimeState?.resume_anchor || undefined,
      bootstrapState: runtimeState
        ? {
            providerState: parseJsonText<Record<string, unknown>>(
              runtimeState.provider_state_json,
              {},
            ),
            recentImChannels: parseJsonText<string[]>(
              runtimeState.recent_im_channels_json,
              [],
            ),
            imChannelLastSeen: parseJsonText<Record<string, number>>(
              runtimeState.im_channel_last_seen_json,
              {},
            ),
            currentPermissionMode: runtimeState.current_permission_mode,
            lastMessageCursor: runtimeState.last_message_cursor,
          }
        : undefined,
      prompt: '',
    };

    const runContext = this.createRunContext(context, requestId, request);

    try {
      const result = await this.requestExecutor.run({
        input,
        ctx: runContext,
        executionProfile: runContext.executionProfile,
        execute: async (effectiveInput, onOutput, executionProfile) =>
          runSessionAgent(
            context.memoryProfile.registeredGroup,
            effectiveInput,
            () => {},
            async (runtimeOutput) => {
              await onOutput(runtimeOutput);
              await opts?.onOutput?.(runtimeOutput);
            },
            context.primaryFolder,
            executionProfile,
          ),
      });
      await this.processRunFollowUps(runContext, result.followUps);
      if (!result.output) {
        throw new Error('Memory runner completed without final output');
      }
      return {
        output: result.output,
        parsed:
          runContext.parsed ||
          parseMemoryAgentResponseText(
            runContext.responseText ||
              result.terminalOutput?.result ||
              result.output.result ||
              null,
          ),
        followUps: result.followUps,
      };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (!runContext.parsed) {
        runContext.parsed = {
          success: false,
          error: error.message,
        };
      }
      throw error;
    }
  }

  private async flushSyntheticWrapupJobs(
    runContext: MemoryRuntimeRunContext,
    jobs: MemorySyntheticWrapupJob[],
  ): Promise<MemorySyntheticWrapupJob[]> {
    if (jobs.length === 0) return [];
    const makeJobKey = (job: MemorySyntheticWrapupJob) =>
      `${job.workspaceFolder}::${job.transcriptFile}`;
    const remainingJobs = new Map(
      runContext.syntheticState.pendingWrapupJobs.map((job) => [
        makeJobKey(job),
        job,
      ]),
    );

    for (const job of jobs) {
      const jobKey = makeJobKey(job);
      if (!remainingJobs.has(jobKey)) {
        continue;
      }
      if (
        Object.keys(job.wrapupCursors).length > 0 &&
        isTranscriptCommitObsolete(
          runContext.executionContext.ownerKey,
          job.wrapupCursors,
        )
      ) {
        remainingJobs.delete(jobKey);
        runContext.syntheticState = {
          ...runContext.syntheticState,
          pendingWrapupJobs: Array.from(remainingJobs.values()),
        };
        runContext.persistSyntheticState();
        continue;
      }
      const result = await this.runRequest(
        runContext.executionContext,
        crypto.randomUUID(),
        {
          type: 'session_wrapup',
          transcriptFile: job.transcriptFile,
          workspaceFolder: job.workspaceFolder,
          chatJids: job.chatJids,
        },
        getSystemSettings().memorySendTimeout,
      );
      if (!result.parsed.success) {
        logger.warn(
          {
            ownerKey: runContext.executionContext.ownerKey,
            workspaceFolder: job.workspaceFolder,
            transcriptFile: job.transcriptFile,
            error: result.parsed.error,
          },
          'Synthetic memory wrapup flush failed',
        );
        continue;
      }
      commitTranscriptExportSuccess(runContext.executionContext.ownerKey, {
        workspaceFolder: job.workspaceFolder,
        wrapupCursors: job.wrapupCursors,
      });
      remainingJobs.delete(jobKey);
      runContext.syntheticState = {
        ...runContext.syntheticState,
        pendingWrapupJobs: Array.from(remainingJobs.values()),
      };
      runContext.persistSyntheticState();
    }
    return Array.from(remainingJobs.values());
  }

  private async execute(
    ownerKey: string,
    requestId: string,
    request: MemoryExecutionRequest,
    timeoutMs: number,
  ): Promise<MemoryAgentResponse> {
    const context = this.prepareExecutionContext(ownerKey);
    const result = await this.runRequest(
      context,
      requestId,
      request,
      timeoutMs,
      undefined,
    );

    return {
      requestId,
      success: result.parsed.success,
      response: result.parsed.response,
      error: result.parsed.error,
    };
  }

  async query(
    ownerKey: string,
    options: {
      query: string;
      context?: string;
      chatJid?: string;
      workspaceFolder?: string;
      channelLabel?: string;
    },
  ): Promise<MemoryAgentResponse> {
    const requestId = crypto.randomUUID();
    const timeoutMs =
      getSystemSettings().memoryQueryTimeout || DEFAULT_QUERY_TIMEOUT_MS;
    return this.runSerialized(ownerKey, () =>
      this.execute(
        ownerKey,
        requestId,
        {
          type: 'query',
          query: options.query,
          context: options.context,
          chatJid: options.chatJid,
          workspaceFolder: options.workspaceFolder,
          channelLabel: options.channelLabel,
        },
        timeoutMs,
      ),
    );
  }

  async send(
    ownerKey: string,
    message: Record<string, unknown>,
  ): Promise<MemoryAgentResponse> {
    const requestId = crypto.randomUUID();
    const msgType = String(message.type || 'unknown');
    if (
      msgType !== 'remember' &&
      msgType !== 'session_wrapup' &&
      msgType !== 'global_sleep'
    ) {
      throw new Error(`Unsupported memory message type: ${msgType}`);
    }
    const settings = getSystemSettings();
    const timeoutMs =
      msgType === 'global_sleep'
        ? settings.memoryGlobalSleepTimeout
        : settings.memorySendTimeout;
    return this.runSerialized(ownerKey, () =>
      this.execute(
        ownerKey,
        requestId,
        {
          ...(message as Record<string, unknown>),
          type: msgType,
        } as unknown as MemoryExecutionRequest,
        timeoutMs,
      ),
    );
  }

  start(): void {
    this.startIdleChecks();
  }

  stop(): void {
    this.stopIdleChecks();
  }

  remember(
    ownerKey: string,
    content: string,
    source?: string,
  ): Promise<MemoryAgentResponse> {
    return this.send(ownerKey, {
      type: 'remember',
      content,
      source,
    });
  }

  sessionWrapup(
    ownerKey: string,
    workspaceFolder: string,
  ): Promise<MemoryAgentResponse> {
    return this.send(ownerKey, {
      type: 'session_wrapup',
      workspaceFolder,
    });
  }

  globalSleep(ownerKey: string): Promise<MemoryAgentResponse> {
    return this.send(ownerKey, { type: 'global_sleep' });
  }

  exportSessionTranscripts(
    ownerKey: string,
    workspaceFolder: string,
    chatJid: string,
  ): Promise<MemoryAgentResponse | null> {
    return this.exportTranscripts(ownerKey, workspaceFolder, [chatJid]);
  }

  exportTranscripts(
    ownerKey: string,
    workspaceFolder: string,
    chatJids: string[],
  ): Promise<MemoryAgentResponse | null> {
    return exportTranscriptsForUser(ownerKey, workspaceFolder, chatJids, this);
  }

  checkIdleAgents(): void {
    const now = Date.now();
    for (const [ownerKey, entry] of this.agents) {
      if (entry.inFlight === 0 && now - entry.lastActivity > IDLE_TIMEOUT_MS) {
        logger.info({ ownerKey }, 'Pruning idle memory session coordinator');
        this.agents.delete(ownerKey);
      }
    }
  }

  async shutdownAll(): Promise<void> {
    this.stopIdleChecks();
    const ownersToFlush = new Set<string>(this.agents.keys());
    for (const session of listSessionRecords()) {
      if (session.kind !== 'memory' || !session.owner_key) continue;
      const syntheticState = readMemorySyntheticLifecycleState(
        readMemoryState(session.owner_key),
      );
      if (syntheticState.pendingWrapupJobs.length > 0) {
        ownersToFlush.add(session.owner_key);
      }
    }

    for (const ownerKey of ownersToFlush) {
      try {
        await this.runSerialized(ownerKey, async () => {
          const context = this.prepareExecutionContext(ownerKey);
          await this.requestExecutor.shutdown(
            this.createRunContext(context, crypto.randomUUID(), {
              type: 'global_sleep',
            }),
          );
        });
      } catch (err) {
        logger.warn(
          { ownerKey, err },
          'Failed to flush synthetic memory wrapups during shutdown',
        );
      }
    }

    for (const entry of this.agents.values()) {
      try {
        await entry.tail;
      } catch {
        // Ignore tail failures during shutdown
      }
    }
    this.agents.clear();
  }

  get activeCount(): number {
    return Array.from(this.agents.values()).filter(
      (entry) => entry.inFlight > 0,
    ).length;
  }

  hasAgent(ownerKey: string): boolean {
    return this.agents.has(ownerKey);
  }
}

// --- Global sleep scheduling ---

export interface GlobalSleepDeps {
  manager: MemoryOrchestrator;
  queue: SessionRuntimeManager;
}

let lastGlobalSleepCheck = 0;
const GLOBAL_SLEEP_CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Check and trigger Memory Agent global_sleep for eligible users.
 * Called from the scheduler loop every 60s, but actually executes at most
 * once per ~30 minutes. No time-of-day restriction.
 *
 * Conditions per user:
 *   1. lastGlobalSleep > 6 hours ago (or never)
 *   2. No active sessions for this user
 *   3. Has pending wrapups (session_wrapup triggered since last global_sleep)
 */
export function runMemoryGlobalSleepIfNeeded(deps: GlobalSleepDeps): void {
  const now = Date.now();

  // Throttle: skip if checked less than 30 minutes ago
  if (now - lastGlobalSleepCheck < GLOBAL_SLEEP_CHECK_INTERVAL_MS) return;
  lastGlobalSleepCheck = now;

  logger.info('Memory global_sleep: checking eligible users');

  // Build set of active group JIDs for quick lookup
  const queueStatus = deps.queue.getRuntimeStatus();
  const activeRuntimeFolders = new Set(
    queueStatus.groups
      .filter((g) => g.active && g.groupFolder)
      .map((g) => g.groupFolder as string),
  );

  const memoryOwners = new Set(
    listSessionRecords()
      .filter((session) => session.kind === 'memory' && session.owner_key)
      .map((session) => session.owner_key!),
  );

  let triggered = 0;
  for (const ownerKey of memoryOwners) {
    const state = readMemoryState(ownerKey);

    // 2. lastGlobalSleep > 6 hours ago (or never run)
    const lastSleep = state.lastGlobalSleep as string | null;
    if (lastSleep) {
      const hoursSince =
        (now - new Date(lastSleep).getTime()) / (1000 * 60 * 60);
      if (hoursSince < 6) continue;
    }

    // 3. No active sessions for this user's explicit session folders
    const ownedFolders = new Set(listOwnedPrimaryFolders(ownerKey));
    const hasActiveSession = Array.from(activeRuntimeFolders).some((folder) =>
      ownedFolders.has(folder),
    );
    if (hasActiveSession) continue;

    // 4. Has pending wrapups
    const pendingWrapups = (state.pendingWrapups || []) as string[];
    if (pendingWrapups.length === 0) continue;

    // All conditions met — trigger global_sleep
    logger.info({ ownerKey }, 'Triggering Memory Agent global_sleep');
    deps.manager
      .send(ownerKey, { type: 'global_sleep' })
      .then(() => {
        // Main process updates state.json after successful global_sleep
        // (LLM no longer touches state.json — it only manages meta.json)
        const updatedState = readMemoryState(ownerKey);
        updatedState.lastGlobalSleep = new Date().toISOString();
        updatedState.pendingWrapups = [];
        writeMemoryState(ownerKey, updatedState);
        logger.info(
          { ownerKey },
          'Memory Agent global_sleep completed, state updated',
        );
      })
      .catch((err) => {
        logger.warn({ ownerKey, err }, 'Memory Agent global_sleep failed');
      });
    triggered++;
  }

  if (triggered > 0) {
    logger.info({ triggered }, 'Memory global_sleep: triggered for users');
  }
}
