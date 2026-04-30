import {
  RUNNER_DESCRIPTORS,
  type RunnerDescriptor,
} from './runner-descriptor.types.js';

export const RUNNER_REGISTRY: Record<
  RunnerDescriptor['id'],
  RunnerDescriptor
> = RUNNER_DESCRIPTORS;

export function getRunnerDescriptor(id: string): RunnerDescriptor | undefined {
  return RUNNER_REGISTRY[id];
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

  for (const descriptor of listRunnerDescriptors()) {
    for (const pattern of descriptor.modelPatterns || []) {
      try {
        if (new RegExp(pattern, 'i').test(normalized)) {
          return descriptor.id;
        }
      } catch {
        if (normalized === pattern.toLowerCase()) {
          return descriptor.id;
        }
      }
    }
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
  if (!descriptor.capabilities.ephemeralSession) return false;
  if (!descriptor.capabilities.filesystemAccess) return false;
  if (descriptor.toolContract.mode === 'none') return false;
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
  const reasons = explainRunnerDegradation(descriptor);
  if (descriptor.capabilities.customTools !== 'mcp') {
    reasons.push('Memory Agent 需要通过 MCP 工具访问记忆能力');
  }
  if (!descriptor.capabilities.ephemeralSession) {
    reasons.push('Memory Agent 需要支持临时会话');
  }
  if (!descriptor.capabilities.filesystemAccess) {
    reasons.push('Memory Agent 需要文件系统访问能力');
  }
  return [...new Set(reasons)];
}
