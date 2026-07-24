import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const originalCwd = process.cwd();
const fixtureRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happyclaw-memory-search-'),
);
process.chdir(fixtureRoot);

try {
  const memory = await import(`./memory-agent.js?search-test=${Date.now()}`);
  const root = memory.ensureMemoryDir('local');
  fs.writeFileSync(
    path.join(root, 'knowledge', 'project.md'),
    [
      '# 项目记录',
      '',
      'HappyClaw 的记忆查询采用读写双车道。',
      '普通查询先走 Markdown 快速检索。',
    ].join('\n'),
    'utf-8',
  );

  const chineseHits = memory.searchMemoryMarkdown('local', '记忆查询双车道');
  assert.equal(chineseHits[0]?.file, 'knowledge/project.md');
  assert.match(chineseHits[0]?.excerpt || '', /读写双车道/);

  const englishHits = memory.searchMemoryMarkdown('local', 'Markdown');
  assert.equal(englishHits[0]?.file, 'knowledge/project.md');
  assert.deepEqual(memory.searchMemoryMarkdown('local', ''), []);
} finally {
  process.chdir(originalCwd);
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}

console.log('memory search tests passed');
