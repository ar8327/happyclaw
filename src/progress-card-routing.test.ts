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
    completionDeleteDelayMs: 10,
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
  assert.equal(
    progress.hasProgressSession('shared-folder'),
    false,
    'a completed Turn must release the Session slot immediately',
  );
  assert.equal(
    progress.claimProgressSession('feishu:chat-b', cardB, 'shared-folder'),
    true,
    'the next Turn must be able to claim a fresh card',
  );
  progress.feedProgressSessionsForFolder('shared-folder', {
    eventType: 'thinking_delta',
    text: 'next turn from another source',
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(
    created,
    ['A', 'B'],
    'a later Turn must create a new card next to its own trigger',
  );
  assert.ok(patched.includes('message-A'));
  assert.ok(
    deleted.includes('message-A'),
    'the completed Turn card must be withdrawn after its visibility delay',
  );

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

  const failedCard = new progress.ProgressCardController({
    client: fakeClient('failed'),
    chatId: 'failed-chat',
    anchorFolder: 'failed-folder',
    anchorSourceChannel: 'feishu:failed-chat',
  });
  assert.equal(
    progress.claimProgressSession(
      'feishu:failed-chat',
      failedCard,
      'failed-folder',
    ),
    true,
  );
  progress.feedProgressSessionsForFolder('failed-folder', {
    eventType: 'thinking_delta',
    text: 'work before failure',
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await progress.finalizeProgressSessionsForFolder(
    'failed-folder',
    'fail',
    'provider failed',
  );
  assert.equal(progress.hasProgressSession('failed-folder'), false);
  assert.equal(
    deleted.includes('message-failed'),
    false,
    'failure diagnostics must remain visible',
  );

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
    'feishu:chat-b',
  );
  assert.equal(
    persisted.some((entry) => entry.folder === 'failed-folder'),
    false,
    'failure diagnostics must not be treated as restart-cleanup anchors',
  );

  await progress.abortAllProgressSessions('test restart');
  assert.ok(
    deleted.includes('message-B'),
    'shutdown must withdraw the active Turn card',
  );

  // Simulate a crash that left an active-card store entry behind.
  fs.writeFileSync(
    storePath,
    JSON.stringify([
      {
        folder: 'crashed-folder',
        sourceChannel: 'feishu:crashed-chat',
        chatId: 'crashed-chat',
        messageId: 'message-crashed',
        createdAt: Date.now(),
      },
    ]),
  );
  await progress.cleanupStaleProgressCards(() => fakeClient('restart-cleanup'));
  assert.equal(progress.hasProgressSession('shared-folder'), false);
  assert.ok(deleted.includes('message-crashed'));

  await progress.deleteProgressSession('shared-folder', () =>
    fakeClient('delete-fallback'),
  );
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
