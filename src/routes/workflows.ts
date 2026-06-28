import { Hono } from 'hono';

import { authMiddleware } from '../middleware/auth.js';
import { getInternalToken } from './memory-agent.js';
import type { AuthUser, WorkflowDefinition } from '../types.js';
import type { Variables } from '../web-context.js';
import { workflowService } from '../workflow-service.js';

const workflowsRoutes = new Hono<{ Variables: Variables }>();

function checkInternalAuth(c: {
  req: { header: (name: string) => string | undefined };
}): boolean {
  const internalToken = getInternalToken();
  if (!internalToken) return false;
  const auth = c.req.header('Authorization');
  if (!auth) return false;
  const token = auth.replace(/^Bearer\s+/i, '');
  return token === internalToken;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function parseDefinition(value: unknown): WorkflowDefinition {
  if (typeof value === 'string') return JSON.parse(value) as WorkflowDefinition;
  return value as WorkflowDefinition;
}

function boolValue(value: unknown): boolean {
  return value === true || value === 'true' || value === '1';
}

function excerptLength(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

// Public Web API
workflowsRoutes.get('/providers', authMiddleware, (c) => {
  return c.json({ providers: workflowService.providers() });
});

workflowsRoutes.get('/', authMiddleware, (c) => {
  const authUser = c.get('user') as AuthUser;
  return c.json({ workflows: workflowService.list(authUser.id) });
});

workflowsRoutes.post('/', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  const body = await c.req.json().catch(() => ({}));
  try {
    const workflow = workflowService.create({
      ownerKey: authUser.id,
      name: typeof body.name === 'string' ? body.name : undefined,
      description: typeof body.description === 'string' ? body.description : undefined,
      definition: parseDefinition(body.definition),
      // Web CRUD is for monitoring/manual definition editing only. Workspace binding
      // is set by the agent-side internal tool from its trusted runtime context.
      workspaceFolder: null,
      groupFolder: null,
      createdBy: authUser.id,
    });
    return c.json({ workflow }, 201);
  } catch (err) {
    return c.json({ error: errorMessage(err) }, 400);
  }
});

workflowsRoutes.get('/runs', authMiddleware, (c) => {
  const authUser = c.get('user') as AuthUser;
  const limit = Number.parseInt(c.req.query('limit') || '50', 10);
  return c.json({
    runs: workflowService.runs(authUser.id, undefined, limit, {
      includeResult: boolValue(c.req.query('include_result')),
      includeTrigger: boolValue(c.req.query('include_trigger')) || boolValue(c.req.query('verbose')),
      excerptLength: excerptLength(c.req.query('excerpt_length')),
    }),
  });
});

workflowsRoutes.get('/runs/:runId', authMiddleware, (c) => {
  const authUser = c.get('user') as AuthUser;
  const run = workflowService.runStatus(authUser.id, c.req.param('runId'), {
    includeResult: boolValue(c.req.query('include_result')),
    includeTrigger: boolValue(c.req.query('include_trigger')) || boolValue(c.req.query('verbose')),
    excerptLength: excerptLength(c.req.query('excerpt_length')),
  });
  if (!run) return c.json({ error: 'Run not found' }, 404);
  return c.json({ run });
});

workflowsRoutes.post('/runs/:runId/cancel', authMiddleware, (c) => {
  const authUser = c.get('user') as AuthUser;
  const ok = workflowService.cancel(authUser.id, c.req.param('runId'));
  if (!ok) return c.json({ error: 'Run not found' }, 404);
  return c.json({ ok: true });
});

workflowsRoutes.get('/runs/:runId/nodes/:nodeId/output', authMiddleware, (c) => {
  const authUser = c.get('user') as AuthUser;
  const result = workflowService.readNodeOutput(
    authUser.id,
    c.req.param('runId'),
    c.req.param('nodeId'),
    {
      includeMetadata: boolValue(c.req.query('include_metadata')),
      includeLogs: boolValue(c.req.query('include_logs')),
    },
  );
  if (result == null) return c.json({ error: 'Output not found' }, 404);
  if (boolValue(c.req.query('include_metadata')) || boolValue(c.req.query('include_logs'))) {
    return c.json(result);
  }
  return c.text(String(result.output || ''), 200, { 'Content-Type': 'text/plain; charset=utf-8' });
});

workflowsRoutes.get('/:workflowId', authMiddleware, (c) => {
  const authUser = c.get('user') as AuthUser;
  const workflow = workflowService.get(authUser.id, c.req.param('workflowId'));
  if (!workflow) return c.json({ error: 'Workflow not found' }, 404);
  return c.json({ workflow });
});

workflowsRoutes.patch('/:workflowId', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  const body = await c.req.json().catch(() => ({}));
  try {
    const workflow = workflowService.update(authUser.id, c.req.param('workflowId'), {
      name: typeof body.name === 'string' ? body.name : undefined,
      description: body.description === null || typeof body.description === 'string' ? body.description : undefined,
      definition: body.definition === undefined ? undefined : parseDefinition(body.definition),
    });
    if (!workflow) return c.json({ error: 'Workflow not found' }, 404);
    return c.json({ workflow });
  } catch (err) {
    return c.json({ error: errorMessage(err) }, 400);
  }
});

workflowsRoutes.delete('/:workflowId', authMiddleware, (c) => {
  const authUser = c.get('user') as AuthUser;
  const ok = workflowService.archive(authUser.id, c.req.param('workflowId'));
  if (!ok) return c.json({ error: 'Workflow not found' }, 404);
  return c.json({ ok: true });
});

workflowsRoutes.post('/:workflowId/run', authMiddleware, async (c) => {
  const authUser = c.get('user') as AuthUser;
  const body = await c.req.json().catch(() => ({}));
  try {
    const result = await workflowService.startRun({
      ownerKey: authUser.id,
      workflowId: c.req.param('workflowId'),
      input: body.input && typeof body.input === 'object' ? body.input : null,
      wait: false,
      runSource: 'web',
      trigger: {
        route: 'POST /api/workflows/:workflowId/run',
        userId: authUser.id,
      },
    });
    const runId = result.run?.id;
    return c.json(runId ? { run: workflowService.runStatus(authUser.id, runId) } : result);
  } catch (err) {
    return c.json({ error: errorMessage(err) }, 400);
  }
});

workflowsRoutes.get('/:workflowId/runs', authMiddleware, (c) => {
  const authUser = c.get('user') as AuthUser;
  const limit = Number.parseInt(c.req.query('limit') || '50', 10);
  return c.json({
    runs: workflowService.runs(authUser.id, c.req.param('workflowId'), limit, {
      includeResult: boolValue(c.req.query('include_result')),
      includeTrigger: boolValue(c.req.query('include_trigger')) || boolValue(c.req.query('verbose')),
      excerptLength: excerptLength(c.req.query('excerpt_length')),
    }),
  });
});

// Internal agent-tool API. These endpoints are token authenticated and scoped by body.userId.
workflowsRoutes.post('/internal/tool', async (c) => {
  if (!checkInternalAuth(c)) return c.json({ error: 'Unauthorized' }, 401);
  const body = await c.req.json().catch(() => ({}));
  if (!body || typeof body.userId !== 'string') {
    return c.json({ error: 'userId is required' }, 400);
  }
  const action = String(body.action || '');
  const ownerKey = body.userId;
  try {
    switch (action) {
      case 'providers':
        return c.json({ providers: workflowService.providers() });
      case 'list':
        return c.json({ workflows: workflowService.list(ownerKey) });
      case 'get': {
        const workflow = workflowService.get(ownerKey, String(body.workflowId || ''));
        if (!workflow) return c.json({ error: 'Workflow not found' }, 404);
        return c.json({ workflow });
      }
      case 'create': {
        const workflow = workflowService.create({
          ownerKey,
          name: typeof body.name === 'string' ? body.name : undefined,
          description: typeof body.description === 'string' ? body.description : undefined,
          definition: parseDefinition(body.definition),
          workspaceFolder: typeof body.workspaceFolder === 'string' ? body.workspaceFolder : null,
          groupFolder: typeof body.groupFolder === 'string' ? body.groupFolder : null,
          createdBy: typeof body.createdBy === 'string' ? body.createdBy : null,
        });
        return c.json({ workflow });
      }
      case 'update': {
        const workflow = workflowService.update(ownerKey, String(body.workflowId || ''), {
          name: typeof body.name === 'string' ? body.name : undefined,
          description: body.description === null || typeof body.description === 'string' ? body.description : undefined,
          definition: body.definition === undefined ? undefined : parseDefinition(body.definition),
          workspaceFolder: body.workspaceFolder === null || typeof body.workspaceFolder === 'string' ? body.workspaceFolder : undefined,
          groupFolder: body.groupFolder === null || typeof body.groupFolder === 'string' ? body.groupFolder : undefined,
        });
        if (!workflow) return c.json({ error: 'Workflow not found' }, 404);
        return c.json({ workflow });
      }
      case 'run': {
        const result = await workflowService.startRun({
          ownerKey,
          workflowId: String(body.workflowId || ''),
          input: body.input && typeof body.input === 'object' ? body.input : null,
          workspaceFolder: typeof body.workspaceFolder === 'string' ? body.workspaceFolder : null,
          wait: false,
          runSource: 'agent-tool',
          trigger: {
            route: 'POST /api/workflows/internal/tool',
            action,
            userId: ownerKey,
            groupFolder: typeof body.groupFolder === 'string' ? body.groupFolder : null,
            workspaceFolder: typeof body.workspaceFolder === 'string' ? body.workspaceFolder : null,
            chatJid: typeof body.chatJid === 'string' ? body.chatJid : null,
            createdBy: typeof body.createdBy === 'string' ? body.createdBy : null,
          },
        });
        const runId = result.run?.id;
        return c.json(runId ? { run: workflowService.runStatus(ownerKey, runId) } : result);
      }
      case 'run_script': {
        const result = await workflowService.startScriptRun({
          ownerKey,
          script: String(body.script || ''),
          name: typeof body.name === 'string' ? body.name : undefined,
          description: typeof body.description === 'string' ? body.description : null,
          settings: body.settings && typeof body.settings === 'object' ? body.settings as WorkflowDefinition['settings'] : undefined,
          input: body.input && typeof body.input === 'object' ? body.input : null,
          workspaceFolder: typeof body.workspaceFolder === 'string' ? body.workspaceFolder : null,
          groupFolder: typeof body.groupFolder === 'string' ? body.groupFolder : null,
          createdBy: typeof body.createdBy === 'string' ? body.createdBy : null,
          wait: body.wait === true,
          runSource: 'agent-tool-script',
          trigger: {
            route: 'POST /api/workflows/internal/tool',
            action,
            userId: ownerKey,
            groupFolder: typeof body.groupFolder === 'string' ? body.groupFolder : null,
            workspaceFolder: typeof body.workspaceFolder === 'string' ? body.workspaceFolder : null,
            chatJid: typeof body.chatJid === 'string' ? body.chatJid : null,
            createdBy: typeof body.createdBy === 'string' ? body.createdBy : null,
          },
        });
        const runId = result.run?.id;
        return c.json(runId ? { run: workflowService.runStatus(ownerKey, runId) } : result);
      }
      case 'status': {
        const run = workflowService.runStatus(ownerKey, String(body.runId || ''), {
          includeResult: body.include_result === true,
          includeTrigger: body.include_trigger === true || body.verbose === true,
          excerptLength: excerptLength(body.excerpt_length),
        });
        if (!run) return c.json({ error: 'Run not found' }, 404);
        return c.json({ run });
      }
      case 'runs':
        return c.json({
          runs: workflowService.runs(
            ownerKey,
            typeof body.workflowId === 'string' ? body.workflowId : undefined,
            Number(body.limit || 50),
            {
              includeResult: body.include_result === true,
              includeTrigger: body.include_trigger === true || body.verbose === true,
              excerptLength: excerptLength(body.excerpt_length),
            },
          ),
        });
      case 'cancel':
        return c.json({ ok: workflowService.cancel(ownerKey, String(body.runId || '')) });
      case 'read_node_output': {
        const output = workflowService.readNodeOutput(ownerKey, String(body.runId || ''), String(body.nodeId || ''), {
          includeMetadata: body.include_metadata === true,
          includeLogs: body.include_logs === true,
        });
        if (output == null) return c.json({ error: 'Output not found' }, 404);
        return c.json(output);
      }
      default:
        return c.json({ error: `Unknown workflow action: ${action}` }, 400);
    }
  } catch (err) {
    return c.json({ error: errorMessage(err) }, 400);
  }
});

export default workflowsRoutes;
