import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type * as lark from '@larksuiteoapi/node-sdk';

const originalCwd = process.cwd();
const fixtureRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happyclaw-progress-routing-'),
);
process.chdir(fixtureRoot);

try {
  const progress = await import(
    `./feishu-progress-card.js?routing-test=${Date.now()}`
  );

  const created: string[] = [];
  const patched: string[] = [];
  const deleted: string[] = [];
  function fakeClient(label: string): lark.Client {
    return {
      im: {
        message: {
          reply: async () => {
            created.push(label);
            return { data: { message_id: `message-${label}` } };
          },
        },
        v1: {
          message: {
            create: async () => {
              created.push(label);
              return { data: { message_id: `message-${label}` } };
            },
            patch: async (request: { path: { message_id: string } }) => {
              patched.push(request.path.message_id);
              return {};
            },
            delete: async (request: { path: { message_id: string } }) => {
              deleted.push(request.path.message_id);
              return {};
            },
          },
        },
      },
    } as unknown as lark.Client;
  }

  const cardA = new progress.ProgressCardController({
    client: fakeClient('A'),
    chatId: 'chat-a',
    anchorFolder: 'shared-folder',
    anchorSourceChannel: 'feishu:chat-a',
  });
  const cardB = new progress.ProgressCardController({
    client: fakeClient('B'),
    chatId: 'chat-b',
    anchorFolder: 'shared-folder',
    anchorSourceChannel: 'feishu:chat-b',
  });
  assert.equal(
    progress.claimProgressSession('feishu:chat-a', cardA, 'shared-folder'),
    true,
  );
  assert.equal(
    progress.claimProgressSession('feishu:chat-b', cardB, 'shared-folder'),
    false,
    'the first Feishu source must keep the Session card anchor',
  );

  progress.feedProgressSessionsForFolder('shared-folder', {
    eventType: 'thinking_delta',
    text: 'working after a cross-channel steer',
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(created, ['A']);

  await progress.completeAndResetProgressSessionsForFolder('shared-folder');
  progress.feedProgressSessionsForFolder('shared-folder', {
    eventType: 'thinking_delta',
    text: 'next turn from another source',
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(
    created,
    ['A'],
    'later turns must patch the same card instead of creating another one',
  );
  assert.ok(patched.includes('message-A'));

  // Different Sessions remain isolated even when they share one source chat.
  const topic1 = new progress.ProgressCardController({
    client: fakeClient('topic-1'),
    chatId: 'same-chat',
    anchorFolder: 'topic-folder-1',
    anchorSourceChannel: 'feishu:same-chat',
  });
  const topic2 = new progress.ProgressCardController({
    client: fakeClient('topic-2'),
    chatId: 'same-chat',
    anchorFolder: 'topic-folder-2',
    anchorSourceChannel: 'feishu:same-chat',
  });
  assert.equal(
    progress.claimProgressSession('feishu:same-chat', topic1, 'topic-folder-1'),
    true,
  );
  assert.equal(
    progress.claimProgressSession('feishu:same-chat', topic2, 'topic-folder-2'),
    true,
  );
  progress.feedProgressSessionsForFolder('topic-folder-1', {
    eventType: 'thinking_delta',
    text: 'topic 1',
  });
  progress.feedProgressSessionsForFolder('topic-folder-2', {
    eventType: 'thinking_delta',
    text: 'topic 2',
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(created.includes('topic-1'));
  assert.ok(created.includes('topic-2'));

  const storePath = path.join(
    fixtureRoot,
    'data',
    'state',
    'progress-cards.json',
  );
  const persisted = JSON.parse(fs.readFileSync(storePath, 'utf-8')) as Array<{
    folder: string;
    sourceChannel: string;
    messageId: string;
  }>;
  assert.equal(
    persisted.filter((entry) => entry.folder === 'shared-folder').length,
    1,
  );
  assert.equal(
    persisted.find((entry) => entry.folder === 'shared-folder')?.sourceChannel,
    'feishu:chat-a',
  );

  await progress.abortAllProgressSessions('test restart');
  assert.deepEqual(
    deleted,
    [],
    'shutdown must preserve the anchored card for restart restoration',
  );

  await progress.restoreProgressCardSessions(() => fakeClient('restored'));
  assert.equal(progress.hasProgressSession('shared-folder'), true);
  progress.feedProgressSessionsForFolder('shared-folder', {
    eventType: 'thinking_delta',
    text: 'resumed after restart',
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(patched.includes('message-A'));
  assert.equal(created.includes('restored'), false);

  await progress.deleteProgressSession('shared-folder', () =>
    fakeClient('delete-fallback'),
  );
  assert.ok((deleted as string[]).includes('message-A'));
  const afterDelete = JSON.parse(fs.readFileSync(storePath, 'utf-8')) as Array<{
    folder: string;
  }>;
  assert.equal(
    afterDelete.some((entry) => entry.folder === 'shared-folder'),
    false,
  );

  await progress.abortAllProgressSessions('test cleanup');
} finally {
  process.chdir(originalCwd);
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}

console.log('progress card routing tests passed');
