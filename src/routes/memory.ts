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
import {
  deleteSessionRuntimeState,
  getJidsByFolder,
  getPrimarySessionForOwner,
  getRunnerProfile,
  getSessionRecord,
  getUserById,
  listSessionRecords,
  saveSessionRecord,
} from '../db.js';
import { logger } from '../logger.js';
import { GROUPS_DIR, DATA_DIR } from '../config.js';
import type { AuthUser } from '../types.js';
import { readMemoryState, writeMemoryState } from '../memory-agent.js';
import type { MemoryOrchestrator } from '../memory-orchestrator.js';
import {
  canServeAsMemoryRunner,
  explainMemoryRunnerDegradation,
  getRunnerDescriptor,
  listRunnerDescriptors,
} from '../runner-registry.js';

import type { SessionRuntimeManager } from '../session-runtime-manager.js';

const memoryRoutes = new Hono<{ Variables: Variables }>();

// --- Per-user operation locks (prevent duplicate trigger-wrapup / trigger-global-sleep) ---

const activeWrapups = new Set<string>();
const activeGlobalSleeps = new Set<string>();

// --- Constants ---

const USER_GLOBAL_DIR = path.join(GROUPS_DIR, 'user-global');
const MAIN_MEMORY_DIR = path.join(GROUPS_DIR, 'main');
const MAIN_MEMORY_FILE = path.join(MAIN_MEMORY_DIR, 'CLAUDE.md');
const MEMORY_DATA_DIR = path.join(DATA_DIR, 'memory');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
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

function resolvePrimarySessionFolderForOwner(ownerKey: string): string | null {
  const primary = getPrimarySessionForOwner(ownerKey);
  if (!primary) return null;
  return primary.id.startsWith('main:')
    ? primary.id.slice('main:'.length)
    : null;
}

function listOwnedSessionFolders(ownerKey: string): string[] {
  return Array.from(
    new Set(
      listSessionRecords()
        .filter(
          (session) =>
            session.owner_key === ownerKey &&
            (session.kind === 'main' || session.kind === 'workspace') &&
            session.id.startsWith('main:'),
        )
        .map((session) => session.id.slice('main:'.length)),
    ),
  );
}

function getMemorySessionForOwner(ownerKey: string) {
  return getSessionRecord(`memory:${ownerKey}`);
}

function listOwnedActiveRuntimeJids(
  queue: SessionRuntimeManager | null,
  ownerKey: string,
): string[] {
  if (!queue) return [];
  const ownedFolders = new Set(listOwnedSessionFolders(ownerKey));
  const primaryFolder = resolvePrimarySessionFolderForOwner(ownerKey);
  if (primaryFolder) ownedFolders.add(primaryFolder);
  return Array.from(
    new Set(
      queue
        .getRuntimeStatus()
        .groups
        .filter(
          (runtime) =>
            runtime.active &&
            typeof runtime.groupFolder === 'string' &&
            ownedFolders.has(runtime.groupFolder),
        )
        .map((runtime) => runtime.jid),
    ),
  );
}

function normalizeRegisteredRunnerId(raw: unknown) {
  if (typeof raw !== 'string') return null;
  const runnerId = raw.trim();
  if (!runnerId) return null;
  return getRunnerDescriptor(runnerId)?.id ?? null;
}

function serializeMemoryConfig(user: AuthUser) {
  const session = getMemorySessionForOwner(user.id);
  const primaryFolder = resolvePrimarySessionFolderForOwner(user.id);
  const ownedFolders = listOwnedSessionFolders(user.id);
  return {
    session: session
      ? {
          id: session.id,
          name: session.name,
          runner_id: session.runner_id,
          runner_profile_id: session.runner_profile_id,
          model: session.model,
          thinking_effort: session.thinking_effort,
          context_compression: session.context_compression,
          owner_key: session.owner_key,
          cwd: session.cwd,
          primary_session_folder: primaryFolder,
          owned_session_folders: ownedFolders,
          owned_session_count: ownedFolders.length,
        }
      : null,
    runners: listRunnerDescriptors().map((descriptor) => ({
      id: descriptor.id,
      label: descriptor.label,
      can_serve_memory: canServeAsMemoryRunner(descriptor),
      degradation_reasons: explainMemoryRunnerDegradation(descriptor),
    })),
  };
}

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
  const inSessions = isWithinRoot(absolute, SESSIONS_DIR);
  const writable = inGroups || inMemoryData;
  const readable = writable || inSessions;

  if (!readable) {
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
    // data/sessions/{folder}/... — check group ownership
    else if (inSessions) {
      const relToSessions = path.relative(SESSIONS_DIR, absolute);
      const folder = relToSessions.split(path.sep)[0];
      if (!isUserOwnedFolder(user, folder)) {
        throw new Error('Memory path out of allowed scope');
      }
    }
  }

  return { absolutePath: absolute, writable };
}

/** Check if a folder belongs to the user via session ownership. */
function isUserOwnedFolder(
  user: { id: string; role: string },
  folder: string,
): boolean {
  if (user.role === 'admin') return true;
  if (!folder) return false;
  return listSessionRecords().some(
    (session) =>
      session.owner_key === user.id &&
      session.id === `main:${folder}` &&
      (session.kind === 'main' || session.kind === 'workspace'),
  );
}

function classifyAgentMemoryLabel(ownerLabel: string, subPath: string): string {
  if (!subPath || subPath === 'index.md') return `${ownerLabel} / 随身索引`;
  if (subPath === 'personality.md') return `${ownerLabel} / 性格记录`;
  if (subPath === 'state.json') return `${ownerLabel} / 系统元数据`;
  if (subPath === 'meta.json') return `${ownerLabel} / 记忆元数据`;
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
): Pick<MemorySource, 'scope' | 'kind' | 'label' | 'ownerName'> {
  const parts = relativePath.split('/');
  // data/groups/user-global/{userId}/CLAUDE.md
  if (
    parts[0] === 'data' &&
    parts[1] === 'groups' &&
    parts[2] === 'user-global'
  ) {
    const userId = parts[3] || 'unknown';
    const name = parts.slice(4).join('/') || 'CLAUDE.md';
    const owner = getUserById(userId);
    const ownerLabel = owner ? owner.display_name || owner.username : userId;
    return {
      scope: 'user-global',
      kind: 'claude',
      label: `${ownerLabel} / 全局记忆 / ${name}`,
      ownerName: ownerLabel,
    };
  }
  // data/groups/main/CLAUDE.md
  if (relativePath === 'data/groups/main/CLAUDE.md') {
    return { scope: 'main', kind: 'claude', label: '主会话记忆 / CLAUDE.md' };
  }
  // data/memory/{key}/...
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
        scope: 'agent-memory' as const,
        kind: 'note' as const,
        label,
        ownerName: ownerLabel,
      };
    }

    // Legacy date memory: data/memory/{folder}/...
    const name = subPath || 'memory';
    return {
      scope: key === 'main' ? 'main' : 'flow',
      kind: 'note' as const,
      label: `${key} / 日期记忆 / ${name}`,
    };
  }
  // data/groups/{folder}/... (non user-global)
  if (parts[0] === 'data' && parts[1] === 'groups') {
    const folder = parts[2] || 'unknown';
    const name = parts.slice(3).join('/');
    const kind = name === 'CLAUDE.md' ? 'claude' : 'note';
    return {
      scope: folder === 'main' ? 'main' : 'flow',
      kind,
      label: `${folder} / ${name}`,
    };
  }
  // data/sessions/{folder}/.claude/...
  const sessionRel = parts.slice(2).join('/');
  return {
    scope: 'session',
    kind: 'session',
    label: `会话自动记忆 / ${sessionRel}`,
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
      walkFiles(fullPath, maxDepth, limit, out, currentDepth + 1);
      continue;
    }
    out.push(fullPath);
  }
}

function isMemoryCandidateFile(filePath: string): boolean {
  const base = path.basename(filePath).toLowerCase();
  if (base === 'settings.json') return true;
  const ext = path.extname(base);
  return MEMORY_SOURCE_EXTENSIONS.has(ext);
}

function listMemorySources(user: AuthUser): MemorySource[] {
  const files = new Set<string>();
  const isAdmin = user.role === 'admin';
  const accessibleFolders = new Set<string>();

  if (isAdmin) {
    for (const session of listSessionRecords()) {
      if (
        session.id.startsWith('main:') &&
        (session.kind === 'main' || session.kind === 'workspace')
      ) {
        accessibleFolders.add(session.id.slice('main:'.length));
      }
    }
  } else {
    for (const session of listSessionRecords()) {
      if (
        session.owner_key === user.id &&
        session.id.startsWith('main:') &&
        (session.kind === 'main' || session.kind === 'workspace')
      ) {
        accessibleFolders.add(session.id.slice('main:'.length));
      }
    }
  }

  // 1. User-global memory: each user only sees their own
  files.add(path.join(USER_GLOBAL_DIR, user.id, 'CLAUDE.md'));

  // 2. Group memories: filter by ownership
  for (const folder of accessibleFolders) {
    files.add(path.join(GROUPS_DIR, folder, 'CLAUDE.md'));
  }

  // 3. Scan group directories (filtered by access)
  for (const folder of accessibleFolders) {
    const folderDir = path.join(GROUPS_DIR, folder);
    const scanned: string[] = [];
    walkFiles(folderDir, 4, MEMORY_LIST_LIMIT, scanned);
    for (const f of scanned) {
      if (isMemoryCandidateFile(f)) files.add(f);
    }
  }

  // 4. Scan data/memory/ (filtered by folder access + own userId for agent memory)
  if (fs.existsSync(MEMORY_DATA_DIR)) {
    const memFolders = fs.readdirSync(MEMORY_DATA_DIR, { withFileTypes: true });
    for (const d of memFolders) {
      if (
        d.isDirectory() &&
        (isAdmin || accessibleFolders.has(d.name) || d.name === user.id)
      ) {
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

  // 5. Scan sessions (filtered by folder access)
  const sessionsDir = path.join(DATA_DIR, 'sessions');
  if (fs.existsSync(sessionsDir)) {
    const sessFolders = fs.readdirSync(sessionsDir, { withFileTypes: true });
    for (const d of sessFolders) {
      if (d.isDirectory() && (isAdmin || accessibleFolders.has(d.name))) {
        const scanned: string[] = [];
        walkFiles(
          path.join(sessionsDir, d.name),
          7,
          MEMORY_LIST_LIMIT,
          scanned,
        );
        for (const f of scanned) {
          if (isMemoryCandidateFile(f)) files.add(f);
        }
      }
    }
  }

  const sources: MemorySource[] = [];
  for (const absolutePath of files) {
    const readable =
      isWithinRoot(absolutePath, GROUPS_DIR) ||
      isWithinRoot(absolutePath, MEMORY_DATA_DIR) ||
      isWithinRoot(absolutePath, path.join(DATA_DIR, 'sessions'));
    if (!readable) continue;

    const relativePath = path
      .relative(process.cwd(), absolutePath)
      .replace(/\\/g, '/');
    const writable =
      isWithinRoot(absolutePath, GROUPS_DIR) ||
      isWithinRoot(absolutePath, MEMORY_DATA_DIR);
    const exists = fs.existsSync(absolutePath);
    let updatedAt: string | null = null;
    let size = 0;
    if (exists) {
      const stat = fs.statSync(absolutePath);
      updatedAt = stat.mtime.toISOString();
      size = stat.size;
    }

    const classified = classifyMemorySource(relativePath);
    sources.push({
      path: relativePath,
      writable,
      exists,
      updatedAt,
      size,
      ...classified,
    });
  }

  const scopeRank: Record<MemorySource['scope'], number> = {
    'agent-memory': 0,
    'user-global': 1,
    main: 2,
    flow: 3,
    session: 4,
  };
  const kindRank: Record<MemorySource['kind'], number> = {
    claude: 0,
    note: 1,
    session: 2,
  };

  sources.sort((a, b) => {
    if (scopeRank[a.scope] !== scopeRank[b.scope])
      return scopeRank[a.scope] - scopeRank[b.scope];
    if (kindRank[a.kind] !== kindRank[b.kind])
      return kindRank[a.kind] - kindRank[b.kind];
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

let injectedOrchestrator: MemoryOrchestrator | null = null;
let injectedQueue: SessionRuntimeManager | null = null;

export function injectMemoryDeps(deps: {
  orchestrator: MemoryOrchestrator;
  queue: SessionRuntimeManager;
}): void {
  injectedOrchestrator = deps.orchestrator;
  injectedQueue = deps.queue;
}

memoryRoutes.get('/status', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;

  const state = readMemoryState(user.id);
  const primaryFolder = resolvePrimarySessionFolderForOwner(user.id);
  const ownedFolders = listOwnedSessionFolders(user.id);
  const activeRuntimeJids = listOwnedActiveRuntimeJids(injectedQueue, user.id);
  const hasActiveSession = activeRuntimeJids.length > 0;

  const pendingWrapups = (state.pendingWrapups || []) as string[];

  return c.json({
    enabled: true,
    lastGlobalSleep: (state.lastGlobalSleep as string | null) || null,
    lastSessionWrapupAt: (state.lastSessionWrapupAt as string | null) || null,
    pendingWrapupsCount: pendingWrapups.length,
    ownedSessionFolders: ownedFolders,
    canTriggerWrapup:
      (ownedFolders.length > 0 || !!primaryFolder) && !activeWrapups.has(user.id),
    canTriggerGlobalSleep:
      pendingWrapups.length > 0 &&
      !activeGlobalSleeps.has(user.id) &&
      !hasActiveSession,
    hasActiveSession,
    wrapupInProgress: activeWrapups.has(user.id),
    globalSleepInProgress: activeGlobalSleeps.has(user.id),
  });
});

memoryRoutes.get('/config', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  return c.json(serializeMemoryConfig(user));
});

memoryRoutes.put('/config', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const existing = getMemorySessionForOwner(user.id);
  if (!existing) {
    return c.json({ error: '记忆会话不存在' }, 404);
  }

  const body = await c.req.json().catch(() => null);
  const runnerId = normalizeRegisteredRunnerId(body?.runner_id);
  if (!runnerId) {
    return c.json({ error: 'runner_id 必须是已注册 runner id' }, 400);
  }

  const descriptor = getRunnerDescriptor(runnerId);
  if (!descriptor || !canServeAsMemoryRunner(descriptor)) {
    return c.json({ error: '该 runner 不支持 memory 会话' }, 400);
  }

  const thinkingEffort =
    body?.thinking_effort === 'low' ||
    body?.thinking_effort === 'medium' ||
    body?.thinking_effort === 'high'
      ? body.thinking_effort
      : null;
  const contextCompression =
    body?.context_compression === 'auto' || body?.context_compression === 'manual'
      ? body.context_compression
      : 'off';
  const model =
    typeof body?.model === 'string' && body.model.trim()
      ? body.model.trim()
      : null;
  const name =
    typeof body?.name === 'string' && body.name.trim()
      ? body.name.trim().slice(0, 100)
      : existing.name;
  const runnerProfileId =
    typeof body?.runner_profile_id === 'string' && body.runner_profile_id.trim()
      ? body.runner_profile_id.trim()
      : body?.runner_profile_id === null
        ? null
        : existing.runner_profile_id;
  if (runnerProfileId) {
    const profile = getRunnerProfile(runnerProfileId);
    if (!profile) {
      return c.json({ error: 'runner_profile_id 不存在' }, 400);
    }
    if (profile.runner_id !== runnerId) {
      return c.json({ error: 'runner_profile_id 与 runner_id 不匹配' }, 400);
    }
  }

  saveSessionRecord({
    ...existing,
    name,
    runner_id: runnerId,
    runner_profile_id: runnerProfileId,
    model,
    thinking_effort: thinkingEffort,
    context_compression: contextCompression,
    updated_at: new Date().toISOString(),
  });
  if (runnerId !== existing.runner_id) {
    deleteSessionRuntimeState(existing.id);
  }

  return c.json(serializeMemoryConfig(user));
});

memoryRoutes.post('/trigger-wrapup', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;

  if (!injectedOrchestrator) {
    return c.json({ error: '记忆系统未初始化' }, 503);
  }
  if (activeWrapups.has(user.id)) {
    return c.json({ error: '会话整理正在进行中，请勿重复触发' }, 409);
  }

  const ownedFolders = listOwnedSessionFolders(user.id);
  if (ownedFolders.length === 0) {
    return c.json({ error: '未找到可整理的会话' }, 400);
  }

  activeWrapups.add(user.id);
  try {
    let completedFolders = 0;
    let touchedFolders = 0;
    const failures: string[] = [];

    for (const folder of ownedFolders) {
      try {
        const allJids = getJidsByFolder(folder);
        const result = await injectedOrchestrator.exportTranscripts(
          user.id,
          folder,
          allJids,
        );
        completedFolders++;
        if (result !== null) touchedFolders++;
        if (result && !result.success) {
          failures.push(`${folder}: ${result.error || '未知错误'}`);
        }
      } catch (err) {
        failures.push(
          `${folder}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (failures.length > 0) {
      return c.json(
        { error: `会话整理部分失败: ${failures.join('；')}` },
        500,
      );
    }
    if (touchedFolders === 0) {
      return c.json({
        success: true,
        message: `没有新消息需要整理，共检查 ${completedFolders} 个会话`,
      });
    }
    return c.json({
      success: true,
      message: `会话整理完成，共处理 ${touchedFolders} 个会话`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, userId: user.id }, 'Manual session_wrapup failed');
    return c.json({ error: `会话整理失败: ${message}` }, 500);
  } finally {
    activeWrapups.delete(user.id);
  }
});

memoryRoutes.post('/trigger-global-sleep', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;

  if (!injectedOrchestrator) {
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
  const activeRuntimeJids = listOwnedActiveRuntimeJids(injectedQueue, user.id);
  if (activeRuntimeJids.length > 0) {
    return c.json(
      { error: '仍有活跃会话运行中，请先停止相关主会话或 worker 会话' },
      409,
    );
  }

  activeGlobalSleeps.add(user.id);
  try {
    await injectedOrchestrator.globalSleep(user.id);
    // Main process updates state.json after successful global_sleep
    const updatedState = readMemoryState(user.id);
    updatedState.lastGlobalSleep = new Date().toISOString();
    updatedState.pendingWrapups = [];
    writeMemoryState(user.id, updatedState);
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
  const activeGroupJids = listOwnedActiveRuntimeJids(injectedQueue, user.id);

  if (activeGroupJids.length === 0) {
    return c.json({ stopped: 0, message: '没有活跃会话' });
  }

  let stopped = 0;
  for (const jid of activeGroupJids) {
    try {
      await injectedQueue.stopSession(jid);
      stopped++;
    } catch (err) {
      logger.warn({ jid, err }, 'Failed to stop group for memory deep sleep');
    }
  }

  return c.json({ stopped, message: `已停止 ${stopped} 个活跃会话` });
});

export default memoryRoutes;
