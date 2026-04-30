import {
  canServeAsMemoryRunner,
  explainRunnerDegradation,
} from './runner-registry.js';
import {
  getRunnerServerManifest,
  listRunnerServerManifests,
} from './runners/index.js';
import { modelsForDescriptor } from './runners/descriptor-manifest.js';
import type { RunnerDescriptor } from './types.js';

export { getRunnerServerManifest, listRunnerServerManifests };

export function serializeRunnerDescriptor(descriptor: RunnerDescriptor) {
  return {
    id: descriptor.id,
    label: descriptor.label,
    description: descriptor.description,
    default_model: descriptor.defaultModel,
    model_patterns: descriptor.modelPatterns || [],
    capabilities: descriptor.capabilities,
    lifecycle: descriptor.lifecycle,
    prompt_contract: descriptor.promptContract,
    runtime_contract: descriptor.runtimeContract,
    tool_contract: descriptor.toolContract,
    profile_schema: descriptor.profileSchema || null,
    models: modelsForDescriptor(descriptor),
    compatibility: descriptor.compatibility,
    can_serve_memory: canServeAsMemoryRunner(descriptor),
    degradation_reasons: explainRunnerDegradation(descriptor),
  };
}
