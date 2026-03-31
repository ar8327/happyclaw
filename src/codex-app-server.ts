/**
 * Codex App-Server client — spawns `codex app-server` to query account rate limits.
 *
 * Protocol: JSONL over stdio (one JSON object per line, NOT Content-Length framing).
 * Lifecycle: spawn → initialize handshake → query → kill.
 */

import { spawn, type ChildProcess } from 'child_process';
import readline from 'readline';

import { logger } from './logger.js';

// ─── Types ─────────────────────────────────────────────────

export interface RateLimitWindow {
  usedPercent: number;
  windowDurationMins: number;
  resetsAt: number; // unix seconds
}

export interface RateLimitCredits {
  hasCredits: boolean;
  unlimited: boolean;
  balance: string;
}

export interface RateLimitSnapshot {
  limitId: string | null;
  limitName: string | null;
  planType: string | null;
  primary: RateLimitWindow | null;
  secondary: RateLimitWindow | null;
  credits: RateLimitCredits | null;
}

export interface CodexRateLimitsResult {
  rateLimits: RateLimitSnapshot;
  rateLimitsByLimitId: Record<string, RateLimitSnapshot> | null;
}

// ─── Cache ─────────────────────────────────────────────────

const CACHE_TTL_MS = 30_000;
let cache: { data: CodexRateLimitsResult; expiresAt: number } | null = null;

// Shared in-flight promise to avoid concurrent spawns
let inflightPromise: Promise<CodexRateLimitsResult> | null = null;

// ─── Implementation ────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 15_000;

interface JsonRpcResponse {
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

function sendJsonRpc(proc: ChildProcess, method: string, params: unknown, id: number): void {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} });
  proc.stdin!.write(msg + '\n');
}

async function doQuery(): Promise<CodexRateLimitsResult> {
  return new Promise<CodexRateLimitsResult>((resolve, reject) => {
    const proc = spawn('codex', ['app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let settled = false;
    const finish = (err: Error | null, data?: CodexRateLimitsResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { proc.kill('SIGTERM'); } catch { /* ignore */ }
      // Safety: force kill after 2s if still alive
      const killTimer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      }, 2000);
      proc.once('exit', () => clearTimeout(killTimer));
      if (err) reject(err);
      else resolve(data!);
    };

    const timer = setTimeout(() => {
      finish(new Error('Codex app-server request timed out'));
    }, REQUEST_TIMEOUT_MS);

    proc.once('error', (err) => {
      finish(new Error(`Failed to spawn codex app-server: ${err.message}`));
    });

    proc.once('exit', (code) => {
      finish(new Error(`codex app-server exited unexpectedly (code ${code})`));
    });

    // Capture stderr for debugging
    proc.stderr?.on('data', () => { /* discard app-server diagnostic output */ });

    // Parse JSONL responses
    const rl = readline.createInterface({ input: proc.stdout! });
    const responses = new Map<number, JsonRpcResponse>();

    rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        const msg = JSON.parse(line);
        // Skip notifications (no id)
        if (msg.id === undefined || msg.id === null) return;
        responses.set(msg.id, msg as JsonRpcResponse);
        onResponse();
      } catch {
        // Skip unparseable lines
      }
    });

    let phase: 'init' | 'query' = 'init';

    function onResponse() {
      if (phase === 'init' && responses.has(1)) {
        // Initialize succeeded, send rate limits query
        phase = 'query';
        sendJsonRpc(proc, 'account/rateLimits/read', {}, 2);
      } else if (phase === 'query' && responses.has(2)) {
        const resp = responses.get(2)!;
        if (resp.error) {
          finish(new Error(`account/rateLimits/read error: ${resp.error.message}`));
        } else {
          finish(null, resp.result as CodexRateLimitsResult);
        }
      }
    }

    // Kick off: send initialize
    sendJsonRpc(proc, 'initialize', {
      clientInfo: { name: 'happyclaw', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    }, 1);
  });
}

// ─── Public API ────────────────────────────────────────────

/**
 * Query Codex account rate limits via the app-server protocol.
 *
 * Results are cached for 30 seconds. Pass `force: true` to bypass cache.
 * Concurrent calls share a single in-flight request.
 */
export async function queryCodexRateLimits(force = false): Promise<CodexRateLimitsResult> {
  // Return cached if fresh
  if (!force && cache && Date.now() < cache.expiresAt) {
    return cache.data;
  }

  // Share in-flight request
  if (inflightPromise) return inflightPromise;

  inflightPromise = doQuery()
    .then((data) => {
      cache = { data, expiresAt: Date.now() + CACHE_TTL_MS };
      return data;
    })
    .finally(() => {
      inflightPromise = null;
    });

  return inflightPromise;
}
