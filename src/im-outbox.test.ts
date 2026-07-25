import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ImOutboxRecord } from './db.js';

const originalCwd = process.cwd();
const fixtureRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happyclaw-im-outbox-'),
);
process.chdir(fixtureRoot);

try {
  const database = await import(`./db.js?im-outbox-test=${Date.now()}`);
  database.initDatabase();
  try {
    const enqueue = (
      id: string,
      targetJid: string,
    ): ReturnType<typeof database.enqueueImOutbox> =>
      database.enqueueImOutbox({
        id,
        sourceChatJid: 'web:test',
        targetJid,
        kind: 'text',
        payload: { text: id },
      });

    const firstA = enqueue('a-1', 'feishu:a');
    const duplicateA = enqueue('a-1', 'feishu:a');
    const secondA = enqueue('a-2', 'feishu:a');
    const firstB = enqueue('b-1', 'telegram:b');
    assert.equal(duplicateA.sequence, firstA.sequence);

    const firstClaim = database.claimReadyImOutbox(10);
    assert.deepEqual(
      firstClaim.map((record: ImOutboxRecord) => record.id),
      [firstA.id, firstB.id],
    );
    assert.deepEqual(database.claimReadyImOutbox(10), []);

    database.markImOutboxDelivered(firstA.id, 'om_a');
    database.markImOutboxDelivered(firstB.id);
    assert.deepEqual(
      database
        .claimReadyImOutbox(10)
        .map((record: ImOutboxRecord) => record.id),
      [secondA.id],
    );

    database.failImOutbox(secondA.id, 7, 'fixture failure');
    assert.equal(database.countFailedImOutbox(), 1);
    assert.equal(database.listFailedImOutbox()[0].id, secondA.id);
    assert.equal(database.retryFailedImOutbox(secondA.id), true);
    assert.equal(database.claimReadyImOutbox(10)[0].id, secondA.id);
    database.failImOutbox(secondA.id, 1, 'clear me');
    assert.equal(database.clearFailedImOutbox(secondA.id), true);
    assert.equal(database.countFailedImOutbox(), 0);

    const interrupted = enqueue('restart-1', 'qq:c');
    assert.equal(database.claimReadyImOutbox(10)[0].id, interrupted.id);
    database.closeDatabase();
    database.initDatabase();
    assert.equal(database.claimReadyImOutbox(10)[0].id, interrupted.id);
  } finally {
    database.closeDatabase();
  }
} finally {
  process.chdir(originalCwd);
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}

console.log('IM outbox tests passed');
