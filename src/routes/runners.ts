import { execFile } from 'child_process';
import { promisify } from 'util';

import { Hono } from 'hono';

import { authMiddleware } from '../middleware/auth.js';
import {
  canServeAsMemoryRunner,
  explainRunnerDegradation,
  getRunnerDescriptor,
  listRunnerDescriptors,
} from '../runner-registry.js';
import {
  detectLocalClaudeCode,
  detectLocalCodexCli,
} from '../runtime-config.js';
import type { RunnerDescriptor, RunnerHealth } from '../types.js';
import type { Variables } from '../web-context.js';

const runnersRoutes = new Hono<{ Variables: Variables }>();
const execFileAsync = promisify(execFile);

function serializeRunner(descriptor: RunnerDescriptor) {
  return {
    id: descriptor.id,
    label: descriptor.label,
    description: descriptor.description,
    default_model: descriptor.defaultModel,
    model_patterns: descriptor.modelPatterns || [],
    capabilities: descriptor.capabilities,
    lifecycle: descriptor.lifecycle,
    prompt_contract: descriptor.promptContract,
    runtime_contract: descriptor.runtimeContract,
    tool_contract: descriptor.toolContract,
    profile_schema: descriptor.profileSchema || null,
    compatibility: descriptor.compatibility,
    can_serve_memory: canServeAsMemoryRunner(descriptor),
    degradation_reasons: explainRunnerDegradation(descriptor),
  };
}

async function detectCommandVersion(command: string): Promise<string | undefined> {
  try {
    const result = await execFileAsync(command, ['--version'], {
      timeout: 3000,
      windowsHide: true,
    });
    return (result.stdout || result.stderr).trim().split('\n')[0] || undefined;
  } catch {
    return undefined;
  }
}

async function buildRunnerHealth(
  descriptor: RunnerDescriptor,
): Promise<RunnerHealth> {
  const command = descriptor.runtimeContract.requiredCommands?.[0];
  const version = command ? await detectCommandVersion(command) : undefined;
  const commandDetected = !command || !!version;
  let authenticated = true;
  const details: Record<string, unknown> = {};

  if (descriptor.id === 'claude') {
    const local = detectLocalClaudeCode();
    authenticated = local.hasCredentials || !!process.env.ANTHROPIC_API_KEY;
    details.credentialsDetected = local.detected;
    details.expiresAt = local.expiresAt;
  } else if (descriptor.id === 'codex') {
    const local = detectLocalCodexCli();
    authenticated = local.hasAuth || !!process.env.OPENAI_API_KEY;
    details.authMode = local.authMode;
    details.accountId = local.accountId;
    details.lastRefresh = local.lastRefresh;
  } else if (descriptor.runtimeContract.auth === 'api_key') {
    authenticated = (descriptor.runtimeContract.requiredEnv || []).every(
      (name) => !!process.env[name],
    );
  } else if (descriptor.runtimeContract.auth === 'none') {
    authenticated = true;
  }

  const missingReasons: string[] = [];
  if (!commandDetected && command) {
    missingReasons.push(`找不到命令 ${command}`);
  }
  for (const envName of descriptor.runtimeContract.requiredEnv || []) {
    if (!process.env[envName]) missingReasons.push(`缺少环境变量 ${envName}`);
  }
  if (!authenticated) {
    missingReasons.push('runner 尚未认证');
  }

  return {
    runnerId: descriptor.id,
    available: commandDetected && authenticated && missingReasons.length === 0,
    commandDetected,
    authenticated,
    version,
    details,
    missingReasons,
  };
}

runnersRoutes.get('/', authMiddleware, (c) => {
  return c.json({ runners: listRunnerDescriptors().map(serializeRunner) });
});

runnersRoutes.get('/:id/health', authMiddleware, async (c) => {
  const descriptor = getRunnerDescriptor(c.req.param('id'));
  if (!descriptor) return c.json({ error: 'Runner not found' }, 404);
  return c.json({ health: await buildRunnerHealth(descriptor) });
});

runnersRoutes.get('/:id/models', authMiddleware, (c) => {
  const descriptor = getRunnerDescriptor(c.req.param('id'));
  if (!descriptor) return c.json({ error: 'Runner not found' }, 404);
  return c.json({
    models: descriptor.defaultModel
      ? [{ id: descriptor.defaultModel, label: descriptor.defaultModel }]
      : [],
  });
});

runnersRoutes.get('/:id/profile-schema', authMiddleware, (c) => {
  const descriptor = getRunnerDescriptor(c.req.param('id'));
  if (!descriptor) return c.json({ error: 'Runner not found' }, 404);
  return c.json({ schema: descriptor.profileSchema || null });
});

export default runnersRoutes;
