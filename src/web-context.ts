// Shared state and utilities for web server

import { WebSocket } from 'ws';
import { RegisteredGroup, UserRole } from './types.js';
import { SessionRuntimeManager } from './session-runtime-manager.js';
import type { AuthUser, NewMessage, MessageCursor } from './types.js';
import type { ActiveTurn } from './turn-manager.js';
import type { TurnObservabilitySnapshot } from './turn-observability.js';
import type { CompressOptions } from './context-compressor.js';
import {
} from './db.js';
import { getLocalWorkbenchAuthUser } from './local-user.js';

export interface WsClientInfo {
  sessionId: string;
  userId: string;
  role: UserRole;
}

export interface WebDeps {
  queue: SessionRuntimeManager;
  getRegisteredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  processGroupMessages: (chatJid: string) => Promise<boolean>;
  ensureTerminalRuntimeStarted: (chatJid: string) => boolean;
  formatMessages: (messages: NewMessage[], isShared?: boolean) => string;
  getLastAgentTimestamp: () => Record<string, MessageCursor>;
  setLastAgentTimestamp: (jid: string, cursor: MessageCursor) => void;
  advanceGlobalCursor: (cursor: MessageCursor) => void;
  trackIpcDelivery?: (jid: string) => void;
  reloadFeishuConnection?: (config: {
    appId: string;
    appSecret: string;
    enabled?: boolean;
  }) => Promise<boolean>;
  reloadTelegramConnection?: (config: {
    botToken: string;
    enabled?: boolean;
  }) => Promise<boolean>;
  reloadUserIMConfig?: (
    userId: string,
    channel: 'feishu' | 'telegram' | 'qq' | 'wechat',
  ) => Promise<boolean>;
  isFeishuConnected?: () => boolean;
  isTelegramConnected?: () => boolean;
  isUserFeishuConnected?: (userId: string) => boolean;
  isUserTelegramConnected?: (userId: string) => boolean;
  isUserQQConnected?: (userId: string) => boolean;
  isUserWeChatConnected?: (userId: string) => boolean;
  processAgentConversation?: (
    chatJid: string,
    agentId: string,
  ) => Promise<void>;
  getFeishuChatInfo?: (
    userId: string,
    chatId: string,
  ) => Promise<{
    avatar?: string;
    name?: string;
    user_count?: string;
    chat_type?: string;
    chat_mode?: string;
  } | null>;
  clearImFailCounts?: (jid: string) => void;
  triggerSessionWrapup?: (folder: string) => Promise<void>;
  getActiveTurnRuntime?: (folder: string) => ActiveTurn | null;
  getPendingTurnCounts?: (folder: string) => Map<string, number>;
  getTurnObservability?: (folder: string) => TurnObservabilitySnapshot | null;
  buildCompressOptions?: (group: RegisteredGroup) => CompressOptions | undefined;
}

export type Variables = {
  user: AuthUser;
  sessionId: string;
};

let deps: WebDeps | null = null;
export const wsClients = new Map<WebSocket, WsClientInfo>();
export const MAX_GROUP_NAME_LEN = 40;

export function setWebDeps(d: WebDeps): void {
  deps = d;
}
export function getWebDeps(): WebDeps | null {
  return deps;
}

// lastActiveCache - 5 min debounce for session activity tracking
export const lastActiveCache = new Map<string, number>();
export const LAST_ACTIVE_DEBOUNCE_MS = 5 * 60 * 1000;
const LAST_ACTIVE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const lastActiveCleanupTimer = setInterval(
  () => {
    const cutoff = Date.now() - LAST_ACTIVE_CACHE_TTL_MS;
    for (const [sessionId, touchedAt] of lastActiveCache.entries()) {
      if (touchedAt < cutoff) lastActiveCache.delete(sessionId);
    }
  },
  60 * 60 * 1000,
);
lastActiveCleanupTimer.unref?.();

// Cookie parser - used by middleware and WebSocket
export function parseCookie(
  cookieHeader: string | undefined,
): Record<string, string> {
  if (!cookieHeader) return {};
  const cookies: Record<string, string> = {};
  for (const cookie of cookieHeader.split(';')) {
    const pair = cookie.trim();
    const eqIndex = pair.indexOf('=');
    if (eqIndex === -1) continue;
    const key = pair.slice(0, eqIndex).trim();
    const value = pair.slice(eqIndex + 1).trim();
    if (key) cookies[key] = value;
  }
  return cookies;
}

// Legacy execution-mode helpers. The runtime is now unified as a local
// subprocess, so old host/container branching is no longer authoritative.
export function isHostExecutionGroup(group: RegisteredGroup): boolean {
  return false;
}

export function hasHostExecutionPermission(user: AuthUser): boolean {
  return user.role === 'admin';
}

export function canAccessGroup(
  user: { id: string; role: UserRole },
  group: RegisteredGroup & { jid: string },
): boolean {
  void group;
  return user.id === getLocalWorkbenchAuthUser().id || user.role === 'admin';
}

export function canModifyGroup(
  user: { id: string; role: UserRole },
  group: RegisteredGroup & { jid: string },
): boolean {
  return canAccessGroup(user, group);
}

export function canManageGroupMembers(
  user: { id: string; role: UserRole },
  group: RegisteredGroup & { jid: string },
): boolean {
  void user;
  void group;
  return false;
}

export function canDeleteGroup(
  user: { id: string; role: UserRole },
  group: RegisteredGroup & { jid: string },
): boolean {
  if (group.is_home) return false;
  return canModifyGroup(user, group);
}
