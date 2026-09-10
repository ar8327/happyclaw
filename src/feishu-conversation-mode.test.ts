import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  applyFeishuConversationMode,
  hasFeishuThreadContext,
  isFeishuBotMentioned,
  normalizeFeishuConversationMode,
  resolveFeishuThreadRootMsgId,
  shouldReplyInFeishuThread,
} from './feishu-conversation-mode.js';
import {
  buildFeishuTopicIdentity,
  resolveFeishuTopicAnchor,
} from './feishu-topic-session.js';
import { buildFeishuTopicNameSuffix } from './feishu-topic-title.js';
import { isSyntheticMessage } from './synthetic-messages.js';

assert.equal(
  isSyntheticMessage({ id: 'task-task-1755-abc-1755', sender: '__task__' }),
  true,
);
assert.equal(
  isSyntheticMessage({ id: 'recovery:turn-1', sender: '__system__' }),
  true,
);
assert.equal(
  isSyntheticMessage({ id: 'om_message', sender: 'ou_user' }),
  false,
);

assert.equal(normalizeFeishuConversationMode('thread'), 'thread');
assert.equal(normalizeFeishuConversationMode('invalid'), 'chat');
assert.equal(isFeishuBotMentioned(undefined, ''), false);
assert.equal(
  isFeishuBotMentioned([{ id: { open_id: 'ou_someone' } }], ''),
  false,
);
assert.equal(
  isFeishuBotMentioned([{ id: { open_id: 'ou_someone' } }], 'ou_bot'),
  false,
);
assert.equal(
  isFeishuBotMentioned([{ id: { open_id: 'ou_bot' } }], 'ou_bot'),
  true,
);
assert.equal(hasFeishuThreadContext({ thread_id: ' omt_thread ' }), true);
assert.equal(hasFeishuThreadContext({ root_id: 'om_root' }), false);
assert.equal(
  resolveFeishuThreadRootMsgId({
    id: 'om_message',
    reply_to_id: 'om_parent',
    root_id: 'om_root',
  }),
  'om_root',
);

assert.deepEqual(
  applyFeishuConversationMode('chat', {}, { id: 'om_message' }),
  {
    replyToMsgId: 'om_message',
    threadRootMsgId: 'om_message',
  },
);

const newThread = applyFeishuConversationMode(
  'thread',
  {},
  { id: 'om_message' },
);
assert.equal(newThread.replyToMsgId, 'om_message');
assert.equal(newThread.threadRootMsgId, 'om_message');
assert.equal(newThread.replyInThread, true);
assert.equal(shouldReplyInFeishuThread(newThread), true);

const existingThread = applyFeishuConversationMode(
  'chat',
  {},
  {
    id: 'om_reply',
    root_id: 'om_root',
    thread_id: 'omt_thread',
  },
);
assert.equal(existingThread.threadId, 'omt_thread');
assert.equal(existingThread.replyInThread, undefined);
assert.equal(shouldReplyInFeishuThread(existingThread), true);

assert.deepEqual(applyFeishuConversationMode('thread'), {
  threadFallbackReason: 'missing_reply_target',
});

assert.equal(
  resolveFeishuTopicAnchor({
    messageId: 'om_message',
    rootId: 'om_root',
    threadId: 'omt_thread',
  }),
  'omt_thread',
);
assert.equal(
  resolveFeishuTopicAnchor({ messageId: 'om_message', rootId: 'om_root' }),
  'om_root',
);

const identityA = buildFeishuTopicIdentity('feishu:oc_chat', 'omt_thread');
const identityB = buildFeishuTopicIdentity('feishu:oc_chat', 'omt_thread');
const identityC = buildFeishuTopicIdentity('feishu:oc_chat', 'omt_other');
assert.deepEqual(identityA, identityB);
assert.notEqual(identityA.jid, identityC.jid);
assert.match(identityA.jid, /^web:feishu-topic-[0-9a-f]{16}$/);
assert.match(identityA.folder, /^flow-feishu-topic-[0-9a-f]{16}$/);

assert.equal(
  buildFeishuTopicNameSuffix(
    'om_123456',
    '[图片: files/a.png]\n@机器人 请整理这个发布计划。后面不用进标题',
  ),
  '请整理这个发布计划',
);
assert.equal(buildFeishuTopicNameSuffix('om_123456'), '123456');

const originalCwd = process.cwd();
const fixtureRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happyclaw-feishu-conversation-'),
);
process.chdir(fixtureRoot);
try {
  const database = await import(
    `./db.js?feishu-conversation-test=${Date.now()}`
  );
  database.initDatabase();
  try {
    database.setRegisteredGroup('feishu:oc_fixture', {
      name: 'Fixture',
      folder: 'fixture',
      added_at: new Date().toISOString(),
      conversation_mode: 'thread',
    });
    assert.equal(
      database.getSessionBinding('feishu:oc_fixture')?.conversation_mode,
      'thread',
    );
    assert.equal(
      database.getRegisteredGroup('feishu:oc_fixture')?.conversation_mode,
      'thread',
    );
    database.ensureChatExists('web:fixture');
    database.storeMessageDirect(
      'om_reply',
      'web:fixture',
      'ou_user',
      'Fixture User',
      'follow-up',
      new Date().toISOString(),
      false,
      undefined,
      undefined,
      'feishu:oc_fixture',
      'om_parent',
      undefined,
      'om_root',
    );
    assert.deepEqual(
      database.getLastInboundMessage('web:fixture', 'feishu:oc_fixture'),
      {
        id: 'om_reply',
        sender: 'ou_user',
        reply_to_id: 'om_parent',
        thread_id: null,
        root_id: 'om_root',
      },
    );

    // A scheduled task trigger is injected as a synthetic inbound message with a
    // host-generated id. It must never become the reply anchor — replying to it
    // makes the Feishu delivery fail with an invalid message_id.
    database.storeMessageDirect(
      'task-task-1755000000000-abc123-1755000001000',
      'web:fixture',
      '__task__',
      '[定时任务]',
      '[task:task-1755000000000-abc123] 汇报进度',
      new Date().toISOString(),
      false,
    );
    assert.equal(
      database.getLastInboundMessage('web:fixture', 'feishu:oc_fixture')?.id,
      'om_reply',
    );
    assert.equal(database.getLastInboundMessage('web:fixture')?.id, 'om_reply');

    // Same guarantee inside a thread.
    database.storeMessageDirect(
      'om_in_thread',
      'web:fixture',
      'ou_user',
      'Fixture User',
      'threaded follow-up',
      new Date().toISOString(),
      false,
      undefined,
      undefined,
      'feishu:oc_fixture',
      undefined,
      'omt_thread',
      'om_root',
    );
    database.storeMessageDirect(
      'task-task-1755000000000-abc123-1755000002000',
      'web:fixture',
      '__task__',
      '[定时任务]',
      '[task:task-1755000000000-abc123] 汇报进度',
      new Date().toISOString(),
      false,
      undefined,
      undefined,
      'feishu:oc_fixture',
      undefined,
      'omt_thread',
      'om_root',
    );
    assert.equal(
      database.getLastInboundMessageInThread(
        'web:fixture',
        'feishu:oc_fixture',
        'omt_thread',
      )?.id,
      'om_in_thread',
    );

    database.closeDatabase();
    database.initDatabase();
    assert.equal(
      database.getSessionBinding('feishu:oc_fixture')?.conversation_mode,
      'thread',
    );
  } finally {
    database.closeDatabase();
  }
} finally {
  process.chdir(originalCwd);
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}

console.log('feishu conversation mode tests passed');
