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
            patch: async () => ({}),
            delete: async () => ({}),
          },
        },
      },
    } as unknown as lark.Client;
  }

  const cardA = new progress.ProgressCardController({
    client: fakeClient('A'),
    chatId: 'chat-a',
  });
  const cardB = new progress.ProgressCardController({
    client: fakeClient('B'),
    chatId: 'chat-b',
  });
  progress.registerProgressSession('feishu:chat-a', cardA, 'shared-folder');
  progress.registerProgressSession('feishu:chat-b', cardB, 'shared-folder');

  progress.feedProgressSessionsForFolder(
    'shared-folder',
    'feishu:chat-a',
    { eventType: 'thinking_delta', text: 'A is working' },
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(
    created,
    ['A'],
    'a stream event must not create a card in a sibling chat',
  );

  // The same source chat can back two independent topic folders. Registering
  // the second route must not replace/abort the first route.
  const topic1 = new progress.ProgressCardController({
    client: fakeClient('topic-1'),
    chatId: 'same-chat',
  });
  const topic2 = new progress.ProgressCardController({
    client: fakeClient('topic-2'),
    chatId: 'same-chat',
  });
  progress.registerProgressSession(
    'feishu:same-chat',
    topic1,
    'topic-folder-1',
  );
  progress.registerProgressSession(
    'feishu:same-chat',
    topic2,
    'topic-folder-2',
  );
  progress.feedProgressSessionsForFolder(
    'topic-folder-1',
    'feishu:same-chat',
    { eventType: 'thinking_delta', text: 'topic 1' },
  );
  progress.feedProgressSessionsForFolder(
    'topic-folder-2',
    'feishu:same-chat',
    { eventType: 'thinking_delta', text: 'topic 2' },
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(created.includes('topic-1'));
  assert.ok(created.includes('topic-2'));

  const persisted = JSON.parse(
    fs.readFileSync(
      path.join(fixtureRoot, 'data', 'state', 'progress-cards.json'),
      'utf-8',
    ),
  ) as Array<{ chatId: string; messageId: string }>;
  assert.equal(
    persisted.filter((entry) => entry.chatId === 'same-chat').length,
    2,
    'restart cleanup must retain every active topic card in the same chat',
  );

  await progress.abortAllProgressSessions('test cleanup');
} finally {
  process.chdir(originalCwd);
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}

console.log('progress card routing tests passed');
