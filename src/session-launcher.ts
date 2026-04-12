import type { ChildProcess } from 'child_process';

import {
  type AvailableGroup,
  type RuntimeInput,
  type RuntimeOutput,
  type ContainerInput,
  type ContainerOutput,
  runLocalAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './runtime-runner.js';
import type { RegisteredGroup } from './types.js';

export type {
  AvailableGroup,
  RuntimeInput,
  RuntimeOutput,
  ContainerInput,
  ContainerOutput,
};
export { writeGroupsSnapshot, writeTasksSnapshot };

export async function runLocalSessionRuntime(
  session: RegisteredGroup,
  input: RuntimeInput,
  onProcess: (proc: ChildProcess, identifier: string) => void,
  onOutput?: (output: RuntimeOutput) => Promise<void>,
  ownerHomeFolder?: string,
): Promise<RuntimeOutput> {
  return runLocalAgent(session, input, onProcess, onOutput, ownerHomeFolder);
}

export async function runSessionAgent(
  session: RegisteredGroup,
  input: RuntimeInput,
  onProcess: (proc: ChildProcess, identifier: string) => void,
  onOutput?: (output: RuntimeOutput) => Promise<void>,
  ownerHomeFolder?: string,
): Promise<RuntimeOutput> {
  return runLocalSessionRuntime(
    session,
    input,
    onProcess,
    onOutput,
    ownerHomeFolder,
  );
}
