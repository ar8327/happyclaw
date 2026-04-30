import { buildRunnerHealth } from '../runner-health.js';
import type { RunnerDescriptor, RunnerModel } from '../types.js';
import type { RunnerServerManifest } from './types.js';

export function modelsForDescriptor(
  descriptor: RunnerDescriptor,
): RunnerModel[] {
  if (descriptor.models && descriptor.models.length > 0) {
    return descriptor.models;
  }
  return descriptor.defaultModel
    ? [{ id: descriptor.defaultModel, label: descriptor.defaultModel }]
    : [];
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
