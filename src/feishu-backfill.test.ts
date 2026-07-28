import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('./feishu.ts', import.meta.url), 'utf8');
const backfillStart = source.indexOf('  async function backfillChatMessages(');
const backfillEnd = source.indexOf(
  '\n  async function runBackfill(',
  backfillStart,
);

assert.ok(backfillStart >= 0, 'backfillChatMessages should exist');
assert.ok(backfillEnd > backfillStart, 'runBackfill should follow backfill');

const backfillSource = source.slice(backfillStart, backfillEnd);
assert.match(
  backfillSource,
  /handleIncomingMessage\(message, 'backfill'\)/,
  'backfilled messages should still enter the normal message pipeline',
);
assert.doesNotMatch(
  backfillSource,
  /sendTextToChat|\.message\.(?:create|reply)\(/,
  'backfill must not emit user-visible connection recovery notices',
);
assert.doesNotMatch(
  source,
  /飞书连接已恢复|补处理断线期间/,
  'connection recovery copy should not be present',
);

console.log('Feishu backfill stays silent while processing messages');
