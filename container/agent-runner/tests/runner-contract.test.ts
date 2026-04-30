import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { RUNNER_DESCRIPTORS } from '../src/runner-descriptor.types.js';
import type {
  NormalizedMessage,
  QueryResult,
} from '../src/runner-interface.js';
import type { RunnerPromptContract } from '../src/runner-descriptor.types.js';
import { listRunnerManifests } from '../src/runners/index.js';
import { fakeJsonManifest } from '../src/runners/fake-json/manifest.js';
import { evaluateRunnerAuthProbe } from '../../../src/runner-health.js';
import { listRunnerServerManifests } from '../../../src/runners/index.js';
import { validateRunnerProfileConfig } from '../../../src/runner-profile-schema.js';

async function collectRun(
  prompt = 'hello',
  opts?: {
    systemPrompt?: string;
    promptContract?: RunnerPromptContract;
  },
): Promise<{
  messages: NormalizedMessage[];
  result: QueryResult;
}> {
  const runner = await fakeJsonManifest.createRunner({
    containerInput: {
      prompt,
      chatJid: 'web:test',
      workspaceFolder: 'test',
      runnerId: fakeJsonManifest.descriptor.id,
      isHome: false,
      isAdminHome: false,
    },
    state: {} as never,
    ipcPaths: {} as never,
    log: () => undefined,
    writeOutput: () => undefined,
    imChannelsFile: '',
    groupDir: process.cwd(),
    globalDir: process.cwd(),
    memoryDir: process.cwd(),
    loadUserMcpServers: () => ({}),
    skillsDir: process.cwd(),
    disableSyntheticArchive: false,
  });

  const generator = runner.runQuery({
    prompt,
    systemPrompt: opts?.systemPrompt || 'system',
    promptContract: opts?.promptContract,
  });
  const messages: NormalizedMessage[] = [];
  let next = await generator.next();
  while (!next.done) {
    messages.push(next.value);
    next = await generator.next();
  }
  return { messages, result: next.value };
}

function assertProductionManifestDescriptors(): void {
  const runnerIndex = fs.readFileSync(
    path.resolve('container/agent-runner/src/runners/index.ts'),
    'utf-8',
  );
  assert.equal(runnerIndex.includes('PRODUCTION_MANIFESTS'), false);
  assert.equal(runnerIndex.includes("from './claude/manifest"), false);
  assert.equal(runnerIndex.includes("from './codex/manifest"), false);

  for (const manifest of listRunnerManifests()) {
    const descriptor = RUNNER_DESCRIPTORS[manifest.descriptor.id];
    assert.ok(descriptor, `missing descriptor for ${manifest.descriptor.id}`);
    assert.deepEqual(
      manifest.descriptor,
      descriptor,
      `manifest descriptor mismatch for ${manifest.descriptor.id}`,
    );
    assert.equal(
      typeof manifest.healthCheck,
      'function',
      `missing healthCheck for ${manifest.descriptor.id}`,
    );
    assert.equal(
      typeof manifest.listModels,
      'function',
      `missing listModels for ${manifest.descriptor.id}`,
    );
  }
}

function assertBackendRunnerManifests(): void {
  const runnerCatalog = fs.readFileSync(
    path.resolve('src/runner-catalog.ts'),
    'utf-8',
  );
  assert.equal(runnerCatalog.includes('runners/index.js'), true);

  const manifests = listRunnerServerManifests();
  assert.equal(
    manifests.length,
    Object.keys(RUNNER_DESCRIPTORS).length,
    'backend registry should expose every shared descriptor without per-runner server files',
  );
  for (const manifest of manifests) {
    const descriptor = RUNNER_DESCRIPTORS[manifest.descriptor.id];
    assert.ok(
      descriptor,
      `missing backend descriptor for ${manifest.descriptor.id}`,
    );
    assert.deepEqual(
      manifest.descriptor,
      descriptor,
      `backend manifest descriptor mismatch for ${manifest.descriptor.id}`,
    );
    assert.equal(typeof manifest.healthCheck, 'function');
    assert.equal(typeof manifest.listModels, 'function');
  }

  assert.equal(
    fs.existsSync(path.resolve('src/runners/claude/manifest.ts')),
    false,
  );
  assert.equal(
    fs.existsSync(path.resolve('src/runners/codex/manifest.ts')),
    false,
  );
}

function assertSharedRunnerHealthIsSynced(): void {
  const shared = fs.readFileSync(
    path.resolve('shared/runner-health.ts'),
    'utf-8',
  );
  const backend = fs.readFileSync(
    path.resolve('src/runner-health.ts'),
    'utf-8',
  );
  const agentRunner = fs.readFileSync(
    path.resolve('container/agent-runner/src/runners/health.ts'),
    'utf-8',
  );
  assert.equal(backend, shared);
  assert.equal(agentRunner, shared);
}

function assertProviderStateOpaque(): void {
  const queryLoop = fs.readFileSync(
    path.resolve('container/agent-runner/src/query-loop.ts'),
    'utf-8',
  );
  assert.equal(queryLoop.includes('activeThreadId'), false);
  assert.equal(queryLoop.includes('startFreshOnNextTurn'), false);

  const sessionRoutes = fs.readFileSync(
    path.resolve('src/routes/sessions.ts'),
    'utf-8',
  );
  assert.equal(sessionRoutes.includes('startFreshOnNextTurn'), false);
  assert.equal(sessionRoutes.includes('archiveState'), false);
}

function assertBackendRunnerChecksAreDescriptorDriven(): void {
  const runnersRoute = fs.readFileSync(
    path.resolve('src/routes/runners.ts'),
    'utf-8',
  );
  assert.equal(runnersRoute.includes('detectLocalClaudeCode'), false);
  assert.equal(runnersRoute.includes('detectLocalCodexCli'), false);
  assert.equal(runnersRoute.includes("authProbe === '"), false);

  const runtimeRunner = fs.readFileSync(
    path.resolve('src/runtime-runner.ts'),
    'utf-8',
  );
  assert.equal(runtimeRunner.includes('detectLocalClaudeCode'), false);
  assert.equal(runtimeRunner.includes('detectLocalCodexCli'), false);
  assert.equal(runtimeRunner.includes("authProbe === '"), false);

  const authRoute = fs.readFileSync(
    path.resolve('src/routes/auth.ts'),
    'utf-8',
  );
  assert.equal(authRoute.includes('detectLocalClaudeCode'), false);
  assert.equal(authRoute.includes('detectLocalCodexCli'), false);
  assert.equal(authRoute.includes('listRunnerDescriptors'), true);
  assert.equal(authRoute.includes('runnerAuthAvailable'), true);

  const configRoute = fs.readFileSync(
    path.resolve('src/routes/config.ts'),
    'utf-8',
  );
  assert.equal(configRoute.includes("'/claude"), false);
  assert.equal(configRoute.includes("'/codex"), false);
  assert.equal(configRoute.includes('detectLocalClaudeCode'), false);
  assert.equal(configRoute.includes('detectLocalCodexCli'), false);
}

function assertLegacyProviderSettingsSurfaceRemoved(): void {
  assert.equal(
    fs.existsSync(
      path.resolve('web/src/components/settings/ClaudeProviderSection.tsx'),
    ),
    false,
  );
  assert.equal(
    fs.existsSync(
      path.resolve('web/src/components/settings/CodexProviderSection.tsx'),
    ),
    false,
  );

  const settingsTypes = fs.readFileSync(
    path.resolve('web/src/components/settings/types.ts'),
    'utf-8',
  );
  assert.equal(settingsTypes.includes('CodexConfigPublic'), false);
  assert.equal(settingsTypes.includes('LocalCodexCliStatus'), false);
}

function assertRuntimeProfileInjectionContract(): void {
  const runtimeRunner = fs.readFileSync(
    path.resolve('src/runtime-runner.ts'),
    'utf-8',
  );
  assert.equal(runtimeRunner.includes('runnerConfig'), true);
  assert.equal(runtimeRunner.includes('validateRunnerProfileConfig'), true);
  assert.equal(runtimeRunner.includes('declaredRunnerDescriptor'), true);
  assert.equal(
    runtimeRunner.includes('runtimeContract.requiredNodePackages'),
    true,
  );
  assert.equal(
    runtimeRunner.includes('runtimeContract.requiredCommands'),
    true,
  );
  assert.equal(runtimeRunner.includes('runtimeContract.configDirEnv'), true);
  assert.equal(runtimeRunner.includes('HAPPYCLAW_RUNNER_CONFIG_DIR'), true);

  const claudeManifest = fs.readFileSync(
    path.resolve('container/agent-runner/src/runners/claude/manifest.ts'),
    'utf-8',
  );
  const codexManifest = fs.readFileSync(
    path.resolve('container/agent-runner/src/runners/codex/manifest.ts'),
    'utf-8',
  );
  for (const manifest of [claudeManifest, codexManifest]) {
    assert.equal(
      manifest.includes('ctx.containerInput.runnerConfig?.model'),
      true,
    );
    assert.equal(
      manifest.includes('ctx.containerInput.runnerConfig?.thinkingEffort'),
      true,
    );
    assert.equal(
      manifest.includes('ctx.containerInput.runnerConfig?.command'),
      true,
    );
    assert.equal(manifest.includes('toolContract.builtinServerName'), true);
  }
}

function assertClaudeRunnerIsOneShotCli(): void {
  const descriptor = RUNNER_DESCRIPTORS.claude;
  assert.equal(descriptor.capabilities.midQueryPush, false);
  assert.equal(descriptor.capabilities.interrupt, 'weak');
  assert.equal(descriptor.capabilities.sessionResume, 'weak');
  assert.equal(descriptor.lifecycle.turnBoundary, 'simulated');
  assert.equal(descriptor.runtimeContract.configDirEnv, undefined);
  assert.equal(
    fs.existsSync(
      path.resolve('container/agent-runner/src/runners/claude/session.ts'),
    ),
    false,
  );

  const claudeRunner = fs.readFileSync(
    path.resolve('container/agent-runner/src/runners/claude/runner.ts'),
    'utf-8',
  );
  assert.equal(claudeRunner.includes('extends BaseCliRunner'), true);
  assert.equal(claudeRunner.includes('supportsMidQueryPush: false'), true);
  assert.equal(claudeRunner.includes('stream-json'), true);
  assert.equal(claudeRunner.includes('--resume'), true);
  assert.equal(claudeRunner.includes('isSessionResumeFailedError'), true);
  assert.equal(
    claudeRunner.includes('No conversation found with session ID'),
    true,
  );
  assert.equal(claudeRunner.includes('ClaudeSession'), false);

  assert.equal(
    fs.existsSync(path.resolve('container/agent-runner/src/providers')),
    false,
  );

  const runtimeRunner = fs.readFileSync(
    path.resolve('src/runtime-runner.ts'),
    'utf-8',
  );
  assert.equal(runtimeRunner.includes("hostEnv['CLAUDE_CONFIG_DIR']"), false);

  const oneShotInvokers = fs.readFileSync(
    path.resolve('container/agent-runner/src/runners/one-shot-invokers.ts'),
    'utf-8',
  );
  assert.equal(oneShotInvokers.includes('process.env.CLAUDE_CONFIG_DIR'), false);
}

function assertRunnerProfileSchemaValidation(): void {
  const schema = {
    type: 'object',
    required: ['command', 'workers'],
    properties: {
      command: {
        type: 'string',
        minLength: 3,
        maxLength: 10,
        pattern: '^[a-z]+$',
      },
      workers: {
        type: 'integer',
        minimum: 1,
        maximum: 8,
      },
      tags: {
        type: 'array',
        minItems: 1,
        maxItems: 2,
        uniqueItems: true,
        items: { type: 'string' },
      },
    },
    additionalProperties: false,
  };

  assert.equal(
    validateRunnerProfileConfig(schema, {
      command: 'claude',
      workers: 2,
      tags: ['stable'],
    }).ok,
    true,
  );

  const invalid = validateRunnerProfileConfig(schema, {
    command: 'Claude!',
    workers: 9,
    tags: ['same', 'same', 'extra'],
    extra: true,
  });
  assert.equal(invalid.ok, false);
  assert.ok(invalid.errors.length >= 5);
}

function assertInvokeAgentIsRegistryDriven(): void {
  const invokeAgentPlugin = fs.readFileSync(
    path.resolve('container/agent-runner/src/plugins/invoke-agent-plugin.ts'),
    'utf-8',
  );
  assert.equal(invokeAgentPlugin.includes('Use Codex'), false);
  assert.equal(invokeAgentPlugin.includes('Use Claude'), false);
  assert.equal(invokeAgentPlugin.includes('listRunnerManifests'), true);
  assert.equal(invokeAgentPlugin.includes('createOneShotInvoker'), true);
}

function assertDescriptorAuthProbeWorks(): void {
  const dir = fs.mkdtempSync(path.join(process.cwd(), '.tmp-runner-probe-'));
  const authFile = path.join(dir, 'auth.json');
  fs.writeFileSync(
    authFile,
    JSON.stringify({
      token: 'secret-token-value',
      account_id: 'account-123456789',
    }),
  );
  try {
    const result = evaluateRunnerAuthProbe({
      type: 'json_file',
      files: [
        {
          path: authFile,
          requiredJsonPaths: [['token']],
          detailJsonFields: [{ name: 'accountId', path: ['account_id'] }],
        },
      ],
    });
    assert.equal(result.authenticated, true);
    assert.equal(result.detected, true);
    assert.equal(result.details.accountId, 'acco...6789');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function assertFakeRunnerContract(): Promise<void> {
  const { messages, result } = await collectRun();
  const eventTypes = messages
    .filter((message) => message.kind === 'stream_event')
    .map((message) => message.event.eventType);

  assert.ok(messages.some((message) => message.kind === 'session_init'));
  assert.ok(messages.some((message) => message.kind === 'resume_anchor'));
  assert.ok(messages.some((message) => message.kind === 'result'));
  assert.deepEqual(eventTypes, [
    'init',
    'text_delta',
    'thinking_delta',
    'tool_use_start',
    'tool_progress',
    'tool_use_end',
  ]);
  assert.equal(result.resumeAnchor, 'fake-anchor');
  assert.equal(result.closedDuringQuery, false);
  assert.equal(result.interruptedDuringQuery, false);
  assert.equal(result.drainDetectedDuringQuery, false);
}

async function assertBaseCliRunnerRecoverableError(): Promise<void> {
  const { messages, result } = await collectRun('context-overflow');
  assert.ok(
    messages.some(
      (message) =>
        message.kind === 'error' &&
        message.recoverable &&
        message.errorType === 'context_overflow',
    ),
  );
  assert.equal(result.contextOverflow, true);
}

async function assertBaseCliRunnerGenericError(): Promise<void> {
  const { messages, result } = await collectRun('generic-error');
  assert.ok(
    messages.some(
      (message) =>
        message.kind === 'error' &&
        !message.recoverable &&
        message.message.includes('GENERIC_ERROR'),
    ),
  );
  assert.equal(result.genericError, 'GENERIC_ERROR: fake provider error');
}

async function assertBaseCliRunnerEnvPromptContract(): Promise<void> {
  const { messages } = await collectRun('hello', {
    systemPrompt: 'env-system-prompt',
    promptContract: {
      mode: 'env',
      dynamicContextReload: 'turn',
    },
  });
  const textDelta = messages.find(
    (message) =>
      message.kind === 'stream_event' &&
      message.event.eventType === 'text_delta',
  );
  assert.equal(
    textDelta?.kind === 'stream_event' ? textDelta.event.text : null,
    'env-system-prompt',
  );
}

async function assertBaseCliRunnerInstructionFilePromptContract(): Promise<void> {
  const { messages } = await collectRun('hello', {
    systemPrompt: 'file-system-prompt',
    promptContract: {
      mode: 'instructions_file',
      dynamicContextReload: 'turn',
    },
  });
  const textDelta = messages.find(
    (message) =>
      message.kind === 'stream_event' &&
      message.event.eventType === 'text_delta',
  );
  assert.equal(
    textDelta?.kind === 'stream_event' ? textDelta.event.text : null,
    'file-system-prompt',
  );
}

assertProductionManifestDescriptors();
assertBackendRunnerManifests();
assertSharedRunnerHealthIsSynced();
assertProviderStateOpaque();
assertBackendRunnerChecksAreDescriptorDriven();
assertLegacyProviderSettingsSurfaceRemoved();
assertRuntimeProfileInjectionContract();
assertClaudeRunnerIsOneShotCli();
assertRunnerProfileSchemaValidation();
assertInvokeAgentIsRegistryDriven();
assertDescriptorAuthProbeWorks();
await assertFakeRunnerContract();
await assertBaseCliRunnerRecoverableError();
await assertBaseCliRunnerGenericError();
await assertBaseCliRunnerEnvPromptContract();
await assertBaseCliRunnerInstructionFilePromptContract();

console.log('runner contract tests passed');
