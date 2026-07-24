import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const originalCwd = process.cwd();
const fixtureRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happyclaw-memory-queue-'),
);
process.chdir(fixtureRoot);

try {
  const database = await import(`./db.js?queue-test=${Date.now()}`);
  database.initDatabase();
  try {
    const first = database.enqueueMemoryWrite({
      ownerKey: 'local',
      kind: 'remember',
      payload: { content: 'fixture' },
      dedupKey: 'same',
    });
    const duplicate = database.enqueueMemoryWrite({
      ownerKey: 'local',
      kind: 'remember',
      payload: { content: 'duplicate' },
      dedupKey: 'same',
    });
    assert.equal(duplicate.id, first.id);

    const claimed = database.claimNextMemoryWrite('local');
    assert.equal(claimed?.id, first.id);
    assert.equal(claimed?.attempts, 1);

    database.retryMemoryWrite(first.id, 'fixture error', 0);
    const retried = database.claimNextMemoryWrite('local');
    assert.equal(retried?.id, first.id);
    assert.equal(retried?.attempts, 2);

    const recoveredCount = database.recoverInterruptedMemoryWrites();
    assert.equal(recoveredCount, 1);
    const recovered = database.claimNextMemoryWrite('local');
    assert.equal(recovered?.id, first.id);
    database.completeMemoryWrite(first.id);

    const metrics = database.getMemoryWriteQueueMetrics('local');
    assert.equal(metrics.pending, 0);
    assert.equal(metrics.running, 0);

    const batchJobs = Array.from({ length: 3 }, (_, index) =>
      database.enqueueMemoryWrite({
        ownerKey: 'local',
        kind: 'session_wrapup',
        payload: { index },
        dedupKey: `batch-${index}`,
      }),
    );
    const batchHead = database.claimNextMemoryWrite('local');
    assert.equal(batchHead?.id, batchJobs[0].id);
    const batchTail = database.claimMemoryWriteBatch(
      'local',
      'session_wrapup',
      7,
    );
    assert.deepEqual(
      batchTail.map((job: { id: string }) => job.id),
      batchJobs.slice(1).map((job) => job.id),
    );
    assert.ok(
      batchTail.every((job: { attempts: number }) => job.attempts === 1),
    );
  } finally {
    database.closeDatabase();
  }
} finally {
  process.chdir(originalCwd);
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}

console.log('memory write queue tests passed');
