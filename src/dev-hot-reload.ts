/**
 * Development-only hot reload for route modules.
 * Watches src/routes/ and src/middleware/ for .ts file changes,
 * then triggers a route rebuild without restarting the process.
 *
 * This keeps running agent processes alive — only HTTP route handlers
 * are swapped. WebSocket connections also survive.
 *
 * Only active when NODE_ENV !== 'production'.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEBOUNCE_MS = 500;

export function startRouteWatcher(onReload: () => Promise<void>): () => void {
  const routesDir = path.join(__dirname, 'routes');
  let debounceTimer: NodeJS.Timeout | null = null;
  const watchers: fs.FSWatcher[] = [];

  const onChange = (dir: string) => (_event: string, filename: string | null) => {
    if (!filename?.endsWith('.ts')) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      const relPath = path.join(path.basename(dir), filename!);
      logger.info({ file: relPath }, '[HMR] File changed, reloading routes...');
      try {
        await onReload();
        logger.info('[HMR] Routes reloaded successfully');
      } catch (err) {
        logger.error({ err }, '[HMR] Route reload failed');
      }
    }, DEBOUNCE_MS);
  };

  try {
    watchers.push(fs.watch(routesDir, onChange(routesDir)));
    logger.info('[HMR] Watching src/routes/ for changes');
  } catch (err) {
    logger.warn({ err }, '[HMR] Failed to watch routes directory');
  }

  // Also watch middleware (auth changes, etc.)
  const middlewareDir = path.join(__dirname, 'middleware');
  try {
    if (fs.existsSync(middlewareDir)) {
      watchers.push(fs.watch(middlewareDir, onChange(middlewareDir)));
      logger.info('[HMR] Watching src/middleware/ for changes');
    }
  } catch {
    // middleware dir might not exist, ignore
  }

  return () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    watchers.forEach((w) => w.close());
  };
}
