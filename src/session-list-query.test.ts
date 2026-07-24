import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const originalCwd = process.cwd();
const fixtureRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happyclaw-session-list-'),
);
process.chdir(fixtureRoot);

try {
  const database = await import(`./db.js?session-list-test=${Date.now()}`);
  database.initDatabase();
  try {
    const chatJids = Array.from({ length: 405 }, (_, index) => `web:${index}`);
    for (const [index, chatJid] of chatJids.entries()) {
      database.ensureChatExists(chatJid);
      database.storeMessageDirect(
        `message-${index}`,
        chatJid,
        'user',
        'User',
        `latest-${index}`,
        new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
        false,
      );
    }

    database.storeMessageDirect(
      'same-time-newer-row',
      chatJids[0],
      'assistant',
      'Assistant',
      'same-time-winner',
      new Date(Date.UTC(2026, 0, 1, 0, 0, 0)).toISOString(),
      true,
    );
    database.ensureChatExists('web:empty');

    const latest = database.getLatestMessagesForChats([
      ...chatJids,
      chatJids[0],
      'web:empty',
    ]);
    type LatestMessage = {
      chat_jid: string;
      content: string;
      timestamp: string;
    };
    const byJid = new Map<string, LatestMessage>(
      latest.map((message: LatestMessage) => [message.chat_jid, message]),
    );

    assert.equal(latest.length, chatJids.length);
    assert.equal(byJid.get(chatJids[0])?.content, 'same-time-winner');
    assert.equal(byJid.get(chatJids[404])?.content, 'latest-404');
    assert.equal(byJid.has('web:empty'), false);
  } finally {
    database.closeDatabase();
  }
} finally {
  process.chdir(originalCwd);
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}

console.log('session list query tests passed');
