/**
 * Safety Lite — lightweight PreToolUse hook for host mode only.
 *
 * Replaces the deleted GPT gatekeeper with simple regex pattern matching.
 * Only enabled when HAPPYCLAW_HOST_MODE=1 (no Docker isolation).
 *
 * Known limitations: does not catch variable expansion, command substitution,
 * eval/source indirection, or alias wrapping. This is a "speed bump", not
 * a security boundary — the real boundary is Docker or OS permissions.
 */

import type {
  HookCallback,
  PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';

const DANGEROUS_PATTERNS = [
  /rm\s+-rf\s+\/(?!tmp|workspace)/, // rm -rf / (excluding safe paths)
  /DROP\s+(DATABASE|TABLE)\s/i, // DROP DATABASE/TABLE
  />\s*\/dev\/sd/, // write to raw device
  /mkfs\./, // format filesystem
  /:\(\)\{ :\|:& \};:/, // fork bomb (escaped (){}|)
];

export function createSafetyLiteHook(): HookCallback {
  return async (input, _toolUseID, _options) => {
    const hookInput = input as PreToolUseHookInput;
    if (hookInput.hook_event_name !== 'PreToolUse') return {};
    if (hookInput.tool_name !== 'Bash') return {};
    const cmd =
      typeof hookInput.tool_input === 'object' &&
      hookInput.tool_input !== null &&
      'command' in hookInput.tool_input &&
      typeof (hookInput.tool_input as Record<string, unknown>).command ===
        'string'
        ? (hookInput.tool_input as Record<string, unknown>).command as string
        : '';
    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(cmd)) {
        return {
          decision: 'block' as const,
          reason: `Safety-lite blocked: ${pattern}`,
        };
      }
    }
    return {};
  };
}
