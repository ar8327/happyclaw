import assert from 'node:assert/strict';
import {
  DurableOutboundTracker,
  TurnOutboundGate,
} from './durable-outbound-tracker.js';

const tracker = new DurableOutboundTracker();
const baseline = tracker.snapshot('main');

tracker.mark('main', {
  messageId: 'outbound:1',
  chatJid: 'web:main',
  text: '进度',
});
tracker.mark('main');
tracker.mark('main', {
  messageId: 'outbound:2',
  chatJid: 'web:main',
  text: '完成',
});

assert.equal(tracker.snapshot('main'), 3);
assert.deepEqual(tracker.latestTextSince('main', baseline), {
  sequence: 3,
  messageId: 'outbound:2',
  chatJid: 'web:main',
  text: '完成',
});
assert.equal(tracker.latestTextSince('main', 3), undefined);
assert.equal(tracker.snapshot('worker'), 0);

const turnBaseline = tracker.snapshot('long-lived');
tracker.mark('long-lived', {
  messageId: 'outbound:old-turn',
  chatJid: 'web:main',
  text: '上一轮回复',
  turnId: 'turn-1',
});

assert.equal(
  tracker.latestTextSince('long-lived', turnBaseline, 'turn-2'),
  undefined,
);

tracker.mark('long-lived', {
  messageId: 'outbound:current-turn',
  chatJid: 'web:main',
  text: '当前轮回复',
  turnId: 'turn-2',
  targetChannel: 'feishu:oc_other',
});

assert.equal(
  tracker.latestTextSince(
    'long-lived',
    turnBaseline,
    'turn-2',
    'feishu:oc_current',
  ),
  undefined,
);

tracker.mark('long-lived', {
  messageId: 'outbound:current-source',
  chatJid: 'web:main',
  text: '当前来源回复',
  turnId: 'turn-2',
  targetChannel: 'feishu:oc_current',
});

assert.deepEqual(
  tracker.latestTextSince(
    'long-lived',
    turnBaseline,
    'turn-2',
    'feishu:oc_current',
  ),
  {
    sequence: 3,
    messageId: 'outbound:current-source',
    chatJid: 'web:main',
    text: '当前来源回复',
    turnId: 'turn-2',
    targetChannel: 'feishu:oc_current',
  },
);

console.log('durable outbound tracker tests passed');

// TurnOutboundGate: the silent-success IM fallback gate.
{
  const gateTracker = new DurableOutboundTracker();
  const gate = new TurnOutboundGate(gateTracker, 'main');

  // Fresh runtime, nothing sent yet — a silent turn must be able to fall back.
  assert.equal(gate.sentThisTurn(), false);

  // Runner with a structured event stream (claude/codex) reports the tool call.
  gate.markToolSignal();
  assert.equal(gate.sentThisTurn(), true);

  // Regression: agy/grok/traex never emit tool events, so only a host-accepted
  // IPC write can prove the turn replied.
  gate.beginTurn();
  assert.equal(gate.sentThisTurn(), false);
  gateTracker.mark('main', {
    messageId: 'outbound:turn-1',
    chatJid: 'web:main',
    text: '随时都在呀',
  });
  assert.equal(gate.sentThisTurn(), true);

  // Regression for the idle-timeout replay: the runtime stays alive for hours
  // after that reply. Exiting later must still count as "already replied".
  assert.equal(gate.sentThisTurn(), true);

  // A later turn that sends nothing must fall back again — a runtime-lifetime
  // baseline would keep the gate permanently closed here.
  gate.beginTurn();
  assert.equal(gate.sentThisTurn(), false);

  // Outbound writes from another Session must not close this gate.
  gateTracker.mark('other-folder');
  assert.equal(gate.sentThisTurn(), false);

  // Non-text outbound (image/file) counts too.
  gateTracker.mark('main');
  assert.equal(gate.sentThisTurn(), true);
}

console.log('turn outbound gate tests passed');
