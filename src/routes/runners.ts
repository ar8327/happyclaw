import { Hono } from 'hono';

import { authMiddleware } from '../middleware/auth.js';
import {
  getRunnerServerManifest,
  listRunnerServerManifests,
  serializeRunnerDescriptor,
} from '../runner-catalog.js';
import type { Variables } from '../web-context.js';

const runnersRoutes = new Hono<{ Variables: Variables }>();

runnersRoutes.get('/', authMiddleware, (c) => {
  return c.json({
    runners: listRunnerServerManifests().map((manifest) =>
      serializeRunnerDescriptor(manifest.descriptor),
    ),
  });
});

runnersRoutes.get('/:id/health', authMiddleware, async (c) => {
  const manifest = getRunnerServerManifest(c.req.param('id'));
  if (!manifest) return c.json({ error: 'Runner not found' }, 404);
  return c.json({ health: await manifest.healthCheck() });
});

runnersRoutes.get('/:id/models', authMiddleware, async (c) => {
  const manifest = getRunnerServerManifest(c.req.param('id'));
  if (!manifest) return c.json({ error: 'Runner not found' }, 404);
  return c.json({ models: await manifest.listModels() });
});

runnersRoutes.get('/:id/profile-schema', authMiddleware, (c) => {
  const manifest = getRunnerServerManifest(c.req.param('id'));
  if (!manifest) return c.json({ error: 'Runner not found' }, 404);
  return c.json({ schema: manifest.profileSchema() });
});

export default runnersRoutes;
