/**
 * Turn history routes.
 * Provides APIs to query turn history and load execution traces.
 */
import { Hono } from 'hono';

import {
  getRegisteredGroup,
  getJidsByFolder,
  getSessionRecord,
  getTurnsByFolder,
  getTurnById,
  getActiveTurnByFolder,
} from '../db.js';
import { authMiddleware } from '../middleware/auth.js';
import type { AuthUser } from '../types.js';
import { canAccessGroup, type Variables } from '../web-context.js';
import { getWebDeps } from '../web-context.js';
import { loadTurnTrace } from '../turn-trace.js';
import type { RegisteredGroup } from '../types.js';

const turnsRoutes = new Hono<{ Variables: Variables }>();

function resolveRouteGroup(
  id: string,
): { routeJid: string; group: RegisteredGroup } | null {
  const direct = getRegisteredGroup(id);
  if (direct && id.startsWith('web:')) {
    return { routeJid: id, group: direct };
  }

  const session = getSessionRecord(id);
  if (!session) return null;

  const folder = session.id.startsWith('main:')
    ? session.id.slice('main:'.length)
    : session.parent_session_id?.startsWith('main:')
      ? session.parent_session_id.slice('main:'.length)
      : null;
  if (!folder) return null;

  const backingJid = getJidsByFolder(folder).find((jid) => jid.startsWith('web:'));
  if (!backingJid) return null;
  const group = getRegisteredGroup(backingJid);
  return group ? { routeJid: backingJid, group } : null;
}

// All routes require authentication
turnsRoutes.use('/*', authMiddleware);

/**
 * GET /:jid/turns — Turn list (paginated)
 */
turnsRoutes.get('/:jid/turns', (c) => {
  const user = c.get('user') as AuthUser;
  const jid = c.req.param('jid');
  const resolved = resolveRouteGroup(jid);
  if (!resolved || !canAccessGroup(user, { ...resolved.group, jid: resolved.routeJid })) {
    return c.json({ error: 'Not found' }, 404);
  }

  const limit = Math.min(parseInt(c.req.query('limit') || '50', 10) || 50, 200);
  const offset = parseInt(c.req.query('offset') || '0', 10) || 0;

  // Query by folder so all IM channels mapped into the same Session workspace are included.
  const turns = getTurnsByFolder(resolved.group.folder, limit, offset);
  return c.json({
    turns: turns.map((t) => ({
      id: t.id,
      chatJid: t.chat_jid,
      channel: t.channel,
      messageIds: t.message_ids ? JSON.parse(t.message_ids) : [],
      startedAt: t.started_at,
      completedAt: t.completed_at,
      status: t.status,
      summary: t.summary,
      groupFolder: t.group_folder,
      hasTrace: !!t.trace_file,
    })),
  });
});

/**
 * GET /:jid/turns/active — Current active turn + pending buffer info
 */
turnsRoutes.get('/:jid/turns/active', (c) => {
  const user = c.get('user') as AuthUser;
  const jid = c.req.param('jid');
  const resolved = resolveRouteGroup(jid);
  if (!resolved || !canAccessGroup(user, { ...resolved.group, jid: resolved.routeJid })) {
    return c.json({ error: 'Not found' }, 404);
  }

  const deps = getWebDeps();
  const runtimeTurn = deps?.getActiveTurnRuntime?.(resolved.group.folder) || null;
  const dbTurn = !runtimeTurn ? getActiveTurnByFolder(resolved.group.folder) : null;
  const activeTurn = runtimeTurn
    ? {
        id: runtimeTurn.id,
        chatJid: runtimeTurn.chatJid,
        channel: runtimeTurn.channel,
        messageIds: runtimeTurn.messageIds,
        startedAt: new Date(runtimeTurn.startedAt).toISOString(),
      }
    : dbTurn
      ? {
          id: dbTurn.id,
          chatJid: dbTurn.chat_jid,
          channel: dbTurn.channel,
          messageIds: dbTurn.message_ids ? JSON.parse(dbTurn.message_ids) : [],
          startedAt: dbTurn.started_at,
        }
      : null;
  const pendingCounts = deps?.getPendingTurnCounts?.(resolved.group.folder) || new Map();
  const observability = deps?.getTurnObservability?.(resolved.group.folder) || null;
  const pendingBuffer = Array.from(pendingCounts.entries())
    .filter(([, count]) => count > 0)
    .map(([channel, count]) => ({ channel, count }));

  return c.json({
    activeTurn: activeTurn
      ? {
          id: activeTurn.id,
          chatJid: activeTurn.chatJid,
          channel: activeTurn.channel,
          messageIds: activeTurn.messageIds,
          startedAt: activeTurn.startedAt,
          status: observability?.runnerState?.state || 'running',
          observability,
        }
      : null,
    pendingBuffer,
  });
});

/**
 * GET /:jid/turns/:turnId — Turn details
 */
turnsRoutes.get('/:jid/turns/:turnId', (c) => {
  const user = c.get('user') as AuthUser;
  const jid = c.req.param('jid');
  const resolved = resolveRouteGroup(jid);
  if (!resolved || !canAccessGroup(user, { ...resolved.group, jid: resolved.routeJid })) {
    return c.json({ error: 'Not found' }, 404);
  }

  const turnId = c.req.param('turnId');
  const turn = getTurnById(turnId);
  if (!turn || turn.group_folder !== resolved.group.folder) {
    return c.json({ error: 'Turn not found' }, 404);
  }

  return c.json({
    id: turn.id,
    chatJid: turn.chat_jid,
    channel: turn.channel,
    messageIds: turn.message_ids ? JSON.parse(turn.message_ids) : [],
    startedAt: turn.started_at,
    completedAt: turn.completed_at,
    status: turn.status,
    resultMessageId: turn.result_message_id,
    summary: turn.summary,
    tokenUsage: turn.token_usage ? JSON.parse(turn.token_usage) : null,
    groupFolder: turn.group_folder,
    hasTrace: !!turn.trace_file,
  });
});

/**
 * GET /:jid/turns/:turnId/trace — Load trace JSON file
 */
turnsRoutes.get('/:jid/turns/:turnId/trace', (c) => {
  const user = c.get('user') as AuthUser;
  const jid = c.req.param('jid');
  const resolved = resolveRouteGroup(jid);
  if (!resolved || !canAccessGroup(user, { ...resolved.group, jid: resolved.routeJid })) {
    return c.json({ error: 'Not found' }, 404);
  }

  const turnId = c.req.param('turnId');
  const turn = getTurnById(turnId);
  if (!turn || turn.group_folder !== resolved.group.folder) {
    return c.json({ error: 'Turn not found' }, 404);
  }

  if (!turn.trace_file) {
    return c.json({ error: 'No trace available' }, 404);
  }

  const trace = loadTurnTrace(turn.trace_file);
  if (!trace) {
    return c.json({ error: 'Trace file not found or corrupted' }, 404);
  }

  return c.json(trace);
});

export default turnsRoutes;
