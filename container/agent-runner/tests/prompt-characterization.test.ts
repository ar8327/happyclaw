import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildContextBundle,
  renderContextBundle,
  type ContextPlugin,
  type ContextSection,
  type PluginContext,
} from '../../agent-runner-core/src/index.js';
import { RUNNER_DESCRIPTORS } from '../src/runner-descriptor.types.js';

// 金标：改动 prompt 文本时必须同步更新，防止无意间漂移。
const CLAUDE_SESSION_STATIC_LEN = 2418;
const CLAUDE_SESSION_STATIC_SHA =
  '1d762d55d5cf2cb2c067cfb62801cf016c2825867825df54a3143ca1271b86e6';
const CODEX_SESSION_STATIC_LEN = 2669;
const CODEX_SESSION_STATIC_SHA =
  '50f3a673aeab4587019e61c1f17862621e1d4f14a42837ee3e48a77fb9ddb07f';
const TURN_DYNAMIC_LEN = 268;
const TURN_DYNAMIC_SHA =
  'e1c5fb86a52d22a18257bd77097942f8465c6f2aef6f8004d4a98c09fe775a22';

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

  // 按生产链路渲染：先按 nativeProvides 过滤，再拆成 system 载体与 turn 增量池。
  const bundle = buildContextBundle(context, plugins);
  const renderFor = (
    runnerId: keyof typeof RUNNER_DESCRIPTORS,
  ): { sessionStatic: string; turnDynamic: string } => {
    const native = new Set<string>(RUNNER_DESCRIPTORS[runnerId].nativeProvides);
    const delivered = bundle.sections.filter(
      (section) => !native.has(section.id),
    );
    const render = (sections: ContextSection[]) =>
      renderContextBundle({ sections }).split(root).join('<ROOT>');
    return {
      sessionStatic: render(
        delivered.filter((section) => section.stability !== 'turn'),
      ),
      turnDynamic: render(
        delivered.filter((section) => section.stability === 'turn'),
      ),
    };
  };

  const claude = renderFor('claude');
  const codex = renderFor('codex');

  assert.equal(claude.sessionStatic.length, CLAUDE_SESSION_STATIC_LEN);
  assert.equal(sha256(claude.sessionStatic), CLAUDE_SESSION_STATIC_SHA);
  assert.equal(claude.turnDynamic.length, TURN_DYNAMIC_LEN);
  assert.equal(sha256(claude.turnDynamic), TURN_DYNAMIC_SHA);
  assert.equal(codex.sessionStatic.length, CODEX_SESSION_STATIC_LEN);
  assert.equal(sha256(codex.sessionStatic), CODEX_SESSION_STATIC_SHA);
  // turn 段与 runner 无关，两条链路必须逐字节一致
  assert.equal(codex.turnDynamic, claude.turnDynamic);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('prompt characterization tests passed');
