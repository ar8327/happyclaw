import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { app } from 'electron';

/**
 * Resolve the "project root" for AgentDock backend depending on context.
 *
 *   Dev  (npm run dev:desktop in repo root):
 *     projectRoot  = <repo>
 *     backendEntry = <repo>/src/index.ts (tsx)
 *     dataDir      = <repo>/data
 *
 *   Packaged (.app):
 *     projectRoot  = process.resourcesPath
 *     backendEntry = <resources>/backend/index.js  (pre-compiled)
 *     dataDir      = ~/Library/Application Support/AgentDock/data
 */
export interface RuntimePaths {
  projectRoot: string;
  backendEntry: string;
  dataDir: string;
  containerDir: string;
  configDir: string;
  webDistDir: string;
  logsDir: string;
  portFile: string;
  devMode: boolean;
}

export function resolveRuntimePaths(): RuntimePaths {
  const isPackaged = app.isPackaged;
  const devMode = !isPackaged;

  let projectRoot: string;
  let backendEntry: string;
  let containerDir: string;
  let configDir: string;
  let webDistDir: string;

  if (devMode) {
    // Repo root is two levels up from the compiled output:
    //   dist/main/paths.js → desktop/ (tsconfig `rootDir: .` → `outDir: dist`)
    // → hence __dirname/../.. resolves to <repo>/desktop. Repo root is one more up.
    projectRoot = path.resolve(__dirname, '..', '..', '..');
    backendEntry = path.join(projectRoot, 'src', 'index.ts');
    containerDir = path.join(projectRoot, 'container');
    configDir = path.join(projectRoot, 'config');
    webDistDir = path.join(projectRoot, 'web', 'dist');
  } else {
    projectRoot = process.resourcesPath;
    backendEntry = path.join(projectRoot, 'backend', 'index.js');
    containerDir = path.join(projectRoot, 'container');
    configDir = path.join(projectRoot, 'config');
    webDistDir = path.join(projectRoot, 'web', 'dist');
  }

  const userDataDir = app.getPath('userData');
  const logsDir = app.getPath('logs');
  const dataDir = process.env.AGENTDOCK_DATA_DIR
    ? path.resolve(process.env.AGENTDOCK_DATA_DIR)
    : devMode
      ? path.join(projectRoot, 'data')
      : path.join(userDataDir, 'data');
  const portFile = path.join(userDataDir, 'port');

  for (const d of [dataDir, logsDir, userDataDir]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }

  return {
    projectRoot,
    backendEntry,
    dataDir,
    containerDir,
    configDir,
    webDistDir,
    logsDir,
    portFile,
    devMode,
  };
}

/**
 * Test if a TCP port is available on localhost.
 */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const net = require('node:net') as typeof import('node:net');
    const srv = net.createServer();
    srv.unref();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => {
      srv.close(() => resolve(true));
    });
  });
}

/**
 * Find a free TCP port starting from `start`.
 */
export async function findFreePort(
  start = 3000,
  maxTries = 50,
): Promise<number> {
  for (let i = 0; i < maxTries; i++) {
    const p = start + i;
    if (await isPortFree(p)) return p;
  }
  // fallback: let OS pick one
  return new Promise((resolve, reject) => {
    const net = require('node:net') as typeof import('node:net');
    const srv = net.createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as import('node:net').AddressInfo;
      srv.close(() => resolve(addr.port));
    });
  });
}
