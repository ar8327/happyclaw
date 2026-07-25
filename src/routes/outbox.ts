import { Hono } from 'hono';
import fs from 'node:fs';
import path from 'node:path';

import {
  clearFailedImOutbox,
  listFailedImOutbox,
  retryFailedImOutbox,
} from '../db.js';
import { authMiddleware } from '../middleware/auth.js';
import type { Variables } from '../web-context.js';
import { DATA_DIR } from '../config.js';

const outboxRoutes = new Hono<{ Variables: Variables }>();
outboxRoutes.use('/*', authMiddleware);

outboxRoutes.get('/failed', (c) => {
  const limit = Number.parseInt(c.req.query('limit') || '100', 10);
  return c.json({
    deliveries: listFailedImOutbox(Number.isFinite(limit) ? limit : 100).map(
      (record) => ({
        id: record.id,
        sourceChatJid: record.source_chat_jid,
        targetJid: record.target_jid,
        kind: record.kind,
        attempts: record.attempts,
        error: record.last_error,
        createdAt: record.created_at,
        updatedAt: record.updated_at,
      }),
    ),
  });
});

outboxRoutes.post('/:id/retry', (c) => {
  const retried = retryFailedImOutbox(c.req.param('id'));
  return retried
    ? c.json({ ok: true })
    : c.json({ error: 'Failed delivery not found' }, 404);
});

outboxRoutes.delete('/:id', (c) => {
  const cleared = clearFailedImOutbox(c.req.param('id'));
  return cleared
    ? c.json({ ok: true })
    : c.json({ error: 'Failed delivery not found' }, 404);
});

outboxRoutes.get('/ipc-errors', (c) => {
  const errorDir = path.join(DATA_DIR, 'ipc', 'errors');
  if (!fs.existsSync(errorDir)) return c.json({ errors: [] });
  const errors = fs
    .readdirSync(errorDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => {
      const stat = fs.statSync(path.join(errorDir, entry.name));
      return {
        name: entry.name,
        size: stat.size,
        updatedAt: stat.mtime.toISOString(),
      };
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return c.json({ errors });
});

outboxRoutes.delete('/ipc-errors/:name', (c) => {
  const name = c.req.param('name');
  if (path.basename(name) !== name || !name.endsWith('.json')) {
    return c.json({ error: 'Invalid IPC error filename' }, 400);
  }
  const filePath = path.join(DATA_DIR, 'ipc', 'errors', name);
  if (!fs.existsSync(filePath)) {
    return c.json({ error: 'IPC error file not found' }, 404);
  }
  fs.unlinkSync(filePath);
  return c.json({ ok: true });
});

export default outboxRoutes;
