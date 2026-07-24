import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const originalCwd = process.cwd();
const fixtureRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happyclaw-memory-retention-'),
);
process.chdir(fixtureRoot);

try {
  const database = await import('./db.js');
  database.initDatabase();
  try {
    const memory = await import('./memory-agent.js');
    const root = memory.ensureMemoryDir('local');
    const transcript = path.join(root, 'transcripts', 'old.md');
    fs.writeFileSync(transcript, '长期项目决定：保留双车道设计。', 'utf-8');
    const oldTime = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    fs.utimesSync(transcript, oldTime, oldTime);

    const backups = path.join(root, 'backups');
    fs.mkdirSync(backups, { recursive: true });
    for (let index = 0; index < 12; index += 1) {
      const file = path.join(backups, `index-${index}.md`);
      fs.writeFileSync(file, String(index), 'utf-8');
      const time = new Date(Date.now() - index * 1_000);
      fs.utimesSync(file, time, time);
    }
    memory.writeMemoryState('local', {
      lastGlobalSleep: null,
      lastSessionWrapups: { 'web:removed': { rowid: 10 } },
      pendingWrapups: [],
    });

    const result = memory.runMemoryRetention('local');
    assert.equal(result.transcriptsArchived, 1);
    assert.equal(result.backupsDeleted, 2);
    assert.equal(result.cursorsPruned, 1);
    assert.equal(fs.existsSync(transcript), false);
    assert.equal(fs.existsSync(`${transcript}.gz`), true);
    assert.match(
      memory.searchMemoryMarkdown('local', '双车道')[0]?.excerpt || '',
      /双车道/,
    );
  } finally {
    database.closeDatabase();
  }
} finally {
  process.chdir(originalCwd);
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}

console.log('memory retention tests passed');
