import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveImagesToTempFiles } from '../src/runners/codex/image-utils.js';

const fixtureRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happyclaw-image-utils-test-'),
);

try {
  const first = Buffer.from('first-image-content');
  const second = Buffer.from('second-image-content');
  const later = Buffer.from('later-ipc-image-content');

  const firstBatch = saveImagesToTempFiles(
    [
      { data: first.toString('base64'), mimeType: 'image/jpeg' },
      { data: second.toString('base64'), mimeType: 'image/png' },
    ],
    fixtureRoot,
  );
  const laterBatch = saveImagesToTempFiles(
    [{ data: later.toString('base64'), mimeType: 'image/jpeg' }],
    fixtureRoot,
  );

  assert.equal(firstBatch.length, 2);
  assert.equal(laterBatch.length, 1);
  assert.notEqual(
    firstBatch[0],
    laterBatch[0],
    'separate IPC deliveries must never reuse image-0.jpg',
  );
  assert.notEqual(
    path.dirname(firstBatch[0]),
    path.dirname(laterBatch[0]),
    'each image delivery should have an isolated batch directory',
  );
  assert.deepEqual(fs.readFileSync(firstBatch[0]), first);
  assert.deepEqual(fs.readFileSync(firstBatch[1]), second);
  assert.deepEqual(fs.readFileSync(laterBatch[0]), later);
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}

console.log('runner image temp-file tests passed');
