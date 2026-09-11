import assert from 'node:assert/strict';
import {
  buildCanonicalFallbackRoute,
  selectLatestCanonicalFallbackSource,
} from './canonical-fallback-routing.js';

function testImFallbackTargetsOriginalThread(): void {
  const route = buildCanonicalFallbackRoute({
    sourceChannel: 'feishu:oc_test',
    sourceChannelType: 'feishu',
    imOptions: {
      replyToMsgId: 'om_trigger',
      threadId: 'omt_thread',
      replyInThread: true,
      threadRootMsgId: 'om_root',
    },
  });

  assert.deepEqual(route, {
    sendToIM: true,
    imTargetJid: 'feishu:oc_test',
    imOptions: {
      replyToMsgId: 'om_trigger',
      threadId: 'omt_thread',
      replyInThread: true,
      threadRootMsgId: 'om_root',
    },
    sourceJid: 'feishu:oc_test',
    replyToId: 'om_trigger',
    threadId: 'omt_thread',
    rootId: 'om_root',
  });
}

function testWebFallbackStaysWebOnly(): void {
  assert.deepEqual(
    buildCanonicalFallbackRoute({
      sourceChannel: 'web:main',
      sourceChannelType: null,
    }),
    {
      sendToIM: false,
      imTargetJid: undefined,
      imOptions: undefined,
      sourceJid: undefined,
      replyToId: undefined,
      threadId: undefined,
      rootId: undefined,
    },
  );
}

function testLatestAckedSourceWinsWithinMixedTurn(): void {
  assert.deepEqual(
    selectLatestCanonicalFallbackSource([
      {
        rowid: 10,
        id: 'web-message',
        chat_jid: 'web:main',
        source_jid: 'web:main',
      },
      {
        rowid: 11,
        id: 'feishu-message',
        chat_jid: 'web:main',
        source_jid: 'feishu:oc_current',
        reply_to_id: 'om_parent',
        thread_id: 'omt_thread',
        root_id: 'om_root',
      },
    ]),
    {
      messageId: 'feishu-message',
      sourceChannel: 'feishu:oc_current',
      replyToId: 'om_parent',
      threadId: 'omt_thread',
      rootId: 'om_root',
    },
  );
}

function testLatestFeishuGroupWinsWithinMixedTurn(): void {
  assert.deepEqual(
    selectLatestCanonicalFallbackSource([
      {
        rowid: 20,
        id: 'group-a-message',
        chat_jid: 'web:main',
        source_jid: 'feishu:oc_group_a',
      },
      {
        rowid: 21,
        id: 'group-b-message',
        chat_jid: 'web:main',
        source_jid: 'feishu:oc_group_b',
      },
    ]),
    {
      messageId: 'group-b-message',
      sourceChannel: 'feishu:oc_group_b',
      replyToId: undefined,
      threadId: undefined,
      rootId: undefined,
    },
  );
}

testImFallbackTargetsOriginalThread();
testWebFallbackStaysWebOnly();
testLatestAckedSourceWinsWithinMixedTurn();
testLatestFeishuGroupWinsWithinMixedTurn();
console.log('canonical fallback routing tests passed');
