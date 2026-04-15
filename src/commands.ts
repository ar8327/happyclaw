/**
 * Slash command handler — intercepts text commands (e.g. /clear) before they
 * enter the normal message pipeline.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  deleteSession,
  getJidsByFolder,
  listSessionRecords,
  storeMessageDirect,
  ensureChatExists,
} from './db.js';
import { DATA_DIR } from './config.js';
import { logger } from './logger.js';
import type { NewMessage, MessageCursor } from './types.js';
import {
  buildWorkerConversationJid,
  buildWorkerSessionId,
  isWorkerSessionId,
} from './worker-session.js';

// ─── Types ──────────────────────────────────────────────────────

export interface CommandDeps {
  queue: {
    stopSession(jid: string, opts?: { force?: boolean }): Promise<void>;
  };
  sessions: Record<string, string>;
  broadcast: (jid: string, msg: NewMessage & { is_from_me: boolean }) => void;
  setLastAgentTimestamp: (jid: string, cursor: MessageCursor) => void;
}

// ─── Session file cleanup (mirrors groups.ts clearSessionJsonlFiles) ────

function clearSessionFiles(folder: string, agentId?: string): void {
  const claudeDir = agentId
    ? path.join(DATA_DIR, 'sessions', folder, 'agents', agentId, '.claude')
    : path.join(DATA_DIR, 'sessions', folder, '.claude');
  if (!fs.existsSync(claudeDir)) return;

  const keep = new Set(['settings.json']);
  const entries = fs.readdirSync(claudeDir);
  for (const entry of entries) {
    if (keep.has(entry)) continue;
    try {
      fs.rmSync(path.join(claudeDir, entry), { recursive: true, force: true });
    } catch (err) {
      logger.warn(
        { entry, folder, agentId, err },
        'Failed to remove session file, skipping',
      );
    }
  }
}

function getWorkerRuntimeJidsForFolder(folder: string): string[] {
  const parentSessionId = `main:${folder}`;
  return Array.from(
    new Set(
      listSessionRecords()
        .filter(
          (session) =>
            session.parent_session_id === parentSessionId
            && session.kind === 'worker'
            && isWorkerSessionId(session.id),
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
  if (agentId) {
    await deps.queue.stopSession(buildWorkerSessionId(agentId), { force: true });
  } else {
    // Main session reset: stop all processes for this folder
    const siblingJids = getJidsByFolder(folder);
    const workerRuntimeJids = getWorkerRuntimeJidsForFolder(folder);
    await Promise.all(
      [...siblingJids, ...workerRuntimeJids].map((j) =>
        deps.queue.stopSession(j, { force: true })
      ),
    );
  }

  // 2. Clear .claude/ session files (preserve settings.json)
  clearSessionFiles(folder, agentId);

  // 3. Delete session from DB (+ in-memory cache for main session)
  deleteSession(folder, agentId);
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
