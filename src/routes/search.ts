import { Hono } from 'hono';
import type { Variables } from '../web-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { canAccessGroup } from '../web-context.js';
import type { AuthUser } from '../types.js';
import {
  getAllRegisteredGroups,
  searchMessages,
  countSearchResults,
  getSessionRecord,
  listAgentsByJid,
} from '../db.js';

const searchRoutes = new Hono<{ Variables: Variables }>();

// GET /api/search/messages - 跨工作区全局搜索
searchRoutes.get('/messages', authMiddleware, (c) => {
  const authUser = c.get('user') as AuthUser;

  const q = c.req.query('q')?.trim();
  if (!q) {
    return c.json({ error: 'Missing search query parameter "q"' }, 400);
  }

  const limitRaw = parseInt(c.req.query('limit') || '50', 10);
  const limit = Math.min(
    Number.isFinite(limitRaw) ? Math.max(1, limitRaw) : 50,
    200,
  );
  const offsetRaw = parseInt(c.req.query('offset') || '0', 10);
  const offset = Number.isFinite(offsetRaw) ? Math.max(0, offsetRaw) : 0;

  // Time range filter: days=7 means last 7 days, days=0 or omitted means no filter
  const daysRaw = parseInt(c.req.query('days') || '0', 10);
  const days = Number.isFinite(daysRaw) ? Math.max(0, daysRaw) : 0;
  const sinceTs = days > 0
    ? new Date(Date.now() - days * 86400000).toISOString()
    : undefined;

  // Collect all JIDs the user can access
  const allGroups = getAllRegisteredGroups();
  const accessibleJids = new Set<string>();
  const groupInfoMap = new Map<
    string,
    {
      folder: string;
      name?: string;
      session_id: string;
      session_folder: string;
      session_name: string;
    }
  >();

  for (const [jid, group] of Object.entries(allGroups)) {
    if (canAccessGroup({ id: authUser.id, role: authUser.role }, { ...group, jid })) {
      accessibleJids.add(jid);
      const sessionId = `main:${group.folder}`;
      const session = getSessionRecord(sessionId);
      groupInfoMap.set(jid, {
        folder: group.folder,
        name: group.name,
        session_id: session?.id || sessionId,
        session_folder: group.folder,
        session_name: session?.name || group.name || group.folder,
      });

      if (!jid.startsWith('web:')) continue;

      for (const agent of listAgentsByJid(jid)) {
        if (agent.kind !== 'conversation') continue;
        const workerSessionId = `worker:${agent.id}`;
        const workerSession = getSessionRecord(workerSessionId);
        const workerJid = `${jid}#agent:${agent.id}`;
        accessibleJids.add(workerJid);
        groupInfoMap.set(workerJid, {
          folder: group.folder,
          name: `${group.name} / ${agent.name}`,
          session_id: workerSession?.id || workerSessionId,
          session_folder: group.folder,
          session_name: workerSession?.name || agent.name,
        });
      }
    }
  }

  const searchableJids = Array.from(accessibleJids);

  if (searchableJids.length === 0) {
    return c.json({ results: [], total: 0, hasMore: false });
  }

  const results = searchMessages(searchableJids, q, limit, offset, sinceTs);
  const total = countSearchResults(searchableJids, q, sinceTs);
  const hasMore = offset + results.length < total;

  // Enrich results with group info
  const enriched = results.map((r) => {
    const info = groupInfoMap.get(r.chat_jid);
    return {
      ...r,
      session_id: info?.session_id,
      session_folder: info?.session_folder,
      session_name: info?.session_name,
      group_name: info?.name,
    };
  });

  return c.json({ results: enriched, total, hasMore });
});

export default searchRoutes;
