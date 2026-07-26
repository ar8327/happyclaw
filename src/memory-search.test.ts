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

  fs.writeFileSync(
    path.join(root, 'knowledge', 'runtime.md'),
    [
      '# 运行环境',
      '',
      '停止会话尚不能自动杀掉底层 shell 子进程，必须终止整棵进程树。',
    ].join('\n'),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(root, 'knowledge', 'health.md'),
    [
      '# 饮食原则',
      '',
      '吃多一餐后无需补偿性运动，也不要饥饿性惩罚或刻意挨饿。',
    ].join('\n'),
    'utf-8',
  );
  fs.mkdirSync(path.join(root, 'transcripts'), { recursive: true });
  const noise = Array.from(
    { length: 40 },
    () => '为什么通过终端处理普通问题，之后再看看结果。',
  ).join('\n');
  fs.writeFileSync(
    path.join(root, 'transcripts', 'noise.md'),
    noise,
    'utf-8',
  );
  fs.writeFileSync(
    path.join(root, 'transcripts', 'noise-copy.md'),
    noise,
    'utf-8',
  );

  const routed = memory.searchMemoryMarkdown(
    'local',
    '停止会话为什么还留着 shell 子进程',
  );
  assert.equal(routed[0]?.file, 'knowledge/runtime.md');

  const diet = memory.searchMemoryMarkdown(
    'local',
    '不要饿肚子补偿吃多了',
  );
  assert.equal(diet[0]?.file, 'knowledge/health.md');

  const noisy = memory.searchMemoryMarkdown('local', '终端普通问题', 20);
  assert.equal(
    noisy.filter((hit: { file: string }) => hit.file.includes('noise')).length,
    1,
    'exact duplicate transcripts should not occupy multiple result slots',
  );
} finally {
  process.chdir(originalCwd);
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}

console.log('memory search tests passed');
