import { Hono } from 'hono';
import path from 'path';
import type { Variables } from '../web-context.js';
import { authMiddleware } from '../middleware/auth.js';
import type { AuthUser } from '../types.js';
import {
  hasHostExecutionPermission,
  canAccessGroup,
  getWebDeps,
} from '../web-context.js';
import {
  getRegisteredGroup,
  getRouterState,
  getSessionRecord,
} from '../db.js';
import { getSystemSettings } from '../runtime-config.js';
import { logger } from '../logger.js';
import { getDefaultRunnerId } from '../runner-registry.js';

// --- Claude Code version cache (1h TTL) ---

let cachedClaudeVersion: { version: string | null; fetchedAt: number } | null =
  null;
const VERSION_CACHE_TTL = 60 * 60 * 1000;

async function getClaudeCodeVersion(): Promise<string | null> {
  const now = Date.now();
  if (
    cachedClaudeVersion &&
    now - cachedClaudeVersion.fetchedAt < VERSION_CACHE_TTL
  ) {
    return cachedClaudeVersion.version;
  }

  // Try global `claude` CLI first, then fallback to SDK-bundled cli.js
  const candidates: Array<{ cmd: string; args: string[] }> = [
    { cmd: 'claude', args: ['--version'] },
    {
      cmd: 'node',
      args: [
        path.join(
          process.cwd(),
          'container',
          'agent-runner',
          'node_modules',
          '@anthropic-ai',
          'claude-agent-sdk',
          'cli.js',
        ),
        '--version',
      ],
    },
  ];

  for (const { cmd, args } of candidates) {
    try {
      const { execFile } = await import('child_process');
      const { promisify } = await import('util');
      const execFileAsync = promisify(execFile);
      const { stdout } = await execFileAsync(cmd, args, { timeout: 5000 });
      const version = stdout.trim() || null;
      if (version) {
        cachedClaudeVersion = { version, fetchedAt: now };
        return version;
      }
    } catch {
      // try next candidate
    }
  }

  cachedClaudeVersion = { version: null, fetchedAt: now };
  return null;
}

function resolveRuntimeAccess(
  runtimeJid: string,
): {
  accessJid: string;
  sessionId: string | null;
  runnerId: string;
} | null {
  const defaultRunnerId = getDefaultRunnerId();
  const agentSep = runtimeJid.indexOf('#agent:');
  if (agentSep >= 0) {
    const accessJid = runtimeJid.slice(0, agentSep);
    const agentId = runtimeJid.slice(agentSep + '#agent:'.length);
    const group = getRegisteredGroup(accessJid);
    const workerSession = agentId ? getSessionRecord(`worker:${agentId}`) : undefined;
    const parentSession = workerSession?.parent_session_id
      ? getSessionRecord(workerSession.parent_session_id)
      : undefined;
    if (!group || !workerSession) return null;
    return {
      accessJid,
      sessionId: workerSession.id,
      runnerId: workerSession.runner_id || parentSession?.runner_id || defaultRunnerId,
    };
  }

  const group = getRegisteredGroup(runtimeJid);
  if (!group) return null;
  const session = getSessionRecord(`main:${group.folder}`);
  return {
    accessJid: runtimeJid,
    sessionId: session?.id || null,
    runnerId: session?.runner_id || (group.llm_provider === 'openai' ? 'codex' : defaultRunnerId),
  };
}

function normalizeRuntimeLabel(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (raw.startsWith('host-')) return `local-${raw.slice('host-'.length)}`;
  if (raw.startsWith('container-')) return `local-${raw.slice('container-'.length)}`;
  return raw;
}

const monitorRoutes = new Hono<{ Variables: Variables }>();

// GET /api/health - 健康检查（无认证）
monitorRoutes.get('/health', async (c) => {
  const checks = {
    database: false,
    queue: false,
    uptime: 0,
  };

  let healthy = true;

  // 检查数据库连通性
  try {
    getRouterState('last_timestamp');
    checks.database = true;
  } catch (err) {
    healthy = false;
    logger.warn({ err }, '健康检查：数据库连接失败');
  }

  // 检查队列状态
  try {
    const deps = getWebDeps();
    if (deps && deps.queue) {
      checks.queue = true;
    } else {
      healthy = false;
    }
  } catch (err) {
    healthy = false;
    logger.warn({ err }, '健康检查：队列不可用');
  }

  // 进程运行时间
  checks.uptime = Math.floor(process.uptime());

  const status = healthy ? 'healthy' : 'unhealthy';
  const statusCode = healthy ? 200 : 503;

  return c.json({ status, checks }, statusCode);
});

// GET /api/status - 获取系统状态
monitorRoutes.get('/status', authMiddleware, async (c) => {
  const deps = getWebDeps();
  if (!deps) return c.json({ error: 'Server not initialized' }, 500);

  const authUser = c.get('user') as AuthUser;
  const isAdmin = hasHostExecutionPermission(authUser);
  const defaultRunnerId = getDefaultRunnerId();
  const queueStatus = deps.queue.getRuntimeStatus();

  // 监控页面属于系统管理功能，admin 可见所有群组状态（不受工作区隔离约束）
  const filteredGroups = isAdmin
    ? queueStatus.groups
    : queueStatus.groups.filter((g) => {
        const resolved = resolveRuntimeAccess(g.jid);
        if (!resolved) return false;
        const group = getRegisteredGroup(resolved.accessJid);
        if (!group) return false;
        return canAccessGroup(
          { id: authUser.id, role: authUser.role },
          { ...group, jid: resolved.accessJid },
        );
      });

  const runtimeSessions = filteredGroups.map((runtime) => {
    const resolved = resolveRuntimeAccess(runtime.jid);
    return {
      ...runtime,
      session_id: resolved?.sessionId || null,
      runner_id: resolved?.runnerId || defaultRunnerId,
      runtime_identifier: normalizeRuntimeLabel(runtime.runtimeIdentifier),
      runtime_label: normalizeRuntimeLabel(runtime.runtimeLabel),
    };
  });

  // For non-admin users, derive aggregate metrics from their own filtered groups only
  // to prevent leaking global system load information across users.
  const activeRuntimes = isAdmin
    ? queueStatus.activeCount
    : filteredGroups.filter((g) => g.active).length;
  const queueLength = isAdmin
    ? queueStatus.waitingCount
    : queueStatus.waitingGroupJids.filter((jid) => {
        const resolved = resolveRuntimeAccess(jid);
        if (!resolved) return false;
        const group = getRegisteredGroup(resolved.accessJid);
        if (!group) return false;
        return canAccessGroup(
          { id: authUser.id, role: authUser.role },
          { ...group, jid: resolved.accessJid },
        );
      }).length;

  return c.json({
    activeRuntimes,
    maxConcurrentRuntimes: getSystemSettings().maxConcurrentRuntimes,
    queueLength,
    uptime: Math.floor(process.uptime()),
    groups: runtimeSessions,
    sessions: runtimeSessions,
    claudeCodeVersion: isAdmin ? await getClaudeCodeVersion() : undefined,
  });
});

export default monitorRoutes;
