import { ChildProcess, spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import type { RuntimePaths } from './paths.js';

export interface BackendHandle {
  process: ChildProcess;
  port: number;
  baseUrl: string;
  stop: () => Promise<void>;
}

function resolveDesktopPath(currentPath?: string): string {
  const homeDir = os.homedir();
  const candidates = [
    ...(currentPath || '').split(path.delimiter),
    path.join(homeDir, '.local', 'bin'),
    path.join(homeDir, 'bin'),
    path.join(homeDir, '.cargo', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ];
  return [
    ...new Set(candidates.filter((entry) => entry && fs.existsSync(entry))),
  ].join(path.delimiter);
}

/**
 * Start the AgentDock backend as a child process.
 *
 * Dev mode: run via `tsx src/index.ts` for instant iteration.
 * Packaged: run the pre-compiled `backend/index.js` with plain node.
 *
 * Port is communicated via the AgentDock backend printing a known marker
 * to stdout: `[agentdock] listening on http://127.0.0.1:<port>`
 */
export async function startBackend(
  paths: RuntimePaths,
  port: number,
  onLog: (line: string) => void = () => {},
): Promise<BackendHandle> {
  const {
    projectRoot,
    backendEntry,
    dataDir,
    containerDir,
    logsDir,
    portFile,
    devMode,
  } = paths;

  // Ensure data subdirs exist so the backend doesn't have to race with us
  for (const d of ['db', 'groups', 'config', 'sessions', 'skills']) {
    const p = path.join(dataDir, d);
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // Tell AgentDock to write data/logs into the app-managed folders
    DATA_DIR: dataDir,
    WEB_PORT: String(port),
    WEB_HOST: '127.0.0.1',
    PATH: resolveDesktopPath(process.env.PATH),
    // Enables the backend readiness marker consumed by this wrapper.
    AGENTDOCK_DESKTOP_MODE: '1',
    // Runner + skill discovery paths (used by runner-catalog & session-launcher)
    CONTAINER_DIR: containerDir,
    // Path resolution inside src/config.ts relies on cwd for mount-allowlist.json lookup
  };

  let cmd: string;
  const args: string[] = [];
  const cwd = projectRoot;

  if (devMode) {
    // Use the host Node in dev so native modules match the repo install.
    cmd = process.env.npm_node_execpath || process.env.NODE || 'node';
    const tsxPath = path.join(
      projectRoot,
      'node_modules',
      'tsx',
      'dist',
      'cli.mjs',
    );
    args.push(tsxPath, backendEntry);
  } else {
    // Electron's process.execPath is the app binary; this makes it run the
    // backend script with Node semantics instead of launching another app.
    env.ELECTRON_RUN_AS_NODE = '1';
    cmd = process.execPath;
    args.push(backendEntry);
  }

  const child = spawn(cmd, args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  // Write port file for debugging
  fs.writeFileSync(paths.portFile, String(port), 'utf-8');

  // Log tee
  const logFile = path.join(
    logsDir,
    `backend-${new Date().toISOString().slice(0, 10)}.log`,
  );
  const logFd = fs.openSync(logFile, 'a');
  const tee = (data: Buffer) => {
    const text = data.toString('utf-8');
    fs.writeSync(logFd, text);
    text.split(/\r?\n/).filter(Boolean).forEach(onLog);
  };
  child.stdout?.on('data', tee);
  child.stderr?.on('data', tee);

  child.on('close', () => {
    try {
      fs.closeSync(logFd);
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(portFile);
    } catch {
      /* ignore */
    }
  });

  // Wait until we can confirm the server is listening
  const portPromise = new Promise<number>((resolve, reject) => {
    const marker = /\[agentdock\]\s+listening\s+on\s+https?:\/\/[^\s:]+:(\d+)/i;
    const fallbackPort = port;
    let settled = false;
    let readyTimeout: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (readyTimeout) clearTimeout(readyTimeout);
      child.stdout?.off('data', stdoutListener);
      child.off('error', errorListener);
      child.off('exit', exitListener);
    };

    const resolveOnce = (value: number) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    const rejectOnce = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const stdoutListener = (data: Buffer) => {
      const txt = data.toString('utf-8');
      const m = txt.match(marker);
      if (m) resolveOnce(parseInt(m[1], 10) || fallbackPort);
    };

    const errorListener = (err: Error) => {
      rejectOnce(err);
    };

    const exitListener = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ) => {
      const status =
        code === null ? `signal ${signal || 'unknown'}` : `exit code ${code}`;
      rejectOnce(
        new Error(`AgentDock backend exited before it was ready (${status})`),
      );
    };

    child.stdout?.on('data', stdoutListener);
    child.once('error', errorListener);
    child.once('exit', exitListener);
    // Safety net: assume port after 15s if backend still alive and never prints marker
    readyTimeout = setTimeout(() => {
      if (!settled && !child.killed && child.exitCode === null) {
        resolveOnce(fallbackPort);
      }
    }, 15_000);
  });

  const resolvedPort = await portPromise;

  const stop = async (): Promise<void> => {
    return new Promise((resolve) => {
      if (!child || child.exitCode !== null) return resolve();
      let resolved = false;
      const done = () => {
        if (!resolved) {
          resolved = true;
          resolve();
        }
      };
      child.once('exit', done);
      // Send SIGINT first (graceful), then SIGTERM fallback
      child.kill('SIGINT');
      setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGTERM');
      }, 4_000);
      setTimeout(done, 10_000);
    });
  };

  return {
    process: child,
    port: resolvedPort,
    baseUrl: `http://127.0.0.1:${resolvedPort}`,
    stop,
  };
}
