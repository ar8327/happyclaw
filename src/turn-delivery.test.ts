import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const testDataDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happyclaw-turn-delivery-'),
);
process.env.DATA_DIR = testDataDir;

const db = await import('./db.js');

try {
  db.initDatabase();
  db.insertTurn({
    id: 'turn-1',
    chat_jid: 'web:test',
    channel: 'web:test',
    message_ids: JSON.stringify(['message-1']),
    started_at: new Date().toISOString(),
    status: 'running',
    group_folder: 'test',
  });
  db.ensureTurnDelivery({
    deliveryId: 'delivery-1',
    turnId: 'turn-1',
    chatJid: 'web:test',
    groupFolder: 'test',
    maxRowid: 7,
    messageIds: ['message-1'],
  });

  db.updateTurnDeliveryStatus(['delivery-1'], 'accepted');
  assert.equal(db.getTurnDelivery('delivery-1')?.status, 'accepted');

  // A delayed pickup event must not downgrade an already accepted delivery.
  db.updateTurnDeliveryStatus(['delivery-1'], 'received');
  assert.equal(db.getTurnDelivery('delivery-1')?.status, 'accepted');

  db.updateTurnDeliveryStatus(['delivery-1'], 'queued', {
    allowAcceptedReplay: true,
  });
  assert.equal(db.getTurnDelivery('delivery-1')?.status, 'queued');
  db.updateTurnDeliveryStatus(['delivery-1'], 'accepted');
  db.updateTurnDeliveryStatus(['delivery-1'], 'completed');
  db.updateTurnDeliveryStatus(['delivery-1'], 'queued');
  assert.equal(db.getTurnDelivery('delivery-1')?.status, 'completed');
  assert.deepEqual(db.getCompletedTurnDeliveryCursors(), [
    { chat_jid: 'web:test', max_rowid: 7 },
  ]);
  assert.equal(db.getRecoverableTurns()[0]?.id, 'turn-1');

  db.closeDatabase();
  console.log('turn delivery tests passed');
} finally {
  try {
    db.closeDatabase();
  } catch {
    // Already closed by the successful path.
  }
  fs.rmSync(testDataDir, { recursive: true, force: true });
}
