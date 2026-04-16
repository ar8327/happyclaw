import { getSystemSettings } from './runtime-config.js';
import type { RuntimeOutput } from './runtime-runner.js';
import type { RunnerDescriptor } from './types.js';

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

export interface MemorySyntheticWrapupJob {
  workspaceFolder: string;
  transcriptFile: string;
  chatJids: string[];
  queuedAt: string;
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
      ? raw.chatJids.filter((jid): jid is string => typeof jid === 'string' && jid.trim().length > 0)
      : [],
    queuedAt:
      typeof raw.queuedAt === 'string' && raw.queuedAt.trim()
        ? raw.queuedAt
        : new Date().toISOString(),
  };
}

function parseRepairState(value: unknown): MemorySyntheticRepairState | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const archivedFolders = Array.isArray(raw.archivedFolders)
    ? raw.archivedFolders.filter(
        (folder): folder is string =>
          typeof folder === 'string' && folder.trim().length > 0,
      )
    : [];
  const transcriptFiles = Array.isArray(raw.transcriptFiles)
    ? raw.transcriptFiles.filter(
        (file): file is string => typeof file === 'string' && file.trim().length > 0,
      )
    : [];
  const queuedAt =
    typeof raw.queuedAt === 'string' && raw.queuedAt.trim()
      ? raw.queuedAt
      : new Date().toISOString();
  if (!queuedAt) {
    return null;
  }
  return {
    queuedAt,
    archivedFolders,
    transcriptFiles,
  };
}

export function getMemoryLifecycleStrategy(
  descriptor: RunnerDescriptor,
): MemoryLifecycleStrategy {
  if (descriptor.compatibility.memory === 'unsupported') return 'unsupported';
  if (descriptor.capabilities.customTools === 'none') return 'unsupported';
  if (
    descriptor.lifecycle.turnBoundary !== 'native' &&
    descriptor.lifecycle.turnBoundary !== 'simulated'
  ) {
    return 'unsupported';
  }
  if (descriptor.lifecycle.archivalTrigger.length === 0) return 'unsupported';
  if (
    descriptor.lifecycle.postCompactRepair === 'native' &&
    descriptor.lifecycle.archivalTrigger.includes('pre_compact')
  ) {
    return 'native';
  }
  if (
    descriptor.lifecycle.postCompactRepair === 'synthetic' ||
    !descriptor.lifecycle.archivalTrigger.includes('pre_compact')
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

function totalTokens(usage: UsageTotals): number {
  return usage.inputTokens + usage.outputTokens;
}

export function getMemorySyntheticArchiveThreshold(): number {
  return Math.max(getSystemSettings().codexArchiveThreshold, 120000);
}

export function consumeMemorySyntheticUsage(
  synthetic: MemorySyntheticLifecycleState,
  output: RuntimeOutput,
): {
  synthetic: MemorySyntheticLifecycleState;
  crossedThreshold: boolean;
  totalTokens: number;
} {
  const usage =
    output.status === 'stream' && output.streamEvent?.eventType === 'usage'
      ? output.streamEvent.usage
      : undefined;
  if (!usage) {
    return {
      synthetic,
      crossedThreshold: false,
      totalTokens: totalTokens(synthetic.usageTotals),
    };
  }
  const previousTotal = totalTokens(synthetic.usageTotals);
  const nextTotals: UsageTotals = {
    inputTokens: synthetic.usageTotals.inputTokens + usage.inputTokens,
    outputTokens: synthetic.usageTotals.outputTokens + usage.outputTokens,
    cacheReadInputTokens:
      synthetic.usageTotals.cacheReadInputTokens + usage.cacheReadInputTokens,
    cacheCreationInputTokens:
      synthetic.usageTotals.cacheCreationInputTokens + usage.cacheCreationInputTokens,
    costUSD: synthetic.usageTotals.costUSD + usage.costUSD,
    durationMs: synthetic.usageTotals.durationMs + usage.durationMs,
    numTurns: synthetic.usageTotals.numTurns + usage.numTurns,
  };
  const nextState = {
    ...synthetic,
    usageTotals: nextTotals,
  };
  const nextTotal = totalTokens(nextTotals);
  return {
    synthetic: nextState,
    crossedThreshold:
      previousTotal < getMemorySyntheticArchiveThreshold() &&
      nextTotal >= getMemorySyntheticArchiveThreshold(),
    totalTokens: nextTotal,
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

export function resetMemorySyntheticUsage(
  synthetic: MemorySyntheticLifecycleState,
  archivedJobs: MemorySyntheticWrapupJob[],
): MemorySyntheticLifecycleState {
  const now = new Date().toISOString();
  return {
    ...synthetic,
    usageTotals: { ...ZERO_USAGE_TOTALS },
    lastArchiveAt: now,
    pendingRepair: {
      queuedAt: now,
      archivedFolders: Array.from(
        new Set(archivedJobs.map((job) => job.workspaceFolder)),
      ),
      transcriptFiles: archivedJobs.map((job) => job.transcriptFile),
    },
  };
}

export function drainMemorySyntheticWrapupJobs(
  synthetic: MemorySyntheticLifecycleState,
): {
  synthetic: MemorySyntheticLifecycleState;
  jobs: MemorySyntheticWrapupJob[];
} {
  return {
    synthetic: {
      ...synthetic,
      pendingWrapupJobs: [],
    },
    jobs: synthetic.pendingWrapupJobs,
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
