import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildAppendPrompt,
  buildFullPrompt,
  type ContextPlugin,
  type PluginContext,
} from '../../agent-runner-core/src/index.js';

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-characterization-'));

try {
  const workspaceGroup = path.join(root, 'group');
  const workspaceGlobal = path.join(root, 'global');
  const workspaceMemory = path.join(root, 'memory');
  fs.mkdirSync(workspaceGroup);
  fs.mkdirSync(workspaceGlobal);
  fs.mkdirSync(workspaceMemory);
  fs.writeFileSync(
    path.join(workspaceGroup, 'CLAUDE.md'),
    'workspace fixture\nrule two\n',
  );
  fs.writeFileSync(path.join(workspaceGlobal, 'CLAUDE.md'), 'global fixture\n');

  const context: PluginContext = {
    chatJid: 'web:fixture',
    groupFolder: 'fixture',
    isHome: true,
    isAdminHome: true,
    workspaceIpc: path.join(root, 'ipc'),
    workspaceGroup,
    workspaceGlobal,
    workspaceMemory,
    userId: 'local',
    skillsDirs: [],
    recentImChannels: new Set(['feishu:fixture', 'telegram:42']),
    contextSummary: 'summary fixture',
    providerInfo: 'fixture provider',
  };

  const plugins: ContextPlugin[] = [
    {
      name: 'memory',
      isEnabled: () => true,
      getTools: () => [],
      getSystemPromptSection: () => '## Memory fixture\nindex fixture',
    },
    {
      name: 'skills',
      isEnabled: () => true,
      getTools: () => [],
      getSystemPromptSection: () => '## Skills fixture\nskill fixture',
    },
  ];

  const appendPrompt = buildAppendPrompt(context, plugins);
  const fullPrompt = buildFullPrompt(context, plugins)
    .split(root)
    .join('<ROOT>');

  assert.equal(appendPrompt.length, 2694);
  assert.equal(
    sha256(appendPrompt),
    'fa50ee5355a092c22dbae68f6b556b4ba240a2e69516282a556c7f6cdf0103a4',
  );
  assert.equal(fullPrompt.length, 2938);
  assert.equal(
    sha256(fullPrompt),
    'bb8c46658de3b7fc68e123c0383f4aee6f77ba5a7984e88f327a7515904c7a20',
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('prompt characterization tests passed');
