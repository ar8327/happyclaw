import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';

const testDataDir = fs.mkdtempSync(`${os.tmpdir()}/happyclaw-turn-routing-`);
process.env.DATA_DIR = testDataDir;

try {
  const database = await import('./db.js');
  database.initDatabase();
  const { TurnManager } = await import(
    `./turn-manager.js?session-routing-test=${Date.now()}`
  );
  const manager = new TurnManager();

  const first = manager.routeMessage('shared-session', 'web:main', 'web:main', [
    'web-message',
  ]);
  assert.equal(first.action, 'start_new');

  const feishu = manager.routeMessage(
    'shared-session',
    'web:main',
    'feishu:oc_current',
    ['feishu-message'],
  );
  assert.deepEqual(feishu, { action: 'inject', turnId: first.turnId });

  const scheduled = manager.routeMessage(
    'shared-session',
    'web:main',
    'task:daily',
    ['task-message'],
  );
  assert.deepEqual(scheduled, { action: 'inject', turnId: first.turnId });
  assert.deepEqual(manager.getPendingCounts('shared-session'), new Map());
  assert.deepEqual(manager.getActiveTurn('shared-session')?.messageIds, [
    'web-message',
    'feishu-message',
    'task-message',
  ]);

  const other = manager.routeMessage(
    'other-session',
    'web:other',
    'feishu:oc_current',
    ['other-message'],
  );
  assert.equal(other.action, 'start_new');
  assert.notEqual(other.turnId, first.turnId);
} finally {
  fs.rmSync(testDataDir, { recursive: true, force: true });
}

console.log('turn manager Session routing tests passed');
