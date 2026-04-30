import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { listRunnerDescriptors } from './runner-registry.js';
import { logger } from './logger.js';

const PRESERVED_RUNTIME_CONFIG_FILES = new Set([
  'settings.json',
  'config.json',
  'auth.json',
]);

function getSessionBaseDir(folder: string, agentId?: string): string {
  return agentId
    ? path.join(DATA_DIR, 'sessions', folder, 'agents', agentId)
    : path.join(DATA_DIR, 'sessions', folder);
}

export function getSessionRuntimeDirs(
  folder: string,
  agentId?: string,
): string[] {
  const baseDir = getSessionBaseDir(folder, agentId);
  const names = new Set<string>([
    ...listRunnerDescriptors().map((descriptor) => `.${descriptor.id}`),
    // Legacy aliases kept so reset also cleans sessions created before the
    // runner registry became descriptor-driven.
    '.claude',
    '.codex',
  ]);
  return [...names].map((name) => path.join(baseDir, name));
}

export function clearSessionRuntimeFiles(
  folder: string,
  agentId?: string,
): void {
  for (const runtimeDir of getSessionRuntimeDirs(folder, agentId)) {
    if (!fs.existsSync(runtimeDir)) continue;
    try {
      for (const entry of fs.readdirSync(runtimeDir)) {
        if (PRESERVED_RUNTIME_CONFIG_FILES.has(entry)) continue;
        fs.rmSync(path.join(runtimeDir, entry), {
          recursive: true,
          force: true,
        });
      }
    } catch (err) {
      logger.warn(
        { folder, agentId, runtimeDir, err },
        'Failed to clear session runtime files',
      );
    }
  }
}
