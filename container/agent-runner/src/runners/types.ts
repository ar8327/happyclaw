import type { AgentRunner } from '../runner-interface.js';
import type { SessionState } from '../session-state.js';
import type { ContainerInput, ContainerOutput } from '../types.js';
import type { RunnerDescriptor, RunnerHealth, RunnerModel } from '../runner-descriptor.types.js';
import type { IpcPaths } from '../ipc-handler.js';

export type RunnerFactoryContext = {
  containerInput: ContainerInput;
  state: SessionState;
  ipcPaths: IpcPaths;
  log: (message: string) => void;
  writeOutput: (output: ContainerOutput) => void;
  imChannelsFile: string;
  groupDir: string;
  globalDir: string;
  memoryDir: string;
  thinkingEffort?: string;
  loadUserMcpServers: () => Record<string, unknown>;
  skillsDir: string;
  disableSyntheticArchive: boolean;
};

export type RunnerHealthContext = {
  env: NodeJS.ProcessEnv;
  cwd: string;
};

export interface RunnerManifest {
  descriptor: RunnerDescriptor;
  createRunner(ctx: RunnerFactoryContext): AgentRunner;
  healthCheck?(ctx: RunnerHealthContext): Promise<RunnerHealth>;
  listModels?(ctx: RunnerHealthContext): Promise<RunnerModel[]>;
}
