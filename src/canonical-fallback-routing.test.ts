import assert from 'node:assert/strict';
import { buildCanonicalFallbackRoute } from './canonical-fallback-routing.js';

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

testImFallbackTargetsOriginalThread();
testWebFallbackStaysWebOnly();
console.log('canonical fallback routing tests passed');
