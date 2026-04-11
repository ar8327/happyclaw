#!/usr/bin/env node

import { evaluateSafetyLite, runPreCompactHook } from './claude-hooks.js';

async function readStdin(): Promise<string> {
  return await new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  const rawInput = await readStdin();
  const input = rawInput.trim() ? JSON.parse(rawInput) as Record<string, unknown> : {};

  if (mode === 'precompact') {
    await runPreCompactHook(input, {
      isHome: process.env.HAPPYCLAW_IS_HOME === '1',
      isAdminHome: process.env.HAPPYCLAW_IS_ADMIN_HOME === '1',
      groupFolder: process.env.HAPPYCLAW_GROUP_FOLDER || 'default',
      userId: process.env.HAPPYCLAW_USER_ID || undefined,
    });
    return;
  }

  if (mode === 'safety-lite') {
    const result = evaluateSafetyLite(input);
    if (result.blocked && result.reason) {
      process.stderr.write(`${result.reason}\n`);
      process.exit(2);
    }
    return;
  }

  throw new Error(`Unknown hook handler mode: ${mode || '(missing)'}`);
}

main().catch((err) => {
  process.stderr.write(`[claude-hook-handler] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
