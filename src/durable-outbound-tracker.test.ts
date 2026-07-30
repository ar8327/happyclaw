import assert from 'node:assert/strict';
import { DurableOutboundTracker } from './durable-outbound-tracker.js';

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
});

assert.deepEqual(
  tracker.latestTextSince('long-lived', turnBaseline, 'turn-2'),
  {
    sequence: 2,
    messageId: 'outbound:current-turn',
    chatJid: 'web:main',
    text: '当前轮回复',
    turnId: 'turn-2',
  },
);

console.log('durable outbound tracker tests passed');
