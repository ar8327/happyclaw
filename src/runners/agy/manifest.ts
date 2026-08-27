import { RUNNER_DESCRIPTORS } from '../../runner-descriptor.types.js';
import { buildRunnerHealth } from '../../runner-health.js';
import type { RunnerModel } from '../../types.js';
import { createCliModelCatalog } from '../cli-model-catalog.js';
import type { RunnerServerManifest } from '../types.js';

const displayNamePatterns = (RUNNER_DESCRIPTORS.agy.modelPatterns || []).map(
  (pattern) => new RegExp(pattern),
);

function isModelDisplayName(value: string): boolean {
  if (displayNamePatterns.length === 0) return true;
  return displayNamePatterns.some((pattern) => pattern.test(value));
}

/**
 * `agy models` 的输出（注意：全写在 stderr）：
 *
 *   Fetching available models...
 *   gemini-3.7-flash-high\tGemini 3.7 Flash (High)
 *   claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)
 *
 * 早期版本只有显示名一列，两种都认。`--model` 吃的是显示名，会话里存的也是
 * 显示名，所以 id 取显示名而不是 slug。
 */
export function parseAgyModels(output: string): RunnerModel[] {
  const models: RunnerModel[] = [];
  const seen = new Set<string>();
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const columns = line.split('\t');
    const displayName = columns[columns.length - 1].trim();
    if (!displayName || seen.has(displayName)) continue;
    if (!isModelDisplayName(displayName)) continue;
    seen.add(displayName);
    models.push({ id: displayName, label: displayName });
  }
  return models;
}

export const listAgyModels = createCliModelCatalog({
  descriptor: RUNNER_DESCRIPTORS.agy,
  command: 'agy',
  commandEnv: 'HAPPYCLAW_AGY_COMMAND',
  args: ['models'],
  stream: 'both',
  parse: parseAgyModels,
  stateEnvKeys: ['HAPPYCLAW_AGY_HOME'],
  // `agy models` 要联网做 eligibility check，实测 6~25s 且抖动很大；默认 5s
  // 必被杀掉，每次都白跑一趟只落到回落列表。慢的是后台刷新，首次调用仍然
  // 只等 firstCallBudget。
  timeoutMs: 30_000,
});

export const agyServerManifest: RunnerServerManifest = {
  descriptor: RUNNER_DESCRIPTORS.agy,
  healthCheck: () => buildRunnerHealth(RUNNER_DESCRIPTORS.agy),
  listModels: () => listAgyModels(),
  profileSchema: () => RUNNER_DESCRIPTORS.agy.profileSchema || null,
};

export default agyServerManifest;
