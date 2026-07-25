import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  invokeWorkflowNode,
  listWorkflowProviders,
} from './workflow-invokers.js';

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

const tmpDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happyclaw-workflow-traex-test-'),
);
const fakeTraex = path.join(tmpDir, 'traex-fixture');
fs.writeFileSync(
  fakeTraex,
  [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    'const args = process.argv.slice(2);',
    "if (args.includes('--version')) {",
    "  process.stdout.write('traex fixture 1.0.0\\n');",
    '  process.exit(0);',
    '}',
    "let prompt = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => { prompt += chunk; });",
    "process.stdin.on('end', () => {",
    "  const outputIndex = args.indexOf('--output-last-message');",
    '  if (outputIndex < 0 || !args[outputIndex + 1]) process.exit(2);',
    '  const payload = {',
    '    args,',
    '    prompt,',
    '    happyclawEnvKeys: Object.keys(process.env)',
    "      .filter((key) => key.startsWith('HAPPYCLAW_'))",
    '      .sort(),',
    '  };',
    '  fs.writeFileSync(args[outputIndex + 1], JSON.stringify(payload));',
    '});',
    '',
  ].join('\n'),
  { mode: 0o755 },
);

const previousCommand = process.env.HAPPYCLAW_TRAEX_COMMAND;
const previousModel = process.env.HAPPYCLAW_TRAEX_MODEL;
try {
  process.env.HAPPYCLAW_TRAEX_COMMAND = fakeTraex;
  delete process.env.HAPPYCLAW_TRAEX_MODEL;

  const provider = listWorkflowProviders().find(
    (candidate) => candidate.id === 'traex',
  );
  assert.ok(provider);
  assert.equal(provider.available, true);
  assert.equal(provider.label, 'TraeX CLI');
  assert.equal(provider.defaultModel, 'TraeX CLI default');

  const result = await invokeWorkflowNode({
    provider: 'traex',
    model: 'c_fixture',
    thinkingEffort: 'xhigh',
    prompt: 'Return the fixture result.',
    cwd: tmpDir,
    timeoutMs: 5_000,
    maxTurns: 3,
  });
  assert.equal(result.provider, 'traex');
  assert.equal(result.model, 'c_fixture');

  const payload = JSON.parse(result.output) as {
    args: string[];
    prompt: string;
    happyclawEnvKeys: string[];
  };
  assert.equal(payload.args[0], 'exec');
  assert.ok(
    payload.args.includes('--dangerously-bypass-approvals-and-sandbox'),
  );
  assert.ok(payload.args.includes('--skip-git-repo-check'));
  assert.ok(payload.args.includes('c_fixture'));
  assert.ok(payload.args.includes('model_reasoning_effort="xhigh"'));
  assert.equal(payload.args.at(-1), '-');
  assert.equal(
    payload.prompt,
    [
      'You must complete this task within at most 3 tool-use turns.',
      '',
      'Return the fixture result.',
    ].join('\n'),
  );
  assert.deepEqual(payload.happyclawEnvKeys, [
    'HAPPYCLAW_INVOKE_DEPTH',
    'HAPPYCLAW_WORKFLOW_NODE',
  ]);
} finally {
  restoreEnv('HAPPYCLAW_TRAEX_COMMAND', previousCommand);
  restoreEnv('HAPPYCLAW_TRAEX_MODEL', previousModel);
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log('TraeX workflow provider test passed');
