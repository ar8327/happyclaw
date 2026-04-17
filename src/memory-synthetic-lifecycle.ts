import type { RuntimeExecutionHook, RunResult } from './runtime-request-executor.js';
import type { RuntimeOutput } from './runtime-runner.js';
import type { MessageCursor, RunnerDescriptor } from './types.js';

export type MemoryLifecycleStrategy = 'native' | 'synthetic' | 'unsupported';

interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD: number;
  durationMs: number;
  numTurns: number;
}

interface MemoryUsageEvent {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD: number;
  durationMs: number;
  numTurns: number;
}

export interface MemorySyntheticWrapupJob {
  workspaceFolder: string;
  transcriptFile: string;
  chatJids: string[];
  queuedAt: string;
  wrapupCursors: Record<string, MessageCursor>;
}

export interface MemorySyntheticRepairState {
  queuedAt: string;
  archivedFolders: string[];
  transcriptFiles: string[];
}

export interface MemorySyntheticLifecycleState {
  usageTotals: UsageTotals;
  pendingWrapupJobs: MemorySyntheticWrapupJob[];
  pendingRepair: MemorySyntheticRepairState | null;
  lastArchiveAt: string | null;
}

export interface MemorySyntheticArchiveCompletion {
  archivedFolders?: string[];
  transcriptFiles?: string[];
}

export type MemorySyntheticLifecycleFollowUp = {
  type: 'flush_synthetic_wrapups';
  jobs: MemorySyntheticWrapupJob[];
};

export interface MemorySyntheticLifecycleHookContext {
  requestType: string;
  syntheticLifecycleStrategy: MemoryLifecycleStrategy;
  syntheticState: MemorySyntheticLifecycleState;
  syntheticRepairPromptApplied: boolean;
  syntheticArchiveCompletion: MemorySyntheticRepairState | null;
  persistSyntheticState(): void;
  flushSyntheticWrapupJobs(
    jobs: MemorySyntheticWrapupJob[],
  ): Promise<MemorySyntheticWrapupJob[]>;
  buildSyntheticWrapupJobs(): MemorySyntheticWrapupJob[];
}

const ZERO_USAGE_TOTALS: UsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  costUSD: 0,
  durationMs: 0,
  numTurns: 0,
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function parseUsageTotals(value: unknown): UsageTotals {
  if (!value || typeof value !== 'object') {
    return { ...ZERO_USAGE_TOTALS };
  }
  const raw = value as Record<string, unknown>;
  return {
    inputTokens: isFiniteNumber(raw.inputTokens) ? raw.inputTokens : 0,
    outputTokens: isFiniteNumber(raw.outputTokens) ? raw.outputTokens : 0,
    cacheReadInputTokens: isFiniteNumber(raw.cacheReadInputTokens)
      ? raw.cacheReadInputTokens
      : 0,
    cacheCreationInputTokens: isFiniteNumber(raw.cacheCreationInputTokens)
      ? raw.cacheCreationInputTokens
      : 0,
    costUSD: isFiniteNumber(raw.costUSD) ? raw.costUSD : 0,
    durationMs: isFiniteNumber(raw.durationMs) ? raw.durationMs : 0,
    numTurns: isFiniteNumber(raw.numTurns) ? raw.numTurns : 0,
  };
}

function parseWrapupJob(value: unknown): MemorySyntheticWrapupJob | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.workspaceFolder !== 'string' ||
    !raw.workspaceFolder.trim() ||
    typeof raw.transcriptFile !== 'string' ||
    !raw.transcriptFile.trim()
  ) {
    return null;
  }
  return {
    workspaceFolder: raw.workspaceFolder,
    transcriptFile: raw.transcriptFile,
    chatJids: Array.isArray(raw.chatJids)
      ? raw.chatJids.filter(
          (jid): jid is string =>
            typeof jid === 'string' && jid.trim().length > 0,
        )
      : [],
    queuedAt:
      typeof raw.queuedAt === 'string' && raw.queuedAt.trim()
        ? raw.queuedAt
        : new Date().toISOString(),
    wrapupCursors:
      raw.wrapupCursors && typeof raw.wrapupCursors === 'object'
        ? Object.fromEntries(
            Object.entries(raw.wrapupCursors as Record<string, unknown>)
              .filter(
                (entry): entry is [string, { rowid: number }] => {
                  const cursor =
                    entry[1] && typeof entry[1] === 'object'
                      ? (entry[1] as { rowid?: unknown })
                      : null;
                  return (
                    !!entry[0] &&
                    !!cursor &&
                    typeof cursor.rowid === 'number' &&
                    Number.isFinite(cursor.rowid)
                  );
                },
              )
              .map(([jid, cursor]) => [jid, { rowid: cursor.rowid }]),
          )
        : {},
  };
}

function sanitizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is string =>
      typeof entry === 'string' && entry.trim().length > 0,
  );
}

function parseRepairState(value: unknown): MemorySyntheticRepairState | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const queuedAt =
    typeof raw.queuedAt === 'string' && raw.queuedAt.trim()
      ? raw.queuedAt
      : new Date().toISOString();
  return {
    queuedAt,
    archivedFolders: sanitizeStringList(raw.archivedFolders),
    transcriptFiles: sanitizeStringList(raw.transcriptFiles),
  };
}

export function getMemoryLifecycleStrategy(
  descriptor: RunnerDescriptor,
): MemoryLifecycleStrategy {
  if (descriptor.capabilities.customTools === 'none') return 'unsupported';
  if (
    descriptor.lifecycle.turnBoundary !== 'native' &&
    descriptor.lifecycle.turnBoundary !== 'simulated'
  ) {
    return 'unsupported';
  }
  if (descriptor.lifecycle.contextShrinkTrigger === 'none') {
    return 'unsupported';
  }
  if (
    descriptor.lifecycle.postCompactRepair === 'native' &&
    descriptor.lifecycle.archivalTrigger.includes('pre_compact')
  ) {
    return 'native';
  }
  if (
    descriptor.lifecycle.contextShrinkTrigger === 'synthetic' &&
    descriptor.lifecycle.archivalTrigger.includes('turn_threshold')
  ) {
    return 'synthetic';
  }
  if (
    descriptor.lifecycle.postCompactRepair === 'synthetic'
  ) {
    return 'synthetic';
  }
  return 'unsupported';
}

export function readMemorySyntheticLifecycleState(
  state: Record<string, unknown>,
): MemorySyntheticLifecycleState {
  const raw =
    state.syntheticLifecycle && typeof state.syntheticLifecycle === 'object'
      ? (state.syntheticLifecycle as Record<string, unknown>)
      : {};
  return {
    usageTotals: parseUsageTotals(raw.usageTotals),
    pendingWrapupJobs: Array.isArray(raw.pendingWrapupJobs)
      ? raw.pendingWrapupJobs
          .map(parseWrapupJob)
          .filter((job): job is MemorySyntheticWrapupJob => job !== null)
      : [],
    pendingRepair: parseRepairState(raw.pendingRepair),
    lastArchiveAt:
      typeof raw.lastArchiveAt === 'string' && raw.lastArchiveAt.trim()
        ? raw.lastArchiveAt
        : null,
  };
}

export function writeMemorySyntheticLifecycleState(
  state: Record<string, unknown>,
  synthetic: MemorySyntheticLifecycleState,
): Record<string, unknown> {
  return {
    ...state,
    syntheticLifecycle: {
      usageTotals: synthetic.usageTotals,
      pendingWrapupJobs: synthetic.pendingWrapupJobs,
      pendingRepair: synthetic.pendingRepair,
      lastArchiveAt: synthetic.lastArchiveAt,
    },
  };
}

export function accumulateMemorySyntheticUsage(
  synthetic: MemorySyntheticLifecycleState,
  usage: MemoryUsageEvent | undefined,
): MemorySyntheticLifecycleState {
  if (!usage) {
    return synthetic;
  }
  return {
    ...synthetic,
    usageTotals: {
      inputTokens: synthetic.usageTotals.inputTokens + usage.inputTokens,
      outputTokens: synthetic.usageTotals.outputTokens + usage.outputTokens,
      cacheReadInputTokens:
        synthetic.usageTotals.cacheReadInputTokens + usage.cacheReadInputTokens,
      cacheCreationInputTokens:
        synthetic.usageTotals.cacheCreationInputTokens +
        usage.cacheCreationInputTokens,
      costUSD: synthetic.usageTotals.costUSD + usage.costUSD,
      durationMs: synthetic.usageTotals.durationMs + usage.durationMs,
      numTurns: synthetic.usageTotals.numTurns + usage.numTurns,
    },
  };
}

export function noteMemorySyntheticCompactCompleted(
  synthetic: MemorySyntheticLifecycleState,
): MemorySyntheticLifecycleState {
  if (synthetic.pendingRepair) {
    return synthetic;
  }
  return {
    ...synthetic,
    pendingRepair: {
      queuedAt: new Date().toISOString(),
      archivedFolders: [],
      transcriptFiles: [],
    },
  };
}

export function noteMemorySyntheticArchiveCompleted(
  synthetic: MemorySyntheticLifecycleState,
  completion: MemorySyntheticArchiveCompletion,
): MemorySyntheticLifecycleState {
  const queuedAt = synthetic.pendingRepair?.queuedAt || new Date().toISOString();
  return {
    ...synthetic,
    usageTotals: { ...ZERO_USAGE_TOTALS },
    lastArchiveAt: new Date().toISOString(),
    pendingRepair: {
      queuedAt,
      archivedFolders: sanitizeStringList(completion.archivedFolders),
      transcriptFiles: sanitizeStringList(completion.transcriptFiles),
    },
  };
}

export function queueMemorySyntheticWrapupJobs(
  synthetic: MemorySyntheticLifecycleState,
  jobs: MemorySyntheticWrapupJob[],
): MemorySyntheticLifecycleState {
  if (jobs.length === 0) return synthetic;
  const seen = new Set(
    synthetic.pendingWrapupJobs.map(
      (job) => `${job.workspaceFolder}::${job.transcriptFile}`,
    ),
  );
  const appended = jobs.filter((job) => {
    const key = `${job.workspaceFolder}::${job.transcriptFile}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (appended.length === 0) return synthetic;
  return {
    ...synthetic,
    pendingWrapupJobs: [...synthetic.pendingWrapupJobs, ...appended],
  };
}

export function clearMemorySyntheticRepair(
  synthetic: MemorySyntheticLifecycleState,
): MemorySyntheticLifecycleState {
  if (!synthetic.pendingRepair) return synthetic;
  return {
    ...synthetic,
    pendingRepair: null,
  };
}

export function buildMemorySyntheticRepairPrompt(
  repair: MemorySyntheticRepairState,
): string {
  const folderLine =
    repair.archivedFolders.length > 0
      ? `- 上一轮 synthetic archive 已覆盖会话: ${repair.archivedFolders.join(', ')}`
      : '- 上一轮 synthetic archive 已完成';
  const transcriptLine =
    repair.transcriptFiles.length > 0
      ? `- 已落盘 transcript: ${repair.transcriptFiles.join(', ')}`
      : '- transcript 已完成落盘，请把磁盘文件视为真源';
  return [
    '[系统补提示] 你刚经历了一次平台模拟的上下文收缩。',
    folderLine,
    transcriptLine,
    '- 处理本次请求前，不要依赖被压缩前的对话上下文。',
    '- 请把 memory 根目录中的 index.md、meta.json、knowledge/、impressions/、transcripts/ 视为唯一真源，按需重新读取。',
    '- 如果本次请求涉及 session_wrapup 或 global_sleep，优先根据 transcriptFile 和磁盘现状继续，而不是凭上下文记忆补写。',
  ].join('\n');
}

export class SyntheticArchiveLifecycleHook<
  Context extends MemorySyntheticLifecycleHookContext,
> implements RuntimeExecutionHook<Context, MemorySyntheticLifecycleFollowUp> {
  readonly name = 'SyntheticArchiveLifecycleHook';

  private async flushPendingWrapups(ctx: Context): Promise<void> {
    if (ctx.syntheticState.pendingWrapupJobs.length === 0) {
      return;
    }
    const remaining = await ctx.flushSyntheticWrapupJobs(
      ctx.syntheticState.pendingWrapupJobs,
    );
    ctx.syntheticState = {
      ...ctx.syntheticState,
      pendingWrapupJobs: remaining,
    };
    ctx.persistSyntheticState();
  }

  async beforeRun(ctx: Context): Promise<{ promptPreamble?: string } | void> {
    if (ctx.syntheticLifecycleStrategy !== 'synthetic') {
      return;
    }
    if (ctx.requestType !== 'session_wrapup') {
      await this.flushPendingWrapups(ctx);
    }
    if (ctx.syntheticState.pendingWrapupJobs.length > 0) {
      return;
    }
    if (
      ctx.requestType !== 'session_wrapup' &&
      ctx.syntheticState.pendingRepair
    ) {
      ctx.syntheticRepairPromptApplied = true;
      return {
        promptPreamble: buildMemorySyntheticRepairPrompt(
          ctx.syntheticState.pendingRepair,
        ),
      };
    }
  }

  onOutput(ctx: Context, output: RuntimeOutput): void {
    if (ctx.syntheticLifecycleStrategy !== 'synthetic') {
      return;
    }
    let changed = false;
    if (
      output.status === 'stream' &&
      output.streamEvent?.eventType === 'usage' &&
      output.streamEvent.usage
    ) {
      ctx.syntheticState = accumulateMemorySyntheticUsage(
        ctx.syntheticState,
        output.streamEvent.usage,
      );
      changed = true;
    }
    if (
      output.status === 'stream' &&
      output.streamEvent?.eventType === 'lifecycle'
    ) {
      if (output.streamEvent.phase === 'compact_completed') {
        ctx.syntheticState = noteMemorySyntheticCompactCompleted(
          ctx.syntheticState,
        );
        changed = true;
      }
      if (output.streamEvent.phase === 'archive_completed') {
        ctx.syntheticArchiveCompletion = {
          queuedAt: new Date().toISOString(),
          archivedFolders: sanitizeStringList(output.streamEvent.archivedFolders),
          transcriptFiles: sanitizeStringList(output.streamEvent.transcriptFiles),
        };
        ctx.syntheticState = noteMemorySyntheticArchiveCompleted(
          ctx.syntheticState,
          ctx.syntheticArchiveCompletion,
        );
        changed = true;
      }
    }
    if (changed) {
      ctx.persistSyntheticState();
    }
  }

  afterRun(
    ctx: Context,
    result: RunResult<MemorySyntheticLifecycleFollowUp>,
  ): { followUps?: MemorySyntheticLifecycleFollowUp[] } | void {
    if (ctx.syntheticLifecycleStrategy !== 'synthetic') {
      return;
    }

    if (
      ctx.syntheticRepairPromptApplied &&
      !ctx.syntheticArchiveCompletion &&
      !result.error &&
      result.output?.status !== 'error'
    ) {
      ctx.syntheticState = clearMemorySyntheticRepair(ctx.syntheticState);
      ctx.persistSyntheticState();
    }

    if (!ctx.syntheticArchiveCompletion) {
      return;
    }

    const jobs = ctx.buildSyntheticWrapupJobs();
    ctx.syntheticState = queueMemorySyntheticWrapupJobs(
      ctx.syntheticState,
      jobs,
    );
    ctx.persistSyntheticState();

    if (jobs.length === 0) {
      return;
    }
    return {
      followUps: [
        {
          type: 'flush_synthetic_wrapups',
          jobs,
        },
      ],
    };
  }

  async onShutdown(ctx: Context): Promise<void> {
    if (ctx.syntheticLifecycleStrategy !== 'synthetic') {
      return;
    }
    await this.flushPendingWrapups(ctx);
  }
}
