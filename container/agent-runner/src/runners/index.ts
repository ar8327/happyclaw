import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { RUNNER_DESCRIPTORS } from '../runner-descriptor.types.js';
import type { RunnerManifest } from './types.js';

function isRunnerManifest(value: unknown): value is RunnerManifest {
  return (
    !!value &&
    typeof value === 'object' &&
    'descriptor' in value &&
    'createRunner' in value
  );
}

function getExportedManifest(moduleExports: Record<string, unknown>) {
  if (isRunnerManifest(moduleExports.default)) return moduleExports.default;
  for (const value of Object.values(moduleExports)) {
    if (isRunnerManifest(value)) return value;
  }
  return null;
}

async function discoverRunnerManifests(): Promise<RunnerManifest[]> {
  const runnersDir = path.dirname(fileURLToPath(import.meta.url));
  const entries = fs
    .readdirSync(runnersDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .sort((a, b) => a.name.localeCompare(b.name));
  const manifests: RunnerManifest[] = [];

  for (const entry of entries) {
    try {
      const moduleExports = (await import(
        `./${entry.name}/manifest.js`
      )) as Record<string, unknown>;
      const manifest = getExportedManifest(moduleExports);
      if (manifest && manifest.production !== false) {
        manifests.push(manifest);
      }
    } catch (err) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === 'ERR_MODULE_NOT_FOUND' || error.code === 'ENOENT') {
        continue;
      }
      throw err;
    }
  }

  return manifests;
}

function createRunnerManifestRegistry(
  manifests: RunnerManifest[],
): Record<string, RunnerManifest> {
  const registry: Record<string, RunnerManifest> = {};
  for (const manifest of manifests) {
    const id = manifest.descriptor.id;
    if (registry[id]) {
      throw new Error(`Duplicate runner manifest id "${id}"`);
    }
    const descriptor = RUNNER_DESCRIPTORS[id];
    if (!descriptor) {
      throw new Error(`Runner manifest "${id}" has no shared descriptor`);
    }
    if (JSON.stringify(manifest.descriptor) !== JSON.stringify(descriptor)) {
      throw new Error(`Runner manifest "${id}" descriptor is out of sync`);
    }
    registry[id] = manifest;
  }
  return registry;
}

export const RUNNER_MANIFESTS: Record<string, RunnerManifest> =
  createRunnerManifestRegistry(await discoverRunnerManifests());

export function listRunnerManifests(): RunnerManifest[] {
  return Object.values(RUNNER_MANIFESTS);
}

export function getRunnerManifest(id: string): RunnerManifest | undefined {
  return RUNNER_MANIFESTS[id];
}

export function getSupportedRunnerIds(): string[] {
  return Object.keys(RUNNER_MANIFESTS);
}
