import crypto from 'crypto';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, STORE_DIR, GROUPS_DIR } from './config.js';
import { logger } from './logger.js';
import {
  getDefaultRunnerId,
  resolveMemoryRunnerId,
} from './runner-registry.js';
import {
  AgentKind,
  AgentStatus,
  NewMessage,
  DbMessage,
  MessageCursor,
  Permission,
  PermissionTemplateKey,
  RegisteredGroup,
  RuntimeStateSnapshot,
  ScheduledTask,
  SessionBindingMode,
  SessionBindingRecord,
  SessionKind,
  SessionRecord,
  SessionRuntimeStateRecord,
  RunnerProfileRecord,
  SubAgent,
  TaskRunLog,
  WorkerSessionRecord,
  User,
  UserPublic,
  UserStatus,
  UserRole,
} from './types.js';
import { getDefaultPermissions, normalizePermissions } from './permissions.js';

let db: Database.Database;

const MAIN_SESSION_ID_PREFIX = 'main:';
const WORKER_SESSION_ID_PREFIX = 'worker:';
const MEMORY_SESSION_ID_PREFIX = 'memory:';

type SessionChannelRow = {
  jid: string;
  session_id: string;
  name: string;
  created_at: string;
  container_config: string | null;
  custom_cwd: string | null;
  init_source_path: string | null;
  init_git_url: string | null;
  selected_skills: string | null;
  mcp_mode: string | null;
  selected_mcps: string | null;
  model: string | null;
  thinking_effort: string | null;
  context_compression: string | null;
};

function tableExists(tableName: string): boolean {
  const row = db
    .prepare(
      "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?",
    )
    .get(tableName) as { ok: number } | undefined;
  return row?.ok === 1;
}

function hasColumn(tableName: string, columnName: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
    name: string;
  }>;
  return columns.some((column) => column.name === columnName);
}

function getTableColumns(tableName: string): string[] {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
    name: string;
  }>;
  return columns.map((column) => column.name);
}

function withForeignKeysDisabled<T>(fn: () => T): T {
  const foreignKeysEnabled = db.pragma('foreign_keys', {
    simple: true,
  }) as number;
  if (foreignKeysEnabled) {
    db.pragma('foreign_keys = OFF');
  }

  try {
    return fn();
  } finally {
    if (foreignKeysEnabled) {
      db.pragma('foreign_keys = ON');
    }
  }
}

function ensureColumn(
  tableName: string,
  columnName: string,
  sqlTypeWithDefault: string,
): void {
  if (hasColumn(tableName, columnName)) return;
  db.exec(
    `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${sqlTypeWithDefault}`,
  );
}

function resolveFolderFromSessionId(sessionId: string): string {
  if (sessionId.startsWith(MAIN_SESSION_ID_PREFIX)) {
    return sessionId.slice(MAIN_SESSION_ID_PREFIX.length);
  }
  const session = getSessionRecord(sessionId);
  if (session?.parent_session_id?.startsWith(MAIN_SESSION_ID_PREFIX)) {
    return session.parent_session_id.slice(MAIN_SESSION_ID_PREFIX.length);
  }
  if (session) {
    return path.basename(session.cwd);
  }
  return '';
}

function resolveLegacyMainSessionId(targetMainJid: string): string | null {
  const trimmed = targetMainJid.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith(MAIN_SESSION_ID_PREFIX)) return trimmed;

  const direct = db
    .prepare('SELECT session_id FROM session_channels WHERE jid = ? LIMIT 1')
    .get(trimmed) as { session_id: string } | undefined;
  if (direct?.session_id) return direct.session_id;

  if (!trimmed.startsWith('web:')) return null;
  const folder = trimmed.slice(4).trim();
  if (!folder) return null;

  return buildMainSessionId(folder);
}

function migrateLegacyRegisteredGroupBindings(): void {
  const hasReplyPolicy = hasColumn('registered_groups', 'reply_policy');
  const hasActivationMode = hasColumn('registered_groups', 'activation_mode');
  const hasRequireMention = hasColumn('registered_groups', 'require_mention');
  const hasTargetAgent = hasColumn('registered_groups', 'target_agent_id');
  const hasTargetMain = hasColumn('registered_groups', 'target_main_jid');
  if (
    !hasReplyPolicy
    && !hasActivationMode
    && !hasRequireMention
    && !hasTargetAgent
    && !hasTargetMain
  ) {
    return;
  }

  const rows = db
    .prepare(
      `SELECT jid, name, folder, added_at${
        hasReplyPolicy ? ', reply_policy' : ", 'source_only' AS reply_policy"
      }${
        hasActivationMode ? ', activation_mode' : ", 'auto' AS activation_mode"
      }${
        hasRequireMention ? ', require_mention' : ', 0 AS require_mention'
      }${
        hasTargetAgent ? ', target_agent_id' : ", NULL AS target_agent_id"
      }${hasTargetMain ? ', target_main_jid' : ", NULL AS target_main_jid"}
       FROM registered_groups`,
    )
    .all() as Array<{
      jid: string;
      name: string;
      folder: string;
      added_at: string;
      reply_policy: string | null;
      activation_mode: string | null;
      require_mention: number | null;
      target_agent_id: string | null;
      target_main_jid: string | null;
    }>;

  const tx = db.transaction(() => {
    for (const row of rows) {
      if (row.jid.startsWith('web:')) {
        db.prepare('DELETE FROM session_bindings WHERE channel_jid = ?').run(row.jid);
        continue;
      }

      const targetAgentId = row.target_agent_id?.trim() || null;
      const targetMainJid = row.target_main_jid?.trim() || null;
      const defaultSessionId = buildMainSessionId(row.folder);
      const current = getSessionBinding(row.jid);
      const sessionId = targetAgentId
        ? buildWorkerSessionId(targetAgentId)
        : resolveLegacyMainSessionId(targetMainJid || '')
          || current?.session_id
          || defaultSessionId;
      if (!sessionId) continue;

      const session = getSessionRecord(sessionId);
      const now = new Date().toISOString();
      const replyPolicy = row.reply_policy === 'mirror' ? 'mirror' : 'source_only';
      saveSessionBinding({
        channel_jid: row.jid,
        session_id: sessionId,
        binding_mode:
          replyPolicy === 'mirror'
            ? 'mirror'
            : targetAgentId
              ? 'direct'
              : session?.kind === 'worker'
              ? 'direct'
              : 'source_only',
        activation_mode: parseActivationMode(row.activation_mode),
        require_mention: row.require_mention === 1,
        display_name: row.name,
        reply_policy: replyPolicy,
        created_at: current?.created_at || row.added_at || now,
        updated_at: now,
      });
    }
  });

  tx();
}

function backfillLegacyGroupOwnersIntoSessions(): void {
  if (!hasColumn('registered_groups', 'created_by')) return;

  const hasIsHome = hasColumn('registered_groups', 'is_home');
  const rows = db
    .prepare(
      `SELECT jid, name, folder, added_at, container_config, custom_cwd,
              init_source_path, init_git_url, created_by, selected_skills,
              mcp_mode, selected_mcps, model, thinking_effort,
              context_compression${
                hasIsHome ? ', is_home' : ', 0 AS is_home'
              }
       FROM registered_groups
       WHERE jid LIKE 'web:%'`,
    )
    .all() as Array<Record<string, unknown>>;

  for (const row of rows) {
    const legacyIsPrimarySession = Number(row.is_home || 0) === 1;
    const ownerKey =
      typeof row.created_by === 'string' && row.created_by.trim()
        ? row.created_by.trim()
        : null;
    const folder = String(row.folder);
    const sessionId = buildMainSessionId(folder);
    const existing = getSessionRecord(sessionId);
    const fallbackGroup: RegisteredGroup = {
      name: String(row.name),
      folder,
      added_at: String(row.added_at),
      containerConfig:
        typeof row.container_config === 'string'
          ? JSON.parse(row.container_config)
          : undefined,
      customCwd:
        typeof row.custom_cwd === 'string' ? row.custom_cwd : undefined,
      initSourcePath:
        typeof row.init_source_path === 'string'
          ? row.init_source_path
          : undefined,
      initGitUrl:
        typeof row.init_git_url === 'string' ? row.init_git_url : undefined,
      is_home: legacyIsPrimarySession,
      selected_skills:
        typeof row.selected_skills === 'string'
          ? JSON.parse(row.selected_skills)
          : null,
      mcp_mode: row.mcp_mode === 'custom' ? 'custom' : 'inherit',
      selected_mcps:
        typeof row.selected_mcps === 'string'
          ? JSON.parse(row.selected_mcps)
          : null,
      model: typeof row.model === 'string' ? row.model : undefined,
      thinking_effort: parseThinkingEffort(
        typeof row.thinking_effort === 'string' ? row.thinking_effort : null,
      ),
      context_compression: parseCompressionMode(
        typeof row.context_compression === 'string'
          ? row.context_compression
          : null,
      ),
    };
    const nextSession: SessionRecord = existing || {
      id: sessionId,
      name: fallbackGroup.name,
      kind:
        legacyIsPrimarySession || folder === 'main' ? 'main' : 'workspace',
      parent_session_id: null,
      cwd: deriveSessionCwd(fallbackGroup),
      runner_id: deriveRunnerId(fallbackGroup),
      runner_profile_id: null,
      model: fallbackGroup.model ?? null,
      thinking_effort: fallbackGroup.thinking_effort ?? null,
      context_compression: fallbackGroup.context_compression ?? 'off',
      is_pinned: false,
      archived: false,
      owner_key: null,
      created_at: fallbackGroup.added_at,
      updated_at: fallbackGroup.added_at,
    };
    if (legacyIsPrimarySession && nextSession.kind !== 'main') {
      nextSession.kind = 'main';
    }
    if (!nextSession.owner_key && ownerKey) {
      nextSession.owner_key = ownerKey;
    }
    saveSessionRecord({
      ...nextSession,
      updated_at: new Date().toISOString(),
    });
  }
}

function migrateRegisteredGroupsToSessionChannels(): void {
  if (!tableExists('registered_groups')) return;

  const hasCustomCwd = hasColumn('registered_groups', 'custom_cwd');
  const hasInitSourcePath = hasColumn('registered_groups', 'init_source_path');
  const hasInitGitUrl = hasColumn('registered_groups', 'init_git_url');
  const hasSelectedSkills = hasColumn('registered_groups', 'selected_skills');
  const hasMcpMode = hasColumn('registered_groups', 'mcp_mode');
  const hasSelectedMcps = hasColumn('registered_groups', 'selected_mcps');
  const hasModel = hasColumn('registered_groups', 'model');
  const hasThinkingEffort = hasColumn('registered_groups', 'thinking_effort');
  const hasContextCompression = hasColumn(
    'registered_groups',
    'context_compression',
  );

  const rows = db
    .prepare(
      `SELECT jid, name, folder, added_at, container_config${
        hasCustomCwd ? ', custom_cwd' : ', NULL AS custom_cwd'
      }${
        hasInitSourcePath ? ', init_source_path' : ', NULL AS init_source_path'
      }${
        hasInitGitUrl ? ', init_git_url' : ', NULL AS init_git_url'
      }${
        hasSelectedSkills ? ', selected_skills' : ', NULL AS selected_skills'
      }${hasMcpMode ? ', mcp_mode' : ", 'inherit' AS mcp_mode"}${
        hasSelectedMcps ? ', selected_mcps' : ', NULL AS selected_mcps'
      }${hasModel ? ', model' : ', NULL AS model'}${
        hasThinkingEffort ? ', thinking_effort' : ', NULL AS thinking_effort'
      }${
        hasContextCompression
          ? ', context_compression'
          : ", 'off' AS context_compression"
      }
       FROM registered_groups`,
    )
    .all() as Array<{
      jid: string;
      name: string;
      folder: string;
      added_at: string;
      container_config: string | null;
      custom_cwd: string | null;
      init_source_path: string | null;
      init_git_url: string | null;
      selected_skills: string | null;
      mcp_mode: string | null;
      selected_mcps: string | null;
      model: string | null;
      thinking_effort: string | null;
      context_compression: string | null;
    }>;

  const tx = db.transaction(() => {
    for (const row of rows) {
      const sessionId = buildMainSessionId(row.folder);
      db.prepare(
        `INSERT INTO session_channels (
          jid, session_id, name, created_at, container_config, custom_cwd,
          init_source_path, init_git_url, selected_skills, mcp_mode,
          selected_mcps, model, thinking_effort, context_compression
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(jid) DO UPDATE SET
          session_id = excluded.session_id,
          name = excluded.name,
          created_at = excluded.created_at,
          container_config = excluded.container_config,
          custom_cwd = excluded.custom_cwd,
          init_source_path = excluded.init_source_path,
          init_git_url = excluded.init_git_url,
          selected_skills = excluded.selected_skills,
          mcp_mode = excluded.mcp_mode,
          selected_mcps = excluded.selected_mcps,
          model = excluded.model,
          thinking_effort = excluded.thinking_effort,
          context_compression = excluded.context_compression`,
      ).run(
        row.jid,
        sessionId,
        row.name,
        row.added_at,
        row.container_config,
        row.custom_cwd,
        row.init_source_path,
        row.init_git_url,
        row.selected_skills,
        row.mcp_mode || 'inherit',
        row.selected_mcps,
        row.model,
        row.thinking_effort,
        row.context_compression || 'off',
      );
    }

    db.exec('DROP TABLE registered_groups');
  });

  tx();
}

function dropLegacySessionRuntimeModeColumn(): void {
  if (!hasColumn('sessions', 'runtime_mode')) return;

  db.transaction(() => {
    db.exec(`
      CREATE TABLE sessions_new (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        parent_session_id TEXT,
        cwd TEXT NOT NULL,
        runner_id TEXT NOT NULL,
        runner_profile_id TEXT,
        model TEXT,
        thinking_effort TEXT,
        context_compression TEXT NOT NULL DEFAULT 'off',
        is_pinned INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        owner_key TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO sessions_new (
        id, name, kind, parent_session_id, cwd, runner_id, runner_profile_id,
        model, thinking_effort, context_compression,
        is_pinned, archived, owner_key, created_at, updated_at
      )
      SELECT
        id, name, kind, parent_session_id, cwd, runner_id, runner_profile_id,
        model, thinking_effort, COALESCE(context_compression, 'off'),
        COALESCE(is_pinned, 0),
        COALESCE(archived, 0), owner_key, created_at, updated_at
      FROM sessions;
      DROP TABLE sessions;
      ALTER TABLE sessions_new RENAME TO sessions;
      CREATE INDEX IF NOT EXISTS idx_sessions_kind ON sessions(kind);
      CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id);
    `);
  })();
}

function dropLegacyUnusedAuthTables(): void {
  for (const tableName of ['invite_codes', 'user_sessions', 'auth_audit_log']) {
    if (!tableExists(tableName)) continue;
    db.exec(`DROP TABLE ${tableName}`);
  }
}

const LEGACY_BILLING_TABLES = [
  'billing_plans',
  'user_subscriptions',
  'user_balances',
  'balance_transactions',
  'monthly_usage',
  'redeem_codes',
  'redeem_code_usage',
  'billing_audit_log',
  'daily_usage',
  'user_quotas',
] as const;

function archiveLegacyBillingData(): void {
  const existingTables = LEGACY_BILLING_TABLES.filter((tableName) =>
    tableExists(tableName),
  );
  const hasLegacyUsersColumn = hasColumn('users', 'subscription_plan_id');
  if (existingTables.length === 0 && !hasLegacyUsersColumn) {
    return;
  }

  const archivePath = path.join(STORE_DIR, 'legacy-billing-archive.json');
  if (fs.existsSync(archivePath)) {
    return;
  }

  const archive: Record<string, unknown> = {
    archived_at: new Date().toISOString(),
    schema_version: getRouterStateInternal('schema_version') ?? null,
    tables: {},
  };

  for (const tableName of existingTables) {
    const rowCount = (
      db.prepare(`SELECT COUNT(*) AS cnt FROM ${tableName}`).get() as {
        cnt: number;
      }
    ).cnt;
    const columns = getTableColumns(tableName);
    const rows = db.prepare(`SELECT * FROM ${tableName}`).all();
    (archive.tables as Record<string, unknown>)[tableName] = {
      columns,
      row_count: rowCount,
      rows,
    };
  }

  if (hasLegacyUsersColumn) {
    archive.users = {
      columns: getTableColumns('users'),
      rows: db
        .prepare('SELECT * FROM users WHERE subscription_plan_id IS NOT NULL')
        .all(),
    };
  }

  fs.writeFileSync(archivePath, JSON.stringify(archive, null, 2), 'utf8');
}

function migrateLegacyBillingUsageSummary(): void {
  if (!tableExists('daily_usage')) {
    return;
  }

  db.exec(`
    INSERT INTO usage_daily_summary (
      user_id,
      model,
      date,
      total_input_tokens,
      total_output_tokens,
      total_cache_read_tokens,
      total_cache_creation_tokens,
      total_cost_usd,
      request_count,
      updated_at
    )
    SELECT
      du.user_id,
      'legacy-billing-total',
      du.date,
      du.total_input_tokens,
      du.total_output_tokens,
      0,
      0,
      du.total_cost_usd,
      du.message_count,
      datetime('now')
    FROM daily_usage du
    WHERE NOT EXISTS (
      SELECT 1
      FROM usage_daily_summary uds
      WHERE uds.user_id = du.user_id
        AND uds.date = du.date
    )
  `);
}

function dropLegacyBillingCompatibility(): void {
  archiveLegacyBillingData();
  migrateLegacyBillingUsageSummary();

  withForeignKeysDisabled(() => {
    for (const tableName of [
      'user_subscriptions',
      'user_balances',
      'balance_transactions',
      'redeem_code_usage',
      'redeem_codes',
      'monthly_usage',
      'billing_audit_log',
      'daily_usage',
      'user_quotas',
      'billing_plans',
    ]) {
      if (!tableExists(tableName)) continue;
      db.exec(`DROP TABLE ${tableName}`);
    }

    if (!hasColumn('users', 'subscription_plan_id')) {
      return;
    }

    db.transaction(() => {
      db.exec(`
        CREATE TABLE users_new (
          id TEXT PRIMARY KEY,
          username TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          display_name TEXT NOT NULL DEFAULT '',
          role TEXT NOT NULL DEFAULT 'member',
          status TEXT NOT NULL DEFAULT 'active',
          permissions TEXT NOT NULL DEFAULT '[]',
          must_change_password INTEGER NOT NULL DEFAULT 0,
          disable_reason TEXT,
          notes TEXT,
          avatar_emoji TEXT,
          avatar_color TEXT,
          ai_name TEXT,
          ai_avatar_emoji TEXT,
          ai_avatar_color TEXT,
          ai_avatar_url TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_login_at TEXT,
          deleted_at TEXT
        );
        INSERT INTO users_new (
          id, username, password_hash, display_name, role, status, permissions,
          must_change_password, disable_reason, notes, avatar_emoji,
          avatar_color, ai_name, ai_avatar_emoji, ai_avatar_color,
          ai_avatar_url, created_at, updated_at, last_login_at, deleted_at
        )
        SELECT
          id, username, password_hash, display_name, role, status, permissions,
          must_change_password, disable_reason, notes, avatar_emoji,
          avatar_color, ai_name, ai_avatar_emoji, ai_avatar_color,
          ai_avatar_url, created_at, updated_at, last_login_at, deleted_at
        FROM users;
        DROP TABLE users;
        ALTER TABLE users_new RENAME TO users;
        CREATE INDEX IF NOT EXISTS idx_users_status_role ON users(status, role);
        CREATE INDEX IF NOT EXISTS idx_users_created_at ON users(created_at);
      `);
    })();
  });
}

function dropLegacyGroupAccessTables(): void {
  for (const tableName of ['group_members', 'user_pinned_groups']) {
    if (!tableExists(tableName)) continue;
    db.exec(`DROP TABLE ${tableName}`);
  }
}

function assertSchema(
  tableName: string,
  requiredColumns: string[],
  forbiddenColumns: string[] = [],
): void {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
    name: string;
  }>;
  const names = new Set(columns.map((c) => c.name));

  const missing = requiredColumns.filter((c) => !names.has(c));
  const forbidden = forbiddenColumns.filter((c) => names.has(c));

  if (missing.length > 0 || forbidden.length > 0) {
    throw new Error(
      `Incompatible DB schema in table "${tableName}". Missing: [${missing.join(', ')}], forbidden: [${forbidden.join(', ')}]. ` +
        'Please remove data/db/messages.db (or legacy store/messages.db) and restart.',
    );
  }
}

/** Internal helper — reads router_state before initDatabase exports are available. */
function getRouterStateInternal(key: string): string | undefined {
  try {
    const row = db
      .prepare('SELECT value FROM router_state WHERE key = ?')
      .get(key) as { value: string } | undefined;
    return row?.value;
  } catch {
    return undefined; // Table may not exist yet on first run
  }
}

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);

  // Enable WAL mode for better concurrency and performance
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  // Custom function: word-boundary match with digit↔letter transition support.
  // Returns 1 if `term` appears at a "semantic boundary" in `content`:
  //   - standard word boundary (\b): whitespace, punctuation, CJK↔Latin, start/end
  //   - digit↔letter transition: "e33ecs" has a boundary between '3' and 'e'
  // e.g. "kill" matches "kill process" but NOT "skill" (letter→letter, no boundary).
  //      "ecs" matches "e33ecs" (digit→letter transition).
  //      "e33" matches "e33ecs" (\b at start) and "成e33" (CJK→Latin \b).
  db.function('word_match', (content: unknown, term: unknown) => {
    if (typeof content !== 'string' || typeof term !== 'string') return 0;
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Match at: word boundary OR digit↔letter transition
    const regex = new RegExp(
      `(?:\\b|(?<=[0-9])(?=[a-zA-Z])|(?<=[a-zA-Z])(?=[0-9]))${escaped}`,
      'i',
    );
    return regex.test(content) ? 1 : 0;
  });
  db.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      source_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      attachments TEXT,
      token_usage TEXT,
      reply_to_id TEXT,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);
    CREATE INDEX IF NOT EXISTS idx_messages_jid_ts ON messages(chat_jid, timestamp);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      context_mode TEXT DEFAULT 'isolated',
      execution_type TEXT DEFAULT 'agent',
      script_command TEXT,
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL,
      created_by TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);
  `);

  // State tables (replacing JSON files)
  db.exec(`
    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS session_channels (
      jid TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      container_config TEXT,
      custom_cwd TEXT,
      init_source_path TEXT,
      init_git_url TEXT,
      selected_skills TEXT,
      mcp_mode TEXT DEFAULT 'inherit',
      selected_mcps TEXT,
      model TEXT,
      thinking_effort TEXT,
      context_compression TEXT DEFAULT 'off'
    );
    CREATE INDEX IF NOT EXISTS idx_session_channels_session
      ON session_channels(session_id);
  `);

  // Auth tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'member',
      status TEXT NOT NULL DEFAULT 'active',
      permissions TEXT NOT NULL DEFAULT '[]',
      must_change_password INTEGER NOT NULL DEFAULT 0,
      disable_reason TEXT,
      notes TEXT,
      avatar_emoji TEXT,
      avatar_color TEXT,
      ai_name TEXT,
      ai_avatar_emoji TEXT,
      ai_avatar_color TEXT,
      ai_avatar_url TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_login_at TEXT,
      deleted_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_users_status_role ON users(status, role);
    CREATE INDEX IF NOT EXISTS idx_users_created_at ON users(created_at);
  `);

  // Token usage tracking tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_records (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      group_folder TEXT NOT NULL,
      agent_id TEXT,
      message_id TEXT,
      model TEXT NOT NULL DEFAULT 'unknown',
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      duration_ms INTEGER DEFAULT 0,
      num_turns INTEGER DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'agent',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_usage_user_date ON usage_records(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_usage_group_date ON usage_records(group_folder, created_at);
    CREATE INDEX IF NOT EXISTS idx_usage_model_date ON usage_records(model, created_at);

    CREATE TABLE IF NOT EXISTS usage_daily_summary (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      model TEXT NOT NULL,
      date TEXT NOT NULL,
      total_input_tokens INTEGER NOT NULL DEFAULT 0,
      total_output_tokens INTEGER NOT NULL DEFAULT 0,
      total_cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      total_cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      total_cost_usd REAL NOT NULL DEFAULT 0,
      request_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, model, date)
    );
    CREATE INDEX IF NOT EXISTS idx_daily_user_date ON usage_daily_summary(user_id, date);
  `);

  const hasLegacyProviderSessions =
    tableExists('sessions') &&
    hasColumn('sessions', 'group_folder') &&
    hasColumn('sessions', 'session_id') &&
    !hasColumn('sessions', 'id');
  if (hasLegacyProviderSessions && !tableExists('provider_sessions_legacy')) {
    db.exec('ALTER TABLE sessions RENAME TO provider_sessions_legacy');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      parent_session_id TEXT,
      cwd TEXT NOT NULL,
      runner_id TEXT NOT NULL,
      runner_profile_id TEXT,
      model TEXT,
      thinking_effort TEXT,
      context_compression TEXT NOT NULL DEFAULT 'off',
      is_pinned INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      owner_key TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS session_bindings (
      channel_jid TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      binding_mode TEXT NOT NULL,
      activation_mode TEXT NOT NULL DEFAULT 'auto',
      require_mention INTEGER NOT NULL DEFAULT 0,
      display_name TEXT,
      reply_policy TEXT NOT NULL DEFAULT 'source_only',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS session_state (
      session_id TEXT PRIMARY KEY,
      provider_session_id TEXT,
      resume_anchor TEXT,
      provider_state_json TEXT,
      recent_im_channels_json TEXT,
      im_channel_last_seen_json TEXT,
      current_permission_mode TEXT,
      last_message_cursor TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS worker_sessions (
      session_id TEXT PRIMARY KEY,
      parent_session_id TEXT NOT NULL,
      source_chat_jid TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      result_summary TEXT
    );
    CREATE TABLE IF NOT EXISTS runner_profiles (
      id TEXT PRIMARY KEY,
      runner_id TEXT NOT NULL,
      name TEXT NOT NULL,
      config_json TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_kind ON sessions(kind);
    CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id);
    CREATE INDEX IF NOT EXISTS idx_bindings_session ON session_bindings(session_id);
    CREATE INDEX IF NOT EXISTS idx_worker_parent ON worker_sessions(parent_session_id);
    CREATE INDEX IF NOT EXISTS idx_profiles_runner ON runner_profiles(runner_id);
  `);

  dropLegacySessionRuntimeModeColumn();
  migrateLegacyRegisteredGroupBindings();
  backfillLegacyGroupOwnersIntoSessions();
  migrateRegisteredGroupsToSessionChannels();

  // Lightweight migrations for existing DBs
  ensureColumn('users', 'permissions', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn('users', 'must_change_password', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('users', 'disable_reason', 'TEXT');
  ensureColumn('users', 'notes', 'TEXT');
  ensureColumn('users', 'deleted_at', 'TEXT');
  ensureColumn('users', 'avatar_emoji', 'TEXT');
  ensureColumn('users', 'avatar_color', 'TEXT');
  ensureColumn('messages', 'attachments', 'TEXT');
  ensureColumn('messages', 'source_jid', 'TEXT');
  ensureColumn('users', 'ai_name', 'TEXT');
  ensureColumn('users', 'ai_avatar_emoji', 'TEXT');
  ensureColumn('users', 'ai_avatar_color', 'TEXT');
  ensureColumn('users', 'ai_avatar_url', 'TEXT');
  ensureColumn('scheduled_tasks', 'created_by', 'TEXT');
  ensureColumn('scheduled_tasks', 'session_id', 'TEXT');
  ensureColumn('scheduled_tasks', 'execution_type', "TEXT DEFAULT 'agent'");
  ensureColumn('scheduled_tasks', 'script_command', 'TEXT');
  ensureColumn('session_channels', 'custom_cwd', 'TEXT');
  ensureColumn('session_channels', 'init_source_path', 'TEXT');
  ensureColumn('session_channels', 'init_git_url', 'TEXT');
  ensureColumn('session_channels', 'selected_skills', 'TEXT');
  ensureColumn('session_channels', 'mcp_mode', "TEXT DEFAULT 'inherit'");
  ensureColumn('session_channels', 'selected_mcps', 'TEXT');
  ensureColumn('session_channels', 'model', 'TEXT');
  ensureColumn('session_channels', 'thinking_effort', 'TEXT');
  ensureColumn('session_channels', 'context_compression', "TEXT DEFAULT 'off'");
  ensureColumn('scheduled_tasks', 'model', 'TEXT');
  db.prepare(
    `UPDATE scheduled_tasks
       SET session_id = 'main:' || group_folder
     WHERE (session_id IS NULL OR TRIM(session_id) = '')
       AND group_folder IS NOT NULL
       AND TRIM(group_folder) != ''`,
  ).run();

  // Context summaries table for conversation compression
  db.exec(`
    CREATE TABLE IF NOT EXISTS context_summaries (
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      summary TEXT NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      model_used TEXT,
      PRIMARY KEY (group_folder, chat_jid)
    )
  `);
  ensureColumn('messages', 'token_usage', 'TEXT');

  dropLegacyUnusedAuthTables();
  dropLegacyBillingCompatibility();
  dropLegacyGroupAccessTables();

  // v19→v20 migration: add token_usage column to messages
  ensureColumn('messages', 'token_usage', 'TEXT');
  assertSchema('messages', [
    'id',
    'chat_jid',
    'source_jid',
    'sender',
    'sender_name',
    'content',
    'timestamp',
    'is_from_me',
    'attachments',
    'token_usage',
  ]);
  assertSchema('scheduled_tasks', [
    'id',
    'session_id',
    'group_folder',
    'chat_jid',
    'prompt',
    'schedule_type',
    'schedule_value',
    'context_mode',
    'execution_type',
    'script_command',
    'next_run',
    'last_run',
    'last_result',
    'status',
    'created_at',
    'created_by',
    'model',
  ]);
  assertSchema(
    'session_channels',
    [
      'jid',
      'session_id',
      'name',
      'created_at',
      'container_config',
      'custom_cwd',
      'init_source_path',
      'init_git_url',
      'selected_skills',
      'mcp_mode',
      'selected_mcps',
      'model',
      'thinking_effort',
      'context_compression',
    ],
  );

  assertSchema('users', [
    'id',
    'username',
    'password_hash',
    'display_name',
    'role',
    'status',
    'permissions',
    'must_change_password',
    'disable_reason',
    'notes',
    'avatar_emoji',
    'avatar_color',
    'ai_name',
    'ai_avatar_emoji',
    'ai_avatar_color',
    'ai_avatar_url',
    'created_at',
    'updated_at',
    'last_login_at',
    'deleted_at',
  ], ['subscription_plan_id']);
  // Store schema version after all migrations complete.

  // v25→v26 migration: cost_usd on messages
  ensureColumn('messages', 'cost_usd', 'REAL');
  ensureColumn('messages', 'reply_to_id', 'TEXT');

  // v27→v28: Token usage tables + history migration
  const v28Check = getRouterStateInternal('schema_version');
  if (!v28Check || parseInt(v28Check, 10) < 28) {
    db.transaction(() => {
      // Count messages with token_usage for logging
      const countBefore = (
        db
          .prepare(
            "SELECT COUNT(*) as cnt FROM messages WHERE token_usage IS NOT NULL AND json_extract(token_usage, '$.modelUsage') IS NOT NULL",
          )
          .get() as { cnt: number }
      ).cnt;

      // Migrate from messages.token_usage modelUsage into usage_records
      db.exec(`
        INSERT OR IGNORE INTO usage_records (id, user_id, group_folder, message_id, model,
          input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
          cost_usd, duration_ms, num_turns, source, created_at)
        SELECT
          lower(hex(randomblob(16))),
          COALESCE(ms.owner_key, 'system'),
          COALESCE(substr(sc.session_id, 6), m.chat_jid),
          m.id,
          COALESCE(jme.key, 'unknown'),
          COALESCE(json_extract(jme.value, '$.inputTokens'), 0),
          COALESCE(json_extract(jme.value, '$.outputTokens'), 0),
          0, 0,
          COALESCE(json_extract(jme.value, '$.costUSD'), 0),
          COALESCE(json_extract(m.token_usage, '$.durationMs'), 0),
          COALESCE(json_extract(m.token_usage, '$.numTurns'), 0),
          'agent',
          m.timestamp
        FROM messages m
          JOIN json_each(json_extract(m.token_usage, '$.modelUsage')) jme
          LEFT JOIN session_channels sc ON sc.jid = m.chat_jid
          LEFT JOIN sessions ms ON ms.id = sc.session_id
        WHERE m.token_usage IS NOT NULL
          AND json_extract(m.token_usage, '$.modelUsage') IS NOT NULL
      `);

      // Migrate messages without modelUsage (legacy) using root-level fields
      db.exec(`
        INSERT OR IGNORE INTO usage_records (id, user_id, group_folder, message_id, model,
          input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
          cost_usd, duration_ms, num_turns, source, created_at)
        SELECT
          lower(hex(randomblob(16))),
          COALESCE(ms.owner_key, 'system'),
          COALESCE(substr(sc.session_id, 6), m.chat_jid),
          m.id,
          'legacy-unknown',
          COALESCE(json_extract(m.token_usage, '$.inputTokens'), 0),
          COALESCE(json_extract(m.token_usage, '$.outputTokens'), 0),
          COALESCE(json_extract(m.token_usage, '$.cacheReadInputTokens'), 0),
          COALESCE(json_extract(m.token_usage, '$.cacheCreationInputTokens'), 0),
          COALESCE(json_extract(m.token_usage, '$.costUSD'), 0),
          COALESCE(json_extract(m.token_usage, '$.durationMs'), 0),
          COALESCE(json_extract(m.token_usage, '$.numTurns'), 0),
          'agent',
          m.timestamp
        FROM messages m
          LEFT JOIN session_channels sc ON sc.jid = m.chat_jid
          LEFT JOIN sessions ms ON ms.id = sc.session_id
        WHERE m.token_usage IS NOT NULL
          AND (json_extract(m.token_usage, '$.modelUsage') IS NULL
               OR json_type(json_extract(m.token_usage, '$.modelUsage')) != 'object')
      `);

      // Build daily summary from usage_records
      db.exec(`
        INSERT OR REPLACE INTO usage_daily_summary (user_id, model, date,
          total_input_tokens, total_output_tokens,
          total_cache_read_tokens, total_cache_creation_tokens,
          total_cost_usd, request_count, updated_at)
        SELECT
          user_id, model, date(created_at, 'localtime'),
          SUM(input_tokens), SUM(output_tokens),
          SUM(cache_read_input_tokens), SUM(cache_creation_input_tokens),
          SUM(cost_usd), COUNT(*), datetime('now')
        FROM usage_records
        GROUP BY user_id, model, date(created_at, 'localtime')
      `);

      const countAfter = (
        db.prepare('SELECT COUNT(*) as cnt FROM usage_records').get() as {
          cnt: number;
        }
      ).cnt;
      logger.info(
        { countBefore, countAfter },
        'Token usage migration v27→v28 completed',
      );
    })();
  }

  // v30: turns table for Turn-based message routing
  db.exec(`
    CREATE TABLE IF NOT EXISTS turns (
      id TEXT PRIMARY KEY,
      chat_jid TEXT NOT NULL,
      channel TEXT,
      message_ids TEXT,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      result_message_id TEXT,
      summary TEXT,
      trace_file TEXT,
      token_usage TEXT,
      group_folder TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_turns_folder ON turns(group_folder, started_at);
    CREATE INDEX IF NOT EXISTS idx_turns_jid ON turns(chat_jid, started_at);
  `);

  // v31: index on turns.result_message_id for trace lookup by message
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_turns_result_msg ON turns(result_message_id);
  `);

  // v32: FTS5 full-text search index for messages
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      content,
      content='messages',
      content_rowid='rowid',
      tokenize='unicode61'
    );
  `);
  // Triggers to keep FTS index in sync with messages table
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
    END;
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
    END;
  `);
  // Rebuild FTS index from content table (idempotent, handles both fresh and existing DBs)
  const msgCount = (
    db.prepare('SELECT count(*) as cnt FROM messages').get() as {
      cnt: number;
    }
  ).cnt;
  if (msgCount > 0) {
    logger.info(
      { msgCount },
      'Rebuilding FTS5 index from existing messages...',
    );
    db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
    logger.info('FTS5 rebuild complete');
  }

  syncSessionWorkbenchProjection();

  const SCHEMA_VERSION = '42';
  db.prepare(
    'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
  ).run('schema_version', SCHEMA_VERSION);
}

/**
 * Store chat metadata only (no message content).
 * Used for all chats to enable group discovery without storing sensitive content.
 */
export function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
): void {
  if (name) {
    // Update with name, preserving existing timestamp if newer
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = excluded.name,
        last_message_time = MAX(last_message_time, excluded.last_message_time)
    `,
    ).run(chatJid, name, timestamp);
  } else {
    // Update timestamp only, preserve existing name if any
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        last_message_time = MAX(last_message_time, excluded.last_message_time)
    `,
    ).run(chatJid, chatJid, timestamp);
  }
}

/**
 * Update chat name without changing timestamp for existing chats.
 * New chats get the current time as their initial timestamp.
 * Used during group metadata sync.
 */
export function updateChatName(chatJid: string, name: string): void {
  db.prepare(
    `
    INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET name = excluded.name
  `,
  ).run(chatJid, name, new Date().toISOString());
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
}

/**
 * Get all known chats, ordered by most recent activity.
 */
export function getAllChats(): ChatInfo[] {
  return db
    .prepare(
      `
    SELECT jid, name, last_message_time
    FROM chats
    ORDER BY last_message_time DESC
  `,
    )
    .all() as ChatInfo[];
}

/**
 * Get timestamp of last group metadata sync.
 */
export function getLastGroupSync(): string | null {
  // Store sync time in a special chat entry
  const row = db
    .prepare(`SELECT last_message_time FROM chats WHERE jid = '__group_sync__'`)
    .get() as { last_message_time: string } | undefined;
  return row?.last_message_time || null;
}

/**
 * Record that group metadata was synced.
 */
export function setLastGroupSync(): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO chats (jid, name, last_message_time) VALUES ('__group_sync__', '__group_sync__', ?)`,
  ).run(now);
}

/**
 * Batch-fetch chat names for a list of JIDs.
 * Returns a Map from jid → name (only includes JIDs found in the DB).
 */
export function getChatNamesByJids(jids: string[]): Map<string, string> {
  const result = new Map<string, string>();
  if (jids.length === 0) return result;
  const placeholders = jids.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT jid, name FROM chats WHERE jid IN (${placeholders})`)
    .all(...jids) as Array<{ jid: string; name: string }>;
  for (const row of rows) {
    if (row.name && row.name !== row.jid) {
      result.set(row.jid, row.name);
    }
  }
  return result;
}

/**
 * Ensure a chat row exists in the chats table (avoids FK violation on messages insert).
 */
export function ensureChatExists(chatJid: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)`,
  ).run(chatJid, chatJid, new Date().toISOString());
}

/**
 * Store a message with full content (channel-agnostic).
 * Only call this for registered groups where message history is needed.
 */
export function storeMessageDirect(
  msgId: string,
  chatJid: string,
  sender: string,
  senderName: string,
  content: string,
  timestamp: string,
  isFromMe: boolean,
  attachments?: string,
  tokenUsage?: string,
  sourceJid?: string,
  replyToId?: string,
): number {
  const result = db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, source_jid, sender, sender_name, content, timestamp, is_from_me, attachments, token_usage, reply_to_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msgId,
    chatJid,
    sourceJid ?? chatJid,
    sender,
    senderName,
    content,
    timestamp,
    isFromMe ? 1 : 0,
    attachments ?? null,
    tokenUsage ?? null,
    replyToId ?? null,
  );
  return Number(result.lastInsertRowid);
}

/**
 * Retrieve a single message by its ID and chat JID.
 * Used to fetch the original message when a user replies to it.
 */
export function getMessageById(
  msgId: string,
  chatJid: string,
): DbMessage | null {
  return (
    (db
      .prepare(
        `SELECT rowid, id, chat_jid, source_jid, sender, sender_name, content, timestamp, attachments, reply_to_id
         FROM messages WHERE id = ? AND chat_jid = ? LIMIT 1`,
      )
      .get(msgId, chatJid) as DbMessage | undefined) ?? null
  );
}

/**
 * Update the token_usage field on a specific agent message, or fall back to
 * the most recent agent message without token_usage for the given chat.
 * When msgId is provided, uses precise `WHERE id = ? AND chat_jid = ?` match
 * to avoid race conditions in concurrent scenarios.
 */
export function updateLatestMessageTokenUsage(
  chatJid: string,
  tokenUsage: string,
  msgId?: string,
  costUsd?: number,
): void {
  if (msgId) {
    db.prepare(
      `UPDATE messages SET token_usage = ?, cost_usd = ? WHERE id = ? AND chat_jid = ?`,
    ).run(tokenUsage, costUsd ?? null, msgId, chatJid);
  } else {
    db.prepare(
      `UPDATE messages SET token_usage = ?, cost_usd = ?
       WHERE rowid = (
         SELECT rowid FROM messages
         WHERE chat_jid = ? AND is_from_me = 1 AND token_usage IS NULL
         ORDER BY timestamp DESC LIMIT 1
       )`,
    ).run(tokenUsage, costUsd ?? null, chatJid);
  }
}

/**
 * Get token usage statistics aggregated by date.
 */
export function getTokenUsageStats(
  days: number,
  chatJids?: string[],
): Array<{
  date: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_usd: number;
  message_count: number;
}> {
  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceStr = since.toISOString();

  const jidFilter =
    chatJids && chatJids.length > 0
      ? `AND m.chat_jid IN (${chatJids.map(() => '?').join(',')})`
      : '';
  const params: unknown[] = [sinceStr, ...(chatJids || [])];

  const baseQuery = `
    SELECT
      date(m.timestamp) as date,
      json_extract(m.token_usage, '$.modelUsage') as model_usage_json,
      json_extract(m.token_usage, '$.inputTokens') as input_tokens,
      json_extract(m.token_usage, '$.outputTokens') as output_tokens,
      json_extract(m.token_usage, '$.cacheReadInputTokens') as cache_read_tokens,
      json_extract(m.token_usage, '$.cacheCreationInputTokens') as cache_creation_tokens,
      json_extract(m.token_usage, '$.costUSD') as cost_usd
    FROM messages m
    WHERE m.token_usage IS NOT NULL
      AND m.timestamp >= ?
      ${jidFilter}
    ORDER BY m.timestamp ASC
  `;

  const rows = db.prepare(baseQuery).all(...params) as Array<{
    date: string;
    model_usage_json: string | null;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    cost_usd: number;
  }>;

  // Aggregate by date + model
  type AggregatedEntry = {
    date: string;
    model: string;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    cost_usd: number;
    message_count: number;
  };
  const aggregated = new Map<string, AggregatedEntry>();

  function addToAggregated(
    date: string,
    model: string,
    inputTokens: number,
    outputTokens: number,
    cacheReadTokens: number,
    cacheCreationTokens: number,
    costUsd: number,
  ): void {
    const key = `${date}|${model}`;
    const existing = aggregated.get(key);
    if (existing) {
      existing.input_tokens += inputTokens;
      existing.output_tokens += outputTokens;
      existing.cache_read_tokens += cacheReadTokens;
      existing.cache_creation_tokens += cacheCreationTokens;
      existing.cost_usd += costUsd;
      existing.message_count += 1;
    } else {
      aggregated.set(key, {
        date,
        model,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_tokens: cacheReadTokens,
        cache_creation_tokens: cacheCreationTokens,
        cost_usd: costUsd,
        message_count: 1,
      });
    }
  }

  for (const row of rows) {
    if (row.model_usage_json) {
      try {
        const modelUsage = JSON.parse(row.model_usage_json) as Record<
          string,
          { inputTokens: number; outputTokens: number; costUSD: number }
        >;
        for (const [model, usage] of Object.entries(modelUsage)) {
          addToAggregated(
            row.date,
            model,
            usage.inputTokens || 0,
            usage.outputTokens || 0,
            0,
            0,
            usage.costUSD || 0,
          );
        }
      } catch (e) {
        logger.warn(
          { date: row.date, error: e },
          'Failed to parse model_usage_json',
        );
        // fallback: use aggregate fields
        addToAggregated(
          row.date,
          'unknown',
          row.input_tokens || 0,
          row.output_tokens || 0,
          row.cache_read_tokens || 0,
          row.cache_creation_tokens || 0,
          row.cost_usd || 0,
        );
      }
    } else {
      addToAggregated(
        row.date,
        'unknown',
        row.input_tokens || 0,
        row.output_tokens || 0,
        row.cache_read_tokens || 0,
        row.cache_creation_tokens || 0,
        row.cost_usd || 0,
      );
    }
  }

  return Array.from(aggregated.values());
}

/**
 * Get token usage summary totals.
 */
export function getTokenUsageSummary(
  days: number,
  chatJids?: string[],
): {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  totalCostUSD: number;
  totalMessages: number;
  totalActiveDays: number;
} {
  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceStr = since.toISOString();

  const jidFilter =
    chatJids && chatJids.length > 0
      ? `AND chat_jid IN (${chatJids.map(() => '?').join(',')})`
      : '';
  const params: unknown[] = [sinceStr, ...(chatJids || [])];

  const row = db
    .prepare(
      `
    SELECT
      COALESCE(SUM(json_extract(token_usage, '$.inputTokens')), 0) as total_input,
      COALESCE(SUM(json_extract(token_usage, '$.outputTokens')), 0) as total_output,
      COALESCE(SUM(json_extract(token_usage, '$.cacheReadInputTokens')), 0) as total_cache_read,
      COALESCE(SUM(json_extract(token_usage, '$.cacheCreationInputTokens')), 0) as total_cache_creation,
      COALESCE(SUM(json_extract(token_usage, '$.costUSD')), 0) as total_cost,
      COUNT(*) as total_messages,
      COUNT(DISTINCT date(timestamp)) as total_active_days
    FROM messages
    WHERE token_usage IS NOT NULL AND timestamp >= ?
      ${jidFilter}
  `,
    )
    .get(...params) as {
    total_input: number;
    total_output: number;
    total_cache_read: number;
    total_cache_creation: number;
    total_cost: number;
    total_messages: number;
    total_active_days: number;
  };

  return {
    totalInputTokens: row.total_input,
    totalOutputTokens: row.total_output,
    totalCacheReadTokens: row.total_cache_read,
    totalCacheCreationTokens: row.total_cache_creation,
    totalCostUSD: row.total_cost,
    totalMessages: row.total_messages,
    totalActiveDays: row.total_active_days,
  };
}

/**
 * Get a local timezone date string (YYYY-MM-DD) from a Date or ISO string.
 */
function toLocalDateString(date?: Date | string): string {
  const d = date ? new Date(date) : new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Insert a usage record and update daily summary.
 */
export function insertUsageRecord(record: {
  userId: string;
  groupFolder: string;
  agentId?: string | null;
  messageId?: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD: number;
  durationMs?: number;
  numTurns?: number;
  source?: string;
}): void {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const localDate = toLocalDateString();

  db.transaction(() => {
    // Insert into usage_records
    db.prepare(
      `
      INSERT INTO usage_records (id, user_id, group_folder, agent_id, message_id, model,
        input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
        cost_usd, duration_ms, num_turns, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      id,
      record.userId,
      record.groupFolder,
      record.agentId ?? null,
      record.messageId ?? null,
      record.model,
      record.inputTokens,
      record.outputTokens,
      record.cacheReadInputTokens,
      record.cacheCreationInputTokens,
      record.costUSD,
      record.durationMs ?? 0,
      record.numTurns ?? 0,
      record.source ?? 'agent',
      now,
    );

    // Upsert daily summary
    db.prepare(
      `
      INSERT INTO usage_daily_summary (user_id, model, date,
        total_input_tokens, total_output_tokens,
        total_cache_read_tokens, total_cache_creation_tokens,
        total_cost_usd, request_count, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))
      ON CONFLICT(user_id, model, date) DO UPDATE SET
        total_input_tokens = total_input_tokens + excluded.total_input_tokens,
        total_output_tokens = total_output_tokens + excluded.total_output_tokens,
        total_cache_read_tokens = total_cache_read_tokens + excluded.total_cache_read_tokens,
        total_cache_creation_tokens = total_cache_creation_tokens + excluded.total_cache_creation_tokens,
        total_cost_usd = total_cost_usd + excluded.total_cost_usd,
        request_count = request_count + 1,
        updated_at = datetime('now')
    `,
    ).run(
      record.userId,
      record.model,
      localDate,
      record.inputTokens,
      record.outputTokens,
      record.cacheReadInputTokens,
      record.cacheCreationInputTokens,
      record.costUSD,
    );
  })();
}

/**
 * Get usage stats from daily summary table (fixes timezone + token KPI issues).
 */
export function getUsageDailyStats(
  days: number,
  userId?: string,
  modelFilter?: string,
): Array<{
  date: string;
  model: string;
  user_id: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_usd: number;
  request_count: number;
}> {
  const sinceDate = toLocalDateString(new Date(Date.now() - days * 86400000));
  const conditions: string[] = ['date >= ?'];
  const params: unknown[] = [sinceDate];

  if (userId) {
    conditions.push('user_id = ?');
    params.push(userId);
  }
  if (modelFilter) {
    conditions.push('model = ?');
    params.push(modelFilter);
  }

  const whereClause = conditions.join(' AND ');
  return db
    .prepare(
      `
    SELECT date, model, user_id,
      total_input_tokens as input_tokens,
      total_output_tokens as output_tokens,
      total_cache_read_tokens as cache_read_tokens,
      total_cache_creation_tokens as cache_creation_tokens,
      total_cost_usd as cost_usd,
      request_count
    FROM usage_daily_summary
    WHERE ${whereClause}
    ORDER BY date ASC
  `,
    )
    .all(...params) as Array<{
    date: string;
    model: string;
    user_id: string;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    cost_usd: number;
    request_count: number;
  }>;
}

/**
 * Get usage summary from daily summary table.
 */
export function getUsageDailySummary(
  days: number,
  userId?: string,
  modelFilter?: string,
): {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  totalCostUSD: number;
  totalMessages: number;
  totalActiveDays: number;
} {
  const sinceDate = toLocalDateString(new Date(Date.now() - days * 86400000));
  const conditions: string[] = ['date >= ?'];
  const params: unknown[] = [sinceDate];

  if (userId) {
    conditions.push('user_id = ?');
    params.push(userId);
  }
  if (modelFilter) {
    conditions.push('model = ?');
    params.push(modelFilter);
  }

  const whereClause = conditions.join(' AND ');
  const row = db
    .prepare(
      `
    SELECT
      COALESCE(SUM(total_input_tokens), 0) as total_input,
      COALESCE(SUM(total_output_tokens), 0) as total_output,
      COALESCE(SUM(total_cache_read_tokens), 0) as total_cache_read,
      COALESCE(SUM(total_cache_creation_tokens), 0) as total_cache_creation,
      COALESCE(SUM(total_cost_usd), 0) as total_cost,
      COALESCE(SUM(request_count), 0) as total_messages,
      COUNT(DISTINCT date) as total_active_days
    FROM usage_daily_summary
    WHERE ${whereClause}
  `,
    )
    .get(...params) as {
    total_input: number;
    total_output: number;
    total_cache_read: number;
    total_cache_creation: number;
    total_cost: number;
    total_messages: number;
    total_active_days: number;
  };

  return {
    totalInputTokens: row.total_input,
    totalOutputTokens: row.total_output,
    totalCacheReadTokens: row.total_cache_read,
    totalCacheCreationTokens: row.total_cache_creation,
    totalCostUSD: row.total_cost,
    totalMessages: row.total_messages,
    totalActiveDays: row.total_active_days,
  };
}

/**
 * Get list of all models that have usage data.
 */
export function getUsageModels(): string[] {
  const rows = db
    .prepare('SELECT DISTINCT model FROM usage_daily_summary ORDER BY model')
    .all() as Array<{ model: string }>;
  return rows.map((r) => r.model);
}

/**
 * Get list of users that have usage data.
 */
export function getUsageUsers(): Array<{ id: string; username: string }> {
  const rows = db
    .prepare(
      `
    SELECT DISTINCT uds.user_id as id, COALESCE(u.username, uds.user_id) as username
    FROM usage_daily_summary uds
    LEFT JOIN users u ON u.id = uds.user_id
    ORDER BY u.username
  `,
    )
    .all() as Array<{ id: string; username: string }>;
  return rows;
}

/**
 * Get the sender ID and message ID of the most recent non-bot message in a chat.
 * Optionally filter by source_jid (e.g., "feishu:oc_xxx") for accurate
 * attribution in multi-channel home containers.
 * The returned `id` is the original IM message ID (e.g., feishu om_xxx).
 */
export function getLastInboundMessage(
  chatJid: string,
  sourceJid?: string,
): { id: string; sender: string } | null {
  const sql = sourceJid
    ? `SELECT id, sender FROM messages WHERE chat_jid = ? AND source_jid = ? AND is_from_me = 0 ORDER BY timestamp DESC, id DESC LIMIT 1`
    : `SELECT id, sender FROM messages WHERE chat_jid = ? AND is_from_me = 0 ORDER BY timestamp DESC, id DESC LIMIT 1`;
  const row = sourceJid
    ? (db.prepare(sql).get(chatJid, sourceJid) as { id: string; sender: string } | undefined)
    : (db.prepare(sql).get(chatJid) as { id: string; sender: string } | undefined);
  return row || null;
}

export function getNewMessages(
  jids: string[],
  cursor: MessageCursor,
): { messages: DbMessage[]; newCursor: MessageCursor } {
  if (jids.length === 0) return { messages: [], newCursor: cursor };

  const placeholders = jids.map(() => '?').join(',');
  // Filter out assistant outputs.
  const sql = `
    SELECT rowid, id, chat_jid, source_jid, sender, sender_name, content, timestamp, attachments, reply_to_id
    FROM messages
    WHERE
      rowid > ?
      AND chat_jid IN (${placeholders})
      AND is_from_me = 0
    ORDER BY rowid ASC
  `;

  const rows = db
    .prepare(sql)
    .all(
      cursor.rowid,
      ...jids,
    ) as DbMessage[];
  const last = rows[rows.length - 1];
  return {
    messages: rows,
    newCursor: last ? { rowid: last.rowid } : cursor,
  };
}

export function getMessagesSince(
  chatJid: string,
  cursor: MessageCursor,
): DbMessage[] {
  // Filter out assistant outputs.
  const sql = `
    SELECT rowid, id, chat_jid, source_jid, sender, sender_name, content, timestamp, attachments, reply_to_id
    FROM messages
    WHERE
      chat_jid = ?
      AND rowid > ?
      AND is_from_me = 0
    ORDER BY rowid ASC
  `;
  return db
    .prepare(sql)
    .all(
      chatJid,
      cursor.rowid,
    ) as DbMessage[];
}

/**
 * Get ALL messages (both user and agent) since a cursor for transcript export.
 * Unlike getMessagesSince, this includes is_from_me messages.
 */
export function getTranscriptMessagesSince(
  chatJid: string,
  cursor: MessageCursor,
): Array<DbMessage & { is_from_me: boolean }> {
  const sql = `
    SELECT rowid, id, chat_jid, source_jid, sender, sender_name, content, timestamp, attachments, is_from_me
    FROM messages
    WHERE
      chat_jid = ?
      AND rowid > ?
    ORDER BY rowid ASC
  `;
  return db
    .prepare(sql)
    .all(chatJid, cursor.rowid) as Array<
    DbMessage & { is_from_me: boolean }
  >;
}

/**
 * Migration helper: look up the rowid of a message by its old-format
 * (timestamp, id) cursor. Falls back to MAX(rowid) at or before that
 * timestamp, or 0 if the table is empty / timestamp predates all rows.
 */
export function getRowidByCursor(timestamp: string, id: string): number {
  if (!timestamp) return 0;
  const exact = db
    .prepare('SELECT rowid FROM messages WHERE id = ? AND timestamp = ?')
    .get(id, timestamp) as { rowid: number } | undefined;
  if (exact) return exact.rowid;
  const fallback = db
    .prepare('SELECT MAX(rowid) as rowid FROM messages WHERE timestamp <= ?')
    .get(timestamp) as { rowid: number | null } | undefined;
  return fallback?.rowid ?? 0;
}

export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): void {
  db.prepare(
    `
    INSERT INTO scheduled_tasks (id, session_id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, execution_type, script_command, next_run, status, created_at, created_by, model)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    task.id,
    task.session_id ?? null,
    task.group_folder,
    task.chat_jid,
    task.prompt,
    task.schedule_type,
    task.schedule_value,
    task.context_mode || 'isolated',
    task.execution_type || 'agent',
    task.script_command ?? null,
    task.next_run,
    task.status,
    task.created_at,
    task.created_by ?? null,
    task.model ?? null,
  );
}

export function getTaskById(id: string): ScheduledTask | undefined {
  return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as
    | ScheduledTask
    | undefined;
}

export function getTasksForGroup(groupFolder: string): ScheduledTask[] {
  return db
    .prepare(
      'SELECT * FROM scheduled_tasks WHERE group_folder = ? ORDER BY created_at DESC',
    )
    .all(groupFolder) as ScheduledTask[];
}

export function getAllTasks(): ScheduledTask[] {
  return db
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as ScheduledTask[];
}

export function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      | 'prompt'
      | 'schedule_type'
      | 'schedule_value'
      | 'context_mode'
      | 'execution_type'
      | 'script_command'
      | 'next_run'
      | 'status'
    >
  > & { model?: string | null },
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(updates.prompt);
  }
  if (updates.schedule_type !== undefined) {
    fields.push('schedule_type = ?');
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push('schedule_value = ?');
    values.push(updates.schedule_value);
  }
  if (updates.context_mode !== undefined) {
    fields.push('context_mode = ?');
    values.push(updates.context_mode);
  }
  if (updates.execution_type !== undefined) {
    fields.push('execution_type = ?');
    values.push(updates.execution_type);
  }
  if (updates.script_command !== undefined) {
    fields.push('script_command = ?');
    values.push(updates.script_command);
  }
  if (updates.next_run !== undefined) {
    fields.push('next_run = ?');
    values.push(updates.next_run);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.model !== undefined) {
    fields.push('model = ?');
    values.push(updates.model);
  }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(
    `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function deleteTask(id: string): void {
  // Delete child records first (FK constraint)
  db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}

export function deleteTasksForGroup(groupFolder: string): void {
  const tx = db.transaction((folder: string) => {
    db.prepare(
      `
      DELETE FROM task_run_logs
      WHERE task_id IN (
        SELECT id FROM scheduled_tasks WHERE group_folder = ?
      )
      `,
    ).run(folder);
    db.prepare('DELETE FROM scheduled_tasks WHERE group_folder = ?').run(
      folder,
    );
  });
  tx(groupFolder);
}

export function getDueTasks(): ScheduledTask[] {
  const now = new Date().toISOString();
  return db
    .prepare(
      `
    SELECT * FROM scheduled_tasks
    WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
    ORDER BY next_run
  `,
    )
    .all(now) as ScheduledTask[];
}

export function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `
    UPDATE scheduled_tasks
    SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
    WHERE id = ?
  `,
  ).run(nextRun, now, lastResult, nextRun, id);
}

export function logTaskRun(log: TaskRunLog): void {
  db.prepare(
    `
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    log.task_id,
    log.run_at,
    log.duration_ms,
    log.status,
    log.result,
    log.error,
  );
}

export function cleanupOldTaskRunLogs(retentionDays = 30): number {
  const cutoff = new Date(
    Date.now() - retentionDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  const result = db
    .prepare(`DELETE FROM task_run_logs WHERE run_at < ?`)
    .run(cutoff);
  return result.changes;
}

// ── Context Summaries ───────────────────────────────────────

export interface ContextSummary {
  group_folder: string;
  chat_jid: string;
  summary: string;
  message_count: number;
  created_at: string;
  model_used: string | null;
}

export function getContextSummary(
  groupFolder: string,
  chatJid: string,
): ContextSummary | undefined {
  return db
    .prepare(
      'SELECT * FROM context_summaries WHERE group_folder = ? AND chat_jid = ?',
    )
    .get(groupFolder, chatJid) as ContextSummary | undefined;
}

export function setContextSummary(summary: ContextSummary): void {
  db.prepare(
    `INSERT OR REPLACE INTO context_summaries (group_folder, chat_jid, summary, message_count, created_at, model_used)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    summary.group_folder,
    summary.chat_jid,
    summary.summary,
    summary.message_count,
    summary.created_at,
    summary.model_used,
  );
}

export function deleteContextSummary(
  groupFolder: string,
  chatJid: string,
): void {
  db.prepare(
    'DELETE FROM context_summaries WHERE group_folder = ? AND chat_jid = ?',
  ).run(groupFolder, chatJid);
}

/**
 * Count messages in a chat since a given timestamp.
 * Used to check if enough new messages accumulated since last compression.
 */
export function countMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
): number {
  const row = db
    .prepare(
      'SELECT COUNT(*) as cnt FROM messages WHERE chat_jid = ? AND timestamp > ?',
    )
    .get(chatJid, sinceTimestamp) as { cnt: number } | undefined;
  return row?.cnt ?? 0;
}

// --- Router state accessors ---

export function getRouterState(key: string): string | undefined {
  const row = db
    .prepare('SELECT value FROM router_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setRouterState(key: string, value: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
  ).run(key, value);
}

// --- Session accessors ---

function buildMainSessionId(groupFolder: string): string {
  return `${MAIN_SESSION_ID_PREFIX}${groupFolder}`;
}

function buildWorkerSessionId(agentId: string): string {
  return `${WORKER_SESSION_ID_PREFIX}${agentId}`;
}

function buildMemorySessionId(ownerKey: string): string {
  return `${MEMORY_SESSION_ID_PREFIX}${ownerKey}`;
}

function resolveLegacySessionKey(
  groupFolder: string,
  agentId?: string | null,
): string {
  const effectiveAgentId = agentId?.trim();
  return effectiveAgentId
    ? buildWorkerSessionId(effectiveAgentId)
    : buildMainSessionId(groupFolder);
}

function parseSessionRecord(row: Record<string, unknown>): SessionRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    kind: row.kind as SessionKind,
    parent_session_id:
      typeof row.parent_session_id === 'string' ? row.parent_session_id : null,
    cwd: String(row.cwd),
    runner_id: normalizeStoredRunnerId(row.runner_id),
    runner_profile_id:
      typeof row.runner_profile_id === 'string' ? row.runner_profile_id : null,
    model: typeof row.model === 'string' ? row.model : null,
    thinking_effort:
      row.thinking_effort === 'low' ||
      row.thinking_effort === 'medium' ||
      row.thinking_effort === 'high'
        ? row.thinking_effort
        : null,
    context_compression:
      row.context_compression === 'auto' || row.context_compression === 'manual'
        ? (row.context_compression as 'auto' | 'manual')
        : 'off',
    is_pinned: Number(row.is_pinned || 0) === 1,
    archived: Number(row.archived || 0) === 1,
    owner_key: typeof row.owner_key === 'string' ? row.owner_key : null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function parseRunnerProfileRecord(
  row: Record<string, unknown>,
): RunnerProfileRecord {
  return {
    id: String(row.id),
    runner_id: normalizeStoredRunnerId(row.runner_id),
    name: String(row.name),
    config_json:
      typeof row.config_json === 'string' ? row.config_json : '{}',
    is_default: Number(row.is_default || 0) === 1,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function parseSessionBindingRecord(
  row: Record<string, unknown>,
): SessionBindingRecord {
  return {
    channel_jid: String(row.channel_jid),
    session_id: String(row.session_id),
    binding_mode: (row.binding_mode || 'source_only') as SessionBindingMode,
    activation_mode: parseActivationMode(
      typeof row.activation_mode === 'string' ? row.activation_mode : null,
    ),
    require_mention: Number(row.require_mention || 0) === 1,
    display_name:
      typeof row.display_name === 'string' ? row.display_name : null,
    reply_policy: row.reply_policy === 'mirror' ? 'mirror' : 'source_only',
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function parseSessionStateRow(
  row: Record<string, unknown>,
): SessionRuntimeStateRecord {
  return {
    session_id: String(row.session_id),
    provider_session_id:
      typeof row.provider_session_id === 'string'
        ? row.provider_session_id
        : null,
    resume_anchor:
      typeof row.resume_anchor === 'string' ? row.resume_anchor : null,
    provider_state_json:
      typeof row.provider_state_json === 'string'
        ? row.provider_state_json
        : null,
    recent_im_channels_json:
      typeof row.recent_im_channels_json === 'string'
        ? row.recent_im_channels_json
        : null,
    im_channel_last_seen_json:
      typeof row.im_channel_last_seen_json === 'string'
        ? row.im_channel_last_seen_json
        : null,
    current_permission_mode:
      typeof row.current_permission_mode === 'string'
        ? row.current_permission_mode
        : null,
    last_message_cursor:
      typeof row.last_message_cursor === 'string' ? row.last_message_cursor : null,
    updated_at: String(row.updated_at),
  };
}

function parseWorkerSessionRow(
  row: Record<string, unknown>,
): WorkerSessionRecord {
  return {
    session_id: String(row.session_id),
    parent_session_id: String(row.parent_session_id),
    source_chat_jid: String(row.source_chat_jid),
    name: String(row.name),
    kind: (row.kind as AgentKind) || 'task',
    prompt: String(row.prompt),
    status: (row.status as AgentStatus) || 'idle',
    created_at: String(row.created_at),
    completed_at:
      typeof row.completed_at === 'string' ? row.completed_at : null,
    result_summary:
      typeof row.result_summary === 'string' ? row.result_summary : null,
  };
}

function extractAgentIdFromWorkerSessionId(sessionId: string): string {
  return sessionId.startsWith(WORKER_SESSION_ID_PREFIX)
    ? sessionId.slice(WORKER_SESSION_ID_PREFIX.length)
    : sessionId;
}

function deriveWorkerGroupFolder(
  row: Record<string, unknown>,
): string {
  const parentSessionId =
    typeof row.parent_session_id === 'string' ? row.parent_session_id : '';
  if (parentSessionId.startsWith(MAIN_SESSION_ID_PREFIX)) {
    return parentSessionId.slice(MAIN_SESSION_ID_PREFIX.length);
  }
  const sourceChatJid =
    typeof row.source_chat_jid === 'string' ? row.source_chat_jid : '';
  const sourceGroup = sourceChatJid ? getRegisteredGroup(sourceChatJid) : undefined;
  return sourceGroup?.folder || '';
}

function mapWorkerAgentRow(row: Record<string, unknown>): SubAgent {
  const sessionId = String(row.session_id);
  return {
    id: extractAgentIdFromWorkerSessionId(sessionId),
    group_folder: deriveWorkerGroupFolder(row),
    chat_jid: String(row.source_chat_jid),
    name: String(row.name),
    prompt: String(row.prompt),
    status: (row.status as AgentStatus) || 'idle',
    kind: (row.kind as AgentKind) || 'task',
    created_by: typeof row.owner_key === 'string' ? row.owner_key : null,
    created_at: String(row.created_at),
    completed_at:
      typeof row.completed_at === 'string' ? row.completed_at : null,
    result_summary:
      typeof row.result_summary === 'string' ? row.result_summary : null,
  };
}

function deriveRunnerId(group?: unknown): SessionRecord['runner_id'] {
  void group;
  return getDefaultRunnerId();
}

function normalizeStoredRunnerId(
  raw: unknown,
  fallback: SessionRecord['runner_id'] = getDefaultRunnerId(),
): SessionRecord['runner_id'] {
  if (typeof raw !== 'string') return fallback;
  const runnerId = raw.trim();
  return runnerId || fallback;
}

function deriveSessionKind(group: RegisteredGroup): SessionKind {
  if (isPrimarySessionFolder(group.folder) || group.folder === 'main') {
    return 'main';
  }
  return 'workspace';
}

function isCompatibilityHomeGroup(jid: string, folder: string): boolean {
  if (!jid.startsWith('web:')) return false;
  return getSessionRecord(buildMainSessionId(folder))?.kind === 'main';
}

function deriveSessionCwd(group: RegisteredGroup): string {
  if (group.customCwd && path.isAbsolute(group.customCwd)) return group.customCwd;
  return path.join(GROUPS_DIR, group.folder);
}

function findPrimarySessionChannelForFolder(
  groupFolder: string,
): RegisteredGroup | undefined {
  const primary = getPrimarySessionChannelByFolder(groupFolder);
  if (primary) return primary;
  const candidates = getJidsByFolder(groupFolder)
    .map((jid) => getRegisteredGroup(jid))
    .filter((group): group is RegisteredGroup & { jid: string } => group != null);
  return candidates.find((group) => group.name.length > 0) || candidates[0];
}

function ensureSessionRecordFromGroup(
  jid: string,
  group: RegisteredGroup,
): string | null {
  if (!jid.startsWith('web:')) return null;
  const now = group.added_at || new Date().toISOString();
  const sessionId = buildMainSessionId(group.folder);
  const existing = getSessionRecord(sessionId);
  const resolvedRunnerId = existing?.runner_id || deriveRunnerId(group);
  db.prepare(
    `INSERT INTO sessions (
      id, name, kind, parent_session_id, cwd, runner_id, runner_profile_id,
      model, thinking_effort, context_compression, is_pinned, archived,
      owner_key, created_at, updated_at
    ) VALUES (?, ?, ?, NULL, ?, ?, NULL, ?, ?, ?, 0, 0, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      kind = excluded.kind,
      cwd = excluded.cwd,
      runner_id = excluded.runner_id,
      model = excluded.model,
      thinking_effort = excluded.thinking_effort,
      context_compression = excluded.context_compression,
      owner_key = excluded.owner_key,
      updated_at = excluded.updated_at`,
  ).run(
    sessionId,
    group.name,
    deriveSessionKind(group),
    deriveSessionCwd(group),
    resolvedRunnerId,
    group.model ?? null,
    group.thinking_effort ?? null,
    group.context_compression ?? 'off',
    existing?.owner_key ?? null,
    now,
    new Date().toISOString(),
  );
  return sessionId;
}

function ensureSessionRecordForLegacyKey(
  groupFolder: string,
  agentId?: string | null,
): string {
  const now = new Date().toISOString();
  const sessionId = resolveLegacySessionKey(groupFolder, agentId);
  const folderGroup = groupFolder
    ? findPrimarySessionChannelForFolder(groupFolder)
    : undefined;
  if (agentId?.trim()) {
    const parentSession = getSessionRecord(buildMainSessionId(groupFolder));
    if (!parentSession?.owner_key) {
      throw new Error(
        `Missing parent session owner for legacy worker session ${agentId} in ${groupFolder}`,
      );
    }
    db.prepare(
      `INSERT OR IGNORE INTO sessions (
        id, name, kind, parent_session_id, cwd, runner_id, runner_profile_id,
        model, thinking_effort, context_compression, is_pinned, archived,
        owner_key, created_at, updated_at
      ) VALUES (?, ?, 'worker', ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`,
    ).run(
      sessionId,
      agentId,
      buildMainSessionId(groupFolder),
      parentSession?.cwd || path.join(GROUPS_DIR, groupFolder),
      parentSession?.runner_id || deriveRunnerId(folderGroup || null),
      parentSession?.runner_profile_id || null,
      parentSession?.model || null,
      parentSession?.thinking_effort || null,
      parentSession?.context_compression || 'off',
      parentSession.owner_key,
      now,
      now,
    );
    return sessionId;
  }
  const folderOwnerKey = getSessionRecord(buildMainSessionId(groupFolder))?.owner_key ?? null;
  db.prepare(
    `INSERT OR IGNORE INTO sessions (
      id, name, kind, parent_session_id, cwd, runner_id, runner_profile_id,
      model, thinking_effort, context_compression, is_pinned, archived,
      owner_key, created_at, updated_at
    ) VALUES (?, ?, 'workspace', NULL, ?, ?, NULL, ?, ?, ?, 0, 0, ?, ?, ?)`,
  ).run(
    sessionId,
    groupFolder,
    folderGroup ? deriveSessionCwd(folderGroup) : path.join(GROUPS_DIR, groupFolder),
    deriveRunnerId(folderGroup || null),
    folderGroup?.model ?? null,
    folderGroup?.thinking_effort ?? null,
    folderGroup?.context_compression ?? 'off',
    folderOwnerKey,
    now,
    now,
  );
  return sessionId;
}

function syncSessionProjectionForGroup(
  jid: string,
  group: RegisteredGroup,
): void {
  ensureSessionRecordFromGroup(jid, group);
}

function deleteSessionProjectionForGroup(jid: string): void {
  const group = getRegisteredGroup(jid);
  if (jid.startsWith('web:') && group) {
    const sessionId = buildMainSessionId(group.folder);
    db.prepare('DELETE FROM session_bindings WHERE session_id = ?').run(sessionId);
    db.prepare('DELETE FROM session_state WHERE session_id = ?').run(sessionId);
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
  }
  db.prepare('DELETE FROM session_bindings WHERE channel_jid = ?').run(jid);
}

export function getSession(
  groupFolder: string,
  agentId?: string | null,
): string | undefined {
  const sessionKey = resolveLegacySessionKey(groupFolder, agentId);
  const row = db
    .prepare(
      'SELECT provider_session_id FROM session_state WHERE session_id = ?',
    )
    .get(sessionKey) as { provider_session_id: string } | undefined;
  return row?.provider_session_id;
}

export function setSession(
  groupFolder: string,
  sessionId: string,
  agentId?: string | null,
): void {
  const sessionKey = ensureSessionRecordForLegacyKey(groupFolder, agentId);
  db.prepare(
    `INSERT INTO session_state (session_id, provider_session_id, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       provider_session_id = excluded.provider_session_id,
       updated_at = excluded.updated_at`,
  ).run(sessionKey, sessionId, new Date().toISOString());
}

export function deleteSession(
  groupFolder: string,
  agentId?: string | null,
): void {
  db.prepare('DELETE FROM session_state WHERE session_id = ?').run(
    resolveLegacySessionKey(groupFolder, agentId),
  );
}

function deleteWorkerArtifactsForFolderRows(groupFolder: string): void {
  const mainSessionId = buildMainSessionId(groupFolder);
  const workerRows = db
    .prepare(
      `SELECT session_id, source_chat_jid
       FROM worker_sessions
       WHERE parent_session_id = ?`,
    )
    .all(mainSessionId) as Array<{
      session_id: string;
      source_chat_jid: string;
    }>;
  const sessionIds = new Set<string>();
  const virtualChatJids = new Set<string>();

  for (const row of workerRows) {
    const sessionId = String(row.session_id);
    const agentId = extractAgentIdFromWorkerSessionId(sessionId);
    sessionIds.add(sessionId);
    if (row.source_chat_jid) {
      virtualChatJids.add(`${row.source_chat_jid}#agent:${agentId}`);
    }
  }

  const sessionIdList = Array.from(sessionIds);
  if (sessionIdList.length > 0) {
    const placeholders = sessionIdList.map(() => '?').join(', ');
    db.prepare(
      `DELETE FROM session_bindings WHERE session_id IN (${placeholders})`,
    ).run(...sessionIdList);
    db.prepare(
      `DELETE FROM session_state WHERE session_id IN (${placeholders})`,
    ).run(...sessionIdList);
    db.prepare(
      `DELETE FROM worker_sessions WHERE session_id IN (${placeholders})`,
    ).run(...sessionIdList);
    db.prepare(
      `DELETE FROM sessions WHERE id IN (${placeholders})`,
    ).run(...sessionIdList);
  }

  const virtualChatJidList = Array.from(virtualChatJids);
  if (virtualChatJidList.length > 0) {
    const placeholders = virtualChatJidList.map(() => '?').join(', ');
    db.prepare(`DELETE FROM messages WHERE chat_jid IN (${placeholders})`).run(
      ...virtualChatJidList,
    );
    db.prepare(`DELETE FROM chats WHERE jid IN (${placeholders})`).run(
      ...virtualChatJidList,
    );
  }
}

export function clearWorkerArtifactsForFolder(groupFolder: string): void {
  const tx = db.transaction((folder: string) => {
    deleteWorkerArtifactsForFolderRows(folder);
  });
  tx(groupFolder);
}

export function deleteAllSessionsForFolder(groupFolder: string): void {
  const mainSessionId = buildMainSessionId(groupFolder);
  deleteWorkerArtifactsForFolderRows(groupFolder);
  db.prepare('DELETE FROM session_bindings WHERE session_id = ?').run(mainSessionId);
  db.prepare('DELETE FROM session_state WHERE session_id = ?').run(mainSessionId);
  db.prepare('DELETE FROM sessions WHERE id = ? OR parent_session_id = ?').run(
    mainSessionId,
    mainSessionId,
  );
}

export function getAllSessions(): Record<string, string> {
  const rows = db
    .prepare(
      'SELECT session_id, provider_session_id FROM session_state WHERE session_id LIKE ? AND provider_session_id IS NOT NULL',
    )
    .all(`${MAIN_SESSION_ID_PREFIX}%`) as Array<{
      session_id: string;
      provider_session_id: string;
    }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.session_id.slice(MAIN_SESSION_ID_PREFIX.length)] =
      row.provider_session_id;
  }
  return result;
}

export function getSessionRecord(id: string): SessionRecord | undefined {
  const row = db
    .prepare('SELECT * FROM sessions WHERE id = ?')
    .get(id) as Record<string, unknown> | undefined;
  return row ? parseSessionRecord(row) : undefined;
}

export function getPrimarySessionForOwner(
  ownerKey: string,
): SessionRecord | undefined {
  const rows = db
    .prepare(
      `SELECT * FROM sessions
       WHERE archived = 0
         AND owner_key = ?
         AND kind IN ('main', 'workspace')
       ORDER BY CASE kind WHEN 'main' THEN 0 ELSE 1 END, updated_at DESC, id ASC`,
    )
    .all(ownerKey) as Array<Record<string, unknown>>;
  return rows[0] ? parseSessionRecord(rows[0]) : undefined;
}

export function isPrimarySessionFolder(folder: string): boolean {
  return getSessionRecord(buildMainSessionId(folder))?.kind === 'main';
}

export function saveSessionRecord(session: SessionRecord): void {
  db.prepare(
    `INSERT INTO sessions (
      id, name, kind, parent_session_id, cwd, runner_id, runner_profile_id,
      model, thinking_effort, context_compression, is_pinned, archived,
      owner_key, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      kind = excluded.kind,
      parent_session_id = excluded.parent_session_id,
      cwd = excluded.cwd,
      runner_id = excluded.runner_id,
      runner_profile_id = excluded.runner_profile_id,
      model = excluded.model,
      thinking_effort = excluded.thinking_effort,
      context_compression = excluded.context_compression,
      is_pinned = excluded.is_pinned,
      archived = excluded.archived,
      owner_key = excluded.owner_key,
      updated_at = excluded.updated_at`,
  ).run(
    session.id,
    session.name,
    session.kind,
    session.parent_session_id,
    session.cwd,
    session.runner_id,
    session.runner_profile_id,
    session.model,
    session.thinking_effort,
    session.context_compression,
    session.is_pinned ? 1 : 0,
    session.archived ? 1 : 0,
    session.owner_key,
    session.created_at,
    session.updated_at,
  );
}

export function listSessionRecords(): SessionRecord[] {
  const rows = db
    .prepare('SELECT * FROM sessions WHERE archived = 0 ORDER BY kind, name, id')
    .all() as Array<Record<string, unknown>>;
  return rows.map(parseSessionRecord);
}

export function listRunnerProfiles(
  runnerId?: RunnerProfileRecord['runner_id'],
): RunnerProfileRecord[] {
  const rows = runnerId
    ? db
        .prepare(
          'SELECT * FROM runner_profiles WHERE runner_id = ? ORDER BY is_default DESC, updated_at DESC, name ASC',
        )
        .all(runnerId)
    : db
        .prepare(
          'SELECT * FROM runner_profiles ORDER BY runner_id ASC, is_default DESC, updated_at DESC, name ASC',
        )
        .all();
  return (rows as Array<Record<string, unknown>>).map(parseRunnerProfileRecord);
}

export function getRunnerProfile(id: string): RunnerProfileRecord | undefined {
  const row = db
    .prepare('SELECT * FROM runner_profiles WHERE id = ?')
    .get(id) as Record<string, unknown> | undefined;
  return row ? parseRunnerProfileRecord(row) : undefined;
}

export function saveRunnerProfile(profile: RunnerProfileRecord): void {
  const now = profile.updated_at || new Date().toISOString();
  const createdAt = profile.created_at || now;
  const tx = db.transaction(() => {
    if (profile.is_default) {
      db.prepare(
        'UPDATE runner_profiles SET is_default = 0, updated_at = ? WHERE runner_id = ? AND id != ?',
      ).run(now, profile.runner_id, profile.id);
    }
    db.prepare(
      `INSERT INTO runner_profiles (
        id, runner_id, name, config_json, is_default, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        runner_id = excluded.runner_id,
        name = excluded.name,
        config_json = excluded.config_json,
        is_default = excluded.is_default,
        updated_at = excluded.updated_at`,
    ).run(
      profile.id,
      profile.runner_id,
      profile.name,
      profile.config_json,
      profile.is_default ? 1 : 0,
      createdAt,
      now,
    );
  });
  tx();
}

export function deleteRunnerProfile(id: string): void {
  db.prepare('DELETE FROM runner_profiles WHERE id = ?').run(id);
}

export function listSessionBindings(): SessionBindingRecord[] {
  const rows = db
    .prepare('SELECT * FROM session_bindings ORDER BY updated_at DESC')
    .all() as Array<Record<string, unknown>>;
  return rows.map(parseSessionBindingRecord);
}

export function saveSessionBinding(binding: SessionBindingRecord): void {
  db.prepare(
    `INSERT INTO session_bindings (
      channel_jid, session_id, binding_mode, activation_mode, require_mention,
      display_name, reply_policy, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(channel_jid) DO UPDATE SET
      session_id = excluded.session_id,
      binding_mode = excluded.binding_mode,
      activation_mode = excluded.activation_mode,
      require_mention = excluded.require_mention,
      display_name = excluded.display_name,
      reply_policy = excluded.reply_policy,
      updated_at = excluded.updated_at`,
  ).run(
    binding.channel_jid,
    binding.session_id,
    binding.binding_mode,
    binding.activation_mode,
    binding.require_mention ? 1 : 0,
    binding.display_name,
    binding.reply_policy,
    binding.created_at,
    binding.updated_at,
  );
}

export function deleteSessionBinding(channelJid: string): void {
  db.prepare('DELETE FROM session_bindings WHERE channel_jid = ?').run(channelJid);
}

export function updateSessionBindingPolicies(
  sessionId: string,
  updates: {
    activation_mode?: SessionBindingRecord['activation_mode'];
    require_mention?: boolean;
    reply_policy?: SessionBindingRecord['reply_policy'];
  },
): number {
  const sets: string[] = [];
  const params: unknown[] = [];

  if (updates.activation_mode !== undefined) {
    sets.push('activation_mode = ?');
    params.push(updates.activation_mode);
  }
  if (updates.require_mention !== undefined) {
    sets.push('require_mention = ?');
    params.push(updates.require_mention ? 1 : 0);
  }
  if (updates.reply_policy !== undefined) {
    sets.push('reply_policy = ?');
    params.push(updates.reply_policy);
  }
  if (sets.length === 0) return 0;

  sets.push('updated_at = ?');
  params.push(new Date().toISOString(), sessionId);

  const result = db
    .prepare(
      `UPDATE session_bindings
       SET ${sets.join(', ')}
       WHERE session_id = ?`,
    )
    .run(...params);
  return result.changes;
}

export function getSessionBinding(
  channelJid: string,
): SessionBindingRecord | undefined {
  const row = db
    .prepare('SELECT * FROM session_bindings WHERE channel_jid = ?')
    .get(channelJid) as Record<string, unknown> | undefined;
  return row ? parseSessionBindingRecord(row) : undefined;
}

export function getWorkerSessionRecord(
  sessionId: string,
): WorkerSessionRecord | undefined {
  const row = db
    .prepare('SELECT * FROM worker_sessions WHERE session_id = ?')
    .get(sessionId) as Record<string, unknown> | undefined;
  return row ? parseWorkerSessionRow(row) : undefined;
}

export function getSessionRuntimeState(
  sessionId: string,
): SessionRuntimeStateRecord | undefined {
  const row = db
    .prepare('SELECT * FROM session_state WHERE session_id = ?')
    .get(sessionId) as Record<string, unknown> | undefined;
  return row ? parseSessionStateRow(row) : undefined;
}

export function upsertSessionRuntimeState(
  sessionId: string,
  snapshot: RuntimeStateSnapshot,
): void {
  if (sessionId.startsWith(MAIN_SESSION_ID_PREFIX)) {
    ensureSessionRecordForLegacyKey(
      sessionId.slice(MAIN_SESSION_ID_PREFIX.length),
    );
  } else if (sessionId.startsWith(WORKER_SESSION_ID_PREFIX)) {
    ensureSessionRecordForLegacyKey(
      '',
      sessionId.slice(WORKER_SESSION_ID_PREFIX.length),
    );
  }
  db.prepare(
    `INSERT INTO session_state (
      session_id, provider_session_id, resume_anchor, provider_state_json,
      recent_im_channels_json, im_channel_last_seen_json, current_permission_mode,
      last_message_cursor, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      provider_session_id = excluded.provider_session_id,
      resume_anchor = excluded.resume_anchor,
      provider_state_json = excluded.provider_state_json,
      recent_im_channels_json = excluded.recent_im_channels_json,
      im_channel_last_seen_json = excluded.im_channel_last_seen_json,
      current_permission_mode = excluded.current_permission_mode,
      last_message_cursor = excluded.last_message_cursor,
      updated_at = excluded.updated_at`,
  ).run(
    sessionId,
    snapshot.providerSessionId ?? null,
    snapshot.resumeAnchor ?? null,
    snapshot.providerState ? JSON.stringify(snapshot.providerState) : null,
    JSON.stringify(snapshot.recentImChannels ?? []),
    JSON.stringify(snapshot.imChannelLastSeen ?? {}),
    snapshot.currentPermissionMode ?? null,
    snapshot.lastMessageCursor ?? null,
    new Date().toISOString(),
  );
}

export function deleteSessionRuntimeState(sessionId: string): void {
  db.prepare('DELETE FROM session_state WHERE session_id = ?').run(sessionId);
}

// --- Session channel accessors ---

function parseGroupRow(
  row: SessionChannelRow,
): RegisteredGroup & { jid: string } {
  const folder = resolveFolderFromSessionId(row.session_id);
  const group: RegisteredGroup & { jid: string } = {
    jid: row.jid,
    name: row.name,
    folder,
    added_at: row.created_at,
    containerConfig: row.container_config
      ? JSON.parse(row.container_config)
      : undefined,
    customCwd: row.custom_cwd ?? undefined,
    initSourcePath: row.init_source_path ?? undefined,
    initGitUrl: row.init_git_url ?? undefined,
    is_home: isCompatibilityHomeGroup(row.jid, folder),
    selected_skills: row.selected_skills
      ? JSON.parse(row.selected_skills)
      : null,
    mcp_mode: row.mcp_mode === 'custom' ? 'custom' : 'inherit',
    selected_mcps: row.selected_mcps ? JSON.parse(row.selected_mcps) : null,
    model: row.model ?? undefined,
    thinking_effort: parseThinkingEffort(row.thinking_effort),
    context_compression: parseCompressionMode(row.context_compression),
  };
  if (!row.jid.startsWith('web:')) {
    const binding = getSessionBinding(row.jid);
    group.reply_policy = binding?.reply_policy ?? 'source_only';
    group.require_mention = binding?.require_mention === true;
    group.activation_mode = binding?.activation_mode ?? 'auto';
  }
  return group;
}

function parseThinkingEffort(
  val: string | null,
): 'low' | 'medium' | 'high' | undefined {
  if (val === 'low' || val === 'medium' || val === 'high') return val;
  return undefined;
}

function parseCompressionMode(
  val: string | null,
): 'off' | 'auto' | 'manual' | undefined {
  if (val === 'auto' || val === 'manual') return val;
  if (val === 'off') return 'off';
  return undefined;
}

const VALID_ACTIVATION_MODES = new Set([
  'auto',
  'always',
  'when_mentioned',
  'disabled',
]);

function parseActivationMode(
  raw: string | null,
): 'auto' | 'always' | 'when_mentioned' | 'disabled' {
  if (raw && VALID_ACTIVATION_MODES.has(raw))
    return raw as 'auto' | 'always' | 'when_mentioned' | 'disabled';
  return 'auto';
}

function resolveSessionOwnerKeyFromSessionId(
  sessionId: string | null | undefined,
): string | null {
  if (!sessionId) return null;
  const session = getSessionRecord(sessionId);
  if (session?.owner_key) return session.owner_key;
  if (!session?.parent_session_id) return null;
  return getSessionRecord(session.parent_session_id)?.owner_key ?? null;
}

function resolveRegisteredGroupOwnerKey(
  jid: string,
  fallbackGroup?: RegisteredGroup,
): string | null {
  const binding = getSessionBinding(jid);
  const boundOwnerKey = resolveSessionOwnerKeyFromSessionId(binding?.session_id);
  if (boundOwnerKey) return boundOwnerKey;

  const group = fallbackGroup ?? getRegisteredGroup(jid);
  if (!group) return null;
  return getSessionRecord(buildMainSessionId(group.folder))?.owner_key ?? null;
}

export function getRegisteredGroup(
  jid: string,
): (RegisteredGroup & { jid: string }) | undefined {
  const row = db
    .prepare('SELECT * FROM session_channels WHERE jid = ?')
    .get(jid) as SessionChannelRow | undefined;
  if (!row) return undefined;
  return parseGroupRow(row);
}

export function setRegisteredGroup(jid: string, group: RegisteredGroup): void {
  db.prepare(
    `INSERT OR REPLACE INTO session_channels (
      jid, session_id, name, created_at, container_config, custom_cwd,
      init_source_path, init_git_url, selected_skills, mcp_mode,
      selected_mcps, model, thinking_effort, context_compression
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jid,
    buildMainSessionId(group.folder),
    group.name,
    group.added_at,
    group.containerConfig ? JSON.stringify(group.containerConfig) : null,
    group.customCwd ?? null,
    group.initSourcePath ?? null,
    group.initGitUrl ?? null,
    group.selected_skills ? JSON.stringify(group.selected_skills) : null,
    group.mcp_mode ?? 'inherit',
    group.selected_mcps ? JSON.stringify(group.selected_mcps) : null,
    group.model ?? null,
    group.thinking_effort ?? null,
    group.context_compression ?? 'off',
  );
  if (!jid.startsWith('web:')) {
    const currentBinding = getSessionBinding(jid);
    const sessionId = currentBinding?.session_id || buildMainSessionId(group.folder);
    const session = getSessionRecord(sessionId);
    const now = new Date().toISOString();
    const replyPolicy = group.reply_policy ?? currentBinding?.reply_policy ?? 'source_only';
    const activationMode = group.activation_mode ?? currentBinding?.activation_mode ?? 'auto';
    const requireMention =
      group.require_mention ?? currentBinding?.require_mention ?? false;
    saveSessionBinding({
      channel_jid: jid,
      session_id: sessionId,
      binding_mode:
        replyPolicy === 'mirror'
          ? 'mirror'
          : session?.kind === 'worker'
            ? 'direct'
            : 'source_only',
      activation_mode: activationMode,
      require_mention: requireMention,
      display_name: group.name,
      reply_policy: replyPolicy,
      created_at: currentBinding?.created_at || group.added_at || now,
      updated_at: now,
    });
  }
  syncSessionProjectionForGroup(jid, group);
  const sessionOwnerKey = resolveRegisteredGroupOwnerKey(jid, group);
  if (sessionOwnerKey) {
    syncMemorySessionProjectionForOwner(sessionOwnerKey);
  }
}

export function deleteRegisteredGroup(jid: string): void {
  deleteSessionProjectionForGroup(jid);
  db.prepare('DELETE FROM session_bindings WHERE channel_jid = ?').run(jid);
  db.prepare('DELETE FROM session_channels WHERE jid = ?').run(jid);
}

/** Get all JIDs that share the same folder (e.g., all JIDs with folder='main'). */
export function getJidsByFolder(folder: string): string[] {
  const sessionId = buildMainSessionId(folder);
  const rows = db
    .prepare('SELECT jid FROM session_channels WHERE session_id = ?')
    .all(sessionId) as Array<{ jid: string }>;
  return rows.map((r) => r.jid);
}

export function getAllRegisteredGroups(): Record<string, RegisteredGroup> {
  const rows = db
    .prepare('SELECT * FROM session_channels')
    .all() as SessionChannelRow[];
  const result: Record<string, RegisteredGroup> = {};
  for (const row of rows) {
    result[row.jid] = parseGroupRow(row);
  }
  return result;
}

function syncSessionWorkbenchProjection(): void {
  const groups = getAllRegisteredGroups();
  for (const [jid, group] of Object.entries(groups)) {
    syncSessionProjectionForGroup(jid, group);
  }

  if (tableExists('provider_sessions_legacy')) {
    const legacyHasAgentId = hasColumn('provider_sessions_legacy', 'agent_id');
    const rows = db
      .prepare(
        legacyHasAgentId
          ? 'SELECT group_folder, session_id, COALESCE(agent_id, \'\') AS agent_id FROM provider_sessions_legacy'
          : "SELECT group_folder, session_id, '' AS agent_id FROM provider_sessions_legacy",
      )
      .all() as Array<{
      group_folder: string;
      session_id: string;
      agent_id: string;
    }>;
    for (const row of rows) {
      const stableSessionId = ensureSessionRecordForLegacyKey(
        row.group_folder,
        row.agent_id || undefined,
      );
      db.prepare(
        `INSERT INTO session_state (session_id, provider_session_id, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           provider_session_id = excluded.provider_session_id,
           updated_at = excluded.updated_at`,
      ).run(stableSessionId, row.session_id, new Date().toISOString());
    }
  }

  if (tableExists('agents')) {
    const agents = db.prepare('SELECT * FROM agents').all() as Array<
      Record<string, unknown>
    >;
    for (const agentRow of agents) {
      syncWorkerSession(mapLegacyAgentRow(agentRow));
    }
    db.exec('DROP TABLE agents');
  }

  const memoryOwners = new Set(
    listSessionRecords()
      .filter(
        (session) =>
          session.owner_key &&
          (session.kind === 'main' || session.kind === 'workspace'),
      )
      .map((session) => session.owner_key!),
  );
  for (const ownerKey of memoryOwners) {
    syncMemorySessionProjectionForOwner(ownerKey);
  }
}

function syncMemorySessionProjectionForOwner(ownerKey: string): void {
  const sessionId = buildMemorySessionId(ownerKey);
  const primarySession = getPrimarySessionForOwner(ownerKey);
  const existing = getSessionRecord(sessionId);
  const now = new Date().toISOString();
  const resolvedRunnerId = resolveMemoryRunnerId(
    existing?.runner_id || primarySession?.runner_id || null,
  );
  const runnerProfileId =
    existing?.runner_id === resolvedRunnerId
      ? existing.runner_profile_id
      : primarySession?.runner_id === resolvedRunnerId
        ? primarySession.runner_profile_id
        : null;
  const model =
    existing?.runner_id === resolvedRunnerId
      ? existing.model
      : primarySession?.runner_id === resolvedRunnerId
        ? primarySession.model
        : null;
  const thinkingEffort =
    existing?.runner_id === resolvedRunnerId
      ? existing.thinking_effort
      : primarySession?.runner_id === resolvedRunnerId
        ? primarySession.thinking_effort
        : null;
  const contextCompression =
    existing?.context_compression
      || primarySession?.context_compression
      || 'off';
  db.prepare(
    `INSERT INTO sessions (
      id, name, kind, parent_session_id, cwd, runner_id, runner_profile_id,
      model, thinking_effort, context_compression, is_pinned, archived,
      owner_key, created_at, updated_at
    ) VALUES (?, ?, 'memory', ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      parent_session_id = excluded.parent_session_id,
      cwd = excluded.cwd,
      runner_id = excluded.runner_id,
      runner_profile_id = excluded.runner_profile_id,
      model = excluded.model,
      thinking_effort = excluded.thinking_effort,
      context_compression = excluded.context_compression,
      owner_key = excluded.owner_key,
      updated_at = excluded.updated_at`,
  ).run(
    sessionId,
    existing?.name || `memory:${ownerKey}`,
    primarySession?.id ?? null,
    path.join(DATA_DIR, 'memory', ownerKey),
    resolvedRunnerId,
    runnerProfileId,
    model,
    thinkingEffort,
    contextCompression,
    ownerKey,
    existing?.created_at || now,
    now,
  );
}

/**
 * Get all registered groups that route to a specific conversation agent.
 * Returns array of { jid, group } for each IM group targeting the given agentId.
 */
export function getGroupsByTargetAgent(
  agentId: string,
): Array<{ jid: string; group: RegisteredGroup }> {
  const sessionId = buildWorkerSessionId(agentId);
  const rows = db
    .prepare(
      `SELECT sc.*
       FROM session_bindings sb
       JOIN session_channels sc ON sc.jid = sb.channel_jid
       WHERE sb.session_id = ?`,
    )
    .all(sessionId) as SessionChannelRow[];
  return rows.map((row) => ({ jid: row.jid, group: parseGroupRow(row) }));
}

/**
 * Get all registered groups that route to a specific workspace's main conversation.
 */
export function getGroupsByTargetMainJid(
  webJid: string,
): Array<{ jid: string; group: RegisteredGroup }> {
  const targetChannel = db
    .prepare('SELECT session_id FROM session_channels WHERE jid = ?')
    .get(webJid) as { session_id: string } | undefined;
  if (!targetChannel?.session_id) return [];
  const rows = db
    .prepare(
      `SELECT sc.*
       FROM session_bindings sb
       JOIN session_channels sc ON sc.jid = sb.channel_jid
       WHERE sb.session_id = ?`,
    )
    .all(targetChannel.session_id) as SessionChannelRow[];
  return rows.map((row) => ({ jid: row.jid, group: parseGroupRow(row) }));
}

/**
 * Find the primary-session web compatibility channel for a folder.
 * Used to resolve the owner of IM channels that share that Session workspace.
 */
export function getPrimarySessionChannelByFolder(
  folder: string,
): (RegisteredGroup & { jid: string }) | undefined {
  const session = getSessionRecord(buildMainSessionId(folder));
  if (!session || session.kind !== 'main') return undefined;
  const row = db
    .prepare(
      "SELECT * FROM session_channels WHERE session_id = ? AND jid LIKE 'web:%' LIMIT 1",
    )
    .get(buildMainSessionId(folder)) as SessionChannelRow | undefined;
  if (!row) return undefined;
  return parseGroupRow(row);
}

/**
 * Find a user's primary-session web compatibility channel from the owner mapping.
 * For admin users, also matches web:main as a final compatibility fallback.
 */
export function getUserPrimarySessionChannel(
  userId: string,
): (RegisteredGroup & { jid: string }) | undefined {
  const session = db
    .prepare(
      `SELECT * FROM sessions
       WHERE kind = 'main' AND owner_key = ?
       ORDER BY updated_at DESC, id ASC
       LIMIT 1`,
    )
    .get(userId) as Record<string, unknown> | undefined;
  if (session) {
    const parsed = parseSessionRecord(session);
    const folder = parsed.id.startsWith(MAIN_SESSION_ID_PREFIX)
      ? parsed.id.slice(MAIN_SESSION_ID_PREFIX.length)
      : null;
    if (folder) {
      return getPrimarySessionChannelByFolder(folder);
    }
  }

  const user = db
    .prepare("SELECT role FROM users WHERE id = ? AND status = 'active'")
    .get(userId) as { role: string } | undefined;
  if (user?.role !== 'admin') return undefined;
  return getPrimarySessionChannelByFolder('main');
}

/**
 * Ensure a user has a primary-session web compatibility channel. If not, create one.
 * Single-user migration keeps this web row backed by a main session.
 * Returns the compatibility channel JID.
 */
export function ensureUserPrimarySessionChannel(
  userId: string,
  role: 'admin' | 'member',
  username?: string,
): string {
  const existing = getUserPrimarySessionChannel(userId);
  if (existing) return existing.jid;

  const now = new Date().toISOString();
  const isAdmin = role === 'admin';
  const jid = isAdmin ? 'web:main' : `web:home-${userId}`;
  const folder = isAdmin ? 'main' : `home-${userId}`;

  const sessionId = buildMainSessionId(folder);

  // For admin: check if web:main already exists and backfill the main session owner.
  if (isAdmin) {
    const existingMain = getRegisteredGroup(jid);
    if (existingMain) {
      const existingSession = getSessionRecord(sessionId);
      if (!existingSession?.owner_key) {
        saveSessionRecord({
          id: sessionId,
          name: existingSession?.name || existingMain.name,
          kind: 'main',
          parent_session_id: null,
          cwd: existingSession?.cwd || path.join(GROUPS_DIR, folder),
          runner_id: existingSession?.runner_id || getDefaultRunnerId(),
          runner_profile_id: existingSession?.runner_profile_id ?? null,
          model: existingSession?.model ?? null,
          thinking_effort: existingSession?.thinking_effort ?? null,
          context_compression: existingSession?.context_compression || 'off',
          is_pinned: existingSession?.is_pinned ?? false,
          archived: existingSession?.archived ?? false,
          owner_key: userId,
          created_at: existingSession?.created_at || now,
          updated_at: now,
        });
      }
      ensureChatExists(jid);
      return jid;
    }
  }

  const name = username ? `${username} Home` : isAdmin ? 'Main' : 'Home';

  const group: RegisteredGroup = {
    name,
    folder,
    added_at: now,
  };

  saveSessionRecord({
    id: sessionId,
    name,
    kind: 'main',
    parent_session_id: null,
    cwd: path.join(GROUPS_DIR, folder),
    runner_id: getDefaultRunnerId(),
    runner_profile_id: null,
    model: null,
    thinking_effort: null,
    context_compression: 'off',
    is_pinned: false,
    archived: false,
    owner_key: userId,
    created_at: now,
    updated_at: now,
  });
  setRegisteredGroup(jid, group);

  // Ensure chat row exists
  ensureChatExists(jid);

  // Create user-global memory directory and initialize CLAUDE.md from template
  const userGlobalDir = path.join(GROUPS_DIR, 'user-global', userId);
  fs.mkdirSync(userGlobalDir, { recursive: true });
  const userClaudeMd = path.join(userGlobalDir, 'CLAUDE.md');
  if (!fs.existsSync(userClaudeMd)) {
    const templatePath = path.resolve(
      process.cwd(),
      'config',
      'global-claude-md.template.md',
    );
    if (fs.existsSync(templatePath)) {
      try {
        fs.writeFileSync(userClaudeMd, fs.readFileSync(templatePath, 'utf-8'), {
          flag: 'wx',
        });
      } catch {
        // EEXIST race or read error — ignore
      }
    }
  }

  return jid;
}

export function deleteChatHistory(chatJid: string): void {
  const tx = db.transaction((jid: string) => {
    db.prepare('DELETE FROM messages WHERE chat_jid = ?').run(jid);
    db.prepare('DELETE FROM chats WHERE jid = ?').run(jid);
  });
  tx(chatJid);
}

export function deleteGroupData(jid: string, folder: string): void {
  const tx = db.transaction(() => {
    // 1. 删除定时任务运行日志 + 定时任务
    db.prepare(
      'DELETE FROM task_run_logs WHERE task_id IN (SELECT id FROM scheduled_tasks WHERE group_folder = ?)',
    ).run(folder);
    db.prepare('DELETE FROM scheduled_tasks WHERE group_folder = ?').run(
      folder,
    );
    // 2. 删除注册信息
    db.prepare('DELETE FROM session_channels WHERE jid = ?').run(jid);
    // 3. 删除会话
    deleteAllSessionsForFolder(folder);
    db.prepare('DELETE FROM session_bindings WHERE channel_jid = ?').run(jid);
    // 4. 删除聊天记录
    db.prepare('DELETE FROM messages WHERE chat_jid = ?').run(jid);
    db.prepare('DELETE FROM chats WHERE jid = ?').run(jid);
  });
  tx();
}

// --- Web API accessors ---

/**
 * Get paginated messages for a chat, cursor-based pagination.
 * Returns messages in descending timestamp order (newest first).
 */
export function getMessagesPage(
  chatJid: string,
  before?: string,
  limit = 50,
): Array<NewMessage & { is_from_me: boolean }> {
  const sql = before
    ? `
      SELECT id, chat_jid, source_jid, sender, sender_name, content, timestamp, is_from_me, attachments, token_usage
      FROM messages
      WHERE chat_jid = ? AND timestamp < ?
      ORDER BY timestamp DESC
      LIMIT ?
    `
    : `
      SELECT id, chat_jid, source_jid, sender, sender_name, content, timestamp, is_from_me, attachments, token_usage
      FROM messages
      WHERE chat_jid = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `;

  const params = before ? [chatJid, before, limit] : [chatJid, limit];
  const rows = db.prepare(sql).all(...params) as Array<
    NewMessage & { is_from_me: number }
  >;

  return rows.map((row) => ({
    ...row,
    is_from_me: row.is_from_me === 1,
  }));
}

/**
 * Get messages after a given timestamp (for polling new messages).
 * Returns in ASC order (oldest first).
 */
export function getMessagesAfter(
  chatJid: string,
  after: string,
  limit = 50,
): Array<NewMessage & { is_from_me: boolean }> {
  const rows = db
    .prepare(
      `SELECT id, chat_jid, source_jid, sender, sender_name, content, timestamp, is_from_me, attachments, token_usage
       FROM messages
       WHERE chat_jid = ? AND timestamp > ?
       ORDER BY timestamp ASC
       LIMIT ?`,
    )
    .all(chatJid, after, limit) as Array<NewMessage & { is_from_me: number }>;

  return rows.map((row) => ({
    ...row,
    is_from_me: row.is_from_me === 1,
  }));
}

/**
 * 多 JID 分页查询（用于主容器合并 web:main + feishu:xxx 消息）。
 */
export function getMessagesPageMulti(
  chatJids: string[],
  before?: string,
  limit = 50,
): Array<NewMessage & { is_from_me: boolean }> {
  if (chatJids.length === 0) return [];
  if (chatJids.length === 1) return getMessagesPage(chatJids[0], before, limit);

  const placeholders = chatJids.map(() => '?').join(',');
  const sql = before
    ? `SELECT id, chat_jid, source_jid, sender, sender_name, content, timestamp, is_from_me, attachments, token_usage
       FROM messages
       WHERE chat_jid IN (${placeholders}) AND timestamp < ?
       ORDER BY timestamp DESC
       LIMIT ?`
    : `SELECT id, chat_jid, source_jid, sender, sender_name, content, timestamp, is_from_me, attachments, token_usage
       FROM messages
       WHERE chat_jid IN (${placeholders})
       ORDER BY timestamp DESC
       LIMIT ?`;

  const params = before ? [...chatJids, before, limit] : [...chatJids, limit];
  const rows = db.prepare(sql).all(...params) as Array<
    NewMessage & { is_from_me: number }
  >;

  return rows.map((row) => ({
    ...row,
    is_from_me: row.is_from_me === 1,
  }));
}

/**
 * 多 JID 增量查询（用于主容器轮询合并消息）。
 */
export function getMessagesAfterMulti(
  chatJids: string[],
  after: string,
  limit = 50,
): Array<NewMessage & { is_from_me: boolean }> {
  if (chatJids.length === 0) return [];
  if (chatJids.length === 1) return getMessagesAfter(chatJids[0], after, limit);

  const placeholders = chatJids.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT id, chat_jid, source_jid, sender, sender_name, content, timestamp, is_from_me, attachments, token_usage
       FROM messages
       WHERE chat_jid IN (${placeholders}) AND timestamp > ?
       ORDER BY timestamp ASC
       LIMIT ?`,
    )
    .all(...chatJids, after, limit) as Array<
    NewMessage & { is_from_me: number }
  >;

  return rows.map((row) => ({
    ...row,
    is_from_me: row.is_from_me === 1,
  }));
}

// --- FTS5 full-text search ---

export interface SearchResult {
  id: string;
  chat_jid: string;
  source_jid?: string;
  sender: string;
  sender_name: string;
  content: string;
  snippet: string;
  timestamp: string;
  is_from_me: boolean;
  attachments?: string;
}

/**
 * Search messages by content using FTS5.
 * Supports single or multiple JIDs for compatibility channel aggregation.
 * @param sinceTs - Optional ISO timestamp to limit results to messages after this time
 */
export function searchMessages(
  chatJids: string[],
  query: string,
  limit = 50,
  offset = 0,
  sinceTs?: string,
): SearchResult[] {
  if (chatJids.length === 0 || !query.trim()) return [];

  const sanitized = query.trim();
  if (!sanitized) return [];

  // Word-boundary prefix matching: LIKE pre-filters candidates, then word_match()
  // ensures the term appears at a word boundary (not mid-word).
  // e.g. "kill" matches "kill 2035" but NOT "skill"; "e33" matches "e33ecs".
  const terms = sanitized.split(/\s+/).filter(Boolean);
  const likeConditions = terms
    .map(() => '(m.content LIKE ? ESCAPE \'\\\' AND word_match(m.content, ?) = 1)')
    .join(' AND ');
  const likeParams = terms.flatMap((t) => [
    `%${t.replace(/%/g, '\\%').replace(/_/g, '\\_')}%`,
    t,
  ]);

  const placeholders = chatJids.map(() => '?').join(',');
  const timeFilter = sinceTs ? 'AND m.timestamp >= ?' : '';
  const sql = `
    SELECT m.id, m.chat_jid, m.source_jid, m.sender, m.sender_name, m.content,
           m.timestamp, m.is_from_me, m.attachments,
           '' AS snippet
    FROM messages m
    WHERE ${likeConditions}
      AND m.chat_jid IN (${placeholders})
      AND m.content != ''
      ${timeFilter}
    ORDER BY m.timestamp DESC
    LIMIT ? OFFSET ?
  `;

  const params: (string | number)[] = [...likeParams, ...chatJids];
  if (sinceTs) params.push(sinceTs);
  params.push(limit, offset);

  const rows = db.prepare(sql).all(...params) as Array<
    Omit<SearchResult, 'is_from_me'> & { is_from_me: number }
  >;

  return rows.map((row) => ({
    ...row,
    is_from_me: row.is_from_me === 1,
  }));
}

/**
 * Count total search results for pagination.
 * @param sinceTs - Optional ISO timestamp to limit count to messages after this time
 */
export function countSearchResults(
  chatJids: string[],
  query: string,
  sinceTs?: string,
): number {
  if (chatJids.length === 0 || !query.trim()) return 0;

  const sanitized = query.trim();
  if (!sanitized) return 0;

  const terms = sanitized.split(/\s+/).filter(Boolean);
  const likeConditions = terms
    .map(() => '(m.content LIKE ? ESCAPE \'\\\' AND word_match(m.content, ?) = 1)')
    .join(' AND ');
  const likeParams = terms.flatMap((t) => [
    `%${t.replace(/%/g, '\\%').replace(/_/g, '\\_')}%`,
    t,
  ]);

  const placeholders = chatJids.map(() => '?').join(',');
  const timeFilter = sinceTs ? 'AND m.timestamp >= ?' : '';
  const sql = `
    SELECT COUNT(*) as cnt
    FROM messages m
    WHERE ${likeConditions}
      AND m.chat_jid IN (${placeholders})
      AND m.content != ''
      ${timeFilter}
  `;

  const params: (string | number)[] = [...likeParams, ...chatJids];
  if (sinceTs) params.push(sinceTs);

  const row = db.prepare(sql).get(...params) as { cnt: number };
  return row.cnt;
}

/**
 * Get task run logs for a specific task, ordered by most recent first.
 */
export function getTaskRunLogs(taskId: string, limit = 20): TaskRunLog[] {
  return db
    .prepare(
      `
    SELECT id, task_id, run_at, duration_ms, status, result, error
    FROM task_run_logs
    WHERE task_id = ?
    ORDER BY run_at DESC
    LIMIT ?
  `,
    )
    .all(taskId, limit) as TaskRunLog[];
}

// ===================== Daily Summary Queries =====================

/**
 * Get messages for a chat within a time range, ordered by timestamp ASC.
 */
export function getMessagesByTimeRange(
  chatJid: string,
  startTs: number,
  endTs: number,
  limit = 500,
): Array<NewMessage & { is_from_me: boolean }> {
  const startIso = new Date(startTs).toISOString();
  const endIso = new Date(endTs).toISOString();
  const rows = db
    .prepare(
      `SELECT id, chat_jid, source_jid, sender, sender_name, content, timestamp, is_from_me, attachments
       FROM messages
       WHERE chat_jid = ? AND timestamp >= ? AND timestamp < ?
       ORDER BY timestamp ASC
       LIMIT ?`,
    )
    .all(chatJid, startIso, endIso, limit) as Array<
    NewMessage & { is_from_me: number }
  >;

  return rows.map((row) => ({
    ...row,
    is_from_me: row.is_from_me === 1,
  }));
}

/**
 * Get all registered Session channels resolved to a specific owner.
 */
export function getGroupsByOwner(
  userId: string,
): Array<RegisteredGroup & { jid: string }> {
  const groups = getAllRegisteredGroups() as Record<
    string,
    RegisteredGroup & { jid: string }
  >;
  return Object.values(groups).filter(
    (group) => resolveRegisteredGroupOwnerKey(group.jid, group) === userId,
  );
}

// ===================== Auth CRUD =====================

function parseUserRole(value: unknown): UserRole {
  return value === 'admin' ? 'admin' : 'member';
}

function parseUserStatus(value: unknown): UserStatus {
  if (value === 'deleted') return 'deleted';
  if (value === 'disabled') return 'disabled';
  return 'active';
}

function parsePermissionsFromDb(raw: unknown, role: UserRole): Permission[] {
  if (typeof raw === 'string') {
    try {
      const parsed = normalizePermissions(JSON.parse(raw));
      if (parsed.length > 0) return parsed;
    } catch {
      // ignore and fall back to role defaults
    }
  }
  return getDefaultPermissions(role);
}

function parseJsonDetails(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function mapUserRow(row: Record<string, unknown>): User {
  const role = parseUserRole(row.role);
  const status = parseUserStatus(row.status);
  return {
    id: String(row.id),
    username: String(row.username),
    password_hash: String(row.password_hash),
    display_name: String(row.display_name ?? ''),
    role,
    status,
    permissions: parsePermissionsFromDb(row.permissions, role),
    must_change_password: !!row.must_change_password,
    disable_reason:
      typeof row.disable_reason === 'string' ? row.disable_reason : null,
    notes: typeof row.notes === 'string' ? row.notes : null,
    avatar_emoji:
      typeof row.avatar_emoji === 'string' ? row.avatar_emoji : null,
    avatar_color:
      typeof row.avatar_color === 'string' ? row.avatar_color : null,
    ai_name: typeof row.ai_name === 'string' ? row.ai_name : null,
    ai_avatar_emoji:
      typeof row.ai_avatar_emoji === 'string' ? row.ai_avatar_emoji : null,
    ai_avatar_color:
      typeof row.ai_avatar_color === 'string' ? row.ai_avatar_color : null,
    ai_avatar_url:
      typeof row.ai_avatar_url === 'string' ? row.ai_avatar_url : null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    last_login_at:
      typeof row.last_login_at === 'string' ? row.last_login_at : null,
    deleted_at: typeof row.deleted_at === 'string' ? row.deleted_at : null,
  };
}

function toUserPublic(user: User, lastActiveAt: string | null): UserPublic {
  return {
    id: user.id,
    username: user.username,
    display_name: user.display_name,
    role: user.role,
    status: user.status,
    permissions: user.permissions,
    must_change_password: user.must_change_password,
    disable_reason: user.disable_reason,
    notes: user.notes,
    avatar_emoji: user.avatar_emoji,
    avatar_color: user.avatar_color,
    ai_name: user.ai_name,
    ai_avatar_emoji: user.ai_avatar_emoji,
    ai_avatar_color: user.ai_avatar_color,
    ai_avatar_url: user.ai_avatar_url,
    created_at: user.created_at,
    last_login_at: user.last_login_at,
    last_active_at: lastActiveAt,
    deleted_at: user.deleted_at,
  };
}

// --- Users ---

export interface CreateUserInput {
  id: string;
  username: string;
  password_hash: string;
  display_name: string;
  role: UserRole;
  status: UserStatus;
  created_at: string;
  updated_at: string;
  permissions?: Permission[];
  must_change_password?: boolean;
  disable_reason?: string | null;
  notes?: string | null;
  last_login_at?: string | null;
  deleted_at?: string | null;
}

export function createUser(user: CreateUserInput): void {
  const permissions = normalizePermissions(
    user.permissions ?? getDefaultPermissions(user.role),
  );
  db.prepare(
    `INSERT INTO users (
      id, username, password_hash, display_name, role, status, permissions, must_change_password,
      disable_reason, notes, created_at, updated_at, last_login_at, deleted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    user.id,
    user.username,
    user.password_hash,
    user.display_name,
    user.role,
    user.status,
    JSON.stringify(permissions),
    user.must_change_password ? 1 : 0,
    user.disable_reason ?? null,
    user.notes ?? null,
    user.created_at,
    user.updated_at,
    user.last_login_at ?? null,
    user.deleted_at ?? null,
  );
}

export type CreateInitialAdminResult =
  | { ok: true }
  | { ok: false; reason: 'already_initialized' | 'username_taken' };

export function createInitialAdminUser(
  user: CreateUserInput,
): CreateInitialAdminResult {
  const tx = db.transaction(
    (input: CreateUserInput): CreateInitialAdminResult => {
      const row = db.prepare('SELECT COUNT(*) as count FROM users').get() as {
        count: number;
      };
      if (row.count > 0) return { ok: false, reason: 'already_initialized' };
      createUser(input);
      return { ok: true };
    },
  );

  try {
    return tx(user);
  } catch (err) {
    if (
      err instanceof Error &&
      err.message.includes('UNIQUE constraint failed: users.username')
    ) {
      return { ok: false, reason: 'username_taken' };
    }
    throw err;
  }
}

export function getUserById(id: string): User | undefined {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? mapUserRow(row) : undefined;
}

export function getUserByUsername(username: string): User | undefined {
  const row = db
    .prepare('SELECT * FROM users WHERE username = ?')
    .get(username) as Record<string, unknown> | undefined;
  return row ? mapUserRow(row) : undefined;
}

export interface ListUsersOptions {
  query?: string;
  role?: UserRole | 'all';
  status?: UserStatus | 'all';
  page?: number;
  pageSize?: number;
}

export interface ListUsersResult {
  users: UserPublic[];
  total: number;
  page: number;
  pageSize: number;
}

export function listUsers(options: ListUsersOptions = {}): ListUsersResult {
  const role = options.role && options.role !== 'all' ? options.role : null;
  const status =
    options.status && options.status !== 'all' ? options.status : null;
  const query = options.query?.trim() || '';
  const page = Math.max(1, Math.floor(options.page || 1));
  const pageSize = Math.min(
    200,
    Math.max(1, Math.floor(options.pageSize || 50)),
  );
  const offset = (page - 1) * pageSize;

  const whereParts: string[] = [];
  const params: unknown[] = [];
  if (role) {
    whereParts.push('u.role = ?');
    params.push(role);
  }
  if (status) {
    whereParts.push('u.status = ?');
    params.push(status);
  }
  if (query) {
    whereParts.push(
      "(u.username LIKE ? OR u.display_name LIKE ? OR COALESCE(u.notes, '') LIKE ?)",
    );
    const like = `%${query}%`;
    params.push(like, like, like);
  }

  const whereClause =
    whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : '';

  const totalRow = db
    .prepare(`SELECT COUNT(*) as count FROM users u ${whereClause}`)
    .get(...params) as { count: number };

  const rows = db
    .prepare(
      `
      SELECT u.*, u.last_login_at AS last_active_at
      FROM users u
      ${whereClause}
      ORDER BY
        CASE u.status
          WHEN 'active' THEN 0
          WHEN 'disabled' THEN 1
          ELSE 2
        END,
        u.created_at DESC
      LIMIT ? OFFSET ?
      `,
    )
    .all(...params, pageSize, offset) as Array<Record<string, unknown>>;

  return {
    users: rows.map((row) => {
      const user = mapUserRow(row);
      const lastActiveAt =
        typeof row.last_active_at === 'string' ? row.last_active_at : null;
      return toUserPublic(user, lastActiveAt);
    }),
    total: totalRow.count,
    page,
    pageSize,
  };
}

export function getAllUsers(): UserPublic[] {
  return listUsers({ role: 'all', status: 'all', page: 1, pageSize: 1000 })
    .users;
}

export function getUserCount(includeDeleted = false): number {
  const row = includeDeleted
    ? (db.prepare('SELECT COUNT(*) as count FROM users').get() as {
        count: number;
      })
    : (db
        .prepare('SELECT COUNT(*) as count FROM users WHERE status != ?')
        .get('deleted') as { count: number });
  return row.count;
}

export function getActiveAdminCount(): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) as count
       FROM users
       WHERE role = 'admin' AND status = 'active'`,
    )
    .get() as { count: number };
  return row.count;
}

export function updateUserFields(
  id: string,
  updates: Partial<
    Pick<
      User,
      | 'username'
      | 'display_name'
      | 'role'
      | 'status'
      | 'password_hash'
      | 'last_login_at'
      | 'permissions'
      | 'must_change_password'
      | 'disable_reason'
      | 'notes'
      | 'avatar_emoji'
      | 'avatar_color'
      | 'ai_name'
      | 'ai_avatar_emoji'
      | 'ai_avatar_color'
      | 'ai_avatar_url'
      | 'deleted_at'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.username !== undefined) {
    fields.push('username = ?');
    values.push(updates.username);
  }
  if (updates.display_name !== undefined) {
    fields.push('display_name = ?');
    values.push(updates.display_name);
  }
  if (updates.role !== undefined) {
    fields.push('role = ?');
    values.push(updates.role);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.password_hash !== undefined) {
    fields.push('password_hash = ?');
    values.push(updates.password_hash);
  }
  if (updates.last_login_at !== undefined) {
    fields.push('last_login_at = ?');
    values.push(updates.last_login_at);
  }
  if (updates.permissions !== undefined) {
    fields.push('permissions = ?');
    values.push(JSON.stringify(normalizePermissions(updates.permissions)));
  }
  if (updates.must_change_password !== undefined) {
    fields.push('must_change_password = ?');
    values.push(updates.must_change_password ? 1 : 0);
  }
  if (updates.disable_reason !== undefined) {
    fields.push('disable_reason = ?');
    values.push(updates.disable_reason);
  }
  if (updates.notes !== undefined) {
    fields.push('notes = ?');
    values.push(updates.notes);
  }
  if (updates.avatar_emoji !== undefined) {
    fields.push('avatar_emoji = ?');
    values.push(updates.avatar_emoji);
  }
  if (updates.avatar_color !== undefined) {
    fields.push('avatar_color = ?');
    values.push(updates.avatar_color);
  }
  if (updates.ai_name !== undefined) {
    fields.push('ai_name = ?');
    values.push(updates.ai_name);
  }
  if (updates.ai_avatar_emoji !== undefined) {
    fields.push('ai_avatar_emoji = ?');
    values.push(updates.ai_avatar_emoji);
  }
  if (updates.ai_avatar_color !== undefined) {
    fields.push('ai_avatar_color = ?');
    values.push(updates.ai_avatar_color);
  }
  if (updates.ai_avatar_url !== undefined) {
    fields.push('ai_avatar_url = ?');
    values.push(updates.ai_avatar_url);
  }
  if (updates.deleted_at !== undefined) {
    fields.push('deleted_at = ?');
    values.push(updates.deleted_at);
  }

  if (fields.length === 0) return;

  fields.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);

  db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(
    ...values,
  );
}

export function deleteUser(id: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE users
     SET status = 'deleted', deleted_at = ?, disable_reason = COALESCE(disable_reason, 'deleted_by_admin'), updated_at = ?
     WHERE id = ?`,
  ).run(now, now, id);
}

export function restoreUser(id: string): void {
  db.prepare(
    `UPDATE users
     SET status = 'disabled', deleted_at = NULL, disable_reason = NULL, updated_at = ?
     WHERE id = ?`,
  ).run(new Date().toISOString(), id);
}

export function deleteExpiredSessions(): number {
  return 0;
}

// ===================== Sub-Agent CRUD =====================

function syncWorkerSession(agent: SubAgent): void {
  const sessionId = buildWorkerSessionId(agent.id);
  const parentSessionId = buildMainSessionId(agent.group_folder);
  const parentSession = getSessionRecord(parentSessionId);
  const parentGroup = findPrimarySessionChannelForFolder(agent.group_folder);
  const ownerKey = parentSession?.owner_key ?? null;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO sessions (
      id, name, kind, parent_session_id, cwd, runner_id, runner_profile_id,
      model, thinking_effort, context_compression, is_pinned, archived,
      owner_key, created_at, updated_at
    ) VALUES (?, ?, 'worker', ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      parent_session_id = excluded.parent_session_id,
      cwd = excluded.cwd,
      runner_id = excluded.runner_id,
      runner_profile_id = excluded.runner_profile_id,
      model = excluded.model,
      thinking_effort = excluded.thinking_effort,
      context_compression = excluded.context_compression,
      owner_key = excluded.owner_key,
      updated_at = excluded.updated_at`,
  ).run(
    sessionId,
    agent.name,
    parentSessionId,
    parentSession?.cwd || path.join(GROUPS_DIR, agent.group_folder),
    parentSession?.runner_id || deriveRunnerId(parentGroup || null),
    parentSession?.runner_profile_id || null,
    parentSession?.model || null,
    parentSession?.thinking_effort || null,
    parentSession?.context_compression || 'off',
    ownerKey,
    agent.created_at || now,
    now,
  );
  db.prepare(
    `INSERT INTO worker_sessions (
      session_id, parent_session_id, source_chat_jid, name, kind, prompt,
      status, created_at, completed_at, result_summary
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      parent_session_id = excluded.parent_session_id,
      source_chat_jid = excluded.source_chat_jid,
      name = excluded.name,
      kind = excluded.kind,
      prompt = excluded.prompt,
      status = excluded.status,
      completed_at = excluded.completed_at,
      result_summary = excluded.result_summary`,
  ).run(
    sessionId,
    parentSessionId,
    agent.chat_jid,
    agent.name,
    agent.kind || 'task',
    agent.prompt,
    agent.status,
    agent.created_at,
    agent.completed_at ?? null,
    agent.result_summary ?? null,
  );
}

export function createAgent(agent: SubAgent): void {
  syncWorkerSession(agent);
}

export function getAgent(id: string): SubAgent | undefined {
  const workerRow = db
    .prepare(
      `SELECT ws.*, s.owner_key
       FROM worker_sessions ws
       LEFT JOIN sessions s ON s.id = ws.session_id
       WHERE ws.session_id = ?`,
    )
    .get(buildWorkerSessionId(id)) as Record<string, unknown> | undefined;
  return workerRow ? mapWorkerAgentRow(workerRow) : undefined;
}

export function listAgentsByFolder(folder: string): SubAgent[] {
  const rows = db
    .prepare(
      `SELECT ws.*, s.owner_key
       FROM worker_sessions ws
       LEFT JOIN sessions s ON s.id = ws.session_id
       WHERE ws.parent_session_id = ?
       ORDER BY ws.created_at DESC`,
    )
    .all(buildMainSessionId(folder)) as Array<Record<string, unknown>>;
  return rows.map(mapWorkerAgentRow);
}

export function listAgentsByJid(chatJid: string): SubAgent[] {
  const rows = db
    .prepare(
      `SELECT ws.*, s.owner_key
       FROM worker_sessions ws
       LEFT JOIN sessions s ON s.id = ws.session_id
       WHERE ws.source_chat_jid = ?
       ORDER BY ws.created_at DESC`,
    )
    .all(chatJid) as Array<Record<string, unknown>>;
  return rows.map(mapWorkerAgentRow);
}

export function updateAgentStatus(
  id: string,
  status: AgentStatus,
  resultSummary?: string,
): void {
  const completedAt =
    status !== 'running' && status !== 'idle' ? new Date().toISOString() : null;
  const sessionId = buildWorkerSessionId(id);
  db.prepare(
    'UPDATE worker_sessions SET status = ?, completed_at = ?, result_summary = ? WHERE session_id = ?',
  ).run(status, completedAt, resultSummary ?? null, sessionId);
}

export function updateAgentInfo(id: string, name: string, prompt: string): void {
  const sessionId = buildWorkerSessionId(id);
  db.prepare('UPDATE worker_sessions SET name = ?, prompt = ? WHERE session_id = ?').run(
    name,
    prompt,
    sessionId,
  );
  db.prepare('UPDATE sessions SET name = ?, updated_at = ? WHERE id = ?').run(
    name,
    new Date().toISOString(),
    sessionId,
  );
}

export function deleteCompletedTaskAgents(beforeTimestamp: string): number {
  const workerRows = db
    .prepare(
      `SELECT session_id
       FROM worker_sessions
       WHERE kind = 'task'
         AND status IN ('completed', 'error')
         AND completed_at IS NOT NULL
         AND completed_at < ?`,
    )
    .all(beforeTimestamp) as Array<{ session_id: string }>;
  const sessionIds = workerRows.map((row) => row.session_id);

  if (sessionIds.length > 0) {
    const placeholders = sessionIds.map(() => '?').join(', ');
    db.prepare(
      `DELETE FROM session_state WHERE session_id IN (${placeholders})`,
    ).run(...sessionIds);
    db.prepare(`DELETE FROM sessions WHERE id IN (${placeholders})`).run(
      ...sessionIds,
    );
    db.prepare(
      `DELETE FROM worker_sessions WHERE session_id IN (${placeholders})`,
    ).run(...sessionIds);
  }
  return sessionIds.length;
}

export function getRunningTaskAgentsByChat(chatJid: string): SubAgent[] {
  const rows = db
    .prepare(
      `SELECT ws.*, s.owner_key
       FROM worker_sessions ws
       LEFT JOIN sessions s ON s.id = ws.session_id
       WHERE ws.source_chat_jid = ?
         AND ws.kind = 'task'
         AND ws.status = 'running'
       ORDER BY ws.created_at DESC`,
    )
    .all(chatJid) as Array<Record<string, unknown>>;
  return rows.map(mapWorkerAgentRow);
}

export function markRunningTaskAgentsAsError(chatJid: string): number {
  const now = new Date().toISOString();
  const workerResult = db
    .prepare(
      "UPDATE worker_sessions SET status = 'error', completed_at = ? WHERE source_chat_jid = ? AND kind = 'task' AND status = 'running'",
    )
    .run(now, chatJid);
  return workerResult.changes;
}

export function markAllRunningTaskAgentsAsError(
  summary = '进程重启，任务中断',
): number {
  const now = new Date().toISOString();
  const workerResult = db
    .prepare(
      "UPDATE worker_sessions SET status = 'error', completed_at = ?, result_summary = COALESCE(result_summary, ?) WHERE kind = 'task' AND status = 'running'",
    )
    .run(now, summary);
  return workerResult.changes;
}

export function deleteAgent(id: string): void {
  const sessionId = buildWorkerSessionId(id);
  db.prepare('DELETE FROM session_bindings WHERE session_id = ?').run(sessionId);
  db.prepare('DELETE FROM session_state WHERE session_id = ?').run(sessionId);
  db.prepare('DELETE FROM worker_sessions WHERE session_id = ?').run(sessionId);
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

function mapLegacyAgentRow(row: Record<string, unknown>): SubAgent {
  return {
    id: String(row.id),
    group_folder: String(row.group_folder),
    chat_jid: String(row.chat_jid),
    name: String(row.name),
    prompt: String(row.prompt),
    status: (row.status as AgentStatus) || 'running',
    kind: (row.kind as AgentKind) || 'task',
    created_by: typeof row.created_by === 'string' ? row.created_by : null,
    created_at: String(row.created_at),
    completed_at:
      typeof row.completed_at === 'string' ? row.completed_at : null,
    result_summary:
      typeof row.result_summary === 'string' ? row.result_summary : null,
  };
}

export function deleteMessagesForChatJid(chatJid: string): void {
  db.prepare('DELETE FROM messages WHERE chat_jid = ?').run(chatJid);
  db.prepare('DELETE FROM chats WHERE jid = ?').run(chatJid);
}

export function getMessage(
  chatJid: string,
  messageId: string,
): {
  id: string;
  chat_jid: string;
  sender: string | null;
  is_from_me: number;
} | null {
  const row = db
    .prepare(
      'SELECT id, chat_jid, sender, is_from_me FROM messages WHERE id = ? AND chat_jid = ?',
    )
    .get(messageId, chatJid) as
    | {
        id: string;
        chat_jid: string;
        sender: string | null;
        is_from_me: number;
      }
    | undefined;
  return row ?? null;
}

export function deleteMessage(chatJid: string, messageId: string): boolean {
  const result = db
    .prepare('DELETE FROM messages WHERE id = ? AND chat_jid = ?')
    .run(messageId, chatJid);
  return result.changes > 0;
}

// ───────────────── Turns ─────────────────

export interface TurnRow {
  id: string;
  chat_jid: string;
  channel: string | null;
  message_ids: string | null;
  started_at: string;
  completed_at: string | null;
  status: string;
  result_message_id: string | null;
  summary: string | null;
  trace_file: string | null;
  token_usage: string | null;
  group_folder: string;
}

export function insertTurn(turn: {
  id: string;
  chat_jid: string;
  channel?: string;
  message_ids?: string;
  started_at: string;
  status: string;
  group_folder: string;
}): void {
  db.prepare(
    `INSERT INTO turns (id, chat_jid, channel, message_ids, started_at, status, group_folder)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    turn.id,
    turn.chat_jid,
    turn.channel || null,
    turn.message_ids || null,
    turn.started_at,
    turn.status,
    turn.group_folder,
  );
}

export function updateTurn(
  id: string,
  fields: Partial<
    Pick<
      TurnRow,
      | 'completed_at'
      | 'status'
      | 'result_message_id'
      | 'summary'
      | 'trace_file'
      | 'token_usage'
      | 'message_ids'
    >
  >,
): void {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      sets.push(`${key} = ?`);
      values.push(value);
    }
  }
  if (sets.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE turns SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

export function getTurnById(id: string): TurnRow | undefined {
  return db.prepare('SELECT * FROM turns WHERE id = ?').get(id) as
    | TurnRow
    | undefined;
}

export function getActiveTurnByFolder(folder: string): TurnRow | undefined {
  return db
    .prepare(
      "SELECT * FROM turns WHERE group_folder = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1",
    )
    .get(folder) as TurnRow | undefined;
}

export function getTurnsByJid(
  chatJid: string,
  limit: number = 50,
  offset: number = 0,
): TurnRow[] {
  return db
    .prepare(
      'SELECT * FROM turns WHERE chat_jid = ? ORDER BY started_at DESC LIMIT ? OFFSET ?',
    )
    .all(chatJid, limit, offset) as TurnRow[];
}

export function getTurnsByFolder(
  folder: string,
  limit: number = 50,
  offset: number = 0,
): TurnRow[] {
  return db
    .prepare(
      'SELECT * FROM turns WHERE group_folder = ? ORDER BY started_at DESC LIMIT ? OFFSET ?',
    )
    .all(folder, limit, offset) as TurnRow[];
}

export function cleanupOldTurns(olderThanDays: number): number {
  const cutoff = new Date(
    Date.now() - olderThanDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  const result = db
    .prepare('DELETE FROM turns WHERE started_at < ?')
    .run(cutoff);
  return result.changes;
}

export function getTurnByResultMessageId(
  messageId: string,
): TurnRow | undefined {
  return db
    .prepare('SELECT * FROM turns WHERE result_message_id = ? LIMIT 1')
    .get(messageId) as TurnRow | undefined;
}

export function getMessageIdsWithTrace(
  messageIds: string[],
): Set<string> {
  if (messageIds.length === 0) return new Set();
  const placeholders = messageIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT result_message_id FROM turns WHERE result_message_id IN (${placeholders}) AND trace_file IS NOT NULL`,
    )
    .all(...messageIds) as Array<{ result_message_id: string }>;
  return new Set(rows.map((r) => r.result_message_id));
}

export function markStaleTurnsAsError(): void {
  const now = new Date().toISOString();
  db.prepare(
    "UPDATE turns SET status = 'error', completed_at = ? WHERE status = 'running'",
  ).run(now);
}

/**
 * Close the database connection.
 * Should be called during graceful shutdown.
 */
export function closeDatabase(): void {
  if (db) {
    db.close();
  }
}
