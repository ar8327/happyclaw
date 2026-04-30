import type { AgentRunner } from '../runner-interface.js';
import type { SessionState } from '../session-state.js';
import type { ContainerInput, ContainerOutput } from '../types.js';
import type {
  RunnerDescriptor,
  RunnerHealth,
  RunnerModel,
} from '../runner-descriptor.types.js';
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

export type OneShotInvokeInput = {
  prompt: string;
  cwd: string;
  model?: string;
  thinkingEffort?: string;
  timeoutMs: number;
  maxTurns?: number;
};

export interface OneShotInvoker {
  runnerId: string;
  label: string;
  description?: string;
  defaultModel?: string;
  models?: string[];
  invoke(input: OneShotInvokeInput): Promise<string>;
}

export interface RunnerManifest {
  descriptor: RunnerDescriptor;
  production?: boolean;
  createRunner(ctx: RunnerFactoryContext): AgentRunner | Promise<AgentRunner>;
  healthCheck?(ctx: RunnerHealthContext): Promise<RunnerHealth>;
  listModels?(ctx: RunnerHealthContext): Promise<RunnerModel[]>;
  createOneShotInvoker?(ctx: RunnerHealthContext): OneShotInvoker | null;
}
