import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { getSessionRecord, listSessionRecords } from './db.js';
import { getDefaultPermissions } from './permissions.js';
import type { AuthUser, UserPublic } from './types.js';

const LOCAL_OPERATOR_FILE = path.join(DATA_DIR, 'config', 'local-operator.json');
const LOCAL_SESSION_ID = 'single-user-workbench';

interface LocalOperatorFile {
  username?: string;
  display_name?: string;
  avatar_emoji?: string | null;
  avatar_color?: string | null;
  ai_name?: string | null;
  ai_avatar_emoji?: string | null;
  ai_avatar_color?: string | null;
  ai_avatar_url?: string | null;
  created_at?: string;
  last_login_at?: string | null;
  last_active_at?: string | null;
}

function isPublicOwnerKey(ownerKey: string | null | undefined): ownerKey is string {
  if (typeof ownerKey !== 'string') return false;
  const normalized = ownerKey.trim();
  return normalized.length > 0 && normalized !== 'system';
}

function loadLocalOperatorFile(): LocalOperatorFile {
  try {
    if (!fs.existsSync(LOCAL_OPERATOR_FILE)) return {};
    return JSON.parse(fs.readFileSync(LOCAL_OPERATOR_FILE, 'utf-8')) as LocalOperatorFile;
  } catch {
    return {};
  }
}

function saveLocalOperatorFile(next: LocalOperatorFile): void {
  fs.mkdirSync(path.dirname(LOCAL_OPERATOR_FILE), { recursive: true });
  fs.writeFileSync(LOCAL_OPERATOR_FILE, JSON.stringify(next, null, 2) + '\n', 'utf-8');
}

function normalizeLocalOperatorFile(
  stored: LocalOperatorFile,
  fallbackNow: string,
): LocalOperatorFile {
  const createdAt =
    stored.created_at ||
    (typeof stored.last_login_at === 'string' ? stored.last_login_at : null) ||
    fallbackNow;
  const lastLoginAt =
    stored.last_login_at !== undefined ? stored.last_login_at : createdAt;
  const lastActiveAt =
    stored.last_active_at !== undefined
      ? stored.last_active_at
      : lastLoginAt;

  return {
    ...stored,
    created_at: createdAt,
    last_login_at: lastLoginAt,
    last_active_at: lastActiveAt,
  };
}

function resolvePrimaryOwnerKey(): string | null {
  const primarySessionOwner = listSessionRecords().find(
    (session) =>
      (session.kind === 'main' || session.kind === 'workspace') &&
      isPublicOwnerKey(session.owner_key),
  )?.owner_key;
  if (primarySessionOwner) return primarySessionOwner;

  const memorySessionOwner = listSessionRecords().find(
    (session) =>
      session.kind === 'memory' && isPublicOwnerKey(session.owner_key),
  )?.owner_key;
  if (memorySessionOwner) return memorySessionOwner;
  return null;
}

export function getLocalWorkbenchSessionId(): string {
  return LOCAL_SESSION_ID;
}

export function getLocalWorkbenchUserPublic(): UserPublic {
  const fallbackNow = new Date().toISOString();
  const stored = loadLocalOperatorFile();
  const normalized = normalizeLocalOperatorFile(stored, fallbackNow);
  if (
    stored.created_at !== normalized.created_at ||
    stored.last_login_at !== normalized.last_login_at ||
    stored.last_active_at !== normalized.last_active_at
  ) {
    saveLocalOperatorFile(normalized);
  }
  const primaryOwnerKey =
    resolvePrimaryOwnerKey() ||
    getSessionRecord('memory:local')?.owner_key ||
    'local';

  return {
    id: primaryOwnerKey,
    username: normalized.username || 'operator',
    display_name: normalized.display_name || 'Operator',
    role: 'admin',
    status: 'active',
    permissions: getDefaultPermissions('admin'),
    must_change_password: false,
    disable_reason: null,
    notes: null,
    avatar_emoji:
      normalized.avatar_emoji !== undefined
        ? normalized.avatar_emoji
        : null,
    avatar_color:
      normalized.avatar_color !== undefined
        ? normalized.avatar_color
        : null,
    ai_name:
      normalized.ai_name !== undefined ? normalized.ai_name : null,
    ai_avatar_emoji:
      normalized.ai_avatar_emoji !== undefined
        ? normalized.ai_avatar_emoji
        : null,
    ai_avatar_color:
      normalized.ai_avatar_color !== undefined
        ? normalized.ai_avatar_color
        : null,
    ai_avatar_url:
      normalized.ai_avatar_url !== undefined
        ? normalized.ai_avatar_url
        : null,
    created_at: normalized.created_at ?? fallbackNow,
    last_login_at:
      normalized.last_login_at !== undefined
        ? normalized.last_login_at
        : normalized.created_at ?? fallbackNow,
    last_active_at:
      normalized.last_active_at !== undefined
        ? normalized.last_active_at
        : normalized.last_login_at ?? normalized.created_at ?? fallbackNow,
    deleted_at: null,
  };
}

export function getLocalWorkbenchAuthUser(): AuthUser {
  const user = getLocalWorkbenchUserPublic();
  return {
    id: user.id,
    username: user.username,
    display_name: user.display_name,
    role: user.role,
    status: 'active',
    permissions: user.permissions,
    must_change_password: false,
  };
}

export function saveLocalWorkbenchProfile(
  updates: Partial<
    Pick<
      UserPublic,
      | 'username'
      | 'display_name'
      | 'avatar_emoji'
      | 'avatar_color'
      | 'ai_name'
      | 'ai_avatar_emoji'
      | 'ai_avatar_color'
      | 'ai_avatar_url'
    >
  >,
): UserPublic {
  const current = getLocalWorkbenchUserPublic();
  const nextFile: LocalOperatorFile = {
    ...loadLocalOperatorFile(),
    ...updates,
    created_at: current.created_at,
    last_login_at: current.last_login_at,
    last_active_at: current.last_active_at,
  };
  saveLocalOperatorFile(nextFile);

  return getLocalWorkbenchUserPublic();
}
