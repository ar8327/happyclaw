import assert from 'node:assert/strict';

import { RUNNER_DESCRIPTORS } from './runner-descriptor.types.js';
import { createCliModelCatalog } from './runners/cli-model-catalog.js';
import { parseAgyModels } from './runners/agy/manifest.js';
import { parseGrokModels } from './runners/grok/manifest.js';

const FALLBACK_COUNT = RUNNER_DESCRIPTORS.agy.models?.length ?? 0;
assert.ok(FALLBACK_COUNT > 0, 'agy descriptor 应带静态回落列表');

/** 用 sh 假装成一个 runner CLI，避免测试依赖真实命令。 */
function fakeCli(script: string) {
  return { command: 'sh', args: ['-c', script] };
}

const twoModels = "printf 'Gemini 3.7 Flash (High)\\nGemini 3.1 Pro (Low)\\n'";

// ─── 解析成功时用实时列表，而不是静态回落 ─────────────────

{
  const list = createCliModelCatalog({
    descriptor: RUNNER_DESCRIPTORS.agy,
    ...fakeCli(twoModels),
    parse: parseAgyModels,
  });
  const models = await list({});
  assert.deepEqual(
    models.map((model) => model.id),
    ['Gemini 3.7 Flash (High)', 'Gemini 3.1 Pro (Low)'],
  );
}

// ─── CLI 缺失 / 失败时回落到 descriptor 静态列表 ───────────

{
  const list = createCliModelCatalog({
    descriptor: RUNNER_DESCRIPTORS.agy,
    command: 'happyclaw-no-such-command',
    args: [],
    parse: parseAgyModels,
  });
  assert.equal((await list({})).length, FALLBACK_COUNT);
}

// ─── CLI 有输出但退出码非 0：输出仍然可用 ──────────────────

{
  const list = createCliModelCatalog({
    descriptor: RUNNER_DESCRIPTORS.agy,
    ...fakeCli(`${twoModels}; exit 1`),
    parse: parseAgyModels,
  });
  assert.equal((await list({})).length, 2);
}

// ─── 解析不出任何模型也要回落，不能返回空列表 ──────────────

{
  const list = createCliModelCatalog({
    descriptor: RUNNER_DESCRIPTORS.agy,
    ...fakeCli("printf 'Fetching available models...\\n'"),
    parse: parseAgyModels,
  });
  assert.equal((await list({})).length, FALLBACK_COUNT);
}

// ─── TTL 内复用缓存，不再 spawn ────────────────────────────

{
  let spawns = 0;
  const list = createCliModelCatalog({
    descriptor: RUNNER_DESCRIPTORS.agy,
    ...fakeCli(twoModels),
    parse: (output) => {
      spawns += 1;
      return parseAgyModels(output);
    },
  });
  await list({});
  await list({});
  await list({});
  assert.equal(spawns, 1, 'TTL 内应只抓一次');

  await list({}, { force: true });
  assert.equal(spawns, 2, 'force 应强制重新抓取');
}

// ─── 慢 CLI：首次不阻塞，后台刷新完再用实时列表 ─────────────

{
  const list = createCliModelCatalog({
    descriptor: RUNNER_DESCRIPTORS.agy,
    ...fakeCli(`sleep 0.6; ${twoModels}`),
    parse: parseAgyModels,
    firstCallBudgetMs: 150,
  });

  const startedAt = Date.now();
  const first = await list({});
  const elapsed = Date.now() - startedAt;
  assert.equal(first.length, FALLBACK_COUNT, '超预算应先给回落列表');
  assert.ok(elapsed < 500, `首次调用不应久等，实际 ${elapsed}ms`);

  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.equal((await list({})).length, 2, '后台刷新落地后应给实时列表');
}

// ─── 并发调用共用同一次刷新 ────────────────────────────────

{
  let spawns = 0;
  const list = createCliModelCatalog({
    descriptor: RUNNER_DESCRIPTORS.agy,
    ...fakeCli(`sleep 0.3; ${twoModels}`),
    parse: (output) => {
      spawns += 1;
      return parseAgyModels(output);
    },
  });
  await Promise.all([list({}), list({}), list({})]);
  assert.equal(spawns, 1, '并发调用不应各 spawn 一次');
}

// ─── agy 输出解析 ──────────────────────────────────────────

{
  // 新版是 `slug\t显示名` 两列，旧版只有显示名一列，两种都要认。
  const models = parseAgyModels(
    [
      'Fetching available models...',
      'gemini-3.7-flash-high\tGemini 3.7 Flash (High)',
      'claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)',
      'GPT-OSS 120B (Medium)',
      '⠋ Fetching available models...',
      '',
      'gemini-3.7-flash-high\tGemini 3.7 Flash (High)',
    ].join('\n'),
  );
  assert.deepEqual(
    models.map((model) => model.id),
    [
      'Gemini 3.7 Flash (High)',
      'Claude Opus 4.6 (Thinking)',
      'GPT-OSS 120B (Medium)',
    ],
  );
  assert.ok(
    models.every((model) => model.label === model.id),
    'label 应与显示名一致',
  );
}

// ─── grok 输出解析 ─────────────────────────────────────────

{
  const models = parseGrokModels(
    [
      'You are not authenticated.',
      '',
      'Default model: grok-4.6',
      '',
      'Available models:',
      '  * grok-4.6 (default)',
      '  - grok-4.5',
      '  - grok-4.5',
    ].join('\n'),
  );
  assert.deepEqual(
    models.map((model) => model.id),
    ['grok-4.6', 'grok-4.5'],
  );
}

console.log('cli-model-catalog tests passed');
