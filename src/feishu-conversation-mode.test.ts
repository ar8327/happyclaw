import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  applyFeishuConversationMode,
  hasFeishuThreadContext,
  normalizeFeishuConversationMode,
  resolveFeishuThreadRootMsgId,
  shouldReplyInFeishuThread,
} from './feishu-conversation-mode.js';
import {
  buildFeishuTopicIdentity,
  resolveFeishuTopicAnchor,
} from './feishu-topic-session.js';
import { buildFeishuTopicNameSuffix } from './feishu-topic-title.js';

assert.equal(normalizeFeishuConversationMode('thread'), 'thread');
assert.equal(normalizeFeishuConversationMode('invalid'), 'chat');
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
      database.getLastInboundMessage(
        'web:fixture',
        'feishu:oc_fixture',
      ),
      {
        id: 'om_reply',
        sender: 'ou_user',
        reply_to_id: 'om_parent',
        thread_id: null,
        root_id: 'om_root',
      },
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
