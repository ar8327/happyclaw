import {
  enqueueSessionWrapupTask,
  waitForSessionWrapupResponse,
} from '../../session-wrapup-ipc.js';

// ---------------------------------------------------------------------------
// Transcript Archival (PreCompact hook)
// ---------------------------------------------------------------------------

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

interface HookInputBase {
  session_id?: string;
  transcript_path?: string;
}

interface PreCompactHookInput extends HookInputBase {
  hook_event_name?: 'PreCompact';
}

interface PreToolUseHookInput extends HookInputBase {
  hook_event_name?: 'PreToolUse';
  tool_name?: string;
  tool_input?: unknown;
}

export async function runPreCompactHook(
  _input: PreCompactHookInput,
  options: {
    isHome: boolean;
    isAdminHome: boolean;
    groupFolder: string;
    userId?: string;
  },
): Promise<void> {
  if (!options.userId) {
    log(`Skipping session_wrapup for ${options.groupFolder}: missing userId`);
    return;
  }

  try {
    const requestId = enqueueSessionWrapupTask({
      workspaceFolder: options.groupFolder,
      groupFolder: options.groupFolder,
      userId: options.userId,
      archiveConversation: true,
    });
    log(`Sent session_wrapup request ${requestId} for ${options.groupFolder}`);
    const response = await waitForSessionWrapupResponse(requestId);
    if (!response.success) {
      log(
        `session_wrapup failed for ${options.groupFolder}: ${response.error || 'unknown error'}`,
      );
      return;
    }
    log(
      `session_wrapup completed for ${options.groupFolder}${response.conversationArchiveFile ? ` -> ${response.conversationArchiveFile}` : ''}`,
    );
  } catch (err) {
    log(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Archive the full transcript to conversations/ before compaction.
 */
export function createPreCompactHook(
  isHome: boolean,
  isAdminHome: boolean,
  groupFolder: string,
  userId?: string,
): (input: PreCompactHookInput) => Promise<Record<string, never>> {
  return async (input) => {
    await runPreCompactHook(input, { isHome, isAdminHome, groupFolder, userId });
    return {};
  };
}

// ---------------------------------------------------------------------------
// Safety Lite (PreToolUse hook — host mode only)
// ---------------------------------------------------------------------------

const DANGEROUS_PATTERNS = [
  /rm\s+-rf\s+\/(?!tmp|workspace)/, // rm -rf / (excluding safe paths)
  /DROP\s+(DATABASE|TABLE)\s/i, // DROP DATABASE/TABLE
  />\s*\/dev\/sd/, // write to raw device
  /mkfs\./, // format filesystem
  /:\(\)\{ :\|:& \};:/, // fork bomb (escaped (){}|)
];

export function evaluateSafetyLite(input: PreToolUseHookInput): { blocked: boolean; reason?: string } {
  if (input.hook_event_name !== 'PreToolUse') return { blocked: false };
  if (input.tool_name !== 'Bash') return { blocked: false };
  const cmd =
    typeof input.tool_input === 'object' &&
    input.tool_input !== null &&
    'command' in input.tool_input &&
    typeof (input.tool_input as Record<string, unknown>).command === 'string'
      ? (input.tool_input as Record<string, unknown>).command as string
      : '';
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(cmd)) {
      return {
        blocked: true,
        reason: `Safety-lite blocked: ${pattern}`,
      };
    }
  }
  return { blocked: false };
}

export function createSafetyLiteHook(): (input: PreToolUseHookInput) => Promise<Record<string, unknown> | {
  decision: 'block';
  reason: string;
}> {
  return async (input) => {
    const result = evaluateSafetyLite(input);
    if (!result.blocked || !result.reason) return {};
    return {
      decision: 'block',
      reason: result.reason,
    };
  };
}
