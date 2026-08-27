#!/usr/bin/env node

/**
 * grok 的 PreToolUse hook 入口。
 *
 * grok 的 hook 载荷用 camelCase 键、事件名是 snake_case（`pre_tool_use`），
 * 而 happyclaw 的 safety-lite 规则是按 Claude Code 的 snake_case 键 +
 * PascalCase 事件名写的。这里做一次键名归一，规则本身完全复用。
 *
 * 阻断语义与 Claude Code 一致（实测）：stderr 写原因 + exit 2，工具不会执行，
 * 模型侧收到 `Hook denied: <stderr>` 的 tool_result。
 */

import { evaluateSafetyLite } from '../claude/hooks.js';
import { GROK_SHELL_TOOL, toClaudeToolName } from './tool-names.js';

interface GrokHookInput {
  hookEventName?: string;
  sessionId?: string;
  transcriptPath?: string;
  toolName?: string;
  toolInput?: unknown;
}

async function readStdin(): Promise<string> {
  return await new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

/** grok 载荷 → Claude Code 载荷。工具名同时归一，safety-lite 才认得出 Bash。 */
export function toClaudeHookInput(input: GrokHookInput): {
  hook_event_name?: 'PreToolUse';
  session_id?: string;
  transcript_path?: string;
  tool_name?: string;
  tool_input?: unknown;
} {
  return {
    hook_event_name:
      input.hookEventName === 'pre_tool_use' ||
      input.hookEventName === 'PreToolUse'
        ? 'PreToolUse'
        : undefined,
    session_id: input.sessionId,
    transcript_path: input.transcriptPath,
    tool_name:
      input.toolName === GROK_SHELL_TOOL
        ? 'Bash'
        : toClaudeToolName(input.toolName),
    tool_input: input.toolInput,
  };
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  const rawInput = await readStdin();
  const input = rawInput.trim()
    ? (JSON.parse(rawInput) as GrokHookInput)
    : ({} as GrokHookInput);

  if (mode === 'safety-lite') {
    const result = evaluateSafetyLite(toClaudeHookInput(input));
    if (result.blocked && result.reason) {
      process.stderr.write(`${result.reason}\n`);
      process.exit(2);
    }
    process.stdout.write('{}');
    return;
  }

  throw new Error(`Unknown hook handler mode: ${mode || '(missing)'}`);
}

main().catch((err) => {
  process.stderr.write(
    `[grok-hook-handler] ${err instanceof Error ? err.message : String(err)}\n`,
  );
  // exit 1 是 hook 自身出错：grok 会把它当作 hook error 提示，但不阻断工具。
  process.exit(1);
});
