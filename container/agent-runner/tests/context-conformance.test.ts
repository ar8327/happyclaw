import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildContextBundle,
  type ContextPlugin,
  type PluginContext,
} from '../../agent-runner-core/src/index.js';
import { RUNNER_DESCRIPTORS } from '../src/runner-descriptor.types.js';
import { planCodexContextInjection } from '../src/runners/codex/runner.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'context-conformance-'));

try {
  const workspaceGroup = path.join(root, 'group');
  const workspaceGlobal = path.join(root, 'global');
  const workspaceMemory = path.join(root, 'memory');
  fs.mkdirSync(workspaceGroup);
  fs.mkdirSync(workspaceGlobal);
  fs.mkdirSync(workspaceMemory);
  fs.writeFileSync(
    path.join(workspaceGroup, 'CLAUDE.md'),
    'workspace version one\n',
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
    recentImChannels: new Set(['feishu:fixture']),
    contextSummary: 'summary version one',
  };
  let memoryVersion = 'memory version one';
  const plugins: ContextPlugin[] = [
    {
      name: 'skills',
      isEnabled: () => true,
      getTools: () => [],
      getSystemPromptSection: () => 'skills fixture',
    },
    {
      name: 'memory',
      isEnabled: () => true,
      getTools: () => [],
      getSystemPromptSection: () => memoryVersion,
    },
  ];

  const firstBundle = buildContextBundle(context, plugins);
  const sectionIds = firstBundle.sections.map((section) => section.id);
  assert.equal(new Set(sectionIds).size, sectionIds.length);

  const deliveredByRunner = new Map<string, Map<string, string>>();
  const assertExactlyOnce = (
    runnerId: string,
    native: Set<string>,
    delivered: Map<string, string>,
    sections = firstBundle.sections,
  ): void => {
    for (const section of sections) {
      const count =
        Number(native.has(section.id)) + Number(delivered.has(section.id));
      assert.equal(
        count,
        1,
        `${runnerId} must provide ${section.id} exactly once`,
      );
    }
  };
  for (const descriptor of Object.values(RUNNER_DESCRIPTORS)) {
    const native = new Set<string>(descriptor.nativeProvides);
    const delivered = new Map(
      firstBundle.sections
        .filter((section) => !native.has(section.id))
        .map((section) => [section.id, section.content]),
    );
    deliveredByRunner.set(descriptor.id, delivered);
    assertExactlyOnce(descriptor.id, native, delivered);
    for (const stability of ['static', 'session', 'turn'] as const) {
      assert.ok(
        firstBundle.sections.some(
          (section) =>
            section.stability === stability &&
            (native.has(section.id) || delivered.has(section.id)),
        ),
        `${descriptor.id} has no reachable ${stability} context`,
      );
    }
  }

  const claudeNative = new Set<string>(
    RUNNER_DESCRIPTORS.claude.nativeProvides,
  );
  const missingClaudeSection = new Map(
    Array.from(deliveredByRunner.get('claude') || []).filter(
      ([id]) => id !== 'global-instructions',
    ),
  );
  assert.throws(
    () =>
      assertExactlyOnce(
        'claude-negative-fixture',
        claudeNative,
        missingClaudeSection,
      ),
    /must provide global-instructions exactly once/,
  );

  for (const section of firstBundle.sections) {
    const deliveredValues = Array.from(deliveredByRunner.values())
      .map((sections) => sections.get(section.id))
      .filter((value): value is string => value !== undefined);
    assert.equal(
      new Set(deliveredValues).size,
      deliveredValues.length > 0 ? 1 : 0,
      `${section.id} differs between delivery paths`,
    );
  }

  const freshPlan = planCodexContextInjection(new Map(), firstBundle.sections, {
    threadChanged: true,
    freshThread: true,
  });
  assert.ok(
    freshPlan.changed.every((section) => {
      const original = firstBundle.sections.find(
        (candidate) => candidate.id === section.id,
      );
      return original?.stability === 'turn';
    }),
  );

  fs.writeFileSync(
    path.join(workspaceGroup, 'CLAUDE.md'),
    'workspace version two\n',
  );
  memoryVersion = 'memory version two';
  context.contextSummary = undefined;
  const secondBundle = buildContextBundle(context, plugins);
  const updatePlan = planCodexContextInjection(
    freshPlan.nextHashes,
    secondBundle.sections,
    { threadChanged: false, freshThread: false },
  );
  assert.ok(
    updatePlan.changed.some(
      (section) =>
        section.id === 'workspace-instructions' &&
        section.content.includes('workspace version two'),
    ),
  );
  assert.ok(
    updatePlan.changed.some(
      (section) =>
        section.id === 'memory-index' &&
        section.content.includes('memory version two'),
    ),
  );
  assert.ok(
    updatePlan.changed.some(
      (section) =>
        section.id === 'context-summary' &&
        section.content.includes('no longer applies'),
    ),
  );

  const noChangePlan = planCodexContextInjection(
    updatePlan.nextHashes,
    secondBundle.sections,
    { threadChanged: false, freshThread: false },
  );
  assert.deepEqual(noChangePlan.changed, []);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('context conformance tests passed');
