/**
 * Slash command handler — intercepts text commands (e.g. /clear) before they
 * enter the normal message pipeline.
 */
import crypto from 'crypto';
import {
  deleteSession,
  deleteContextSummary,
  getJidsByFolder,
  interruptNonTerminalTurnsForFolder,
  listSessionRecords,
  storeMessageDirect,
  ensureChatExists,
} from './db.js';
import { logger } from './logger.js';
import type { NewMessage, MessageCursor } from './types.js';
import {
  buildWorkerConversationJid,
  buildWorkerSessionId,
  isWorkerSessionId,
} from './worker-session.js';
import { clearSessionRuntimeFiles } from './runner-runtime-files.js';

// ─── Types ──────────────────────────────────────────────────────

export interface CommandDeps {
  queue: {
    stopSession(jid: string, opts?: { force?: boolean }): Promise<void>;
    discardSessionState(jid: string): void;
  };
  sessions: Record<string, string>;
  broadcast: (jid: string, msg: NewMessage & { is_from_me: boolean }) => void;
  setLastAgentTimestamp: (jid: string, cursor: MessageCursor) => void;
  discardTurnState?: (folder: string) => void;
}

function getWorkerRuntimeJidsForFolder(folder: string): string[] {
  const parentSessionId = `main:${folder}`;
  return Array.from(
    new Set(
      listSessionRecords()
        .filter(
          (session) =>
            session.parent_session_id === parentSessionId &&
            session.kind === 'worker' &&
            isWorkerSessionId(session.id),
        )
        .map((session) => session.id),
    ),
  );
}

// ─── Core reset ─────────────────────────────────────────────────

export async function executeSessionReset(
  chatJid: string,
  folder: string,
  deps: CommandDeps,
  agentId?: string,
): Promise<void> {
  const contextJids = agentId
    ? [buildWorkerConversationJid(chatJid, agentId)]
    : Array.from(new Set([...getJidsByFolder(folder), chatJid]));
  let runtimeJids: string[];
  if (agentId) {
    runtimeJids = [buildWorkerSessionId(agentId)];
  } else {
    // Main session reset: stop all processes for this folder
    const siblingJids = getJidsByFolder(folder);
    const workerRuntimeJids = getWorkerRuntimeJidsForFolder(folder);
    runtimeJids = Array.from(new Set([...siblingJids, ...workerRuntimeJids]));
  }
  await Promise.all(
    runtimeJids.map((jid) => deps.queue.stopSession(jid, { force: true })),
  );
  for (const runtimeJid of runtimeJids) {
    // A failure path can schedule a retry while its process is exiting. Drop
    // that idle scheduler state so it cannot restart the just-reset Session.
    deps.queue.discardSessionState(runtimeJid);
  }

  if (!agentId) {
    const interruptedTurns = interruptNonTerminalTurnsForFolder(folder);
    deps.discardTurnState?.(folder);
    if (interruptedTurns > 0) {
      logger.info(
        { chatJid, folder, interruptedTurns },
        'Session reset stopped unfinished turns from recovery',
      );
    }
  }

  // 2. Clear runner runtime files while preserving local config/auth files.
  clearSessionRuntimeFiles(folder, agentId);

  // 3. Delete session from DB (+ in-memory cache for main session)
  deleteSession(folder, agentId);
  for (const contextJid of contextJids) {
    deleteContextSummary(folder, contextJid);
  }
  if (!agentId) {
    delete deps.sessions[folder];
  }

  // 4. Insert context_reset divider message into the correct JID
  const targetJid = agentId
    ? buildWorkerConversationJid(chatJid, agentId)
    : chatJid;
  const dividerMessageId = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  ensureChatExists(targetJid);
  const dividerRowid = storeMessageDirect(
    dividerMessageId,
    targetJid,
    '__system__',
    'system',
    'context_reset',
    timestamp,
    true,
  );

  deps.broadcast(targetJid, {
    id: dividerMessageId,
    chat_jid: targetJid,
    sender: '__system__',
    sender_name: 'system',
    content: 'context_reset',
    timestamp,
    is_from_me: true,
  });

  // 5. Advance lastAgentTimestamp so old messages before the reset are not
  //    re-sent to the next fresh agent session.
  if (agentId) {
    deps.setLastAgentTimestamp(buildWorkerConversationJid(chatJid, agentId), {
      rowid: dividerRowid,
    });
  } else {
    const siblingJids = getJidsByFolder(folder);
    for (const siblingJid of siblingJids) {
      deps.setLastAgentTimestamp(siblingJid, { rowid: dividerRowid });
    }
  }

  logger.info({ chatJid, folder, agentId }, 'Session reset via /clear command');
}
