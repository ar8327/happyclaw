import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { RUNNER_DESCRIPTORS } from '../runner-descriptor.types.js';
import { createDescriptorBackedManifest } from './descriptor-manifest.js';
import type { RunnerServerManifest } from './types.js';

function isRunnerServerManifest(value: unknown): value is RunnerServerManifest {
  return (
    !!value &&
    typeof value === 'object' &&
    'descriptor' in value &&
    'healthCheck' in value &&
    'listModels' in value &&
    'profileSchema' in value
  );
}

function getExportedManifest(
  moduleExports: Record<string, unknown>,
): RunnerServerManifest | null {
  if (isRunnerServerManifest(moduleExports.default)) {
    return moduleExports.default;
  }
  for (const value of Object.values(moduleExports)) {
    if (isRunnerServerManifest(value)) return value;
  }
  return null;
}

async function discoverServerManifests(): Promise<RunnerServerManifest[]> {
  const runnersDir = path.dirname(fileURLToPath(import.meta.url));
  const entries = fs
    .readdirSync(runnersDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .sort((a, b) => a.name.localeCompare(b.name));
  const manifests: RunnerServerManifest[] = [];

  for (const entry of entries) {
    try {
      const moduleExports = (await import(
        `./${entry.name}/manifest.js`
      )) as Record<string, unknown>;
      const manifest = getExportedManifest(moduleExports);
      if (manifest) manifests.push(manifest);
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

function createServerManifestRegistry(
  manifests: RunnerServerManifest[],
): Record<string, RunnerServerManifest> {
  const registry: Record<string, RunnerServerManifest> = Object.fromEntries(
    Object.values(RUNNER_DESCRIPTORS).map((descriptor) => [
      descriptor.id,
      createDescriptorBackedManifest(descriptor),
    ]),
  );
  const overrideIds = new Set<string>();
  for (const manifest of manifests) {
    const id = manifest.descriptor.id;
    if (overrideIds.has(id)) {
      throw new Error(`Duplicate runner server manifest id "${id}"`);
    }
    const descriptor = RUNNER_DESCRIPTORS[id];
    if (!descriptor) {
      throw new Error(
        `Runner server manifest "${id}" has no shared descriptor`,
      );
    }
    if (JSON.stringify(manifest.descriptor) !== JSON.stringify(descriptor)) {
      throw new Error(
        `Runner server manifest "${id}" descriptor is out of sync`,
      );
    }
    overrideIds.add(id);
    registry[id] = manifest;
  }
  return registry;
}

export const RUNNER_SERVER_MANIFESTS: Record<string, RunnerServerManifest> =
  createServerManifestRegistry(await discoverServerManifests());

export function listRunnerServerManifests(): RunnerServerManifest[] {
  return Object.values(RUNNER_SERVER_MANIFESTS);
}

export function getRunnerServerManifest(
  id: string,
): RunnerServerManifest | undefined {
  return RUNNER_SERVER_MANIFESTS[id];
}
