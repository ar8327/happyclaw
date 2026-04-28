/**
 * Internal HTTP endpoints for Memory Agent communication.
 *
 * These endpoints are called by agent-runner (inside containers or host processes)
 * to interact with the per-user memory orchestration runtime.
 *
 * Authentication: Bearer token (HAPPYCLAW_INTERNAL_TOKEN), generated at startup.
 * Only accepts requests from localhost.
 */

import { Hono } from 'hono';
import type { Variables } from '../web-context.js';
import { getChatNamesByJids } from '../db.js';
import { logger } from '../logger.js';
import type { MemoryOrchestrator } from '../memory-orchestrator.js';
import { resolveChannelLabel } from '../memory-agent.js';
let orchestrator: MemoryOrchestrator | null = null;
let internalToken: string | null = null;

/**
 * Inject dependencies at startup.
 * Called from src/index.ts after MemoryOrchestrator is initialized.
 */
export function injectMemoryOrchestratorDeps(deps: {
  orchestrator: MemoryOrchestrator;
  token: string;
}): void {
  orchestrator = deps.orchestrator;
  internalToken = deps.token;
}

/** Get the internal token (for passing to agent-runner via env). */
export function getInternalToken(): string | null {
  return internalToken;
}

const memoryAgentRoutes = new Hono<{ Variables: Variables }>();

// Bearer token middleware for internal endpoints
function checkInternalAuth(c: {
  req: { header: (name: string) => string | undefined };
}): boolean {
  if (!internalToken) return false;
  const auth = c.req.header('Authorization');
  if (!auth) return false;
  const token = auth.replace(/^Bearer\s+/i, '');
  return token === internalToken;
}

// POST /api/internal/memory/query
memoryAgentRoutes.post('/query', async (c) => {
  if (!checkInternalAuth(c)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  if (!orchestrator) {
    return c.json({ error: 'Memory Agent not initialized' }, 503);
  }

  const body = await c.req.json().catch(() => null);
  if (
    !body ||
    typeof body.userId !== 'string' ||
    typeof body.query !== 'string'
  ) {
    return c.json({ error: 'Invalid request: userId and query required' }, 400);
  }

  try {
    // Resolve channel label from chatJid if provided
    let channelLabel: string | undefined;
    const chatJid = body.chatJid as string | undefined;
    const workspaceFolder =
      (body.workspaceFolder as string | undefined)
      || (body.groupFolder as string | undefined);
    if (chatJid) {
      const names = getChatNamesByJids([chatJid]);
      channelLabel = resolveChannelLabel(chatJid, names.get(chatJid));
    }

    const result = await orchestrator.query(body.userId, {
      query: body.query,
      context: body.context as string | undefined,
      chatJid,
      workspaceFolder,
      channelLabel,
    });

    if (result.success) {
      return c.json({
        response: result.response || '',
        found: !!result.response,
      });
    } else {
      return c.json({ error: result.error || 'Query failed' }, 502);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    if (message.includes('timeout')) {
      return c.json({ error: '记忆系统处理超时' }, 408);
    }
    if (message.includes('concurrency limit')) {
      return c.json({ error: '记忆系统正忙' }, 503);
    }
    if (message.includes('exited')) {
      return c.json({ error: '记忆系统暂时不可用' }, 502);
    }

    logger.error({ err, userId: body.userId }, 'Memory query error');
    return c.json({ error: message }, 500);
  }
});

// POST /api/internal/memory/remember
memoryAgentRoutes.post('/remember', async (c) => {
  if (!checkInternalAuth(c)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  if (!orchestrator) {
    return c.json({ error: 'Memory Agent not initialized' }, 503);
  }

  const body = await c.req.json().catch(() => null);
  if (
    !body ||
    typeof body.userId !== 'string' ||
    typeof body.content !== 'string'
  ) {
    return c.json(
      { error: 'Invalid request: userId and content required' },
      400,
    );
  }

  try {
    // Resolve channel label from chatJid if provided
    let channelLabel: string | undefined;
    const chatJid = body.chatJid as string | undefined;
    const workspaceFolder =
      (body.workspaceFolder as string | undefined)
      || (body.groupFolder as string | undefined);
    if (chatJid) {
      const names = getChatNamesByJids([chatJid]);
      channelLabel = resolveChannelLabel(chatJid, names.get(chatJid));
    }

    void orchestrator.send(body.userId, {
      type: 'remember',
      content: body.content,
      importance: body.importance || 'normal',
      chatJid,
      workspaceFolder,
      channelLabel,
    }).catch((err) => {
      logger.error({ err, userId: body.userId }, 'Memory remember background task failed');
    });
    return c.json({ accepted: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, userId: body.userId }, 'Memory remember error');
    return c.json({ error: message }, 500);
  }
});

// POST /api/internal/memory/session-wrapup
memoryAgentRoutes.post('/session-wrapup', async (c) => {
  if (!checkInternalAuth(c)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  if (!orchestrator) {
    return c.json({ error: 'Memory Agent not initialized' }, 503);
  }

  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.userId !== 'string') {
    return c.json({ error: 'Invalid request: userId required' }, 400);
  }

  try {
    const workspaceFolder =
      (body.workspaceFolder as string | undefined)
      || (body.groupFolder as string | undefined);
    await orchestrator.send(body.userId, {
      type: 'session_wrapup',
      transcriptFile: body.transcriptFile,
      workspaceFolder,
      chatJids: body.chatJids,
    });
    return c.json({ accepted: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, userId: body.userId }, 'Memory session-wrapup error');
    return c.json({ error: message }, 500);
  }
});

export default memoryAgentRoutes;
