/**
 * IPC handler functions extracted from index.ts.
 * Handles sentinel file checks, IPC message draining, and idle message waiting.
 */

import fs from 'fs';
import path from 'path';
import type { ContainerOutput } from './types.js';
import type { SessionState } from './session-state.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LogFn = (message: string) => void;
export type WriteOutputFn = (output: ContainerOutput) => void;

export interface IpcMessage {
  text: string;
  images?: Array<{ data: string; mimeType?: string }>;
  ackTargets?: string[];
  ackSourceChannels?: string[];
}

/**
 * Drain result: parsed messages plus optional mode change instruction.
 */
export interface IpcDrainResult {
  messages: IpcMessage[];
  modeChange?: string; // 'plan' | 'bypassPermissions'
}

/**
 * Resolved IPC directory paths — derived once from WORKSPACE_IPC.
 */
export interface IpcPaths {
  inputDir: string;
  closeSentinel: string;
  drainSentinel: string;
  interruptSentinel: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const IPC_POLL_MS = 500;

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const normalized = value.filter(
    (item): item is string => typeof item === 'string' && item.length > 0,
  );
  return normalized.length > 0 ? [...new Set(normalized)] : undefined;
}

function extractAckSourceChannels(text: string): string[] | undefined {
  const sources = [...text.matchAll(/source="([^"]+)"/g)]
    .map((match) => match[1])
    .filter(Boolean);
  return sources.length > 0 ? [...new Set(sources)] : undefined;
}

export function buildIpcAckStreamEvent(
  sessionRecordId: string,
  messageOrMessages: IpcMessage | IpcMessage[],
): NonNullable<ContainerOutput['streamEvent']> {
  const messages = Array.isArray(messageOrMessages)
    ? messageOrMessages
    : [messageOrMessages];
  const ipcAckTargets = normalizeStringArray(
    messages.flatMap((message) => message.ackTargets || []),
  );
  const ipcAckSources = normalizeStringArray(
    messages.flatMap((message) => message.ackSourceChannels || []),
  );
  return {
    eventType: 'status',
    statusText: 'ipc_message_received',
    ipcAckSessionId: sessionRecordId,
    ipcAckTargets,
    ipcAckSources,
    ipcAckMessageCount: messages.length,
  };
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

export function buildIpcPaths(workspaceIpc: string): IpcPaths {
  const inputDir = path.join(workspaceIpc, 'input');
  return {
    inputDir,
    closeSentinel: path.join(inputDir, '_close'),
    drainSentinel: path.join(inputDir, '_drain'),
    interruptSentinel: path.join(inputDir, '_interrupt'),
  };
}

// ---------------------------------------------------------------------------
// Sentinel checks
// ---------------------------------------------------------------------------

/**
 * Check for _close sentinel.
 */
export function shouldClose(paths: IpcPaths): boolean {
  if (fs.existsSync(paths.closeSentinel)) {
    try { fs.unlinkSync(paths.closeSentinel); } catch { /* ignore */ }
    return true;
  }
  return false;
}

/**
 * Check for _drain sentinel.
 * Unlike _close (immediate exit), _drain means "finish current query then exit".
 */
export function shouldDrain(paths: IpcPaths): boolean {
  if (fs.existsSync(paths.drainSentinel)) {
    try { fs.unlinkSync(paths.drainSentinel); } catch { /* ignore */ }
    return true;
  }
  return false;
}

/**
 * Check for _interrupt sentinel (graceful query interruption).
 */
export function shouldInterrupt(paths: IpcPaths): boolean {
  if (fs.existsSync(paths.interruptSentinel)) {
    try { fs.unlinkSync(paths.interruptSentinel); } catch { /* ignore */ }
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

export function isInterruptRelatedError(err: unknown): boolean {
  const errno = err as NodeJS.ErrnoException;
  const message = err instanceof Error ? err.message : String(err ?? '');
  return errno?.code === 'ABORT_ERR'
    || /abort|aborted|interrupt|interrupted|cancelled|canceled/i.test(message);
}

// ---------------------------------------------------------------------------
// IPC message drain
// ---------------------------------------------------------------------------

/**
 * Drain all pending IPC input messages.
 * Returns messages found (with optional images), or empty array.
 */
export function drainIpcInput(paths: IpcPaths, log: LogFn): IpcDrainResult {
  const result: IpcDrainResult = { messages: [] };
  try {
    const files = fs.readdirSync(paths.inputDir)
      .filter(f => f.endsWith('.json'))
      .sort();

    for (const file of files) {
      const filePath = path.join(paths.inputDir, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && typeof data.text === 'string' && data.text.length > 0) {
          result.messages.push({
            text: data.text,
            images: data.images,
            ackTargets: normalizeStringArray(data.ackTargets),
            ackSourceChannels:
              normalizeStringArray(data.ackSourceChannels)
              || normalizeStringArray(data.sourceChannels)
              || extractAckSourceChannels(data.text),
          });
        } else if (data.type === 'set_mode' && data.mode) {
          result.modeChange = data.mode;
        }
      } catch (err) {
        log(`Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`);
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Wait for next IPC message (idle polling)
// ---------------------------------------------------------------------------

/**
 * Wait for a new IPC message or _close sentinel.
 * Returns the messages (with optional images), or null if _close.
 */
export function waitForIpcMessage(
  paths: IpcPaths,
  log: LogFn,
  writeOutput: WriteOutputFn,
  state: SessionState,
  imChannelsFile: string,
  sessionRecordId: string,
  onDrain?: () => Promise<void> | void,
): Promise<IpcMessage | null> {
  return new Promise((resolve) => {
    let pollCount = 0;
    const HEARTBEAT_INTERVAL = 120; // Log every ~60 seconds (120 polls * 500ms)
    const poll = () => {
      pollCount++;
      if (shouldClose(paths)) {
        resolve(null);
        return;
      }
      if (shouldDrain(paths)) {
        log('Drain sentinel received while idle, exiting for turn boundary');
        Promise.resolve(onDrain?.())
          .catch((err) => {
            log(
              `Idle drain cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          })
          .finally(() => {
            writeOutput({ status: 'drained', result: null });
            // Must self-exit: unlike _close (host sends SIGTERM), _drain expects
            // the process to terminate. SDK/MCP resources keep the event loop alive.
            process.exit(0);
          });
        return;
      }
      if (shouldInterrupt(paths)) {
        log('Interrupt sentinel received while idle, ignoring');
        state.clearInterruptRequested();
      }
      // Periodic heartbeat to detect stuck polling
      if (pollCount % HEARTBEAT_INTERVAL === 0) {
        try {
          const files = fs.readdirSync(paths.inputDir);
          log(`Idle heartbeat: ${Math.round(pollCount * IPC_POLL_MS / 1000)}s waiting, IPC dir has ${files.length} files: [${files.join(', ')}]`);
        } catch {
          log(`Idle heartbeat: ${Math.round(pollCount * IPC_POLL_MS / 1000)}s waiting, IPC dir read failed`);
        }
      }
      const { messages, modeChange } = drainIpcInput(paths, log);
      if (modeChange) {
        state.currentPermissionMode = modeChange;
        log(`Mode change during idle: ${modeChange}`);
      }
      if (messages.length > 0) {
        // 合并多条消息的文本和图片
        const combinedText = messages.map((m) => m.text).join('\n');
        const allImages = messages.flatMap((m) => m.images || []);
        // Track IM channels for post-compaction routing reminder
        state.extractSourceChannels(combinedText, imChannelsFile);
        log(`Idle IPC pickup: ${messages.length} message(s), ${combinedText.length} chars`);
        // Emit one acknowledgement per IPC message file so host-side counts stay balanced.
        for (const message of messages) {
          writeOutput({
            status: 'stream',
            result: null,
            streamEvent: buildIpcAckStreamEvent(sessionRecordId, message),
          });
        }
        resolve({
          text: combinedText,
          images: allImages.length > 0 ? allImages : undefined,
          ackTargets: normalizeStringArray(
            messages.flatMap((message) => message.ackTargets || []),
          ),
          ackSourceChannels: normalizeStringArray(
            messages.flatMap((message) => message.ackSourceChannels || []),
          ),
        });
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}
