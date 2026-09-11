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

  progress.markProgressSessionRecoveringForFolder('shared-folder');
  assert.equal(
    progress.hasProgressSession('shared-folder'),
    true,
    'a recoverable runtime exit must keep the current Turn card registered',
  );
  assert.equal(
    progress.claimProgressSession('feishu:chat-b', cardB, 'shared-folder'),
    false,
    'the replacement runtime must reuse the current Turn card',
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(
    created,
    ['A'],
    'runtime recovery must not create a second Feishu card',
  );

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

  // A transient Lark gateway failure must not permanently suppress the tool
  // card. Reuse one UUID so a timed-out but accepted request stays idempotent.
  let retryAttempts = 0;
  const retryUuids: string[] = [];
  const retryCard = new progress.ProgressCardController({
    client: {
      im: {
        message: {
          reply: async (request: { data: { uuid?: string } }) => {
            retryAttempts++;
            retryUuids.push(request.data.uuid || '');
            if (retryAttempts === 1) {
              throw Object.assign(new Error('Request failed with status 504'), {
                code: 'ERR_BAD_RESPONSE',
                response: { status: 504 },
              });
            }
            created.push('retry');
            return { data: { message_id: 'message-retry' } };
          },
        },
        v1: {
          message: {
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
    } as unknown as lark.Client,
    chatId: 'retry-chat',
    replyToMsgId: 'retry-trigger',
    anchorFolder: 'retry-folder',
    anchorSourceChannel: 'feishu:retry-chat',
    createRetryBaseDelayMs: 5,
    maxCreateAttempts: 3,
  });
  assert.equal(
    progress.claimProgressSession(
      'feishu:retry-chat',
      retryCard,
      'retry-folder',
    ),
    true,
  );
  progress.feedProgressSessionsForFolder('retry-folder', {
    eventType: 'tool_use_start',
    toolUseId: 'retry-tool',
    toolName: 'Read',
    toolInputSummary: 'Caelum source',
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(retryAttempts, 2);
  assert.ok(retryUuids[0]);
  assert.deepEqual(
    new Set(retryUuids).size,
    1,
    'transient retries must reuse one Lark idempotency UUID',
  );
  assert.ok(created.includes('retry'));
  assert.ok(
    patched.includes('message-retry'),
    'the recovered card must render the accumulated tool event',
  );
  await progress.completeAndResetProgressSessionsForFolder('retry-folder');

  // Once created, transient patch failures must keep retrying at a bounded
  // cadence. The old implementation stopped forever after three failures,
  // leaving a healthy Turn behind a frozen card.
  let transientPatchAttempts = 0;
  let recoveredPatchContent = '';
  const patchRecoveryCard = new progress.ProgressCardController({
    client: {
      im: {
        message: {
          reply: async () => ({
            data: { message_id: 'message-patch-recovery' },
          }),
        },
        v1: {
          message: {
            patch: async (request: { data: { content: string } }) => {
              transientPatchAttempts++;
              if (transientPatchAttempts <= 3) {
                throw Object.assign(
                  new Error('Request failed with status 504'),
                  {
                    code: 'ERR_BAD_RESPONSE',
                    response: { status: 504 },
                  },
                );
              }
              recoveredPatchContent = request.data.content;
              return {};
            },
            delete: async () => ({}),
          },
        },
      },
    } as unknown as lark.Client,
    chatId: 'patch-recovery-chat',
    replyToMsgId: 'patch-recovery-trigger',
    anchorFolder: 'patch-recovery-folder',
    anchorSourceChannel: 'feishu:patch-recovery-chat',
    flushIntervalMs: 0,
    patchRetryBaseDelayMs: 1,
    maxPatchRetryDelayMs: 2,
  });
  assert.equal(
    progress.claimProgressSession(
      'feishu:patch-recovery-chat',
      patchRecoveryCard,
      'patch-recovery-folder',
    ),
    true,
  );
  progress.feedProgressSessionsForFolder('patch-recovery-folder', {
    eventType: 'tool_use_start',
    toolUseId: 'patch-recovery-tool',
    toolName: 'Bash',
    toolInputSummary: 'gh run watch 30816272510',
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(
    transientPatchAttempts,
    4,
    'the card must recover after more than three transient patch failures',
  );
  assert.match(recoveredPatchContent, /gh run watch 30816272510/);
  await progress.completeAndResetProgressSessionsForFolder(
    'patch-recovery-folder',
  );

  let cancelledRetryAttempts = 0;
  const cancelledRetryCard = new progress.ProgressCardController({
    client: {
      im: {
        message: {
          reply: async () => {
            cancelledRetryAttempts++;
            throw Object.assign(new Error('Request failed with status 504'), {
              code: 'ERR_BAD_RESPONSE',
              response: { status: 504 },
            });
          },
        },
      },
    } as unknown as lark.Client,
    chatId: 'cancelled-retry-chat',
    replyToMsgId: 'cancelled-retry-trigger',
    anchorFolder: 'cancelled-retry-folder',
    anchorSourceChannel: 'feishu:cancelled-retry-chat',
    createRetryBaseDelayMs: 50,
    maxCreateAttempts: 3,
  });
  assert.equal(
    progress.claimProgressSession(
      'feishu:cancelled-retry-chat',
      cancelledRetryCard,
      'cancelled-retry-folder',
    ),
    true,
  );
  progress.feedProgressSessionsForFolder('cancelled-retry-folder', {
    eventType: 'thinking_delta',
    text: 'short turn',
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  await progress.completeAndResetProgressSessionsForFolder(
    'cancelled-retry-folder',
  );
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(
    cancelledRetryAttempts,
    2,
    'a terminal Turn gets one idempotent reconciliation attempt but no delayed retry',
  );

  // The Turn may finish while the initial create request is still waiting on
  // a gateway timeout. Preserve that terminal state and reconcile it after the
  // in-flight request rejects instead of reviving an active card.
  let rejectRacingCreate: ((reason?: unknown) => void) | undefined;
  let racingCreateAttempts = 0;
  const racingCreateUuids: string[] = [];
  const racingPatchedCards: Array<Record<string, unknown>> = [];
  const racingCard = new progress.ProgressCardController({
    client: {
      im: {
        message: {
          reply: async (request: { data: { uuid?: string } }) => {
            racingCreateAttempts++;
            racingCreateUuids.push(request.data.uuid || '');
            if (racingCreateAttempts === 1) {
              return await new Promise((_resolve, reject) => {
                rejectRacingCreate = reject;
              });
            }
            return { data: { message_id: 'message-racing-terminal' } };
          },
        },
        v1: {
          message: {
            patch: async (request: { data: { content: string } }) => {
              racingPatchedCards.push(JSON.parse(request.data.content));
              return {};
            },
            delete: async () => ({}),
          },
        },
      },
    } as unknown as lark.Client,
    chatId: 'racing-terminal-chat',
    replyToMsgId: 'racing-terminal-trigger',
    anchorFolder: 'racing-terminal-folder',
    anchorSourceChannel: 'feishu:racing-terminal-chat',
    completionDeleteDelayMs: 10,
  });
  assert.equal(
    progress.claimProgressSession(
      'feishu:racing-terminal-chat',
      racingCard,
      'racing-terminal-folder',
    ),
    true,
  );
  progress.feedProgressSessionsForFolder('racing-terminal-folder', {
    eventType: 'tool_use_start',
    toolUseId: 'racing-tool',
    toolName: 'Read',
    toolInputSummary: 'while create is pending',
  });
  await progress.completeAndResetProgressSessionsForFolder(
    'racing-terminal-folder',
  );
  assert.ok(rejectRacingCreate, 'the initial create request must be in flight');
  rejectRacingCreate(
    Object.assign(new Error('Request failed with status 504'), {
      code: 'ERR_BAD_RESPONSE',
      response: { status: 504 },
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(racingCreateAttempts, 2);
  assert.equal(new Set(racingCreateUuids).size, 1);
  assert.equal(
    (racingPatchedCards.at(-1)?.header as { template?: string } | undefined)
      ?.template,
    'green',
    'the timeout reconciliation must preserve the completed state',
  );

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
