import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TasksPlugin } from './tasks.js';
import type { PluginContext } from '../plugin.js';

const workspaceIpc = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happyclaw-task-routing-'),
);

try {
  const ctx: PluginContext = {
    chatJid: 'web:main',
    groupFolder: 'main',
    isHome: true,
    isAdminHome: true,
    workspaceIpc,
    workspaceGroup: workspaceIpc,
    workspaceGlobal: workspaceIpc,
    workspaceMemory: workspaceIpc,
    currentSourceChannel: 'feishu:stale',
  };
  fs.writeFileSync(
    path.join(workspaceIpc, '.current-delivery.json'),
    JSON.stringify({
      sourceChannel: 'feishu:current-chat',
      updatedAt: Date.now(),
    }),
  );

  const plugin = new TasksPlugin();
  const scheduleTask = plugin
    .getTools(ctx)
    .find((tool) => tool.name === 'schedule_task');
  assert.ok(scheduleTask);
  const result = await scheduleTask.execute({
    prompt: 'follow up',
    schedule_type: 'interval',
    schedule_value: '60000',
  });
  assert.equal(result.isError, undefined);

  const tasksDir = path.join(workspaceIpc, 'tasks');
  const files = fs.readdirSync(tasksDir);
  assert.equal(files.length, 1);
  const request = JSON.parse(
    fs.readFileSync(path.join(tasksDir, files[0]), 'utf-8'),
  ) as { targetJid: string };
  assert.equal(
    request.targetJid,
    'feishu:current-chat',
    'default target must follow the current delivery instead of runtime launch JID',
  );

  const explicit = await scheduleTask.execute({
    prompt: 'cross group',
    schedule_type: 'interval',
    schedule_value: '60000',
    target_group_jid: 'feishu:explicit-chat',
  });
  assert.equal(explicit.isError, undefined);
  const explicitFile = fs.readdirSync(tasksDir).sort().at(-1);
  assert.ok(explicitFile);
  const explicitRequest = JSON.parse(
    fs.readFileSync(path.join(tasksDir, explicitFile), 'utf-8'),
  ) as { targetJid: string };
  assert.equal(explicitRequest.targetJid, 'feishu:explicit-chat');
} finally {
  fs.rmSync(workspaceIpc, { recursive: true, force: true });
}

console.log('task delivery routing tests passed');
