import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { getAllUsers, getSessionRecord, listSessionRecords, updateUserFields } from './db.js';
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

function resolvePrimaryOwnerKey(): string | null {
  const sessionOwner = listSessionRecords().find(
    (session) =>
      (session.kind === 'main' || session.kind === 'memory') &&
      typeof session.owner_key === 'string' &&
      session.owner_key.trim().length > 0,
  )?.owner_key;
  if (sessionOwner) return sessionOwner;
  return null;
}

function resolveBackingUser(): UserPublic | null {
  const ownerKey = resolvePrimaryOwnerKey();
  if (!ownerKey) return null;
  const users = getAllUsers().filter((user) => user.status !== 'deleted');
  return users.find((user) => user.id === ownerKey) || null;
}

export function getLocalWorkbenchSessionId(): string {
  return LOCAL_SESSION_ID;
}

export function getLocalWorkbenchUserPublic(): UserPublic {
  const fallbackNow = new Date().toISOString();
  const stored = loadLocalOperatorFile();
  const backingUser = resolveBackingUser();
  const primaryOwnerKey =
    backingUser?.id ||
    resolvePrimaryOwnerKey() ||
    getSessionRecord('memory:local')?.owner_key ||
    'local';

  return {
    id: primaryOwnerKey,
    username: stored.username || backingUser?.username || 'operator',
    display_name: stored.display_name || backingUser?.display_name || 'Operator',
    role: 'admin',
    status: 'active',
    permissions: getDefaultPermissions('admin'),
    must_change_password: false,
    disable_reason: null,
    notes: null,
    avatar_emoji:
      stored.avatar_emoji !== undefined
        ? stored.avatar_emoji
        : (backingUser?.avatar_emoji ?? null),
    avatar_color:
      stored.avatar_color !== undefined
        ? stored.avatar_color
        : (backingUser?.avatar_color ?? null),
    ai_name:
      stored.ai_name !== undefined ? stored.ai_name : (backingUser?.ai_name ?? null),
    ai_avatar_emoji:
      stored.ai_avatar_emoji !== undefined
        ? stored.ai_avatar_emoji
        : (backingUser?.ai_avatar_emoji ?? null),
    ai_avatar_color:
      stored.ai_avatar_color !== undefined
        ? stored.ai_avatar_color
        : (backingUser?.ai_avatar_color ?? null),
    ai_avatar_url:
      stored.ai_avatar_url !== undefined
        ? stored.ai_avatar_url
        : (backingUser?.ai_avatar_url ?? null),
    created_at:
      stored.created_at || backingUser?.created_at || fallbackNow,
    last_login_at:
      stored.last_login_at !== undefined
        ? stored.last_login_at
        : (backingUser?.last_login_at ?? fallbackNow),
    last_active_at: fallbackNow,
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
  };
  saveLocalOperatorFile(nextFile);

  const backingUser = resolveBackingUser();
  if (backingUser) {
    updateUserFields(backingUser.id, {
      username: updates.username,
      display_name: updates.display_name,
      avatar_emoji: updates.avatar_emoji,
      avatar_color: updates.avatar_color,
      ai_name: updates.ai_name,
      ai_avatar_emoji: updates.ai_avatar_emoji,
      ai_avatar_color: updates.ai_avatar_color,
      ai_avatar_url: updates.ai_avatar_url,
      last_login_at: current.last_login_at,
    });
  }

  return getLocalWorkbenchUserPublic();
}
