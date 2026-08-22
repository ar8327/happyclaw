/**
 * 从 runner CLI 实时抓模型目录，带进程内缓存。
 *
 * 每个 runner 的模型列表只有 CLI 自己知道，descriptor 里的 `models` 数组是
 * 手写快照，一旦上游发新模型就过期。这里统一处理三件事：
 *
 * - 缓存与去重：`/model` 卡片每次渲染都会问一遍模型列表，不能每次都 spawn。
 * - 首次调用预算：飞书卡片回调等不起一个慢 CLI，超预算先返回回落列表，
 *   后台继续刷新，下一次调用就是新的。
 * - 回落：CLI 缺失、未登录、断网时退回 descriptor 静态列表，不要空着。
 *
 * 解析交给各 runner 的 `parse`，因为输出格式各不相同；输出流也不可靠
 * （`agy models` 在 TTY 下把目录写 stderr、管道下写 stdout），所以 `stream`
 * 支持声明 'both'。
 */
import { execFile } from 'child_process';
import { promisify } from 'util';

import { logger } from '../logger.js';
import { modelsForDescriptor } from '../runner-health.js';
import type { RunnerDescriptor, RunnerModel } from '../types.js';

const execFileAsync = promisify(execFile);

const DEFAULT_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_FIRST_CALL_BUDGET_MS = 2_500;
const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;

export type CliModelCatalogStream = 'stdout' | 'stderr' | 'both';

export interface CliModelCatalogOptions {
  descriptor: RunnerDescriptor;
  /** 默认命令名，可被 `commandEnv` 覆盖。 */
  command: string;
  commandEnv?: string;
  args: string[];
  /** 模型目录写在哪个流上。默认 stdout。 */
  stream?: CliModelCatalogStream;
  /**
   * 解析 CLI 输出。`fallback` 是 descriptor 静态列表，可用来补 label 等
   * CLI 不给的元数据。抛错或返回空数组都会触发回落。
   */
  parse(output: string, fallback: RunnerModel[]): RunnerModel[];
  /** 参与缓存 key 的环境变量（配置目录等，换了就得重新抓）。 */
  stateEnvKeys?: string[];
  timeoutMs?: number;
  refreshIntervalMs?: number;
  firstCallBudgetMs?: number;
}

export interface CliModelCatalogCallOptions {
  /** 忽略 TTL 强制刷新。仍然复用进行中的刷新。 */
  force?: boolean;
}

export type CliModelCatalog = (
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>,
  callOptions?: CliModelCatalogCallOptions,
) => Promise<RunnerModel[]>;

interface CatalogState {
  lastRefreshAttemptAt: number;
  models?: RunnerModel[];
  refreshInFlight?: Promise<RunnerModel[]>;
}

function pickOutput(
  stream: CliModelCatalogStream,
  stdout: string,
  stderr: string,
): string {
  if (stream === 'stderr') return stderr;
  if (stream === 'both') return `${stdout}\n${stderr}`;
  return stdout;
}

export function createCliModelCatalog(
  options: CliModelCatalogOptions,
): CliModelCatalog {
  const states = new Map<string, CatalogState>();
  const stream = options.stream ?? 'stdout';
  const refreshIntervalMs =
    options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const firstCallBudgetMs =
    options.firstCallBudgetMs ?? DEFAULT_FIRST_CALL_BUDGET_MS;

  return async function listModels(env = process.env, callOptions = {}) {
    const command =
      (options.commandEnv ? env[options.commandEnv]?.trim() : '') ||
      options.command;
    const stateKey = JSON.stringify([
      command,
      ...(options.stateEnvKeys || []).map((name) => env[name] || ''),
      env.HOME || '',
    ]);
    const state = states.get(stateKey) || { lastRefreshAttemptAt: 0 };
    states.set(stateKey, state);

    const now = Date.now();
    if (
      !callOptions.force &&
      state.models &&
      now - state.lastRefreshAttemptAt < refreshIntervalMs
    ) {
      return state.models;
    }

    if (!state.refreshInFlight) {
      state.lastRefreshAttemptAt = now;
      state.refreshInFlight = (async () => {
        const fallbackModels = modelsForDescriptor(options.descriptor, env);
        try {
          let stdout = '';
          let stderr = '';
          try {
            const result = await execFileAsync(command, options.args, {
              env: { ...process.env, ...env },
              timeout: timeoutMs,
              maxBuffer: MAX_OUTPUT_BYTES,
              windowsHide: true,
            });
            stdout = result.stdout;
            stderr = result.stderr;
          } catch (err) {
            // 有些 CLI 未登录时照样打印目录但以非 0 退出，输出仍可用。
            const failure = err as { stdout?: string; stderr?: string };
            if (!failure.stdout && !failure.stderr) throw err;
            stdout = failure.stdout || '';
            stderr = failure.stderr || '';
          }
          const parsed = options.parse(
            pickOutput(stream, stdout, stderr),
            fallbackModels,
          );
          if (parsed.length === 0) {
            throw new Error('CLI returned no models');
          }
          state.models = parsed;
          return parsed;
        } catch (err) {
          logger.warn(
            { runner: options.descriptor.id, command, err },
            'Failed to refresh runner model catalog; using fallback models',
          );
          state.models = state.models || fallbackModels;
          return state.models;
        }
      })().finally(() => {
        state.refreshInFlight = undefined;
      });
    }

    // force 是调用方明确要最新的，等刷新跑完再答。
    if (callOptions.force) return state.refreshInFlight;
    // 否则已经有一份结果就直接用，让刷新在后台跑完。
    if (state.models) return state.models;

    let budgetTimer: NodeJS.Timeout | undefined;
    const budget = new Promise<RunnerModel[]>((resolve) => {
      budgetTimer = setTimeout(
        () => resolve(modelsForDescriptor(options.descriptor, env)),
        firstCallBudgetMs,
      );
    });
    try {
      return await Promise.race([state.refreshInFlight, budget]);
    } finally {
      if (budgetTimer) clearTimeout(budgetTimer);
    }
  };
}
