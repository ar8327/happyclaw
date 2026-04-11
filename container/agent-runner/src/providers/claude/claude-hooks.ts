import fs from 'fs';
import path from 'path';
import type { SessionsIndex, ParsedMessage } from '../../types.js';
import { sanitizeFilename, generateFallbackName } from '../../utils.js';
import { writeIpcFile } from 'happyclaw-agent-runner-core';

// ---------------------------------------------------------------------------
// Transcript Archival (PreCompact hook)
// ---------------------------------------------------------------------------

// Mirror the workspace path resolution from index.ts
const WORKSPACE_GROUP = process.env.HAPPYCLAW_WORKSPACE_GROUP || '/workspace/group';
const WORKSPACE_IPC = process.env.HAPPYCLAW_WORKSPACE_IPC || '/workspace/ipc';

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

function getSessionSummary(sessionId: string, transcriptPath: string): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) {
    log(`Sessions index not found at ${indexPath}`);
    return null;
  }

  try {
    const index: SessionsIndex = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    const entry = index.entries.find(e => e.sessionId === sessionId);
    if (entry?.summary) {
      return entry.summary;
    }
  } catch (err) {
    log(`Failed to read sessions index: ${err instanceof Error ? err.message : String(err)}`);
  }

  return null;
}

export async function runPreCompactHook(
  input: PreCompactHookInput,
  options: {
    isHome: boolean;
    isAdminHome: boolean;
    groupFolder: string;
    userId?: string;
  },
): Promise<void> {
  const transcriptPath = input.transcript_path;
  const sessionId = input.session_id;

  if (!transcriptPath || !sessionId || !fs.existsSync(transcriptPath)) {
    log('No transcript found for archiving');
    return;
  }

  try {
    const content = fs.readFileSync(transcriptPath, 'utf-8');
    const messages = parseTranscript(content);

    if (messages.length === 0) {
      log('No messages to archive');
      return;
    }

    const summary = getSessionSummary(sessionId, transcriptPath);
    const name = summary ? sanitizeFilename(summary) : generateFallbackName();

    const conversationsDir = path.join(WORKSPACE_GROUP, 'conversations');
    fs.mkdirSync(conversationsDir, { recursive: true });

    const date = new Date().toISOString().split('T')[0];
    const filename = `${date}-${name}.md`;
    const filePath = path.join(conversationsDir, filename);

    const markdown = formatTranscriptMarkdown(messages, summary);
    fs.writeFileSync(filePath, markdown);

    log(`Archived conversation to ${filePath}`);

    if (options.isHome && options.userId) {
      const tasksDir = path.join(WORKSPACE_IPC, 'tasks');
      writeIpcFile(tasksDir, {
        type: 'session_wrapup',
        groupFolder: options.groupFolder,
        userId: options.userId,
        timestamp: new Date().toISOString(),
      });
      log(`Sent session_wrapup IPC signal for ${options.groupFolder}`);
    }
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

export function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text = typeof entry.message.content === 'string'
          ? entry.message.content
          : entry.message.content.map((c: { text?: string }) => c.text || '').join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
    }
  }

  return messages;
}

export function formatTranscriptMarkdown(messages: ParsedMessage[], title?: string | null): string {
  const now = new Date();
  const formatDateTime = (d: Date) => d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : 'HappyClaw';
    const content = msg.content.length > 2000
      ? msg.content.slice(0, 2000) + '...'
      : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
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
