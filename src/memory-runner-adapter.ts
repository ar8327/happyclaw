import type {
  RuntimeLaunchProfile,
  RuntimeOutput,
  RuntimeInput,
} from './runtime-runner.js';
import { runSessionAgent } from './session-launcher.js';
import type { MemoryProfile } from './memory-profile.js';
import {
  getMemoryLifecycleStrategy,
} from './memory-synthetic-lifecycle.js';
import type { RunnerDescriptor } from './types.js';

export class MemoryRunnerAdapter {
  run(
    runnerDescriptor: RunnerDescriptor,
    profile: MemoryProfile,
    input: RuntimeInput,
    onOutput: (output: RuntimeOutput) => Promise<void> | void,
    ownerPrimarySessionFolder: string,
  ): Promise<RuntimeOutput> {
    const launchProfile: RuntimeLaunchProfile = {
      toolProfile: profile.toolProfile,
      additionalDirectories: profile.allowedDirectories,
      disableUserMcpServers: profile.disableUserMcpServers,
    };
    const lifecycleStrategy = getMemoryLifecycleStrategy(runnerDescriptor);
    if (lifecycleStrategy === 'unsupported') {
      throw new Error(
        `Runner "${runnerDescriptor.id}" cannot serve as memory runner`,
      );
    }
    const forwardOutput = async (output: RuntimeOutput) => {
      await onOutput(output);
    };
    switch (lifecycleStrategy) {
      case 'native':
        return runSessionAgent(
          profile.registeredGroup,
          input,
          () => {},
          forwardOutput,
          ownerPrimarySessionFolder,
          launchProfile,
        );
      case 'synthetic':
        return runSessionAgent(
          profile.registeredGroup,
          input,
          () => {},
          forwardOutput,
          ownerPrimarySessionFolder,
          launchProfile,
        );
      default:
        throw new Error(
          `Unsupported memory lifecycle strategy for runner "${runnerDescriptor.id}"`,
        );
    }
  }
}
