import {
  buildRunnerHealth,
  modelsForDescriptor as resolveModelsForDescriptor,
} from '../runner-health.js';
import type { RunnerDescriptor, RunnerModel } from '../types.js';
import type { RunnerServerManifest } from './types.js';

export function modelsForDescriptor(
  descriptor: RunnerDescriptor,
): RunnerModel[] {
  return resolveModelsForDescriptor(descriptor);
}

export function createDescriptorBackedManifest(
  descriptor: RunnerDescriptor,
): RunnerServerManifest {
  return {
    descriptor,
    healthCheck: () => buildRunnerHealth(descriptor),
    listModels: () => modelsForDescriptor(descriptor),
    profileSchema: () => descriptor.profileSchema || null,
  };
}
