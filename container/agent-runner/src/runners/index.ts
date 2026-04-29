import { claudeManifest } from './claude/manifest.js';
import { codexManifest } from './codex/manifest.js';
import type { RunnerManifest } from './types.js';

export const RUNNER_MANIFESTS: Record<string, RunnerManifest> = {
  [claudeManifest.descriptor.id]: claudeManifest,
  [codexManifest.descriptor.id]: codexManifest,
};

export function listRunnerManifests(): RunnerManifest[] {
  return Object.values(RUNNER_MANIFESTS);
}

export function getRunnerManifest(id: string): RunnerManifest | undefined {
  return RUNNER_MANIFESTS[id];
}

export function getSupportedRunnerIds(): string[] {
  return Object.keys(RUNNER_MANIFESTS);
}
