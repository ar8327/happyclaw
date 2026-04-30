import type { RunnerDescriptor, RunnerHealth, RunnerModel } from '../types.js';

export interface RunnerServerManifest {
  descriptor: RunnerDescriptor;
  healthCheck(): Promise<RunnerHealth>;
  listModels(): RunnerModel[] | Promise<RunnerModel[]>;
  profileSchema(): Record<string, unknown> | null;
}
