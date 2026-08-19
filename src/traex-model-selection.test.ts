import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  readTraexAuthContext,
  resetTraexResumeStateForCorrectedSelection,
  resolveLegacyTraexRunnerMigration,
  resolveTraexModelSelection,
} from './traex-model-selection.js';

const models = [
  { id: 'gpt-5.6-sol', modelProvider: 'openai' },
  { id: 'GPT-5.6-Sol', modelProvider: 'trae' },
  { id: 'openai/gpt-5.6-sol', modelProvider: 'seed' },
];

assert.deepEqual(
  resolveTraexModelSelection('gpt-5.6-sol', models, {
    authMode: 'trae',
    hasOpenAiApiKey: false,
  }),
  {
    model: 'GPT-5.6-Sol',
    modelProvider: 'trae',
    correctedLegacySelection: true,
  },
);

assert.deepEqual(
  resolveTraexModelSelection('gpt-5.6-sol', models, {
    authMode: 'trae',
    hasOpenAiApiKey: true,
  }),
  {
    model: 'gpt-5.6-sol',
    modelProvider: 'openai',
    correctedLegacySelection: false,
  },
);

assert.deepEqual(
  resolveLegacyTraexRunnerMigration('codex', 'gpt-5.6-sol', models, {
    authMode: 'trae',
    hasOpenAiApiKey: false,
  }),
  {
    runnerId: 'traex',
    model: 'GPT-5.6-Sol',
    modelProvider: 'trae',
    correctedLegacySelection: true,
  },
);

assert.equal(
  resolveLegacyTraexRunnerMigration('traex', 'gpt-5.6-sol', models, {
    authMode: 'trae',
    hasOpenAiApiKey: false,
  }),
  null,
);

assert.equal(
  resolveLegacyTraexRunnerMigration('codex', 'gpt-5.6-sol', models, {
    authMode: 'trae',
    hasOpenAiApiKey: true,
  }),
  null,
);

assert.equal(
  resolveLegacyTraexRunnerMigration(
    'codex',
    'gpt-5.6-sol',
    [...models, { id: 'Gpt-5.6-Sol', modelProvider: 'trae' }],
    {
      authMode: 'trae',
      hasOpenAiApiKey: false,
    },
  ),
  null,
);

assert.deepEqual(
  resolveTraexModelSelection('GPT-5.6-Sol', models, {
    authMode: 'trae',
    hasOpenAiApiKey: false,
  }),
  {
    model: 'GPT-5.6-Sol',
    modelProvider: 'trae',
    correctedLegacySelection: false,
  },
);

assert.deepEqual(
  resolveTraexModelSelection('gpt-5.6-sol', models, {
    authMode: 'openai',
    hasOpenAiApiKey: false,
  }),
  {
    model: 'gpt-5.6-sol',
    modelProvider: 'openai',
    correctedLegacySelection: false,
  },
);

const legacyResumeInput = {
  sessionId: 'old-openai-thread',
  resumeAnchor: 'old-openai-anchor',
  bootstrapState: {
    providerState: { activeThreadId: 'old-openai-thread' },
    recentImChannels: ['feishu:test'],
    imChannelLastSeen: { 'feishu:test': 123 },
    currentPermissionMode: 'default',
    lastMessageCursor: 'old-openai-thread',
  },
};
assert.deepEqual(
  resetTraexResumeStateForCorrectedSelection(legacyResumeInput, true),
  {
    sessionId: undefined,
    resumeAnchor: undefined,
    bootstrapState: {
      providerState: undefined,
      recentImChannels: ['feishu:test'],
      imChannelLastSeen: { 'feishu:test': 123 },
      currentPermissionMode: 'default',
      lastMessageCursor: null,
    },
  },
);
assert.equal(
  resetTraexResumeStateForCorrectedSelection(legacyResumeInput, false),
  legacyResumeInput,
);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-traex-auth-'));
try {
  const authFile = path.join(tmpDir, 'auth.json');
  fs.writeFileSync(
    authFile,
    JSON.stringify({ auth_mode: 'trae', OPENAI_API_KEY: null }),
  );
  assert.deepEqual(readTraexAuthContext(authFile, {}), {
    authMode: 'trae',
    hasOpenAiApiKey: false,
  });
  assert.deepEqual(readTraexAuthContext(authFile, { OPENAI_API_KEY: 'set' }), {
    authMode: 'trae',
    hasOpenAiApiKey: true,
  });
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log('TraeX legacy model selection test passed');
