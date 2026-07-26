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

console.log('durable outbound tracker tests passed');
