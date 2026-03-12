// Memory management routes and utilities

import { Hono } from 'hono';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Variables } from '../web-context.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  MemoryFileSchema,
  MemoryGlobalSchema,
  type MemorySource,
  type MemoryFilePayload,
  type MemorySearchHit,
} from '../schemas.js';
import { getAllRegisteredGroups, getGroupsByOwner, getJidsByFolder, getUserById, getUserHomeGroup } from '../db.js';
import { logger } from '../logger.js';
import { GROUPS_DIR, DATA_DIR } from '../config.js';
import type { AuthUser } from '../types.js';
import type { MemoryAgentManager } from '../memory-agent.js';
import { readMemoryState, exportTranscriptsForUser } from '../memory-agent.js';
import { getUserMemoryMode } from '../runtime-config.js';
import type { GroupQueue } from '../group-queue.js';

const memoryRoutes = new Hono<{ Variables: Variables }>();

// --- Per-user operation locks (prevent duplicate trigger-wrapup / trigger-global-sleep) ---

const activeWrapups = new Set<string>();
const activeGlobalSleeps = new Set<string>();

// --- Constants ---

const USER_GLOBAL_DIR = path.join(GROUPS_DIR, 'user-global');
const MAIN_MEMORY_DIR = path.join(GROUPS_DIR, 'main');
const MAIN_MEMORY_FILE = path.join(MAIN_MEMORY_DIR, 'CLAUDE.md');
const MEMORY_DATA_DIR = path.join(DATA_DIR, 'memory');
const MAX_GLOBAL_MEMORY_LENGTH = 200_000;
const MAX_MEMORY_FILE_LENGTH = 500_000;
const MEMORY_LIST_LIMIT = 500;
const MEMORY_SEARCH_LIMIT = 120;
const MEMORY_SOURCE_EXTENSIONS = new Set([
  '.md',
  '.txt',
  '.json',
  '.jsonl',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.cfg',
  '.conf',
]);

// --- Utility Functions ---

function isWithinRoot(targetPath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

function normalizeRelativePath(input: unknown): string {
  if (typeof input !== 'string') {
    throw new Error('path must be a string');
  }
  const normalized = input.replace(/\\/g, '/').trim().replace(/^\/+/, '');
  if (!normalized || normalized.includes('\0')) {
    throw new Error('Invalid memory path');
  }
  const parts = normalized.split('/');
  if (parts.some((p) => !p || p === '.' || p === '..')) {
    throw new Error('Invalid memory path');
  }
  return normalized;
}

function resolveMemoryPath(
  relativePath: string,
  user: AuthUser,
): {
  absolutePath: string;
  writable: boolean;
} {
  const absolute = path.resolve(process.cwd(), relativePath);
  const inGroups = isWithinRoot(absolute, GROUPS_DIR);
  const inMemoryData = isWithinRoot(absolute, MEMORY_DATA_DIR);
  const writable = inGroups || inMemoryData;

  if (!writable) {
    throw new Error('Memory path out of allowed scope');
  }

  // User ownership check for non-admin
  if (user.role !== 'admin') {
    // user-global/{userId}/... — member can only access their own
    if (isWithinRoot(absolute, USER_GLOBAL_DIR)) {
      const relToUserGlobal = path.relative(USER_GLOBAL_DIR, absolute);
      const ownerUserId = relToUserGlobal.split(path.sep)[0];
      if (ownerUserId !== user.id) {
        throw new Error('Memory path out of allowed scope');
      }
    }
    // data/groups/{folder}/... — check group ownership
    else if (inGroups) {
      const relToGroups = path.relative(GROUPS_DIR, absolute);
      const folder = relToGroups.split(path.sep)[0];
      if (!isUserOwnedFolder(user, folder)) {
        throw new Error('Memory path out of allowed scope');
      }
    }
    // data/memory/{key}/... — agent memory uses userId as key, legacy uses folder
    else if (inMemoryData) {
      const relToMemory = path.relative(MEMORY_DATA_DIR, absolute);
      const memoryOwner = relToMemory.split(path.sep)[0];
      // Allow if the key matches the user's own ID (agent memory: data/memory/{userId}/)
      if (memoryOwner !== user.id && !isUserOwnedFolder(user, memoryOwner)) {
        throw new Error('Memory path out of allowed scope');
      }
    }
  }

  return { absolutePath: absolute, writable };
}

/** Check if a folder belongs to the user (via registered_groups). */
function isUserOwnedFolder(
  user: { id: string; role: string },
  folder: string,
): boolean {
  if (user.role === 'admin') return true;
  if (!folder) return false;
  const groups = getAllRegisteredGroups();
  for (const group of Object.values(groups)) {
    if (group.folder === folder && group.created_by === user.id) {
      return true;
    }
  }
  return false;
}

function classifyAgentMemoryLabel(ownerLabel: string, subPath: string): string {
  if (!subPath || subPath === 'index.md') return `${ownerLabel} / 随身索引`;
  if (subPath === 'personality.md') return `${ownerLabel} / 性格记录`;
  if (subPath === 'state.json') return `${ownerLabel} / 系统元数据`;
  if (subPath.startsWith('knowledge/')) {
    const name = subPath.slice('knowledge/'.length);
    return `${ownerLabel} / 知识库 / ${name}`;
  }
  if (subPath.startsWith('impressions/')) {
    const name = subPath.slice('impressions/'.length);
    return `${ownerLabel} / 印象 / ${name}`;
  }
  if (subPath.startsWith('transcripts/')) {
    const name = subPath.slice('transcripts/'.length);
    return `${ownerLabel} / 对话记录 / ${name}`;
  }
  return `${ownerLabel} / ${subPath}`;
}

function classifyMemorySource(
  relativePath: string,
): Pick<MemorySource, 'type' | 'label' | 'ownerName' | 'folder'> {
  const parts = relativePath.split('/');

  // data/groups/user-global/{userId}/...
  if (
    parts[0] === 'data' &&
    parts[1] === 'groups' &&
    parts[2] === 'user-global'
  ) {
    const userId = parts[3] || 'unknown';
    const name = parts.slice(4).join('/') || 'CLAUDE.md';
    const owner = getUserById(userId);
    const ownerLabel = owner ? owner.display_name || owner.username : userId;

    if (name === 'HEARTBEAT.md') {
      return {
        type: 'heartbeat',
        label: `${ownerLabel} / 每日心跳`,
        ownerName: ownerLabel,
      };
    }
    return {
      type: 'global',
      label: `${ownerLabel} / 全局记忆 / ${name}`,
      ownerName: ownerLabel,
    };
  }
  // data/memory/{folder}/...
  if (parts[0] === 'data' && parts[1] === 'memory') {
    const key = parts[2] || 'unknown';
    const subPath = parts.slice(3).join('/') || '';

    // Check if this is an agent memory directory (has index.md)
    const indexCheck = path.join(MEMORY_DATA_DIR, key, 'index.md');
    if (fs.existsSync(indexCheck)) {
      // Agent memory: data/memory/{userId}/...
      const owner = getUserById(key);
      const ownerLabel = owner ? owner.display_name || owner.username : key;
      const label = classifyAgentMemoryLabel(ownerLabel, subPath);
      return {
        type: 'date',
        label,
        ownerName: ownerLabel,
      };
    }

    // Legacy date memory: data/memory/{folder}/...
    const name = subPath || 'memory';
    return {
      type: 'date',
      label: `${key} / 日期记忆 / ${name}`,
      folder: key,
    };
  }

  // data/groups/{folder}/conversations/...
  if (
    parts[0] === 'data' &&
    parts[1] === 'groups' &&
    parts.length >= 4 &&
    parts[3] === 'conversations'
  ) {
    const folder = parts[2] || 'unknown';
    const name = parts.slice(4).join('/');
    return {
      type: 'conversation',
      label: `${folder} / 对话归档 / ${name}`,
      folder,
    };
  }

  // data/groups/{folder}/... (session memory)
  if (parts[0] === 'data' && parts[1] === 'groups') {
    const folder = parts[2] || 'unknown';
    const name = parts.slice(3).join('/');
    return {
      type: 'session',
      label: `${folder} / ${name}`,
      folder,
    };
  }

  // Fallback
  return {
    type: 'session',
    label: parts.slice(2).join('/'),
    folder: parts[2] || undefined,
  };
}

function readMemoryFile(
  relativePath: string,
  user: AuthUser,
): MemoryFilePayload {
  const normalized = normalizeRelativePath(relativePath);
  const { absolutePath, writable } = resolveMemoryPath(normalized, user);
  if (!fs.existsSync(absolutePath)) {
    if (!writable) {
      throw new Error('Memory file not found');
    }
    return {
      path: normalized,
      content: '',
      updatedAt: null,
      size: 0,
      writable,
    };
  }
  const content = fs.readFileSync(absolutePath, 'utf-8');
  const stat = fs.statSync(absolutePath);
  return {
    path: normalized,
    content,
    updatedAt: stat.mtime.toISOString(),
    size: Buffer.byteLength(content, 'utf-8'),
    writable,
  };
}

// 记忆路径中禁止写入的系统子目录（CLAUDE.md 除外，它是记忆文件）
const MEMORY_BLOCKED_DIRS = ['logs', '.claude', 'conversations'];

function isBlockedMemoryPath(normalizedPath: string): boolean {
  const parts = normalizedPath.split('/');
  // 路径格式: data/groups/{folder}/{subpath...} 或 data/memory/{folder}/{subpath...}
  // 检查 data/groups/{folder}/ 下的系统子目录
  if (parts[0] === 'data' && parts[1] === 'groups' && parts.length >= 4) {
    const subPath = parts[3];
    if (MEMORY_BLOCKED_DIRS.includes(subPath)) return true;
  }
  return false;
}

function writeMemoryFile(
  relativePath: string,
  content: string,
  user: AuthUser,
): MemoryFilePayload {
  const normalized = normalizeRelativePath(relativePath);
  const { absolutePath, writable } = resolveMemoryPath(normalized, user);
  if (!writable) {
    throw new Error('Memory file is read-only');
  }
  if (isBlockedMemoryPath(normalized)) {
    throw new Error('Cannot write to system path');
  }
  if (normalized.includes('user-global/') && normalized.endsWith('/HEARTBEAT.md')) {
    throw new Error('HEARTBEAT.md is read-only (auto-generated)');
  }
  if (Buffer.byteLength(content, 'utf-8') > MAX_MEMORY_FILE_LENGTH) {
    throw new Error('Memory file is too large');
  }

  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  const tempPath = `${absolutePath}.tmp`;
  fs.writeFileSync(tempPath, content, 'utf-8');
  fs.renameSync(tempPath, absolutePath);

  const stat = fs.statSync(absolutePath);
  return {
    path: normalized,
    content,
    updatedAt: stat.mtime.toISOString(),
    size: Buffer.byteLength(content, 'utf-8'),
    writable,
  };
}

// Directories to skip when scanning group workspaces for memory files
const WALK_SKIP_DIRS = new Set(['logs', '.claude', 'conversations', 'downloads', 'node_modules']);

function walkFiles(
  baseDir: string,
  maxDepth: number,
  limit: number,
  out: string[],
  currentDepth = 0,
): void {
  if (out.length >= limit || currentDepth > maxDepth || !fs.existsSync(baseDir))
    return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= limit) break;
    const fullPath = path.join(baseDir, entry.name);
    if (entry.isDirectory()) {
      if (WALK_SKIP_DIRS.has(entry.name)) continue;
      walkFiles(fullPath, maxDepth, limit, out, currentDepth + 1);
      continue;
    }
    out.push(fullPath);
  }
}

function isMemoryCandidateFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return MEMORY_SOURCE_EXTENSIONS.has(ext);
}

function listMemorySources(user: AuthUser): MemorySource[] {
  const files = new Set<string>();
  const isAdmin = user.role === 'admin';
  const groups = getAllRegisteredGroups();
  const accessibleFolders = new Set<string>();

  if (isAdmin) {
    for (const group of Object.values(groups)) {
      accessibleFolders.add(group.folder);
    }
  } else {
    for (const group of Object.values(groups)) {
      if (group.created_by === user.id) {
        accessibleFolders.add(group.folder);
      }
    }
  }

  // 1. User-global memory + heartbeat
  files.add(path.join(USER_GLOBAL_DIR, user.id, 'CLAUDE.md'));
  const heartbeatPath = path.join(USER_GLOBAL_DIR, user.id, 'HEARTBEAT.md');
  if (fs.existsSync(heartbeatPath)) {
    files.add(heartbeatPath);
  }

  // 2. Group CLAUDE.md files
  for (const folder of accessibleFolders) {
    files.add(path.join(GROUPS_DIR, folder, 'CLAUDE.md'));
  }

  // 3. Scan group workspace directories (skips system dirs via WALK_SKIP_DIRS)
  for (const folder of accessibleFolders) {
    const folderDir = path.join(GROUPS_DIR, folder);
    const scanned: string[] = [];
    walkFiles(folderDir, 4, MEMORY_LIST_LIMIT, scanned);
    for (const f of scanned) {
      if (isMemoryCandidateFile(f)) files.add(f);
    }
  }

  // 4. Scan data/memory/ (date memory files + per-user memory index files)
  if (fs.existsSync(MEMORY_DATA_DIR)) {
    const memFolders = fs.readdirSync(MEMORY_DATA_DIR, { withFileTypes: true });
    for (const d of memFolders) {
      if (d.isDirectory() && (isAdmin || accessibleFolders.has(d.name) || d.name === user.id)) {
        const scanned: string[] = [];
        walkFiles(
          path.join(MEMORY_DATA_DIR, d.name),
          4,
          MEMORY_LIST_LIMIT,
          scanned,
        );
        for (const f of scanned) {
          if (isMemoryCandidateFile(f)) files.add(f);
        }
      }
    }
  }

  // 5. Scan conversations/ directories (read-only archives)
  for (const folder of accessibleFolders) {
    const convDir = path.join(GROUPS_DIR, folder, 'conversations');
    if (!fs.existsSync(convDir)) continue;
    try {
      const entries = fs.readdirSync(convDir, { withFileTypes: true });
      for (const entry of entries) {
        if (files.size >= MEMORY_LIST_LIMIT) break;
        if (!entry.isFile()) continue;
        const fullPath = path.join(convDir, entry.name);
        if (isMemoryCandidateFile(fullPath)) files.add(fullPath);
      }
    } catch { /* skip unreadable */ }
  }

  const sources: MemorySource[] = [];
  for (const absolutePath of files) {
    const inGroups = isWithinRoot(absolutePath, GROUPS_DIR);
    const inMemoryData = isWithinRoot(absolutePath, MEMORY_DATA_DIR);
    if (!inGroups && !inMemoryData) continue;

    const relativePath = path
      .relative(process.cwd(), absolutePath)
      .replace(/\\/g, '/');
    const exists = fs.existsSync(absolutePath);
    let updatedAt: string | null = null;
    let size = 0;
    if (exists) {
      const stat = fs.statSync(absolutePath);
      updatedAt = stat.mtime.toISOString();
      size = stat.size;
    }

    const classified = classifyMemorySource(relativePath);
    const writable = classified.type !== 'heartbeat' && classified.type !== 'conversation';
    sources.push({
      path: relativePath,
      writable,
      exists,
      updatedAt,
      size,
      ...classified,
    });
  }

  const typeRank: Record<MemorySource['type'], number> = {
    global: 0,
    heartbeat: 1,
    session: 2,
    date: 3,
    conversation: 4,
  };

  sources.sort((a, b) => {
    if (typeRank[a.type] !== typeRank[b.type])
      return typeRank[a.type] - typeRank[b.type];
    if (a.folder !== b.folder)
      return (a.folder || '').localeCompare(b.folder || '', 'zh-CN');
    return a.path.localeCompare(b.path, 'zh-CN');
  });

  return sources.slice(0, MEMORY_LIST_LIMIT);
}

function buildSearchSnippet(
  content: string,
  index: number,
  keywordLength: number,
): string {
  const start = Math.max(0, index - 36);
  const end = Math.min(content.length, index + keywordLength + 36);
  return content.slice(start, end).replace(/\s+/g, ' ').trim();
}

function searchMemorySources(
  keyword: string,
  user: AuthUser,
  limit = MEMORY_SEARCH_LIMIT,
): MemorySearchHit[] {
  const normalizedKeyword = keyword.trim().toLowerCase();
  if (!normalizedKeyword) return [];

  const maxResults = Number.isFinite(limit)
    ? Math.max(1, Math.min(MEMORY_SEARCH_LIMIT, Math.trunc(limit)))
    : MEMORY_SEARCH_LIMIT;

  const hits: MemorySearchHit[] = [];
  const sources = listMemorySources(user);

  for (const source of sources) {
    if (hits.length >= maxResults) break;
    if (!source.exists || source.size === 0) continue;
    if (source.size > MAX_MEMORY_FILE_LENGTH) continue;

    try {
      const payload = readMemoryFile(source.path, user);
      const lower = payload.content.toLowerCase();
      const firstIndex = lower.indexOf(normalizedKeyword);
      if (firstIndex === -1) continue;

      let count = 0;
      let from = 0;
      while (from < lower.length) {
        const idx = lower.indexOf(normalizedKeyword, from);
        if (idx === -1) break;
        count += 1;
        from = idx + normalizedKeyword.length;
      }

      hits.push({
        ...source,
        hits: count,
        snippet: buildSearchSnippet(
          payload.content,
          firstIndex,
          normalizedKeyword.length,
        ),
      });
    } catch {
      continue;
    }
  }

  return hits;
}

// --- Routes ---
// All memory routes require authentication (member + admin).
// User-level filtering is handled inside each function.

memoryRoutes.get('/sources', authMiddleware, (c) => {
  try {
    const user = c.get('user') as AuthUser;
    return c.json({ sources: listMemorySources(user) });
  } catch (err) {
    logger.error({ err }, 'Failed to list memory sources');
    return c.json({ error: 'Failed to list memory sources' }, 500);
  }
});

memoryRoutes.get('/search', authMiddleware, (c) => {
  const query = c.req.query('q');
  if (!query || !query.trim()) {
    return c.json({ error: 'Missing q' }, 400);
  }
  const limitRaw = Number(c.req.query('limit'));
  const limit = Number.isFinite(limitRaw) ? limitRaw : MEMORY_SEARCH_LIMIT;
  try {
    const user = c.get('user') as AuthUser;
    return c.json({ hits: searchMemorySources(query, user, limit) });
  } catch (err) {
    logger.error({ err }, 'Failed to search memory sources');
    return c.json({ error: 'Failed to search memory sources' }, 500);
  }
});

memoryRoutes.get('/file', authMiddleware, (c) => {
  const filePath = c.req.query('path');
  if (!filePath) return c.json({ error: 'Missing path' }, 400);
  try {
    const user = c.get('user') as AuthUser;
    return c.json(readMemoryFile(filePath, user));
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Failed to read memory file';
    const status = message.includes('not found') ? 404 : 400;
    return c.json({ error: message }, status);
  }
});

memoryRoutes.put('/file', authMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const validation = MemoryFileSchema.safeParse(body);
  if (!validation.success) {
    return c.json(
      { error: 'Invalid request body', details: validation.error.format() },
      400,
    );
  }
  try {
    const user = c.get('user') as AuthUser;
    return c.json(
      writeMemoryFile(validation.data.path, validation.data.content, user),
    );
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Failed to write memory file';
    return c.json({ error: message }, 400);
  }
});

// Legacy /global API — now operates on the current user's user-global memory.
memoryRoutes.get('/global', authMiddleware, (c) => {
  try {
    const user = c.get('user') as AuthUser;
    const userGlobalPath = `data/groups/user-global/${user.id}/CLAUDE.md`;
    return c.json(readMemoryFile(userGlobalPath, user));
  } catch (err) {
    logger.error({ err }, 'Failed to read user global memory');
    return c.json({ error: 'Failed to read global memory' }, 500);
  }
});

memoryRoutes.put('/global', authMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const validation = MemoryGlobalSchema.safeParse(body);
  if (!validation.success) {
    return c.json(
      { error: 'Invalid request body', details: validation.error.format() },
      400,
    );
  }
  if (
    Buffer.byteLength(validation.data.content, 'utf-8') >
    MAX_GLOBAL_MEMORY_LENGTH
  ) {
    return c.json({ error: 'Global memory is too large' }, 400);
  }

  try {
    const user = c.get('user') as AuthUser;
    const userGlobalPath = `data/groups/user-global/${user.id}/CLAUDE.md`;
    return c.json(
      writeMemoryFile(userGlobalPath, validation.data.content, user),
    );
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Failed to write global memory';
    logger.error({ err }, 'Failed to write user global memory');
    return c.json({ error: message }, 400);
  }
});

// --- Memory Agent status & manual triggers ---

let injectedManager: MemoryAgentManager | null = null;
let injectedQueue: GroupQueue | null = null;

export function injectMemoryDeps(deps: {
  manager: MemoryAgentManager;
  queue: GroupQueue;
}): void {
  injectedManager = deps.manager;
  injectedQueue = deps.queue;
}

memoryRoutes.get('/status', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const mode = getUserMemoryMode(user.id);
  if (mode !== 'agent') {
    return c.json({
      enabled: false,
      lastGlobalSleep: null,
      lastSessionWrapupAt: null,
      pendingWrapupsCount: 0,
      canTriggerWrapup: false,
      canTriggerGlobalSleep: false,
      hasActiveSession: false,
    });
  }

  const state = readMemoryState(user.id);
  const homeGroup = getUserHomeGroup(user.id);

  // Check active sessions
  let hasActiveSession = false;
  if (injectedQueue) {
    const queueStatus = injectedQueue.getStatus();
    const activeJids = new Set(
      queueStatus.groups.filter((g) => g.active).map((g) => g.jid),
    );
    const userGroups = getGroupsByOwner(user.id);
    hasActiveSession = userGroups.some((g) => activeJids.has(g.jid));
  }

  const pendingWrapups = (state.pendingWrapups || []) as string[];

  return c.json({
    enabled: true,
    lastGlobalSleep: (state.lastGlobalSleep as string | null) || null,
    lastSessionWrapupAt: (state.lastSessionWrapupAt as string | null) || null,
    pendingWrapupsCount: pendingWrapups.length,
    canTriggerWrapup: !!homeGroup && !activeWrapups.has(user.id),
    canTriggerGlobalSleep: pendingWrapups.length > 0 && !activeGlobalSleeps.has(user.id),
    hasActiveSession,
    wrapupInProgress: activeWrapups.has(user.id),
    globalSleepInProgress: activeGlobalSleeps.has(user.id),
  });
});

memoryRoutes.post('/trigger-wrapup', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;

  if (getUserMemoryMode(user.id) !== 'agent') {
    return c.json({ error: 'AI 记忆系统未启用' }, 400);
  }
  if (!injectedManager) {
    return c.json({ error: '记忆系统未初始化' }, 503);
  }
  if (activeWrapups.has(user.id)) {
    return c.json({ error: '会话整理正在进行中，请勿重复触发' }, 409);
  }

  const homeGroup = getUserHomeGroup(user.id);
  if (!homeGroup) {
    return c.json({ error: '未找到主容器' }, 400);
  }

  activeWrapups.add(user.id);
  try {
    const allJids = getJidsByFolder(homeGroup.folder);
    exportTranscriptsForUser(user.id, homeGroup.folder, allJids, injectedManager);
    return c.json({ success: true, message: '已触发会话整理' });
  } finally {
    activeWrapups.delete(user.id);
  }
});

memoryRoutes.post('/trigger-global-sleep', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;

  if (getUserMemoryMode(user.id) !== 'agent') {
    return c.json({ error: 'AI 记忆系统未启用' }, 400);
  }
  if (!injectedManager) {
    return c.json({ error: '记忆系统未初始化' }, 503);
  }
  if (activeGlobalSleeps.has(user.id)) {
    return c.json({ error: '深度整理正在进行中，请勿重复触发' }, 409);
  }

  const state = readMemoryState(user.id);
  const pendingWrapups = (state.pendingWrapups || []) as string[];
  if (pendingWrapups.length === 0) {
    return c.json({ error: '没有待整理的会话记录，无需执行深度整理' }, 400);
  }

  activeGlobalSleeps.add(user.id);
  try {
    await injectedManager.send(user.id, { type: 'global_sleep' });
    return c.json({ success: true, message: '深度整理已完成' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, userId: user.id }, 'Manual global_sleep failed');
    return c.json({ error: `深度整理失败: ${message}` }, 500);
  } finally {
    activeGlobalSleeps.delete(user.id);
  }
});

memoryRoutes.post('/stop-active-sessions', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;

  if (!injectedQueue) {
    return c.json({ error: '队列未初始化' }, 503);
  }

  const userGroups = getGroupsByOwner(user.id);
  const queueStatus = injectedQueue.getStatus();
  const activeJids = new Set(
    queueStatus.groups.filter((g) => g.active).map((g) => g.jid),
  );

  const activeGroupJids = userGroups
    .map((g) => g.jid)
    .filter((jid) => activeJids.has(jid));

  if (activeGroupJids.length === 0) {
    return c.json({ stopped: 0, message: '没有活跃会话' });
  }

  let stopped = 0;
  for (const jid of activeGroupJids) {
    try {
      await injectedQueue.stopGroup(jid);
      stopped++;
    } catch (err) {
      logger.warn({ jid, err }, 'Failed to stop group for memory deep sleep');
    }
  }

  return c.json({ stopped, message: `已停止 ${stopped} 个活跃会话` });
});

export default memoryRoutes;
