import type { RunnerDescriptor } from './types.js';

export const RUNNER_REGISTRY: Record<RunnerDescriptor['id'], RunnerDescriptor> = {
  claude: {
    id: 'claude',
    label: 'Claude',
    capabilities: {
      sessionResume: 'strong',
      interrupt: 'strong',
      imageInput: true,
      usage: 'exact',
      midQueryPush: false,
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
      memory: 'full',
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
      memory: 'synthetic',
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

export function canServeAsMemoryRunner(descriptor: RunnerDescriptor): boolean {
  if (descriptor.compatibility.memory === 'unsupported') return false;
  if (descriptor.capabilities.customTools === 'none') return false;
  if (
    descriptor.lifecycle.turnBoundary !== 'native' &&
    descriptor.lifecycle.turnBoundary !== 'simulated'
  ) {
    return false;
  }
  return descriptor.lifecycle.archivalTrigger.length > 0;
}

export function explainRunnerDegradation(
  descriptor: RunnerDescriptor,
): string[] {
  const reasons: string[] = [];
  if (descriptor.compatibility.memory === 'synthetic') {
    reasons.push('memory 依赖 synthetic lifecycle，而不是 runner 原生 compact hook');
  }
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
