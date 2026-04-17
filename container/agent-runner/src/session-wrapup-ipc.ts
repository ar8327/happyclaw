import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { writeIpcFile } from 'happyclaw-agent-runner-core';

const WORKSPACE_IPC = process.env.HAPPYCLAW_WORKSPACE_IPC || '/workspace/ipc';
const TASKS_DIR = path.join(WORKSPACE_IPC, 'tasks');
const RESPONSES_DIR = path.join(WORKSPACE_IPC, 'responses');
const RESPONSE_POLL_MS = 200;
const STALE_RESPONSE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WRAPUP_TIMEOUT_MS = parseInt(
  process.env.HAPPYCLAW_MEMORY_SEND_TIMEOUT || '120000',
  10,
);

export interface SessionWrapupTask {
  workspaceFolder: string;
  groupFolder?: string;
  userId: string;
  archiveConversation?: boolean;
}

export interface SessionWrapupResponse {
  type: 'session_wrapup_result';
  requestId: string;
  success: boolean;
  error?: string;
  transcriptFile?: string;
  workspaceFolder?: string;
  chatJids?: string[];
  conversationArchiveFile?: string;
  noNewMessages?: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseWrapupResponse(filePath: string): SessionWrapupResponse | null {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<
      string,
      unknown
    >;
    if (
      raw.type !== 'session_wrapup_result' ||
      typeof raw.requestId !== 'string' ||
      typeof raw.success !== 'boolean'
    ) {
      return null;
    }
    return {
      type: 'session_wrapup_result',
      requestId: raw.requestId,
      success: raw.success,
      error: typeof raw.error === 'string' ? raw.error : undefined,
      transcriptFile:
        typeof raw.transcriptFile === 'string' ? raw.transcriptFile : undefined,
      workspaceFolder:
        typeof raw.workspaceFolder === 'string'
          ? raw.workspaceFolder
          : undefined,
      chatJids: Array.isArray(raw.chatJids)
        ? raw.chatJids.filter(
            (jid): jid is string =>
              typeof jid === 'string' && jid.trim().length > 0,
          )
        : undefined,
      conversationArchiveFile:
        typeof raw.conversationArchiveFile === 'string'
          ? raw.conversationArchiveFile
          : undefined,
      noNewMessages: raw.noNewMessages === true,
    };
  } catch {
    return null;
  }
}

function maybeDeleteStaleResponse(filePath: string, now: number): void {
  try {
    const stat = fs.statSync(filePath);
    if (now - stat.mtimeMs < STALE_RESPONSE_TTL_MS) return;
    fs.unlinkSync(filePath);
  } catch {
    /* ignore */
  }
}

export function enqueueSessionWrapupTask(
  task: SessionWrapupTask & { requestId?: string },
): string {
  const requestId = task.requestId || crypto.randomUUID();
  writeIpcFile(TASKS_DIR, {
    type: 'session_wrapup',
    requestId,
    timestamp: new Date().toISOString(),
    ...task,
  });
  return requestId;
}

export async function waitForSessionWrapupResponse(
  requestId: string,
  timeoutMs = DEFAULT_WRAPUP_TIMEOUT_MS,
): Promise<SessionWrapupResponse> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    try {
      if (fs.existsSync(RESPONSES_DIR)) {
        const now = Date.now();
        const files = fs
          .readdirSync(RESPONSES_DIR)
          .filter((file) => file.endsWith('.json'))
          .sort();
        for (const file of files) {
          const filePath = path.join(RESPONSES_DIR, file);
          const response = parseWrapupResponse(filePath);
          if (!response || response.requestId !== requestId) {
            maybeDeleteStaleResponse(filePath, now);
            continue;
          }
          try {
            fs.unlinkSync(filePath);
          } catch {
            /* ignore */
          }
          return response;
        }
      }
    } catch {
      /* ignore */
    }

    await sleep(RESPONSE_POLL_MS);
  }

  return {
    type: 'session_wrapup_result',
    requestId,
    success: false,
    error: `Timed out after ${timeoutMs}ms waiting for session_wrapup`,
  };
}
