import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { paginateTopLevelSessions } from './session-pagination.js';
import type { SessionRecord } from './types.js';

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

    database.saveSessionRecord({
      id: 'main:traex-runtime',
      name: 'TraeX Runtime',
      kind: 'workspace',
      parent_session_id: null,
      cwd: '/work/traex-runtime',
      runner_id: 'traex',
      runner_profile_id: null,
      model: 'c_seed_2_1',
      thinking_effort: 'xhigh',
      model_backend_variant: 'max',
      context_compression: 'off',
      is_pinned: false,
      archived: false,
      owner_key: 'operator',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    });
    const traexSession = database.getSessionRecord('main:traex-runtime');
    assert.equal(traexSession?.thinking_effort, 'xhigh');
    assert.equal(traexSession?.model_backend_variant, 'max');

    const chats = database.getChatsByJids([
      ...chatJids,
      chatJids[0],
      'web:empty',
    ]);
    assert.equal(chats.length, chatJids.length + 1);
    assert.equal(
      chats.find((chat: { jid: string }) => chat.jid === 'web:empty')?.jid,
      'web:empty',
    );

    const activityTimestamp = '2099-02-03T04:05:06.000Z';
    database.setRegisteredGroup('web:activity-source', {
      name: 'Activity Source',
      folder: 'activity-source',
      added_at: '2026-01-01T00:00:00.000Z',
    });
    database.setRegisteredGroup('web:activity-target', {
      name: 'Activity Target',
      folder: 'activity-target',
      added_at: '2026-01-01T00:00:00.000Z',
    });
    database.ensureChatExists('web:activity-source');
    database.ensureChatExists('web:activity-target');
    database.storeMessageDirect(
      'activity-message',
      'web:activity-source',
      'user',
      'User',
      'bound activity',
      activityTimestamp,
      false,
    );
    database.storeChatMetadata(
      'web:activity-source',
      activityTimestamp,
      'Activity Source',
    );
    database.saveSessionBinding({
      channel_jid: 'web:activity-source',
      session_id: 'main:activity-target',
      binding_mode: 'source_only',
      activation_mode: 'auto',
      require_mention: false,
      display_name: 'Activity Source',
      reply_policy: 'source_only',
      conversation_mode: 'chat',
      created_at: activityTimestamp,
      updated_at: activityTimestamp,
    });

    const activity = database.getSessionActivityForSessions([
      'main:activity-source',
      'main:activity-target',
    ]) as Array<{ session_id: string; last_message_at: string }>;
    assert.deepEqual(activity, [
      {
        session_id: 'main:activity-target',
        last_message_at: activityTimestamp,
      },
    ]);
  } finally {
    database.closeDatabase();
  }
} finally {
  process.chdir(originalCwd);
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}

function session(
  id: string,
  overrides: Partial<SessionRecord> = {},
): SessionRecord {
  return {
    id,
    name: id,
    kind: 'workspace',
    parent_session_id: null,
    cwd: `/work/${id}`,
    runner_id: 'codex',
    runner_profile_id: null,
    model: null,
    thinking_effort: null,
    model_backend_variant: null,
    context_compression: 'off',
    is_pinned: false,
    archived: false,
    owner_key: 'operator',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const authorizedSessions = [
  session('main:home', { kind: 'main', name: 'Home' }),
  session('main:pinned', { name: 'Pinned', is_pinned: true }),
  session('main:recent', { name: 'Recent' }),
  session('worker:hidden', { kind: 'worker', name: 'Hidden' }),
  session('main:archived', { name: 'Archived', archived: true }),
];
const activityBySessionId = new Map([
  ['main:recent', '2026-03-01T00:00:00.000Z'],
  ['main:pinned', '2026-02-01T00:00:00.000Z'],
]);

const firstPage = paginateTopLevelSessions(
  authorizedSessions,
  activityBySessionId,
  { page: 1, pageSize: 2 },
);
assert.deepEqual(
  firstPage.sessions.map((record) => record.id),
  ['main:home', 'main:pinned'],
);
assert.equal(firstPage.total, 3);
assert.equal(firstPage.totalPages, 2);

const clampedPage = paginateTopLevelSessions(
  authorizedSessions,
  activityBySessionId,
  { page: 99, pageSize: 2 },
);
assert.equal(clampedPage.page, 2);
assert.deepEqual(
  clampedPage.sessions.map((record) => record.id),
  ['main:recent'],
);

const searched = paginateTopLevelSessions(
  authorizedSessions,
  activityBySessionId,
  { page: 1, pageSize: 30, query: '/work/main:recent' },
);
assert.deepEqual(
  searched.sessions.map((record) => record.id),
  ['main:recent'],
);

console.log('session list query tests passed');
