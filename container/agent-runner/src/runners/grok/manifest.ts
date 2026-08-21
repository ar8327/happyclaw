import { execFile } from 'child_process';
import { promisify } from 'util';

import type { RunnerManifest } from '../types.js';
import type { RunnerModel } from '../../runner-descriptor.types.js';
import { RUNNER_DESCRIPTORS } from '../../runner-descriptor.types.js';
import { descriptorHealthCheck, descriptorModels } from '../health.js';
import { hasGrokOneShotAuth, invokeGrokOneShot } from '../one-shot-invokers.js';

const execFileAsync = promisify(execFile);

function configuredModel(ctxModel?: string): string {
  return (
    ctxModel ||
    process.env.HAPPYCLAW_GROK_MODEL ||
    RUNNER_DESCRIPTORS.grok.defaultModel ||
    'grok-4.6'
  );
}

/**
 * 优先实时读取 `grok models`，失败回落到描述符静态列表。
 *
 * 输出形如：
 *   Default model: grok-4.6
 *   Available models:
 *     * grok-4.6 (default)
 *     - grok-4.5
 */
async function listGrokModels(): Promise<RunnerModel[]> {
  try {
    const result = await execFileAsync('grok', ['models'], {
      timeout: 10_000,
      windowsHide: true,
    });
    const models: RunnerModel[] = [];
    for (const line of result.stdout.split('\n')) {
      const match = line.match(/^\s*[*-]\s+(\S+)/);
      if (!match) continue;
      const id = match[1];
      if (models.some((model) => model.id === id)) continue;
      models.push({ id, label: id });
    }
    if (models.length > 0) return models;
  } catch {
    /* fall through */
  }
  return descriptorModels(RUNNER_DESCRIPTORS.grok);
}

export const grokManifest: RunnerManifest = {
  descriptor: RUNNER_DESCRIPTORS.grok,
  createRunner: async (ctx) => {
    const { GrokRunner } = await import('./runner.js');
    return new GrokRunner({
      ...ctx,
      model: configuredModel(ctx.containerInput.runnerConfig?.model),
      thinkingEffort:
        ctx.containerInput.runnerConfig?.thinkingEffort || ctx.thinkingEffort,
      command: ctx.containerInput.runnerConfig?.command,
      builtinMcpServerName:
        RUNNER_DESCRIPTORS.grok.toolContract.builtinServerName,
    });
  },
  healthCheck: (ctx) => descriptorHealthCheck(RUNNER_DESCRIPTORS.grok, ctx.env),
  listModels: () => listGrokModels(),
  createOneShotInvoker: (ctx) => {
    if (!hasGrokOneShotAuth(ctx.env)) return null;
    const defaultModel = configuredModel();
    return {
      runnerId: 'grok',
      label: 'Grok',
      description: RUNNER_DESCRIPTORS.grok.description,
      defaultModel,
      models: [defaultModel],
      invoke: (input) =>
        invokeGrokOneShot({
          ...input,
          model: input.model || defaultModel,
        }),
    };
  },
};
