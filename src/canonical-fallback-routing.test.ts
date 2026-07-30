import assert from 'node:assert/strict';
import {
  buildCanonicalFallbackRoute,
  canReuseCanonicalOutbound,
  selectLatestConsumedSourceChannel,
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

function testCanonicalOutboundMustTargetTriggeringConversation(): void {
  const currentImRoute = {
    chatJid: 'web:main',
    sourceChannel: 'feishu:oc_current',
    sourceChannelType: 'feishu',
    imOptions: { threadId: 'omt_current' },
  };

  assert.equal(
    canReuseCanonicalOutbound({
      ...currentImRoute,
      outbound: {
        chatJid: 'web:main',
        targetChannel: 'feishu:oc_current',
        threadId: 'omt_current',
      },
    }),
    true,
  );
  assert.equal(
    canReuseCanonicalOutbound({
      ...currentImRoute,
      outbound: {
        chatJid: 'web:main',
        targetChannel: 'feishu:oc_other',
        threadId: 'omt_current',
      },
    }),
    false,
  );
  assert.equal(
    canReuseCanonicalOutbound({
      ...currentImRoute,
      outbound: {
        chatJid: 'web:main',
        targetChannel: 'feishu:oc_current',
        threadId: 'omt_other',
      },
    }),
    false,
  );
  assert.equal(
    canReuseCanonicalOutbound({
      ...currentImRoute,
      outbound: { chatJid: 'web:main' },
    }),
    false,
  );
}

function testWebOutboundCanOnlySatisfyWebSource(): void {
  assert.equal(
    canReuseCanonicalOutbound({
      chatJid: 'web:main',
      sourceChannel: 'web:main',
      sourceChannelType: null,
      outbound: { chatJid: 'web:main' },
    }),
    true,
  );
  assert.equal(
    canReuseCanonicalOutbound({
      chatJid: 'web:main',
      sourceChannel: 'web:main',
      sourceChannelType: null,
      outbound: {
        chatJid: 'web:main',
        targetChannel: 'feishu:oc_other',
      },
    }),
    false,
  );
}

function testLatestConsumedDeliveryControlsFallbackSource(): void {
  assert.equal(
    selectLatestConsumedSourceChannel(
      [
        { rowid: 10, chatJid: 'web:main', sourceJid: 'web:main' },
        {
          rowid: 11,
          chatJid: 'web:main',
          sourceJid: 'feishu:oc_injected',
        },
      ],
      'web:main',
    ),
    'feishu:oc_injected',
  );
  assert.equal(
    selectLatestConsumedSourceChannel([], 'feishu:oc_initial'),
    'feishu:oc_initial',
  );
}

testImFallbackTargetsOriginalThread();
testWebFallbackStaysWebOnly();
testCanonicalOutboundMustTargetTriggeringConversation();
testWebOutboundCanOnlySatisfyWebSource();
testLatestConsumedDeliveryControlsFallbackSource();
console.log('canonical fallback routing tests passed');
