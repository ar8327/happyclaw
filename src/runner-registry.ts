import type { RunnerDescriptor } from './types.js';

const CLAUDE_MODEL_ALIASES = new Set(['opus', 'sonnet', 'haiku']);

export const RUNNER_REGISTRY: Record<RunnerDescriptor['id'], RunnerDescriptor> = {
  claude: {
    id: 'claude',
    label: 'Claude',
    capabilities: {
      sessionResume: 'strong',
      interrupt: 'strong',
      imageInput: true,
      usage: 'exact',
      midQueryPush: true,
      runtimeModeSwitch: false,
      toolStreaming: 'fine',
      backgroundTasks: true,
      subAgent: 'tool-only',
      customTools: 'mcp',
      mcpTransport: ['stdio'],
      skills: ['native', 'tool-loader'],
    },
    lifecycle: {
      turnBoundary: 'native',
      archivalTrigger: ['pre_compact'],
      contextShrinkTrigger: 'native_event',
      beforeToolExecutionGuard: 'native_hook',
      hookStreaming: 'progress',
      postCompactRepair: 'native',
    },
    promptContract: {
      mode: 'append',
      dynamicContextReload: 'turn',
    },
    compatibility: {
      chat: 'full',
      im: 'full',
      observability: 'full',
    },
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    capabilities: {
      sessionResume: 'weak',
      interrupt: 'weak',
      imageInput: true,
      usage: 'approx',
      midQueryPush: false,
      runtimeModeSwitch: false,
      toolStreaming: 'coarse',
      backgroundTasks: false,
      subAgent: 'tool-only',
      customTools: 'mcp',
      mcpTransport: ['stdio'],
      skills: ['tool-loader'],
    },
    lifecycle: {
      turnBoundary: 'native',
      archivalTrigger: ['turn_threshold', 'cleanup_only'],
      contextShrinkTrigger: 'synthetic',
      beforeToolExecutionGuard: 'sandbox_only',
      hookStreaming: 'none',
      postCompactRepair: 'synthetic',
    },
    promptContract: {
      mode: 'instructions_file',
      dynamicContextReload: 'turn',
    },
    compatibility: {
      chat: 'full',
      im: 'degraded',
      observability: 'degraded',
    },
  },
};

export function getRunnerDescriptor(id: string): RunnerDescriptor | undefined {
  return RUNNER_REGISTRY[id as keyof typeof RUNNER_REGISTRY];
}

export function listRunnerDescriptors(): RunnerDescriptor[] {
  return Object.values(RUNNER_REGISTRY);
}

export function getDefaultRunnerDescriptor(): RunnerDescriptor | undefined {
  return listRunnerDescriptors()[0];
}

export function getDefaultRunnerId(): RunnerDescriptor['id'] {
  return getDefaultRunnerDescriptor()?.id || 'claude';
}

export function inferRunnerIdFromModel(
  model: string | null | undefined,
): RunnerDescriptor['id'] | null {
  const normalized = model?.trim().toLowerCase();
  if (!normalized) return null;

  if (CLAUDE_MODEL_ALIASES.has(normalized) || normalized.startsWith('claude-')) {
    return 'claude';
  }

  if (/^gpt-[a-z0-9._-]+$/i.test(normalized)) {
    return 'codex';
  }

  if (/^o[1-9](?:$|[-._])/.test(normalized)) {
    return 'codex';
  }

  return null;
}

export function isModelCompatibleWithRunner(
  runnerId: RunnerDescriptor['id'],
  model: string | null | undefined,
): boolean {
  const inferredRunnerId = inferRunnerIdFromModel(model);
  return !inferredRunnerId || inferredRunnerId === runnerId;
}

export function canServeAsMemoryRunner(descriptor: RunnerDescriptor): boolean {
  if (descriptor.capabilities.customTools === 'none') return false;
  return (
    descriptor.lifecycle.turnBoundary === 'native' ||
    descriptor.lifecycle.turnBoundary === 'simulated'
  );
}

export function listMemoryRunnerDescriptors(): RunnerDescriptor[] {
  return listRunnerDescriptors().filter((descriptor) =>
    canServeAsMemoryRunner(descriptor),
  );
}

export function getDefaultMemoryRunnerDescriptor(
  preferredId?: RunnerDescriptor['id'] | null,
): RunnerDescriptor | undefined {
  const preferred =
    preferredId && getRunnerDescriptor(preferredId)
      ? getRunnerDescriptor(preferredId)
      : undefined;
  if (preferred && canServeAsMemoryRunner(preferred)) {
    return preferred;
  }
  return listMemoryRunnerDescriptors()[0] || getDefaultRunnerDescriptor();
}

export function getDefaultMemoryRunnerId(
  preferredId?: RunnerDescriptor['id'] | null,
): RunnerDescriptor['id'] {
  return getDefaultMemoryRunnerDescriptor(preferredId)?.id || getDefaultRunnerId();
}

export function resolveMemoryRunnerId(
  candidateId?: RunnerDescriptor['id'] | null,
): RunnerDescriptor['id'] {
  const candidate =
    candidateId && getRunnerDescriptor(candidateId)
      ? getRunnerDescriptor(candidateId)
      : undefined;
  if (candidate && canServeAsMemoryRunner(candidate)) {
    return candidate.id;
  }
  return getDefaultMemoryRunnerId(candidateId);
}

export function explainRunnerDegradation(
  descriptor: RunnerDescriptor,
): string[] {
  const reasons: string[] = [];
  if (descriptor.capabilities.toolStreaming === 'coarse') {
    reasons.push('工具流式事件只有粗粒度观测');
  }
  if (descriptor.lifecycle.hookStreaming === 'none') {
    reasons.push('前端无法看到 hook 生命周期事件');
  }
  if (descriptor.capabilities.sessionResume !== 'strong') {
    reasons.push('会话恢复强度不是 strong，恢复后的连续性较弱');
  }
  return reasons;
}

export function explainMemoryRunnerDegradation(
  descriptor: RunnerDescriptor,
): string[] {
  const reasons: string[] = [];
  if (descriptor.capabilities.toolStreaming === 'coarse') {
    reasons.push('工具流式事件只有粗粒度观测');
  }
  if (descriptor.lifecycle.hookStreaming === 'none') {
    reasons.push('前端无法看到 hook 生命周期事件');
  }
  return reasons;
}
