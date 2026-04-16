import type {
  RuntimeLaunchProfile,
  RuntimeOutput,
  RuntimeInput,
} from './runtime-runner.js';
import { runSessionAgent } from './session-launcher.js';
import type { MemoryProfile } from './memory-profile.js';

export class MemoryRunnerAdapter {
  run(
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
    return runSessionAgent(
      profile.registeredGroup,
      input,
      () => {},
      async (output) => {
        await onOutput(output);
      },
      ownerPrimarySessionFolder,
      launchProfile,
    );
  }
}
