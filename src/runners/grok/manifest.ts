import { RUNNER_DESCRIPTORS } from '../../runner-descriptor.types.js';
import { buildRunnerHealth } from '../../runner-health.js';
import type { RunnerModel } from '../../types.js';
import { createCliModelCatalog } from '../cli-model-catalog.js';
import type { RunnerServerManifest } from '../types.js';

/**
 * `grok models` 的输出：
 *
 *   Default model: grok-4.6
 *
 *   Available models:
 *     * grok-4.6 (default)
 *     - grok-4.5
 *
 * 未登录时它会先打一行 "You are not authenticated."，但模型目录照常打印，
 * 所以这里只认列表项那几行。
 */
export function parseGrokModels(output: string): RunnerModel[] {
  const models: RunnerModel[] = [];
  const seen = new Set<string>();
  for (const line of output.split('\n')) {
    const match = line.match(/^\s*[*-]\s+(\S+)/);
    if (!match) continue;
    const id = match[1];
    if (seen.has(id)) continue;
    seen.add(id);
    models.push({ id, label: id });
  }
  return models;
}

export const listGrokModels = createCliModelCatalog({
  descriptor: RUNNER_DESCRIPTORS.grok,
  command: 'grok',
  commandEnv: 'HAPPYCLAW_GROK_COMMAND',
  args: ['models'],
  parse: parseGrokModels,
  stateEnvKeys: ['GROK_HOME'],
});

export const grokServerManifest: RunnerServerManifest = {
  descriptor: RUNNER_DESCRIPTORS.grok,
  healthCheck: () => buildRunnerHealth(RUNNER_DESCRIPTORS.grok),
  listModels: () => listGrokModels(),
  profileSchema: () => RUNNER_DESCRIPTORS.grok.profileSchema || null,
};

export default grokServerManifest;
