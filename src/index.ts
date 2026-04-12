import { ChildProcess, execFile } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

import { CronExpressionParser } from 'cron-parser';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  GROUPS_DIR,
  STORE_DIR,
  IPC_POLL_INTERVAL,
  MAIN_GROUP_FOLDER,
  POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import {
  AvailableGroup,
  RuntimeInput,
  RuntimeOutput,
  runSessionAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './session-launcher.js';
import {
  closeDatabase,
  createTask,
  deleteExpiredSessions,
  deleteTask,
  ensureChatExists,
  ensureUserHomeGroup,
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getJidsByFolder,
  getLastGroupSync,
  getRegisteredGroup,
  getPrimarySessionForOwner,
  getUserById,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  getRowidByCursor,
  getTaskById,
  getUserHomeGroup,
  getLastInboundMessage,
  initDatabase,
  isGroupShared,
  getSessionBinding,
  getSessionRecord,
  getSessionRuntimeState,
  getWorkerSessionRecord,
  listSessionBindings,
  listUsers,
  listSessionRecords,
  setLastGroupSync,
  setRegisteredGroup,
  setRouterState,
  setSession,
  deleteSession,
  storeMessageDirect,
  updateLatestMessageTokenUsage,
  updateChatName,
  updateTask,
  createAgent,
  getAgent,
  updateAgentStatus,
  updateAgentInfo,
  deleteCompletedTaskAgents,
  getRunningTaskAgentsByChat,
  markRunningTaskAgentsAsError,
  markAllRunningTaskAgentsAsError,
  getSession,
  listAgentsByJid,
  getGroupsByOwner,
  getMessagesPage,
  addGroupMember,
  cleanupOldDailyUsage,
  cleanupOldBillingAuditLog,
  insertUsageRecord,
  getTranscriptMessagesSince,
  markStaleTurnsAsError,
  cleanupOldTurns,
  getMessageById,
  getContextSummary,
  deleteSessionBinding,
  saveSessionBinding,
  upsertSessionRuntimeState,
} from './db.js';
// feishu.js deprecated exports are no longer needed; imManager handles all connections
import { imManager } from './im-manager.js';
import { getChannelType, extractChatId, type IMSendOptions } from './im-channel.js';
import { abortAllStreamingSessions } from './feishu-streaming-card.js';
import {
  type ProgressCardController,
  registerProgressSession,
  unregisterProgressSession,
  abortAllProgressSessions,
  cleanupStaleProgressCards,
  feedProgressSessionsForFolder,
  completeAndResetProgressSessionsForFolder,
  finalizeProgressSessionsForFolder,
  hasActiveProgressSession,
} from './feishu-progress-card.js';
import {
  formatContextMessages,
  formatWorkspaceList,
  formatSystemStatus,
  resolveLocationInfo,
  type WorkspaceInfo,
} from './im-command-utils.js';
import { analyzeIntent } from './intent-analyzer.js';
import {
  getFeishuProviderConfigWithSource,
  getTelegramProviderConfig,
  getTelegramProviderConfigWithSource,
  getUserFeishuConfig,
  getUserTelegramConfig,
  getUserQQConfig,
  getUserWeChatConfig,
  getSystemSettings,
  saveUserFeishuConfig,
  saveUserTelegramConfig,
  updateAllSessionCredentials,
  getUserIMPreferences,
  getUserImGeneralConfig,
} from './runtime-config.js';
import type {
  FeishuConnectConfig,
  TelegramConnectConfig,
  QQConnectConfig,
  WeChatConnectConfig,
} from './im-manager.js';
import { SessionRuntimeManager } from './session-runtime-manager.js';
import { TurnManager } from './turn-manager.js';
import { saveTurnTrace, cleanupOldTraces } from './turn-trace.js';
import { startSchedulerLoop } from './task-scheduler.js';
import {
  checkBillingAccessFresh,
  formatBillingAccessDeniedMessage,
  updateUsage,
  deductUsageCost,
  checkAndExpireSubscriptions,
  isBillingEnabled,
  getUserConcurrentContainerLimit,
  reconcileMonthlyUsage,
} from './billing.js';
import {
  AgentStatus,
  DbMessage,
  MessageCursor,
  NewMessage,
  RegisteredGroup,
} from './types.js';
import { logger } from './logger.js';
import { normalizeImageAttachments } from './message-attachments.js';
import {
  startWebServer,
  broadcastToWebClients,
  broadcastNewMessage,
  broadcastTyping,
  broadcastStreamEvent,
  broadcastAgentStatus,
  broadcastBillingUpdate,
  broadcastRunnerState,
  broadcastTurnEvent,
  shutdownTerminals,
  shutdownWebServer,
} from './web.js';
import { streamingBlocksManager } from './streaming-blocks.js';
import {
  compressContext,
  shouldAutoCompress,
  type CompressOptions,
} from './context-compressor.js';
import { turnObservabilityManager } from './turn-observability.js';
import { verifyPairingCode } from './telegram-pairing.js';
import {
  MemoryAgentManager,
  exportTranscriptsForUser,
} from './memory-agent.js';
import { MemoryOrchestrator } from './memory-orchestrator.js';
import { injectMemoryAgentDeps } from './routes/memory-agent.js';
import { injectFeishuApiDeps } from './routes/feishu-api.js';
import { injectMemoryDeps } from './routes/memory.js';
import { sendToolCommentary, resetTurnCommentaryTimer } from './im-commentary.js';

const GROUP_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const execFileAsync = promisify(execFile);
const DEFAULT_MAIN_JID = 'web:main';
const DEFAULT_MAIN_NAME = 'Main';

let globalMessageCursor: MessageCursor = { rowid: 0 };
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, MessageCursor> = {};
let messageLoopRunning = false;
let ipcWatcherRunning = false;
let shuttingDown = false;

const queue = new SessionRuntimeManager();
const turnManager = new TurnManager();
const EMPTY_CURSOR: MessageCursor = { rowid: 0 };
const terminalWarmupInFlight = new Set<string>();

/**
 * Per-folder map of trigger messages: sourceJid → { id, sender } of the last
 * inbound message from that IM channel in the current batch.
 * Set by processGroupMessages when launching the agent, read by IPC handler
 * to thread replies and resolve urgent targets accurately.
 * This avoids querying DB for "last inbound" which may return a message
 * the agent hasn't seen (arrived after agent started).
 */
const triggerMessagesByFolder = new Map<
  string,
  Map<string, { id: string; sender: string }>
>();

// IPC delivery watchdog: track piped messages awaiting agent acknowledgement.
// When the agent-runner consumes an IPC message it emits a status stream_event
// "ipc_message_received".  If no ack arrives within IPC_DELIVERY_TIMEOUT_MS the
// host logs a warning — this helped us diagnose the "swallowed message" bug
// where the SDK silently dropped an IPC-injected query.
//
// Uses a counter + per-entry timers so rapid-fire messages to the same JID
// don't silently cancel each other's watchdogs.
const IPC_DELIVERY_TIMEOUT_MS = 120_000;
const pendingIpcDeliveries = new Map<
  string,
  {
    count: number;
    timers: ReturnType<typeof setTimeout>[];
    firstSentAt: number;
  }
>();
function trackIpcDelivery(chatJid: string): void {
  const existing = pendingIpcDeliveries.get(chatJid);
  const now = Date.now();
  const timer = setTimeout(() => {
    const entry = pendingIpcDeliveries.get(chatJid);
    if (entry) {
      const idx = entry.timers.indexOf(timer);
      if (idx >= 0) entry.timers.splice(idx, 1);
      entry.count = Math.max(0, entry.count - 1);
      logger.warn(
        { chatJid, timeoutMs: IPC_DELIVERY_TIMEOUT_MS },
        'IPC message not acknowledged by agent — possible SDK hang or dropped query',
      );
      if (entry.count <= 0) pendingIpcDeliveries.delete(chatJid);
    }
  }, IPC_DELIVERY_TIMEOUT_MS);
  if (existing) {
    existing.count++;
    existing.timers.push(timer);
  } else {
    pendingIpcDeliveries.set(chatJid, {
      count: 1,
      timers: [timer],
      firstSentAt: now,
    });
  }
}
function ackIpcDelivery(chatJid: string): void {
  const entry = pendingIpcDeliveries.get(chatJid);
  if (entry && entry.count > 0) {
    entry.count--;
    const timer = entry.timers.shift();
    if (timer) clearTimeout(timer);
    logger.info(
      {
        chatJid,
        pending: entry.count,
        latencyMs: Date.now() - entry.firstSentAt,
      },
      'IPC delivery acknowledged by agent',
    );
    if (entry.count <= 0) pendingIpcDeliveries.delete(chatJid);
  }
}

function trackIpcDeliveries(chatJids: Iterable<string>): void {
  for (const chatJid of new Set(chatJids)) {
    if (chatJid) trackIpcDelivery(chatJid);
  }
}

function ackIpcDeliveries(chatJids: Iterable<string>): void {
  for (const chatJid of new Set(chatJids)) {
    if (chatJid) ackIpcDelivery(chatJid);
  }
}

function collectIpcDeliveryKeys(
  chatJid: string,
  messages: Array<Pick<DbMessage, 'chat_jid' | 'source_jid'>>,
): string[] {
  const keys = new Set<string>([chatJid]);
  for (const message of messages) {
    const sourceJid = message.source_jid || message.chat_jid;
    if (sourceJid) keys.add(sourceJid);
  }
  return Array.from(keys);
}

function collectIpcAckKeys(
  fallbackJids: string[],
  streamEvent: NonNullable<RuntimeOutput['streamEvent']> & {
    ipcAckTargets?: string[];
    ipcAckSources?: string[];
  },
): string[] {
  const keys = new Set<string>(fallbackJids);
  for (const jid of streamEvent.ipcAckTargets || []) {
    if (jid) keys.add(jid);
  }
  for (const jid of streamEvent.ipcAckSources || []) {
    if (jid) keys.add(jid);
  }
  return Array.from(keys);
}

function persistRuntimeStateForSession(
  groupFolder: string,
  runtimeState: NonNullable<RuntimeOutput['runtimeState']>,
  agentId?: string,
): void {
  const sessionId = agentId ? `worker:${agentId}` : `main:${groupFolder}`;
  upsertSessionRuntimeState(sessionId, {
    providerSessionId: runtimeState.providerSessionId,
    resumeAnchor: runtimeState.resumeAnchor,
    providerState: runtimeState.providerState,
    recentImChannels: runtimeState.recentImChannels,
    imChannelLastSeen: runtimeState.imChannelLastSeen,
    currentPermissionMode: runtimeState.currentPermissionMode,
    lastMessageCursor: runtimeState.lastMessageCursor ?? null,
  });
}

function parseRuntimeStateJson<T>(
  value: string | null | undefined,
  fallback: T,
): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function getRuntimeBootstrapState(
  groupFolder: string,
  agentId?: string,
): {
  providerSessionId?: string;
  resumeAnchor?: string;
  bootstrapState?: RuntimeInput['bootstrapState'];
} {
  const sessionKey = agentId ? `worker:${agentId}` : `main:${groupFolder}`;
  const runtimeState = getSessionRuntimeState(sessionKey);
  const providerSessionId =
    runtimeState?.provider_session_id || getSession(groupFolder, agentId) || undefined;
  if (!runtimeState) {
    return { providerSessionId };
  }

  return {
    providerSessionId,
    resumeAnchor: runtimeState.resume_anchor || undefined,
    bootstrapState: {
      providerState: parseRuntimeStateJson<Record<string, unknown>>(
        runtimeState.provider_state_json,
        {},
      ),
      recentImChannels: parseRuntimeStateJson<string[]>(
        runtimeState.recent_im_channels_json,
        [],
      ),
      imChannelLastSeen: parseRuntimeStateJson<Record<string, number>>(
        runtimeState.im_channel_last_seen_json,
        {},
      ),
      currentPermissionMode: runtimeState.current_permission_mode,
      lastMessageCursor: runtimeState.last_message_cursor ?? null,
    },
  };
}

function resolveSessionOwnerKey(groupFolder: string): string | undefined {
  return getSessionRecord(`main:${groupFolder}`)?.owner_key || undefined;
}

function buildMainSessionRecordId(groupFolder: string): string {
  return `main:${groupFolder}`;
}

function buildWorkerSessionRecordId(agentId: string): string {
  return `worker:${agentId}`;
}

function resolveStableSessionOwnerKey(
  groupFolder: string,
  agentId?: string,
): string | undefined {
  if (agentId) {
    return getSessionRecord(buildWorkerSessionRecordId(agentId))?.owner_key
      || resolveSessionOwnerKey(groupFolder);
  }
  return resolveSessionOwnerKey(groupFolder);
}

function isImplicitDefaultSessionBinding(
  chatJid: string,
  group: RegisteredGroup | undefined,
  binding: ReturnType<typeof getSessionBinding> | undefined,
): boolean {
  if (!group || !binding) return false;
  if (group.activation_mode === 'disabled') return false;
  if (chatJid.startsWith('web:')) return false;
  return binding.session_id === `main:${group.folder}`;
}

function getExplicitSessionBinding(
  chatJid: string,
  fallbackGroup?: RegisteredGroup,
): ReturnType<typeof getSessionBinding> | undefined {
  const group =
    fallbackGroup ?? registeredGroups[chatJid] ?? getRegisteredGroup(chatJid);
  const binding = getSessionBinding(chatJid);
  return isImplicitDefaultSessionBinding(chatJid, group, binding)
    ? undefined
    : binding;
}

function getChatBindingPolicy(chatJid: string): {
  activationMode: 'auto' | 'always' | 'when_mentioned' | 'disabled';
  requireMention: boolean;
  replyPolicy: 'source_only' | 'mirror';
  sessionId: string | null;
} {
  const group = registeredGroups[chatJid] ?? getRegisteredGroup(chatJid);
  const binding = getExplicitSessionBinding(chatJid, group);
  if (binding) {
    return {
      activationMode: binding.activation_mode,
      requireMention: binding.require_mention === true,
      replyPolicy: binding.reply_policy === 'mirror' ? 'mirror' : 'source_only',
      sessionId: binding.session_id,
    };
  }

  return {
    activationMode: group?.activation_mode ?? 'auto',
    requireMention: group?.require_mention === true,
    replyPolicy: group?.reply_policy === 'mirror' ? 'mirror' : 'source_only',
    sessionId: group ? resolveDefaultSessionBinding(chatJid, group) : null,
  };
}

function resolveBoundSessionTarget(
  chatJid: string,
  fallbackGroup?: RegisteredGroup,
): {
  sessionId: string | null;
  boundAgentId: string | null;
  effectiveJid: string | null;
  folder: string;
  locationLine: string;
  replyPolicy: 'source_only' | 'mirror' | null;
  contextCompression: 'off' | 'auto' | 'manual';
} {
  const group =
    fallbackGroup ?? registeredGroups[chatJid] ?? getRegisteredGroup(chatJid);
  const defaultFolder = group?.folder || MAIN_GROUP_FOLDER;
  const defaultCompression = group?.context_compression ?? 'off';
  const defaultLocationLine = `${findGroupNameByFolder(defaultFolder)} / 主会话`;
  const policy = getChatBindingPolicy(chatJid);
  const bindingSessionId = policy.sessionId;

  if (!bindingSessionId) {
    return {
      sessionId: null,
      boundAgentId: null,
      effectiveJid: group ? findWebJidForFolder(group.folder) : null,
      folder: defaultFolder,
      locationLine: defaultLocationLine,
      replyPolicy: null,
      contextCompression: defaultCompression,
    };
  }

  const boundSession = getSessionRecord(bindingSessionId);
  if (!boundSession) {
    return {
      sessionId: bindingSessionId,
      boundAgentId: null,
      effectiveJid: null,
      folder: defaultFolder,
      locationLine: defaultLocationLine,
      replyPolicy: policy.replyPolicy,
      contextCompression: defaultCompression,
    };
  }

  if (boundSession.kind === 'worker') {
    const worker = getWorkerSessionRecord(boundSession.id);
    const boundAgentId = boundSession.id.startsWith('worker:')
      ? boundSession.id.slice('worker:'.length)
      : null;
    const parentSession = boundSession.parent_session_id
      ? getSessionRecord(boundSession.parent_session_id)
      : null;
    const sourceGroup = worker
      ? (registeredGroups[worker.source_chat_jid] ??
        getRegisteredGroup(worker.source_chat_jid))
      : null;
    const folder =
      sourceGroup?.folder ||
      (parentSession?.id.startsWith('main:')
        ? parentSession.id.slice('main:'.length)
        : defaultFolder);
    const workspaceName =
      parentSession?.name || sourceGroup?.name || findGroupNameByFolder(folder);
    return {
      sessionId: boundSession.id,
      boundAgentId,
      effectiveJid:
        worker && boundAgentId
          ? `${worker.source_chat_jid}#agent:${boundAgentId}`
          : null,
      folder,
      locationLine: `${workspaceName} / ${worker?.name || boundAgentId || boundSession.name}`,
      replyPolicy: policy.replyPolicy,
      contextCompression:
        parentSession?.context_compression || defaultCompression,
    };
  }

  const folder = boundSession.id.startsWith('main:')
    ? boundSession.id.slice('main:'.length)
    : boundSession.parent_session_id?.startsWith('main:')
      ? boundSession.parent_session_id.slice('main:'.length)
      : defaultFolder;

  return {
    sessionId: boundSession.id,
    boundAgentId: null,
    effectiveJid: findWebJidForFolder(folder) || `web:${folder}`,
    folder,
    locationLine: `${boundSession.name} / 主会话`,
    replyPolicy: policy.replyPolicy,
    contextCompression: boundSession.context_compression,
  };
}

function resolveChatOwnerKey(
  chatJid: string,
  fallbackGroup?: RegisteredGroup,
  agentId?: string,
): string | undefined {
  const policy = getChatBindingPolicy(chatJid);
  if (policy.sessionId) {
    const boundSession = getSessionRecord(policy.sessionId);
    if (boundSession?.owner_key) return boundSession.owner_key;
    if (boundSession?.parent_session_id) {
      const parentSession = getSessionRecord(boundSession.parent_session_id);
      if (parentSession?.owner_key) return parentSession.owner_key;
    }
  }

  if (agentId) {
    const workerSession = getSessionRecord(buildWorkerSessionRecordId(agentId));
    if (workerSession?.owner_key) return workerSession.owner_key;
  }

  const group = fallbackGroup ?? registeredGroups[chatJid] ?? getRegisteredGroup(chatJid);
  if (!group) return undefined;
  return resolveSessionOwnerKey(group.folder);
}

function clearIpcDeliveryTracker(chatJid: string): void {
  const entry = pendingIpcDeliveries.get(chatJid);
  if (entry) {
    for (const t of entry.timers) clearTimeout(t);
    pendingIpcDeliveries.delete(chatJid);
  }
}

function applyExplicitChatBinding(
  chatJid: string,
  group: RegisteredGroup,
  sessionId: string | null,
  replyPolicy: 'source_only' | 'mirror' = 'source_only',
): void {
  const current = getSessionBinding(chatJid);
  const now = new Date().toISOString();
  const implicitDefaultSessionId =
    group.activation_mode === 'disabled' || chatJid.startsWith('web:')
      ? null
      : `main:${group.folder}`;
  if (!sessionId || sessionId === implicitDefaultSessionId) {
    deleteSessionBinding(chatJid);
    return;
  }
  const session = getSessionRecord(sessionId);
  saveSessionBinding({
    channel_jid: chatJid,
    session_id: sessionId,
    binding_mode:
      replyPolicy === 'mirror'
        ? 'mirror'
        : session?.kind === 'worker'
          ? 'direct'
          : 'source_only',
    activation_mode: group.activation_mode ?? 'auto',
    require_mention: group.require_mention === true,
    display_name: group.name,
    reply_policy: replyPolicy,
    created_at: current?.created_at || group.added_at || now,
    updated_at: now,
  });
}

function resolveDefaultSessionBinding(
  chatJid: string,
  group: RegisteredGroup,
): string | null {
  if (group.activation_mode === 'disabled') return null;
  if (group.target_agent_id) return `worker:${group.target_agent_id}`;
  if (group.target_main_jid) {
    const targetGroup = registeredGroups[group.target_main_jid]
      ?? getRegisteredGroup(group.target_main_jid);
    if (targetGroup) return `main:${targetGroup.folder}`;
  }
  if (chatJid.startsWith('web:')) return null;
  return `main:${group.folder}`;
}

// Track consecutive IM send failures per JID for auto-unbind
const imSendFailCounts = new Map<string, number>();
const IM_SEND_FAIL_THRESHOLD = 3;

// Track consecutive IM health check failures per JID for safe auto-unbind
const imHealthCheckFailCounts = new Map<string, number>();
const IM_HEALTH_CHECK_FAIL_THRESHOLD = 3;
const RELATIVE_IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.svg',
]);

/** Unbind an IM group from its conversation agent or main conversation, syncing DB + in-memory cache + failure counters. */
function unbindImGroup(jid: string, reason: string): void {
  const group = registeredGroups[jid] ?? getRegisteredGroup(jid);
  const storedBinding = getSessionBinding(jid);
  const binding = getExplicitSessionBinding(jid, group);
  if (!binding && !group?.target_agent_id && !group?.target_main_jid) {
    if (storedBinding) deleteSessionBinding(jid);
    return;
  }
  const agentId = group?.target_agent_id;
  const targetMainJid = group?.target_main_jid;
  if (!group) {
    deleteSessionBinding(jid);
    logger.info(
      { jid, sessionId: binding?.session_id || storedBinding?.session_id || null },
      `${reason} but backing IM group is already gone`,
    );
    return;
  }
  const updated = {
    ...group,
    target_agent_id: undefined,
    target_main_jid: undefined,
    reply_policy: 'source_only' as const,
    activation_mode: 'disabled' as const,
  };
  setRegisteredGroup(jid, updated);
  deleteSessionBinding(jid);
  registeredGroups[jid] = updated;
  imSendFailCounts.delete(jid);
  imHealthCheckFailCounts.delete(jid);
  logger.info({ jid, agentId, targetMainJid }, reason);
}

/** Check per-user IM setting to decide whether auto-unbind on failure is enabled. */
function shouldAutoUnbindOnFailure(jid: string): boolean {
  const group = registeredGroups[jid] ?? getRegisteredGroup(jid);
  const ownerKey = resolveChatOwnerKey(jid, group);
  if (!ownerKey) return true;
  return getUserImGeneralConfig(ownerKey).autoUnbindOnSendFailure;
}

/**
 * Resolve the workspace folder an IM chat should use for file downloads and
 * execution context. Bound targets take precedence over the source IM folder.
 */
function resolveEffectiveFolder(chatJid: string): string | undefined {
  const group = registeredGroups[chatJid] ?? getRegisteredGroup(chatJid);
  if (!group) return undefined;
  return resolveBoundSessionTarget(chatJid, group).folder || group.folder;
}

/**
 * Resolve the effective group for a non-home group by finding its sibling home group.
 * Non-home groups use their own local runtime metadata and customCwd.
 * Populates registeredGroups cache as a side-effect.
 */
function resolveEffectiveGroup(group: RegisteredGroup): {
  effectiveGroup: RegisteredGroup;
  isHome: boolean;
} {
  if (group.is_home) return { effectiveGroup: group, isHome: true };

  const siblingJids = getJidsByFolder(group.folder);
  for (const jid of siblingJids) {
    const sibling = registeredGroups[jid] ?? getRegisteredGroup(jid);
    if (sibling && !registeredGroups[jid]) registeredGroups[jid] = sibling;
    if (sibling?.is_home) {
      return {
        effectiveGroup: {
          ...group,
          executionMode: sibling.executionMode,
          customCwd: sibling.customCwd || group.customCwd,
          created_by: group.created_by || sibling.created_by,
          is_home: true,
        },
        isHome: true,
      };
    }
  }

  return { effectiveGroup: group, isHome: false };
}

/** Resolve the owner's primary session folder for shared runtime credentials. */
function resolveOwnerHomeFolder(group: RegisteredGroup): string {
  const ownerKey = resolveSessionOwnerKey(group.folder);
  if (!ownerKey) {
    return group.folder;
  }
  const primarySession = getPrimarySessionForOwner(ownerKey);
  if (primarySession?.id.startsWith('main:')) {
    return primarySession.id.slice('main:'.length);
  }
  return group.folder;
}

/**
 * Write usage records from a usage event to the database.
 * Handles both modelUsage (per-model breakdown) and legacy flat format.
 * When modelUsage is present, root-level cache tokens are assigned to the first model entry.
 */
function writeUsageRecords(opts: {
  userId: string;
  groupFolder: string;
  messageId?: string;
  agentId?: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    costUSD: number;
    durationMs: number;
    numTurns: number;
    modelUsage?: Record<
      string,
      { inputTokens: number; outputTokens: number; costUSD: number }
    >;
  };
}): void {
  const { userId, groupFolder, messageId, agentId, usage } = opts;
  if (usage.modelUsage) {
    const models = Object.entries(usage.modelUsage);
    let cacheReadAssigned = false;
    for (const [model, mu] of models) {
      insertUsageRecord({
        userId,
        groupFolder,
        agentId,
        messageId,
        model,
        inputTokens: mu.inputTokens,
        outputTokens: mu.outputTokens,
        // Assign root-level cache tokens to the first model entry
        cacheReadInputTokens: cacheReadAssigned
          ? 0
          : usage.cacheReadInputTokens,
        cacheCreationInputTokens: cacheReadAssigned
          ? 0
          : usage.cacheCreationInputTokens,
        costUSD: mu.costUSD,
        durationMs: usage.durationMs,
        numTurns: usage.numTurns,
        source: 'agent',
      });
      cacheReadAssigned = true;
    }
  } else {
    insertUsageRecord({
      userId,
      groupFolder,
      agentId,
      messageId,
      model: 'unknown',
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadInputTokens: usage.cacheReadInputTokens,
      cacheCreationInputTokens: usage.cacheCreationInputTokens,
      costUSD: usage.costUSD,
      durationMs: usage.durationMs,
      numTurns: usage.numTurns,
      source: 'agent',
    });
  }
}

/** Send a message to an IM channel with automatic fail-count tracking and auto-unbind. */
function extractLocalImImagePaths(
  text: string,
  groupFolder?: string,
  userId?: string,
): string[] {
  if (!groupFolder || !text) return [];

  const workspaceRoot = path.resolve(GROUPS_DIR, groupFolder);
  const userGlobalRoot = userId
    ? path.resolve(GROUPS_DIR, 'user-global', userId)
    : null;
  const seen = new Set<string>();
  const imagePaths: string[] = [];
  const candidates: string[] = [];
  const markdownImageRe = /!\[[^\]]*]\(([^)]+)\)/g;
  const taggedImageRe = /\[图片:\s*([^\]\n]+)\]/g;

  const pushCandidate = (raw: string): void => {
    const trimmed = raw.trim().replace(/^<|>$/g, '');
    const pathToken = trimmed
      .split(/\s+/)[0]
      ?.trim()
      .replace(/^['"]|['"]$/g, '');
    if (
      !pathToken ||
      pathToken.startsWith('/') ||
      pathToken.startsWith('data:') ||
      /^[a-z]+:\/\//i.test(pathToken)
    ) {
      return;
    }
    candidates.push(pathToken);
  };

  for (const match of text.matchAll(markdownImageRe)) {
    pushCandidate(match[1] || '');
  }
  for (const match of text.matchAll(taggedImageRe)) {
    pushCandidate(match[1] || '');
  }

  const tryResolveInRoot = (
    root: string,
    candidate: string,
  ): string | null => {
    const resolved = path.resolve(root, candidate);
    const ext = path.extname(resolved).toLowerCase();
    if (!RELATIVE_IMAGE_EXTENSIONS.has(ext)) return null;
    if (resolved !== root && !resolved.startsWith(root + path.sep))
      return null;
    try {
      if (fs.statSync(resolved).isFile()) return resolved;
    } catch { /* ignore */ }
    return null;
  };

  for (const candidate of candidates) {
    // Try group workspace first, then user-global as fallback
    const resolved =
      tryResolveInRoot(workspaceRoot, candidate) ||
      (userGlobalRoot ? tryResolveInRoot(userGlobalRoot, candidate) : null);
    if (!resolved || seen.has(resolved)) continue;
    seen.add(resolved);
    imagePaths.push(resolved);
  }

  return imagePaths;
}

function sendImWithFailTracking(
  imJid: string,
  text: string,
  localImagePaths: string[],
  options?: IMSendOptions,
): void {
  imManager
    .sendMessage(imJid, text, localImagePaths, options)
    .then(() => {
      imSendFailCounts.delete(imJid);
    })
    .catch((err) => {
      logger.warn({ imJid, err }, 'Failed to relay message to IM');
      const count = (imSendFailCounts.get(imJid) ?? 0) + 1;
      imSendFailCounts.set(imJid, count);
      if (count >= IM_SEND_FAIL_THRESHOLD && shouldAutoUnbindOnFailure(imJid)) {
        try {
          unbindImGroup(
            imJid,
            'Auto-unbound IM group after consecutive send failures',
          );
        } catch (unbindErr) {
          logger.error({ imJid, unbindErr }, 'Failed to auto-unbind IM group');
        }
      }
    });
}

function isCursorAfter(candidate: MessageCursor, base: MessageCursor): boolean {
  return candidate.rowid > base.rowid;
}

function normalizeCursor(value: unknown): MessageCursor {
  // New format: { rowid: number }
  if (
    value &&
    typeof value === 'object' &&
    typeof (value as { rowid?: unknown }).rowid === 'number'
  ) {
    return { rowid: (value as { rowid: number }).rowid };
  }
  // Old format migration: { timestamp, id } → look up rowid
  if (
    value &&
    typeof value === 'object' &&
    typeof (value as { timestamp?: unknown }).timestamp === 'string'
  ) {
    const ts = (value as { timestamp: string }).timestamp;
    const id =
      typeof (value as { id?: unknown }).id === 'string'
        ? (value as { id: string }).id
        : '';
    return { rowid: getRowidByCursor(ts, id) };
  }
  if (typeof value === 'string') {
    return { rowid: getRowidByCursor(value, '') };
  }
  return { ...EMPTY_CURSOR };
}

function sendSystemMessage(jid: string, type: string, detail: string): void {
  const msgId = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  ensureChatExists(jid);
  storeMessageDirect(
    msgId,
    jid,
    '__system__',
    'system',
    `${type}:${detail}`,
    timestamp,
    true,
  );
  broadcastNewMessage(jid, {
    id: msgId,
    chat_jid: jid,
    sender: '__system__',
    sender_name: 'system',
    content: `${type}:${detail}`,
    timestamp,
    is_from_me: true,
  });
}

function sendBillingDeniedMessage(jid: string, content: string): string {
  const msgId = `sys_quota_${Date.now()}`;
  const timestamp = new Date().toISOString();
  ensureChatExists(jid);
  storeMessageDirect(
    msgId,
    jid,
    '__billing__',
    ASSISTANT_NAME,
    content,
    timestamp,
    true,
  );
  broadcastNewMessage(jid, {
    id: msgId,
    chat_jid: jid,
    sender: '__billing__',
    sender_name: ASSISTANT_NAME,
    content,
    timestamp,
    is_from_me: true,
  });
  return msgId;
}

function getSessionClaudeDir(folder: string, agentId?: string): string {
  return agentId
    ? path.join(DATA_DIR, 'sessions', folder, 'agents', agentId, '.claude')
    : path.join(DATA_DIR, 'sessions', folder, '.claude');
}

async function clearSessionRuntimeFiles(
  folder: string,
  agentId?: string,
): Promise<void> {
  const claudeDir = getSessionClaudeDir(folder, agentId);
  if (!fs.existsSync(claudeDir)) return;

  try {
    for (const entry of fs.readdirSync(claudeDir)) {
      if (entry === 'settings.json') continue;
      fs.rmSync(path.join(claudeDir, entry), { recursive: true, force: true });
    }
  } catch (err) {
    logger.error(
      { folder, agentId, err },
      'Failed to clear session runtime files directly',
    );
  }
}

/**
 * Slash command handler for IM channels (Feishu/Telegram).
 * Returns a reply string on success, or null if command not recognized.
 */
async function handleCommand(
  chatJid: string,
  command: string,
): Promise<string | null> {
  const parts = command.split(/\s+/);
  const cmd = parts[0];
  const rawArgs = command.slice(cmd.length).trim();

  switch (cmd) {
    case 'clear':
      return '此命令仅支持在 Web 端使用';
    case 'list':
    case 'ls':
      return handleListCommand(chatJid);
    case 'status':
      return handleStatusCommand(chatJid);
    case 'recall':
    case 'rc':
      return handleRecallCommand(chatJid);
    case 'where':
      return handleWhereCommand(chatJid);
    case 'unbind':
      return handleUnbindCommand(chatJid);
    case 'bind':
      return handleBindCommand(chatJid, rawArgs);
    case 'new':
      return handleNewCommand(chatJid, rawArgs);
    case 'require_mention':
      return handleRequireMentionCommand(chatJid, rawArgs);
    default:
      return null;
  }
}

/**
 * Collect all accessible workspaces for a user as pure WorkspaceInfo[].
 */
function collectWorkspaces(userId: string): WorkspaceInfo[] {
  const ownedGroups = getGroupsByOwner(userId);
  const user = getUserById(userId);
  const isAdmin = user?.role === 'admin';

  const seen = new Set<string>();
  const workspaces: WorkspaceInfo[] = [];

  for (const g of ownedGroups) {
    if (!g.jid.startsWith('web:')) continue;
    if (seen.has(g.folder)) continue;
    seen.add(g.folder);

    const agents = listAgentsByJid(g.jid)
      .filter((a) => a.kind === 'conversation')
      .map((a) => ({ id: a.id, name: a.name, status: a.status }));

    workspaces.push({ folder: g.folder, name: g.name, agents });
  }

  if (isAdmin && !seen.has(MAIN_GROUP_FOLDER)) {
    const agents = listAgentsByJid(DEFAULT_MAIN_JID)
      .filter((a) => a.kind === 'conversation')
      .map((a) => ({ id: a.id, name: a.name, status: a.status }));
    workspaces.push({
      folder: MAIN_GROUP_FOLDER,
      name: DEFAULT_MAIN_NAME,
      agents,
    });
  }

  return workspaces;
}

function resolveBindingTarget(
  userId: string,
  rawSpec: string,
): {
  sessionId: string;
  display: string;
} | null {
  const spec = rawSpec.trim();
  if (!spec) return null;

  const [workspaceSpecRaw, agentSpecRaw] = spec.split('/', 2);
  const workspaceSpec = workspaceSpecRaw.trim().toLowerCase();
  const agentSpec = agentSpecRaw?.trim().toLowerCase();
  const workspaces = collectWorkspaces(userId);
  const workspace = workspaces.find(
    (ws) =>
      ws.folder.toLowerCase() === workspaceSpec ||
      ws.name.trim().toLowerCase() === workspaceSpec,
  );
  if (!workspace) return null;

  if (!agentSpec || agentSpec === 'main' || agentSpec === '主会话' || agentSpec === '主对话') {
    if (!findWebJidForFolder(workspace.folder)) return null;
    return {
      sessionId: `main:${workspace.folder}`,
      display: `${workspace.name} / 主会话`,
    };
  }

  const agent = workspace.agents.find(
    (item) =>
      item.id.toLowerCase().startsWith(agentSpec) ||
      item.name.trim().toLowerCase() === agentSpec,
  );
  if (!agent) return null;

  return {
    sessionId: `worker:${agent.id}`,
    display: `${workspace.name} / ${agent.name}`,
  };
}

/**
 * Find the primary web JID for a folder (the one used for web:xxx groups).
 */
function findWebJidForFolder(folder: string): string | null {
  for (const [jid, group] of Object.entries(registeredGroups)) {
    if (group.folder === folder && jid.startsWith('web:')) return jid;
  }
  const jids = getJidsByFolder(folder);
  for (const jid of jids) {
    if (jid.startsWith('web:')) return jid;
  }
  return null;
}

/**
 * Find the display name for a folder by looking up its web group.
 */
function findGroupNameByFolder(folder: string): string {
  const webJid = findWebJidForFolder(folder);
  if (webJid) {
    const group = registeredGroups[webJid] ?? getRegisteredGroup(webJid);
    if (group) return group.name;
  }
  return folder;
}

/**
 * Fetch recent messages and format a context summary.
 */
function getConversationContext(
  folder: string,
  agentId: string | null,
  count = 5,
  maxLen = 80,
): string {
  const webJid = findWebJidForFolder(folder);
  if (!webJid) return '';

  const chatJidForMsg = agentId ? `${webJid}#agent:${agentId}` : webJid;
  const messages = getMessagesPage(chatJidForMsg, undefined, count);

  if (messages.length === 0) return '\n\n📭 该对话暂无消息记录';

  const formatted = formatContextMessages(messages.reverse(), maxLen);
  return formatted || '\n\n📭 该对话暂无消息记录';
}

function handleListCommand(chatJid: string): string {
  const group = registeredGroups[chatJid] ?? getRegisteredGroup(chatJid);
  if (!group) return '当前 IM 未绑定工作区';

  const userId = resolveChatOwnerKey(chatJid, group);
  if (!userId) return '无法确定用户身份';

  const workspaces = collectWorkspaces(userId);
  if (workspaces.length === 0) return '没有可用的工作区';
  const location = getLocationForGroup(chatJid, group);

  return (
    formatWorkspaceList(
      workspaces,
      location.folder,
      location.boundAgentId,
    ) +
    '\n💡 使用 /bind <workspace> 或 /bind <workspace>/<agent短ID>'
  );
}

function handleStatusCommand(chatJid: string): string {
  const group = registeredGroups[chatJid] ?? getRegisteredGroup(chatJid);
  if (!group) return '当前 IM 未绑定工作区';

  const location = getLocationForGroup(chatJid, group);
  const effectiveQueueJid = location.effectiveJid || chatJid;

  const queueStatus = queue.getRuntimeStatus();
  const settings = getSystemSettings();

  // Check if the current group's folder is active or queued
  const lookupGroup = (jid: string) =>
    registeredGroups[jid] ?? getRegisteredGroup(jid);
  const groupState =
    queueStatus.groups.find((g) => g.jid === effectiveQueueJid)
    || queueStatus.groups.find((g) => {
      const rg = lookupGroup(g.jid);
      return rg?.folder === location.folder;
    });
  const isActive = !!groupState?.active;
  const waitingTargets = [effectiveQueueJid, chatJid];
  const queueIndex = waitingTargets
    .map((jid) => queueStatus.waitingGroupJids.indexOf(jid))
    .find((index) => index >= 0);
  const queuePosition = !isActive && queueIndex !== undefined
    ? queueIndex + 1
    : null;

  return formatSystemStatus(
    location,
    {
      activeRuntimes: queueStatus.activeCount,
      maxRuntimes: settings.maxConcurrentRuntimes,
      waitingCount: queueStatus.waitingCount,
      waitingGroupJids: queueStatus.waitingGroupJids,
    },
    isActive,
    queuePosition,
  );
}

/**
 * Resolve location info for a registered group (shared helper to avoid
 * duplicating the lookupGroup closure + resolveLocationInfo call).
 */
function getLocationForGroup(chatJid: string, group: RegisteredGroup) {
  const resolved = resolveBoundSessionTarget(chatJid, group);
  return {
    locationLine: resolved.locationLine,
    folder: resolved.folder,
    replyPolicy: resolved.replyPolicy,
    boundAgentId: resolved.boundAgentId,
    effectiveJid: resolved.effectiveJid,
  };
}

function handleWhereCommand(chatJid: string): string {
  const group = registeredGroups[chatJid] ?? getRegisteredGroup(chatJid);
  if (!group) return '当前 IM 未绑定工作区';

  const location = getLocationForGroup(chatJid, group);

  const lines = [`📍 当前绑定: ${location.locationLine}`];
  if (location.replyPolicy) {
    lines.push(`🔁 回复策略: ${location.replyPolicy}`);
  }
  return lines.join('\n');
}

function handleUnbindCommand(chatJid: string): string {
  const group = registeredGroups[chatJid] ?? getRegisteredGroup(chatJid);
  if (!group) return '当前 IM 未绑定工作区';
  if (!getExplicitSessionBinding(chatJid, group))
    return '当前聊天没有额外绑定，已在默认工作区。';
  unbindImGroup(chatJid, 'IM slash command unbind');
  return '已解绑，后续消息将回到该聊天自己的默认工作区。';
}

function handleBindCommand(chatJid: string, rawSpec: string): string {
  const group = registeredGroups[chatJid] ?? getRegisteredGroup(chatJid);
  if (!group) return '当前 IM 未绑定工作区';
  const userId = resolveChatOwnerKey(chatJid, group);
  if (!userId) return '无法确定当前聊天所属用户';

  // Helper: build location info + workspace list block (shared by no-args and not-found cases)
  const buildBindHelpLines = (prefix: string[]): string => {
    const location = getLocationForGroup(chatJid, group);
    const lines = [...prefix, `📍 当前绑定: ${location.locationLine}`];
    if (location.replyPolicy) {
      lines.push(`🔁 回复策略: ${location.replyPolicy}`);
    }
    const workspaces = collectWorkspaces(userId);
    if (workspaces.length > 0) {
      lines.push('');
      lines.push(
        formatWorkspaceList(
          workspaces,
          location.folder,
          location.boundAgentId,
        ),
      );
    }
    lines.push('');
    lines.push('用法: /bind <名称> 或 /bind <工作区>/<agent短ID>');
    return lines.join('\n');
  };

  if (!rawSpec) {
    return buildBindHelpLines([]) + '\n/new <名称> — 创建新工作区并绑定\n/unbind — 解绑回默认';
  }

  const resolved = resolveBindingTarget(userId, rawSpec);
  if (!resolved) {
    return buildBindHelpLines([`未找到「${rawSpec}」。`, '']);
  }

  const updated: RegisteredGroup = {
    ...group,
    target_agent_id: undefined,
    target_main_jid: undefined,
    reply_policy: 'source_only',
  };
  setRegisteredGroup(chatJid, updated);
  applyExplicitChatBinding(chatJid, updated, resolved.sessionId, 'source_only');
  registeredGroups[chatJid] = updated;
  imSendFailCounts.delete(chatJid);
  imHealthCheckFailCounts.delete(chatJid);
  return `已切换到 ${resolved.display}\n🔁 回复策略: source_only`;
}

function handleNewCommand(chatJid: string, rawName: string): string {
  const group = registeredGroups[chatJid] ?? getRegisteredGroup(chatJid);
  if (!group) return '当前 IM 未绑定工作区';
  const userId = resolveChatOwnerKey(chatJid, group);
  if (!userId) return '无法确定当前聊天所属用户';

  const name = rawName.trim();
  if (!name) return '用法: /new <工作区名称>';
  if (name.length > 50) return '名称过长（最多 50 字符）';

  // Create a new workspace (same pattern as routes/groups.ts POST)
  const newJid = `web:${crypto.randomUUID()}`;
  const folder = `flow-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const now = new Date().toISOString();

  const newGroup: RegisteredGroup = {
    name,
    folder,
    added_at: now,
    executionMode: 'local',
    created_by: userId,
  };

  // Register the workspace
  registerGroup(newJid, newGroup);
  ensureChatExists(newJid);
  updateChatName(newJid, name);
  addGroupMember(folder, userId, 'owner', userId);

  // Bind the current IM group to the new workspace's main conversation
  const updated: RegisteredGroup = {
    ...group,
    target_main_jid: undefined,
    target_agent_id: undefined,
    reply_policy: 'source_only',
  };
  setRegisteredGroup(chatJid, updated);
  applyExplicitChatBinding(chatJid, updated, `main:${folder}`, 'source_only');
  registeredGroups[chatJid] = updated;
  imSendFailCounts.delete(chatJid);
  imHealthCheckFailCounts.delete(chatJid);

  return `工作区「${name}」已创建并绑定\n📁 ${folder}\n🔁 回复策略: source_only\n\n发送 /unbind 可解绑回默认工作区`;
}

function handleRequireMentionCommand(chatJid: string, rawArgs: string): string {
  const group = registeredGroups[chatJid] ?? getRegisteredGroup(chatJid);
  if (!group) return '未找到当前会话';

  const action = rawArgs.trim().toLowerCase();
  if (action === 'true') {
    const updated: RegisteredGroup = { ...group, require_mention: true };
    setRegisteredGroup(chatJid, updated);
    const policy = getChatBindingPolicy(chatJid);
    applyExplicitChatBinding(
      chatJid,
      updated,
      policy.sessionId,
      policy.replyPolicy,
    );
    registeredGroups[chatJid] = updated;
    return '已开启：群聊中需要 @机器人 才会响应';
  } else if (action === 'false') {
    const updated: RegisteredGroup = { ...group, require_mention: false };
    setRegisteredGroup(chatJid, updated);
    const policy = getChatBindingPolicy(chatJid);
    applyExplicitChatBinding(
      chatJid,
      updated,
      policy.sessionId,
      policy.replyPolicy,
    );
    registeredGroups[chatJid] = updated;
    return '已关闭：群聊中所有消息都会响应，无需 @机器人';
  } else if (!action) {
    const current = group.require_mention === true;
    return `当前 require_mention: ${current}\n\n用法:\n/require_mention true — 需要 @机器人\n/require_mention false — 全量响应`;
  }
  return '用法: /require_mention true|false';
}

const recallCooldowns = new Map<string, number>();

async function handleRecallCommand(chatJid: string): Promise<string> {
  logger.info({ chatJid }, '/recall command received');

  const now = Date.now();
  const lastRecall = recallCooldowns.get(chatJid) || 0;
  if (now - lastRecall < 10000) {
    return '⏳ 请稍后再试（冷却中）';
  }
  recallCooldowns.set(chatJid, now);

  const group = registeredGroups[chatJid] ?? getRegisteredGroup(chatJid);
  if (!group) {
    logger.warn({ chatJid }, '/recall: no registered group found');
    return '当前 IM 未绑定工作区';
  }

  const resolvedTarget = resolveBoundSessionTarget(chatJid, group);
  const targetJid = resolvedTarget.effectiveJid || undefined;
  const targetFolder = resolvedTarget.folder;
  const targetAgentId = resolvedTarget.boundAgentId;
  const header = `🧠 ${resolvedTarget.locationLine}`;

  if (!targetJid) {
    logger.warn({ chatJid, targetFolder }, '/recall: no JID found for target');
    return `${header}\n\n📭 该对话暂无消息记录`;
  }

  // Fetch recent messages for summarization
  const messages = getMessagesPage(targetJid, undefined, 10);
  logger.info(
    { chatJid, targetJid, messageCount: messages.length },
    '/recall: fetched messages',
  );

  if (messages.length === 0) return `${header}\n\n📭 该对话暂无消息记录`;

  // Build chronological transcript
  const transcript = messages
    .reverse()
    .map((msg) => {
      const who = msg.is_from_me ? 'AI' : msg.sender_name || '用户';
      const text = (msg.content || '').slice(0, 300);
      return `${who}: ${text}`;
    })
    .join('\n');

  logger.info(
    { chatJid, transcriptLen: transcript.length },
    '/recall: built transcript, calling Claude CLI',
  );

  // Try to summarize via Claude CLI
  const summary = await summarizeWithClaude(transcript);
  if (summary) {
    logger.info(
      { chatJid, summaryLen: summary.length },
      '/recall: summary generated successfully',
    );
    return `${header}\n\n${summary}`;
  }

  logger.warn(
    { chatJid },
    '/recall: summary failed, falling back to raw messages',
  );

  // Fallback: raw context if CLI unavailable
  const context = getConversationContext(targetFolder, targetAgentId, 10, 200);
  if (!context) return `${header}\n\n📭 该对话暂无消息记录`;
  return header + context;
}

/**
 * Call Claude CLI (`claude --print`) to summarize a conversation transcript.
 * Uses the same auth mechanism (OAuth / API Key) as normal agent conversations.
 * Returns null if CLI is unavailable or call fails.
 */
async function summarizeWithClaude(transcript: string): Promise<string | null> {
  const prompt = `请用简洁的中文总结以下对话的要点和进展，重点说明讨论了什么、达成了什么结论、还有什么待办事项。不要逐条翻译，而是提炼核心信息。\n\n${transcript}`;

  return new Promise((resolve) => {
    logger.info(
      { promptLen: prompt.length },
      'summarizeWithClaude: invoking claude CLI via stdin',
    );

    const model = process.env.RECALL_MODEL || '';
    const args = ['--print'];
    if (model) {
      args.push('--model', model);
    }

    const child = execFile(
      'claude',
      args,
      {
        timeout: 30000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, CLAUDECODE: '' },
      },
      (err, stdout, stderr) => {
        if (err) {
          const e = err as Error & { code?: number | string };
          logger.warn(
            {
              message: e.message?.slice(0, 200),
              code: e.code,
              stderr: stderr?.slice(0, 300),
              stdout: stdout?.slice(0, 300),
            },
            'summarizeWithClaude: CLI call failed',
          );
          resolve(null);
          return;
        }
        const text = stdout.trim();
        logger.info(
          {
            stdoutLen: text.length,
            stderr: stderr?.trim().slice(0, 200) || '',
          },
          'summarizeWithClaude: CLI returned',
        );
        resolve(text || null);
      },
    );

    // Feed prompt via stdin to avoid arg length limits and special char issues
    child.stdin?.write(prompt);
    child.stdin?.end();
  });
}

async function setTyping(jid: string, isTyping: boolean): Promise<void> {
  await imManager.setTyping(jid, isTyping);
  broadcastTyping(jid, isTyping);
}

interface SendMessageOptions {
  /** Whether to forward the reply to the IM channel (Feishu/Telegram). Defaults to true for IM JIDs. */
  sendToIM?: boolean;
  /** Pre-computed local image paths to attach to IM messages. Avoids redundant filesystem scans. */
  localImagePaths?: string[];
  /** External message ID from IM platform (e.g. Feishu om_xxx). Used as DB message ID for reply matching. */
  externalMsgId?: string;
}

/**
 * One-time migration: copy system-level IM config → admin's per-user config.
 * Safe to call repeatedly — writes a flag file after first successful run.
 */
function migrateSystemIMToPerUser(): void {
  const flagFile = path.join(DATA_DIR, 'config', '.im-config-migrated');
  if (fs.existsSync(flagFile)) return;

  try {
    // Find first admin user
    const adminResult = listUsers({
      status: 'active',
      role: 'admin',
      page: 1,
      pageSize: 1,
    });
    const admin = adminResult.users[0];
    if (!admin) {
      // No admin yet (fresh install) — nothing to migrate
      return;
    }

    let migratedFeishu = false;
    let migratedTelegram = false;

    // Feishu: copy system config → admin per-user (if admin has no per-user config)
    const existingUserFeishu = getUserFeishuConfig(admin.id);
    if (!existingUserFeishu) {
      const { config: sysFeishu, source: feishuSource } =
        getFeishuProviderConfigWithSource();
      if (feishuSource !== 'none' && sysFeishu.appId && sysFeishu.appSecret) {
        saveUserFeishuConfig(admin.id, {
          appId: sysFeishu.appId,
          appSecret: sysFeishu.appSecret,
          enabled: sysFeishu.enabled,
        });
        migratedFeishu = true;
      }
    }

    // Telegram: copy system config → admin per-user (if admin has no per-user config)
    const existingUserTelegram = getUserTelegramConfig(admin.id);
    if (!existingUserTelegram) {
      const { config: sysTelegram, source: telegramSource } =
        getTelegramProviderConfigWithSource();
      if (telegramSource !== 'none' && sysTelegram.botToken) {
        saveUserTelegramConfig(admin.id, {
          botToken: sysTelegram.botToken,
          proxyUrl: sysTelegram.proxyUrl,
          enabled: sysTelegram.enabled,
        });
        migratedTelegram = true;
      }
    }

    // Write flag file (even if nothing was migrated — to avoid re-checking)
    fs.mkdirSync(path.dirname(flagFile), { recursive: true });
    fs.writeFileSync(flagFile, new Date().toISOString() + '\n', 'utf-8');

    if (migratedFeishu || migratedTelegram) {
      logger.info(
        {
          adminId: admin.id,
          feishu: migratedFeishu,
          telegram: migratedTelegram,
        },
        'Migrated system-level IM config to admin per-user config',
      );
    }
  } catch (err) {
    logger.warn(
      { err },
      'Failed to migrate system-level IM config (non-fatal)',
    );
  }
}

function loadState(): void {
  // Load from SQLite — try new rowid format first, fall back to old format
  const persistedRowid = getRouterState('last_cursor_rowid');
  if (persistedRowid) {
    globalMessageCursor = { rowid: Number(persistedRowid) || 0 };
  } else {
    // Migrate from old (timestamp, id) format
    const persistedTimestamp = getRouterState('last_timestamp') || '';
    const lastTimestampId = getRouterState('last_timestamp_id') || '';
    globalMessageCursor = {
      rowid: getRowidByCursor(persistedTimestamp, lastTimestampId),
    };
  }
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    const parsed = agentTs
      ? (JSON.parse(agentTs) as Record<string, unknown>)
      : {};
    const normalized: Record<string, MessageCursor> = {};
    for (const [jid, raw] of Object.entries(parsed)) {
      normalized[jid] = normalizeCursor(raw);
    }
    lastAgentTimestamp = normalized;
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();

  // Auto-register default groups from config/default-groups.json
  const defaultGroupsPath = path.resolve(
    process.cwd(),
    'config',
    'default-groups.json',
  );
  if (fs.existsSync(defaultGroupsPath)) {
    try {
      const defaults = JSON.parse(
        fs.readFileSync(defaultGroupsPath, 'utf-8'),
      ) as Array<{
        jid: string;
        name: string;
        folder: string;
      }>;
      for (const g of defaults) {
        if (!registeredGroups[g.jid]) {
          registerGroup(g.jid, {
            name: g.name,
            folder: g.folder,
            added_at: new Date().toISOString(),
          });
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to load default groups config');
    }
  }

  // Ensure every active user has a home group (is_home=true).
  // Admin → folder='main'
  // Member → folder='home-{userId}'
  try {
    // Paginate through all active users
    const activeUsers: Array<{ id: string; role: string; username: string }> =
      [];
    {
      let page = 1;
      while (true) {
        const result = listUsers({ status: 'active', page, pageSize: 200 });
        activeUsers.push(...result.users);
        if (activeUsers.length >= result.total) break;
        page++;
      }
    }
    for (const user of activeUsers) {
      const homeJid = ensureUserHomeGroup(
        user.id,
        user.role as 'admin' | 'member',
        user.username,
      );
      // Always refresh this entry from DB to pick up any patches.
      const freshGroup = getRegisteredGroup(homeJid);
      if (freshGroup) {
        registeredGroups[homeJid] = freshGroup;
      } else if (!registeredGroups[homeJid]) {
        registeredGroups = getAllRegisteredGroups();
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to ensure user home groups');
  }

  // Normalize legacy home groups onto the single local-runtime compatibility shape.
  for (const [jid, group] of Object.entries(registeredGroups)) {
    if (!group.is_home) continue;

    const expectedMode = 'local';

    if (group.executionMode !== expectedMode) {
      group.executionMode = expectedMode;
      setRegisteredGroup(jid, group);
      registeredGroups[jid] = group;
      // 清除旧 session，避免恢复不兼容的 session
      if (sessions[group.folder]) {
        logger.info(
          { folder: group.folder, expectedMode },
          'Clearing stale session during execution mode migration',
        );
        delete sessions[group.folder];
        deleteSession(group.folder);
      }
    }
  }

  // Initialize per-user global CLAUDE.md from template for users missing it
  const templatePath = path.resolve(
    process.cwd(),
    'config',
    'global-claude-md.template.md',
  );
  if (fs.existsSync(templatePath)) {
    const template = fs.readFileSync(templatePath, 'utf-8');
    const userGlobalBase = path.join(GROUPS_DIR, 'user-global');
    // Ensure every active user has a user-global dir
    try {
      let page = 1;
      const allUsers: Array<{ id: string }> = [];
      while (true) {
        const result = listUsers({ status: 'active', page, pageSize: 200 });
        allUsers.push(...result.users);
        if (allUsers.length >= result.total) break;
        page++;
      }
      for (const u of allUsers) {
        const userDir = path.join(userGlobalBase, u.id);
        fs.mkdirSync(userDir, { recursive: true });
        const userClaudeMd = path.join(userDir, 'CLAUDE.md');
        if (!fs.existsSync(userClaudeMd)) {
          try {
            fs.writeFileSync(userClaudeMd, template, { flag: 'wx' });
            logger.info(
              { userId: u.id },
              'Initialized user-global CLAUDE.md from template',
            );
          } catch (err: unknown) {
            if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
              logger.warn(
                { userId: u.id, err },
                'Failed to initialize user-global CLAUDE.md',
              );
            }
          }
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to initialize user-global CLAUDE.md files');
    }
  }

  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_cursor_rowid', String(globalMessageCursor.rowid));
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  const groupDir = path.join(GROUPS_DIR, group.folder);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Sync group metadata from Feishu.
 * Fetches all bot groups and stores their names in the database.
 * Called on startup, daily, and on-demand via IPC.
 */
async function syncGroupMetadata(force = false): Promise<void> {
  // Check if we need to sync (skip if synced recently, unless forced)
  if (!force) {
    const lastSync = getLastGroupSync();
    if (lastSync) {
      const lastSyncTime = new Date(lastSync).getTime();
      const now = Date.now();
      if (now - lastSyncTime < GROUP_SYNC_INTERVAL_MS) {
        logger.debug({ lastSync }, 'Skipping group sync - synced recently');
        return;
      }
    }
  }

  // Sync groups via any connected user's Feishu instance
  const connectedUserIds = imManager.getConnectedUserIds();
  for (const uid of connectedUserIds) {
    if (imManager.isFeishuConnected(uid)) {
      await imManager.syncFeishuGroups(uid);
      break; // Only need one sync
    }
  }
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
function getAvailableGroups(): AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.jid.startsWith('feishu:'))
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatMessages(messages: NewMessage[], isShared = false, feishuAgentReply = false): string {
  const lines = messages.map((m) => {
    const content = isShared ? `[${m.sender_name}] ${m.content}` : m.content;
    const sourceJid = m.source_jid || m.chat_jid;
    const channelType = getChannelType(sourceJid);
    let sourceAttr = '';
    if (channelType) {
      const chatId = extractChatId(sourceJid);
      sourceAttr = ` source="${escapeXml(channelType)}:${escapeXml(chatId)}"`;
    }
    // In agent-driven reply threading mode, expose message IDs for Feishu messages only,
    // so the agent can specify which message to reply to via send_message(reply_to_message_id=...)
    const isFeishuMsg = channelType === 'feishu';
    const idAttr = feishuAgentReply && isFeishuMsg ? ` id="${escapeXml(m.id)}"` : '';

    // Build reply-to attributes if the message is replying to another message.
    // Uses lightweight attribute references instead of embedding full content —
    // the original message is likely already in the agent's conversation context.
    let replyAttrs = '';
    if (m.reply_to_id) {
      const original = getMessageById(m.reply_to_id, m.chat_jid);
      if (original) {
        const preview = original.content.length > 30
          ? original.content.slice(0, 30) + '...'
          : original.content;
        replyAttrs = ` reply-to="${escapeXml(m.reply_to_id)}" reply-to-sender="${escapeXml(original.sender_name)}" reply-to-preview="${escapeXml(preview)}"`;
      }
    }

    return `<message sender="${escapeXml(m.sender_name)}"${sourceAttr}${idAttr}${replyAttrs} time="${m.timestamp}">${escapeXml(content)}</message>`;
  });
  return `<messages>\n${lines.join('\n')}\n</messages>`;
}

function collectMessageImages(
  chatJid: string,
  messages: NewMessage[],
): Array<{ data: string; mimeType: string }> {
  const images: Array<{ data: string; mimeType: string }> = [];
  for (const msg of messages) {
    if (!msg.attachments) continue;
    try {
      const parsed = JSON.parse(msg.attachments);
      const normalized = normalizeImageAttachments(parsed, {
        onMimeMismatch: ({ declaredMime, detectedMime }) => {
          logger.warn(
            { chatJid, messageId: msg.id, declaredMime, detectedMime },
            'Attachment MIME mismatch detected, using detected MIME',
          );
        },
      });
      for (const item of normalized) {
        images.push({ data: item.data, mimeType: item.mimeType });
      }
    } catch (err) {
      logger.warn(
        { chatJid, messageId: msg.id },
        'Failed to parse message attachments',
      );
    }
  }
  return images;
}

/**
 * Resolve the channel identifier for a batch of messages.
 * Takes the last message's source_jid, falling back to chat_jid.
 */
function resolveChannel(messages: NewMessage[]): string {
  const last = messages[messages.length - 1];
  return last.source_jid || last.chat_jid;
}

function splitRuntimeJid(chatJid: string): {
  baseJid: string;
  agentId: string | null;
} {
  const agentSep = chatJid.indexOf('#agent:');
  if (agentSep < 0) {
    return { baseJid: chatJid, agentId: null };
  }
  const agentId = chatJid.slice(agentSep + 7).trim();
  return {
    baseJid: chatJid.slice(0, agentSep),
    agentId: agentId || null,
  };
}

/**
 * Resolve the effective folder for a group JID (via serialization key).
 * This mirrors the logic in GroupQueue.getSerializationKey.
 */
function resolveGroupFolder(chatJid: string): string {
  const { baseJid } = splitRuntimeJid(chatJid);
  const group = registeredGroups[baseJid];
  return group?.folder || baseJid;
}

function resolveRuntimeOwnerContext(chatJid: string): {
  folder: string;
  userId: string;
} | null {
  const { baseJid, agentId } = splitRuntimeJid(chatJid);
  const group = registeredGroups[baseJid] ?? getRegisteredGroup(baseJid);
  if (agentId) {
    const workerSession = getSessionRecord(buildWorkerSessionRecordId(agentId));
    const parentSession = workerSession?.parent_session_id
      ? getSessionRecord(workerSession.parent_session_id)
      : null;
    const folder = group?.folder
      || (parentSession?.id.startsWith('main:')
        ? parentSession.id.slice('main:'.length)
        : '');
    if (!folder) return null;
    const userId = workerSession?.owner_key
      || parentSession?.owner_key
      || resolveSessionOwnerKey(folder);
    return userId ? { folder, userId } : null;
  }
  if (!group?.folder) return null;
  const userId = resolveSessionOwnerKey(group.folder);
  return userId ? { folder: group.folder, userId } : null;
}

function syncPendingTurnObservability(folder: string): void {
  turnObservabilityManager.setPendingCounts(
    folder,
    turnManager.getPendingCounts(folder),
  );
}

function broadcastInterruptedTurn(
  folder: string,
  chatJid: string,
  detail?: string,
): void {
  const activeTurn = turnManager.getActiveTurn(folder);
  if (!activeTurn) return;
  turnObservabilityManager.markInterrupted(folder, activeTurn, detail);
  broadcastTurnEvent(chatJid, {
    eventType: 'status',
    statusText: 'interrupted',
  });
  turnManager.interruptTurn(folder);
  broadcastTurnEvent(chatJid, {
    eventType: 'turn_completed',
    turnId: activeTurn.id,
    turnStatus: 'interrupted',
    turnChannel: activeTurn.channel,
    turnMessageCount: activeTurn.messageIds.length,
  });
  turnObservabilityManager.clear(folder);
  syncPendingTurnObservability(folder);
}

/**
 * Build CompressOptions for a group, wiring up knowledge extraction
 * to the Memory Agent if enabled.
 */
function buildCompressOptions(group: RegisteredGroup): CompressOptions | undefined {
  const userId = resolveSessionOwnerKey(group.folder);
  if (!group.knowledge_extraction || !userId) return undefined;
  return {
    extractKnowledge: true,
    onKnowledgeEntry: async (content: string, importance: string) => {
      if (!memoryAgentManagerRef) return;
      await memoryAgentManagerRef.send(userId, {
        type: 'remember',
        content,
        importance,
      });
    },
  };
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 *
 * Uses streaming output: agent results are sent to Feishu as they arrive.
 * The container stays alive for idleTimeout after each result, allowing
 * rapid-fire messages to be piped in without spawning a new container.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  let group = registeredGroups[chatJid];
  if (!group) {
    // Group may have been created after loadState (e.g., during setup/registration)
    registeredGroups = getAllRegisteredGroups();
    group = registeredGroups[chatJid];
  }
  if (!group) return true;

  // activation_mode === 'disabled' 时忽略所有消息（DM 和群聊）
  if (group.activation_mode === 'disabled') {
    logger.debug({ chatJid }, 'Group activation_mode is disabled, skipping');
    return true;
  }

  const resolved = resolveEffectiveGroup(group);
  let effectiveGroup = resolved.effectiveGroup;
  let isHome = resolved.isHome;

  // Get all messages since last agent interaction
  const sinceCursor = lastAgentTimestamp[chatJid] || EMPTY_CURSOR;
  const missedMessages = getMessagesSince(chatJid, sinceCursor);

  if (missedMessages.length === 0) return true;

  // Admin home is shared as web:main, so select runtime owner from the latest
  // active admin sender to avoid writing global memory into another admin's
  // user-global directory.
  if (chatJid === 'web:main' && effectiveGroup.is_home) {
    for (let i = missedMessages.length - 1; i >= 0; i--) {
      const sender = missedMessages[i]?.sender;
      if (!sender || sender === 'happyclaw-agent' || sender === '__system__')
        continue;
      const senderUser = getUserById(sender);
      if (senderUser?.status === 'active' && senderUser.role === 'admin') {
        effectiveGroup = { ...effectiveGroup, created_by: senderUser.id };
        break;
      }
    }
  }

  const shared = isGroupShared(group.folder);
  // Check if this user has Feishu agent-reply mode enabled
  const ownerUserId =
    ((chatJid === 'web:main' && effectiveGroup.is_home)
      ? effectiveGroup.created_by
      : undefined)
    || resolveSessionOwnerKey(effectiveGroup.folder)
    || effectiveGroup.created_by;
  const feishuAgentReply = ownerUserId
    ? getUserFeishuConfig(ownerUserId)?.replyThreadingMode === 'agent'
    : false;
  const prompt = formatMessages(missedMessages, shared, feishuAgentReply);

  const images = collectMessageImages(chatJid, missedMessages);
  const imagesForAgent = images.length > 0 ? images : undefined;

  logger.info(
    {
      group: group.name,
      messageCount: missedMessages.length,
      imageCount: images.length,
      shared,
    },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, getSystemSettings().idleTimeout);
  };

  await setTyping(chatJid, true);
  let hadError = false;
  let sentReply = false;
  let lastError = '';
  let cursorCommitted = false;
  let lastReplyMsgId: string | undefined;
  const queryTaskIds = new Set<string>();
  const lastProcessed = missedMessages[missedMessages.length - 1];
  let handoffAfterCompletedTurn = false;

  const pickRunningTaskForNotification = (): string | null => {
    const runningInQuery = Array.from(queryTaskIds)
      .map((id) => getAgent(id))
      .filter(
        (a): a is NonNullable<ReturnType<typeof getAgent>> =>
          !!a &&
          a.kind === 'task' &&
          a.chat_jid === chatJid &&
          a.status === 'running',
      )
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    if (runningInQuery.length > 0) {
      return runningInQuery[0].id;
    }
    const runningInChat = listAgentsByJid(chatJid)
      .filter((a) => a.kind === 'task' && a.status === 'running')
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    return runningInChat[0]?.id || null;
  };

  const commitCursor = (): void => {
    if (cursorCommitted) return;
    // Only advance, never regress — the message loop may have already
    // advanced the cursor via IPC injection while the agent was running.
    const current = lastAgentTimestamp[chatJid];
    if (current && lastProcessed.rowid <= current.rowid) {
      cursorCommitted = true;
      return;
    }
    lastAgentTimestamp[chatJid] = { rowid: lastProcessed.rowid };
    saveState();
    cursorCommitted = true;
  };

  // Auto-compression: fire-and-forget after successful completion.
  // Called from both 'drained' and normal-exit paths.
  // For IM groups with target_main_jid, inherit compression setting from target group.
  const tryAutoCompress = (): void => {
    const ownCompression = group.context_compression;
    const boundTarget = resolveBoundSessionTarget(chatJid, group);
    const effectiveCompression =
      (ownCompression && ownCompression !== 'off')
        ? ownCompression
        : boundTarget?.contextCompression ?? ownCompression ?? 'off';
    if (
      effectiveCompression !== 'auto' ||
      !shouldAutoCompress(effectiveGroup.folder, chatJid)
    ) {
      return;
    }
    const folder = effectiveGroup.folder;
    const sessionIdBeforeCompress = sessions[folder];
    const compressBoundary = new Date().toISOString();
    const compressOpts = buildCompressOptions(group);
    if (compressOpts) {
      compressOpts.beforeTimestamp = compressBoundary;
    }
    compressContext(folder, chatJid, compressOpts ?? { beforeTimestamp: compressBoundary })
      .then((result) => {
        if (result.success) {
          if (sessions[folder] === sessionIdBeforeCompress) {
            delete sessions[folder];
          } else {
            logger.info(
              { folder, chatJid },
              'Session changed during auto-compression, skipping session clear (new agent run likely started)',
            );
          }
          logger.info(
            { folder, chatJid, messageCount: result.messageCount },
            'Auto-compressed context after successful agent run',
          );
          const extractedMsg = result.extractedKnowledge
            ? `，萃取了 ${result.extractedKnowledge} 条知识到记忆系统`
            : '';
          sendSystemMessage(
            chatJid,
            'context_compressed',
            `历史对话已自动压缩为摘要（${result.messageCount} 条消息${extractedMsg}），后续对话基于摘要继续。`,
          );
        }
      })
      .catch((err) => {
        logger.error({ folder, chatJid, err }, 'Auto-compression failed');
      });
  };

  const finalizeCurrentTurn = (
    status: 'completed' | 'error' | 'interrupted' | 'drained',
    options?: { errorDetail?: string },
  ): void => {
    const activeTurn = turnManager.getActiveTurn(group.folder);
    if (!activeTurn) return;

    let traceFile: string | undefined;
    try {
      const finalBlocks = streamingBlocksManager.finalize(group.folder);
      if (finalBlocks.length > 0) {
        traceFile = saveTurnTrace({
          turnId: activeTurn.id,
          chatJid,
          channel: activeTurn.channel,
          folder: group.folder,
          messageIds: activeTurn.messageIds,
          startedAt: new Date(activeTurn.startedAt).toISOString(),
          completedAt: new Date().toISOString(),
          status,
          blocks: finalBlocks,
        });
      }
    } catch (err) {
      logger.warn({ err, turnId: activeTurn.id }, 'Failed to save turn trace');
    }

    if (status === 'interrupted') {
      turnManager.interruptTurn(group.folder);
    } else if (status === 'error') {
      turnManager.failTurn(group.folder, options?.errorDetail);
    } else {
      turnManager.completeTurn(group.folder, {
        resultMessageId: lastReplyMsgId,
        summary: undefined,
        traceFile,
      });
    }

    broadcastTurnEvent(chatJid, {
      eventType: 'turn_completed',
      turnId: activeTurn.id,
      turnStatus: status,
      turnChannel: activeTurn.channel,
      turnMessageCount: activeTurn.messageIds.length,
    });
    turnObservabilityManager.clear(group.folder);
    syncPendingTurnObservability(group.folder);
    // Reset im-commentary turn timer so next turn gets a fresh 30s warmup
    resetTurnCommentaryTimer(group.folder);
  };

  if (ownerUserId) {
    const owner = getUserById(ownerUserId);
    if (owner && owner.role !== 'admin') {
      const accessResult = checkBillingAccessFresh(
        ownerUserId,
        owner.role,
      );
      if (!accessResult.allowed) {
        const sysMsg = formatBillingAccessDeniedMessage(accessResult);
        sendBillingDeniedMessage(chatJid, sysMsg);
        commitCursor();
        await setTyping(chatJid, false);
        logger.info(
          {
            chatJid,
            userId: ownerUserId,
            reason: accessResult.reason,
            blockType: accessResult.blockType,
          },
          'Billing access denied inside processGroupMessages',
        );
        return true;
      }
    }
  }

  // 新一轮从干净状态开始
  streamingBlocksManager.reset(group.folder);
  turnObservabilityManager.syncTurn(
    group.folder,
    turnManager.getActiveTurn(group.folder),
  );
  broadcastRunnerState(chatJid, 'starting');

  // Build per-sourceJid trigger message map so IPC handler can thread
  // replies to the correct triggering message (not whatever DB says is latest).
  const triggerMap = new Map<string, { id: string; sender: string }>();
  for (const m of missedMessages) {
    const srcJid = m.source_jid || m.chat_jid;
    // Last message per source wins (chronological order)
    triggerMap.set(srcJid, { id: m.id, sender: m.sender });
  }
  triggerMessagesByFolder.set(effectiveGroup.folder, triggerMap);

  // Create Feishu progress card if enabled for this user.
  // The controller uses lazy client resolution — the lark client is resolved
  // when the card is actually created (on first stream event), not now.
  // This avoids race conditions after service restarts.
  let progressCard: ProgressCardController | undefined;
  const sourceChannel = resolveChannel(missedMessages);
  const sourceChannelType = getChannelType(sourceChannel);
  const feishuConfig = ownerUserId ? getUserFeishuConfig(ownerUserId) : null;
  if (
    ownerUserId &&
    sourceChannelType === 'feishu' &&
    feishuConfig?.streamingCard
  ) {
    progressCard = imManager.createProgressCard(sourceChannel);
    if (progressCard) {
      registerProgressSession(sourceChannel, progressCard, group.folder);
    }
  }

  let wasInterrupted = false;
  const output = await runAgent(
    effectiveGroup,
    prompt,
    chatJid,
    async (result) => {
      try {
        // 流式事件处理 - 广播 WebSocket + 持久化 SDK Task 生命周期到 DB
        if (result.status === 'stream' && result.streamEvent) {
          broadcastStreamEvent(chatJid, result.streamEvent);
          // 累积 streaming blocks（后端持久化，前端可随时查询）
          streamingBlocksManager
            .getOrCreate(group.folder)
            .feed(result.streamEvent);
          // Feed progress cards (Feishu real-time tool trace) — feeds ALL
          // active sessions for this folder, including cards created for
          // IPC-injected Feishu chats that share the same workspace.
          feedProgressSessionsForFolder(group.folder, result.streamEvent);

          // IM Commentary: update the progress card with human-readable explanation (fire-and-forget)
          const _se = result.streamEvent;
          if (_se.eventType === 'tool_use_start' && feishuConfig?.imCommentary && progressCard) {
            sendToolCommentary({
              folder: group.folder,
              toolName: _se.toolName ?? '',
              toolInputSummary: _se.toolInputSummary,
              isNested: _se.isNested ?? false,
              onCommentary: (text) => progressCard.addCommentary(text),
            }).catch(() => {});
          }

          turnObservabilityManager.feedEvent(
            group.folder,
            result.streamEvent,
            turnManager.getActiveTurn(group.folder),
          );

          // IPC delivery acknowledgement from agent-runner
          const se = result.streamEvent;
          if (
            se.eventType === 'status' &&
            se.statusText === 'ipc_message_received'
          ) {
            ackIpcDeliveries(collectIpcAckKeys([chatJid], se));
          }
          if (se.eventType === 'status' && se.statusText === 'interrupted') {
            wasInterrupted = true;
          }

          // Persist SDK Task lifecycle to DB so tabs survive page refresh
          if (
            (se.eventType === 'task_start' && se.toolUseId) ||
            (se.eventType === 'tool_use_start' &&
              se.toolName === 'Task' &&
              se.toolUseId)
          ) {
            try {
              const taskId = se.toolUseId;
              queryTaskIds.add(taskId);
              const existing = getAgent(taskId);
              const desc = se.taskDescription || se.toolInputSummary || '';
              const taskName = desc.slice(0, 40) || existing?.name || 'Task';
              if (!existing) {
                createAgent({
                  id: taskId,
                  group_folder: group.folder,
                  chat_jid: chatJid,
                  name: taskName,
                  prompt: desc,
                  status: 'running',
                  kind: 'task',
                  created_by: null,
                  created_at: new Date().toISOString(),
                  completed_at: null,
                  result_summary: null,
                });
              } else if (se.taskDescription) {
                updateAgentInfo(
                  taskId,
                  se.taskDescription.slice(0, 40),
                  se.taskDescription,
                );
              }
              broadcastAgentStatus(
                chatJid,
                taskId,
                'running',
                taskName,
                desc,
                undefined,
                'task',
              );
            } catch (err) {
              logger.warn(
                { err, toolUseId: se.toolUseId },
                'Failed to persist task_start to DB',
              );
            }
          }
          if (se.eventType === 'tool_use_end' && se.toolUseId) {
            try {
              const existing = getAgent(se.toolUseId);
              if (
                existing &&
                existing.kind === 'task' &&
                existing.status === 'running'
              ) {
                updateAgentStatus(se.toolUseId, 'completed');
                queryTaskIds.delete(existing.id);
                broadcastAgentStatus(
                  chatJid,
                  existing.id,
                  'completed',
                  existing.name,
                  existing.prompt,
                  existing.result_summary || '任务已完成',
                  'task',
                );
              }
            } catch (err) {
              logger.warn(
                { err, toolUseId: se.toolUseId },
                'Failed to persist tool_use_end to DB',
              );
            }
          }
          if (se.eventType === 'task_notification' && se.taskId) {
            try {
              const status =
                se.taskStatus === 'completed' ? 'completed' : 'error';
              const summary = se.taskSummary?.slice(0, 2000);
              let targetTaskId = se.taskId;
              let existing = getAgent(targetTaskId);
              if (!existing || existing.kind !== 'task') {
                const fallbackTaskId = pickRunningTaskForNotification();
                if (fallbackTaskId) {
                  targetTaskId = fallbackTaskId;
                  existing = getAgent(fallbackTaskId);
                  logger.warn(
                    {
                      chatJid,
                      sdkTaskId: se.taskId,
                      mappedTaskId: fallbackTaskId,
                    },
                    'Task notification ID mismatch, mapped to running task',
                  );
                }
              }

              if (!existing) {
                createAgent({
                  id: targetTaskId,
                  group_folder: group.folder,
                  chat_jid: chatJid,
                  name: 'Task',
                  prompt: '',
                  status,
                  kind: 'task',
                  created_by: null,
                  created_at: new Date().toISOString(),
                  completed_at: new Date().toISOString(),
                  result_summary: summary || null,
                });
                broadcastAgentStatus(
                  chatJid,
                  targetTaskId,
                  status,
                  'Task',
                  '',
                  summary,
                  'task',
                );
              } else if (existing.kind === 'task') {
                updateAgentStatus(existing.id, status, summary);
                queryTaskIds.delete(existing.id);
                broadcastAgentStatus(
                  chatJid,
                  existing.id,
                  status,
                  existing.name,
                  existing.prompt,
                  summary,
                  'task',
                );
              }
            } catch (err) {
              logger.warn(
                { err, taskId: se.taskId },
                'Failed to persist task_notification to DB',
              );
            }
          }

          // Persist token usage to the latest agent message + usage_records
          if (se.eventType === 'usage' && se.usage) {
            try {
              updateLatestMessageTokenUsage(
                chatJid,
                JSON.stringify(se.usage),
                lastReplyMsgId,
                se.usage.costUSD,
              );

              // Write to usage_records + usage_daily_summary
              writeUsageRecords({
                userId: ownerUserId || 'system',
                groupFolder: effectiveGroup.folder,
                messageId: lastReplyMsgId,
                usage: se.usage,
              });

              logger.debug(
                {
                  chatJid,
                  msgId: lastReplyMsgId,
                  costUSD: se.usage.costUSD,
                  inputTokens: se.usage.inputTokens,
                },
                'Token usage persisted',
              );

              // Update billing monthly usage
              const ownerGroup = registeredGroups[chatJid];
              const billingOwnerUserId =
                ownerGroup ? resolveChatOwnerKey(chatJid, ownerGroup) : undefined;
              if (billingOwnerUserId && se.usage.costUSD) {
                try {
                  const effective = updateUsage(
                    billingOwnerUserId,
                    se.usage.costUSD,
                    se.usage.inputTokens || 0,
                    se.usage.outputTokens || 0,
                  );
                  deductUsageCost(
                    billingOwnerUserId,
                    se.usage.costUSD,
                    lastReplyMsgId || chatJid,
                    effective,
                  );
                  // Broadcast real-time billing update to the user
                  const owner = getUserById(billingOwnerUserId);
                  if (owner && owner.role !== 'admin') {
                    const freshAccess = checkBillingAccessFresh(
                      billingOwnerUserId,
                      owner.role,
                    );
                    if (freshAccess.usage) {
                      broadcastBillingUpdate(billingOwnerUserId, {
                        ...freshAccess,
                      });
                    }
                  }
                } catch (billingErr) {
                  logger.warn(
                    { err: billingErr, chatJid },
                    'Failed to update billing usage',
                  );
                }
              }
            } catch (err) {
              logger.warn({ err, chatJid }, 'Failed to persist token usage');
            }
          }

          return;
        }

        // Streaming output callback — called for each agent result
        if (result.result) {
          const raw =
            typeof result.result === 'string'
              ? result.result
              : JSON.stringify(result.result);
          const text = raw.trim();
          logger.info(
            { group: group.name },
            `Agent output: ${raw.slice(0, 200)}`,
          );
          if (text) {
            // Stop typing indicator before sending — clears the 4s refresh timer
            // so it doesn't keep firing while the agent stays alive in idle state.
            await setTyping(chatJid, false);
            // Web 存储 + 广播，不发 IM（模型通过 send_message 工具主动发 IM）
            lastReplyMsgId = await sendMessage(chatJid, text, {
              sendToIM: false,
            });
            sentReply = true;
            // Persist cursor as soon as a visible reply is emitted.
            // Long-lived runners may stay alive for idleTimeout, and waiting
            // until process exit would cause duplicate replay after restart.
            commitCursor();
          }
          // Only reset idle timer on actual results, not session-update markers (result: null)
          resetIdleTimer();

          // Finalize streaming blocks for this round (kept for turn trace persistence)
          streamingBlocksManager.finalize(group.folder);
        }

        // Complete all progress cards for this folder after each turn so they
        // don't stay at "执行中" while the agent idles between IPC messages.
        // Cards reset to idle and will lazily create new ones on the next turn.
        if (result.status === 'success') {
          await completeAndResetProgressSessionsForFolder(group.folder);
        }

          // Query 返回无文本结果（仅工具调用、send_message 等）：通知前端清除
          // 流式状态，避免 agent idle 期间持续显示"正在思考..."。
        if (result.status === 'success' && !result.result) {
          const pendingCounts = turnManager.getPendingCounts(group.folder);
          if (pendingCounts.size > 0) {
            handoffAfterCompletedTurn = true;
            const drained = queue.sendDrain(chatJid);
            logger.info(
              {
                chatJid,
                folder: group.folder,
                pendingChannels: Array.from(pendingCounts.entries()),
                drained,
              },
              'Turn completed with queued work pending, draining runner for handoff',
            );
            if (!drained) {
              handoffAfterCompletedTurn = false;
              finalizeCurrentTurn('completed');
              broadcastRunnerState(chatJid, 'idle');
            }
          } else {
            finalizeCurrentTurn('completed');
            broadcastRunnerState(chatJid, 'idle');
          }
        }

        if (result.status === 'error') {
          hadError = true;
          if (result.error) lastError = result.error;
        }
      } catch (err) {
        logger.error({ group: group.name, err }, 'onOutput callback failed');
        hadError = true;
      }
    },
    imagesForAgent,
  );

  await setTyping(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);
  clearIpcDeliveryTracker(chatJid);

  // Complete or abort ALL Feishu progress cards for this folder
  // (includes cards created via IPC injection for sibling Feishu chats).
  {
    const isError = output.status === 'error' || hadError;
    if (isError || wasInterrupted) {
      await finalizeProgressSessionsForFolder(
        group.folder,
        'abort',
        isError ? '执行出错' : '已中断',
      );
    } else {
      await finalizeProgressSessionsForFolder(group.folder, 'complete');
    }
  }

  // Agent 进程已退出：通知前端清除流式状态（"正在思考..."）。
  // 正常有回复时前端已通过 new_message/agent_reply 清理，这里作为兜底确保
  // 无可见回复（result 为 null）或异常退出时 streaming 状态也能被清除。
  broadcastRunnerState(chatJid, 'idle');

  // --- Turn lifecycle: complete/fail turn and save trace ---
  const activeTurn = turnManager.getActiveTurn(group.folder);
  if (activeTurn) {
    const isErrorExit_ = output.status === 'error' || hadError;
    const isDrained = output.status === 'drained';
    const isInterrupted = wasInterrupted;
    finalizeCurrentTurn(
      isInterrupted
        ? 'interrupted'
        : isErrorExit_
          ? 'error'
          : handoffAfterCompletedTurn
            ? 'completed'
            : isDrained
            ? 'drained'
            : 'completed',
      { errorDetail: output.error || lastError },
    );

    // Check if there are queued turns to process next
    const nextEntry = turnManager.drainNext(group.folder);
    if (nextEntry) {
      logger.info(
        {
          folder: group.folder,
          nextChatJid: nextEntry.chatJid,
          nextChannel: nextEntry.channel,
        },
        'Turn: draining next queued entry',
      );
      // The next message poll cycle will pick up the queued chatJid's messages
      // via the normal cursor mechanism since we didn't advance cursor for queued messages
      const queuedDetail =
        nextEntry.chatJid === chatJid
          ? '上一轮已结束，等待下一轮开始'
          : `正在等待当前 Turn 结束 · ${nextEntry.channel}`;
      broadcastRunnerState(nextEntry.chatJid, 'queued', queuedDetail);
      queue.enqueueMessageCheck(nextEntry.chatJid);
    }
  }

  streamingBlocksManager.remove(group.folder);

  // 不可恢复的转录错误（如超大图片/MIME 错配被固化在会话历史中）：无论是否已有回复，都必须重置会话
  const errorForReset = [lastError, output.error].filter(Boolean).join(' ');
  if (
    (output.status === 'error' || hadError) &&
    errorForReset.includes('unrecoverable_transcript:')
  ) {
    const detail = (lastError || output.error || '').replace(
      /.*unrecoverable_transcript:\s*/,
      '',
    );
    logger.warn(
      { group: group.name, folder: group.folder, error: detail },
      'Unrecoverable transcript error, auto-resetting session',
    );

    // 清除会话文件（保留 settings.json）
    await clearSessionRuntimeFiles(group.folder);

    // 清除当前主会话（保留同 folder 下独立 agent 会话）
    try {
      deleteSession(group.folder);
      delete sessions[group.folder];
    } catch (err) {
      logger.error(
        { folder: group.folder, err },
        'Failed to clear session state during auto-reset',
      );
    }

    sendSystemMessage(chatJid, 'context_reset', `会话已自动重置：${detail}`);
    commitCursor();
    return true;
  }

  // Container closed during query (e.g. home folder drain) without sending a reply:
  // don't commit cursor so the message gets retried on the next poll cycle.
  // If sentReply is true the cursor was already committed at line 722, no action needed.
  if (output.status === 'closed' && !sentReply) {
    logger.warn(
      { group: group.name, chatJid },
      'Container closed during query without reply, keeping cursor for retry',
    );
    return true;
  }

  // Drained: query completed, process exiting for turn boundary.
  // This is a successful completion — commit cursor, run auto-compression, and return.
  if (output.status === 'drained') {
    commitCursor();
    tryAutoCompress();
    return true;
  }

  // Query 出错时，将残留 running task 标记为 error，避免长期僵尸状态。
  // 正常退出不做强制 completed，避免把未确认完成的任务误判为已完成。
  const isErrorExit = output.status === 'error' || hadError;
  if (isErrorExit) {
    try {
      // 先获取 running agents（广播需要 agent 详情），再批量标记 error
      const runningAgents = getRunningTaskAgentsByChat(chatJid);
      const marked = markRunningTaskAgentsAsError(chatJid);
      if (marked > 0) {
        logger.info(
          { chatJid, marked },
          'Marked remaining running task agents as error',
        );
        for (const agent of runningAgents) {
          broadcastAgentStatus(
            chatJid,
            agent.id,
            'error',
            agent.name,
            agent.prompt,
            '容器超时或异常退出',
            agent.kind,
          );
        }
      }
    } catch (err) {
      logger.warn({ chatJid, err }, 'Failed to mark running task agents');
    }
  } else {
    // Safety net: if query already ended successfully but some task agents are still
    // running (usually due SDK event ID mismatch), force-complete them to avoid stale tabs.
    try {
      let completed = 0;
      for (const taskId of queryTaskIds) {
        const agent = getAgent(taskId);
        if (
          !agent ||
          agent.kind !== 'task' ||
          agent.chat_jid !== chatJid ||
          agent.status !== 'running'
        )
          continue;
        updateAgentStatus(
          taskId,
          'completed',
          agent.result_summary || '任务已完成',
        );
        broadcastAgentStatus(
          chatJid,
          taskId,
          'completed',
          agent.name,
          agent.prompt,
          agent.result_summary || '任务已完成',
          agent.kind,
        );
        completed += 1;
      }
      if (completed > 0) {
        logger.warn(
          { chatJid, completed },
          'Force-completed stale running task agents after successful query',
        );
      }
    } catch (err) {
      logger.warn(
        { chatJid, err },
        'Failed to force-complete stale running task agents',
      );
    }
  }

  if (isErrorExit && !sentReply) {
    // Only roll back cursor if no reply was sent — if the agent already
    // replied successfully, a subsequent timeout is not a real error and
    // rolling back would cause the same messages to be re-processed,
    // leading to duplicate replies.
    const errorDetail = output.error || lastError || '未知错误';

    // Resolve IM source for error forwarding
    const errorSourceJid =
      missedMessages[missedMessages.length - 1]?.source_jid || chatJid;
    const errorImChannel = getChannelType(errorSourceJid)
      ? errorSourceJid
      : null;

    // 上下文溢出错误：跳过重试，提交游标，通知用户
    if (errorDetail.startsWith('context_overflow:')) {
      const overflowMsg = errorDetail.replace(/^context_overflow:\s*/, '');
      sendSystemMessage(chatJid, 'context_overflow', overflowMsg);
      if (errorImChannel) {
        sendImWithFailTracking(
          errorImChannel,
          `⚠️ 上下文溢出：${overflowMsg}`,
          [],
        );
      }
      logger.warn(
        { group: group.name, error: overflowMsg },
        'Context overflow detected, skipping retry',
      );
      commitCursor();
      tryAutoCompress();
      triggerMessagesByFolder.delete(effectiveGroup.folder);
      return true;
    }

    sendSystemMessage(chatJid, 'agent_error', errorDetail);
    // Forward agent errors to IM so users aren't left waiting in silence
    const isRateLimit = /overloaded|limit|rate.?limit|quota|resets/i.test(errorDetail);
    if (errorImChannel) {
      const sendOpts: IMSendOptions = {};
      sendImWithFailTracking(
        errorImChannel,
        `⚠️ Agent 错误：${errorDetail}${isRateLimit ? '\n\n> 💡 请检查当前 runner 的凭据、额度或上游限流状态。' : ''}`,
        [],
        Object.keys(sendOpts).length > 0 ? sendOpts : undefined,
      );
    }
    logger.warn(
      { group: group.name, error: errorDetail },
      'Agent error (no reply sent), keeping cursor at previous position for retry',
    );
    triggerMessagesByFolder.delete(effectiveGroup.folder);
    return false;
  }

  // Final fallback for silent-success paths (no visible reply).
  commitCursor();
  tryAutoCompress();

  triggerMessagesByFolder.delete(effectiveGroup.folder);
  return true;
}

async function runTerminalWarmup(chatJid: string): Promise<void> {
  const group = registeredGroups[chatJid];
  if (!group) return;

  logger.info({ chatJid, group: group.name }, 'Starting terminal warmup run');

  const warmupReadyToken = '<terminal_ready>';
  const warmupPrompt = [
    '这是系统触发的终端预热请求。',
    `请只回复 ${warmupReadyToken}，不要回复其它内容，也不要调用工具。`,
  ].join(' ');

  let bootstrapCompleted = false;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { chatJid, group: group.name },
        'Terminal warmup idle timeout, closing stdin',
      );
      queue.closeStdin(chatJid);
    }, getSystemSettings().idleTimeout);
  };

  try {
    const output = await runAgent(
      group,
      warmupPrompt,
      chatJid,
      async (result) => {
        if (result.status === 'stream' && result.streamEvent) {
          broadcastStreamEvent(chatJid, result.streamEvent);
          return;
        }

        if (result.status === 'error') return;

        // During warmup query, NEVER emit assistant text to chat.
        // Only mark bootstrap complete after the session update marker.
        if (result.result === null) {
          if (!bootstrapCompleted) {
            bootstrapCompleted = true;
            resetIdleTimer();
          }
          return;
        }

        if (!bootstrapCompleted) return;

        const raw =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        const text = raw.trim();
        if (!text || text === warmupReadyToken) return;
        await sendMessage(chatJid, text, { sendToIM: false });
        resetIdleTimer();
      },
    );

    if (output.status === 'error') {
      logger.warn(
        { chatJid, group: group.name, error: output.error },
        'Terminal warmup run ended with error',
      );
    } else {
      logger.info(
        { chatJid, group: group.name },
        'Terminal warmup run completed',
      );
    }
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
  }
}

function ensureTerminalRuntimeStarted(chatJid: string): boolean {
  const group = registeredGroups[chatJid];
  if (!group) return false;

  const status = queue.getRuntimeStatus();
  const groupStatus = status.groups.find((g) => g.jid === chatJid);
  if (groupStatus?.active) return true;
  if (terminalWarmupInFlight.has(chatJid)) return true;

  terminalWarmupInFlight.add(chatJid);
  const taskId = `terminal-warmup:${chatJid}`;
  queue.enqueueTask(chatJid, taskId, async () => {
    try {
      await runTerminalWarmup(chatJid);
    } finally {
      terminalWarmupInFlight.delete(chatJid);
    }
  });
  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: RuntimeOutput) => Promise<void>,
  images?: Array<{ data: string; mimeType?: string }>,
): Promise<{
  status: 'success' | 'error' | 'closed' | 'drained';
  error?: string;
}> {
  const isHome = !!group.is_home;
  const isAdminHome = isHome && group.folder === MAIN_GROUP_FOLDER;
  const sessionRecordId = buildMainSessionRecordId(group.folder);
  const sessionRecord = getSessionRecord(sessionRecordId);
  const runtimeBootstrap = getRuntimeBootstrapState(group.folder);
  const sessionId = runtimeBootstrap.providerSessionId;

  // Load context summary if session was compressed (no active session)
  let contextSummary: string | undefined;
  if (!sessionId) {
    const summary = getContextSummary(group.folder, chatJid);
    if (summary) {
      contextSummary = summary.summary;
    }
  }

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isAdminHome,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (admin home only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isAdminHome,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: RuntimeOutput) => {
        if (output.runtimeState) {
          persistRuntimeStateForSession(group.folder, output.runtimeState);
        }
        // 仅从成功的输出中更新 session ID；
        // error 输出可能携带 stale ID，会覆盖流式传递的有效 session
        if (output.newSessionId && output.status !== 'error') {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const onProcessCb = (proc: ChildProcess, identifier: string) => {
      queue.registerProcess(chatJid, proc, null, group.folder, identifier);
    };

    const ownerHomeFolder = resolveOwnerHomeFolder(group);
    const activeTurnId = turnManager.getActiveTurn(group.folder)?.id;

    const output = await runSessionAgent(
      group,
      {
        prompt,
        sessionId,
        resumeAnchor: runtimeBootstrap.resumeAnchor,
        sessionRecordId,
        groupFolder: group.folder,
        chatJid,
        isHome,
        isAdminHome,
        images,
        userId: sessionRecord?.owner_key || resolveStableSessionOwnerKey(group.folder),
        turnId: activeTurnId,
        contextSummary,
        bootstrapState: runtimeBootstrap.bootstrapState,
      },
      onProcessCb,
      wrappedOnOutput,
      ownerHomeFolder,
    );

    // 仅从成功的最终输出中更新 session ID；
    // error 状态的输出可能携带 stale ID，覆盖流式阶段已写入的有效 session
    if (output.runtimeState) {
      persistRuntimeStateForSession(group.folder, output.runtimeState);
    }
    if (output.newSessionId && output.status !== 'error') {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    // Agent was interrupted by _close sentinel (home folder drain).
    // Propagate so processGroupMessages can skip cursor commit.
    if (output.status === 'closed') {
      return { status: 'closed' };
    }

    // Agent exited cleanly due to _drain sentinel (turn boundary).
    // Treat as successful completion — cursor should be committed.
    if (output.status === 'drained') {
      return { status: 'drained' };
    }

    if (output.status === 'error') {
      logger.error({ group: group.name, error: output.error }, 'Agent error');
      if (output.result && wrappedOnOutput) {
        try {
          await wrappedOnOutput(output);
        } catch (err) {
          logger.error(
            { group: group.name, err },
            'Failed to emit agent error output',
          );
        }
      }
      return { status: 'error', error: output.error };
    }

    return { status: 'success' };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error({ group: group.name, err }, 'Agent error');
    return { status: 'error', error: errorMsg };
  }
}

async function sendMessage(
  jid: string,
  text: string,
  options: SendMessageOptions = {},
): Promise<string | undefined> {
  const isIMChannel = getChannelType(jid) !== null;
  const sendToIM = options.sendToIM ?? isIMChannel;
  try {
    let externalMsgId: string | undefined;
    if (sendToIM && isIMChannel) {
      try {
        const groupForImages = registeredGroups[jid] ?? getRegisteredGroup(jid);
        const localImagePaths =
          options.localImagePaths ??
          extractLocalImImagePaths(text, resolveEffectiveFolder(jid), groupForImages?.created_by);
        externalMsgId = await imManager.sendMessage(jid, text, localImagePaths);
      } catch (err) {
        logger.error({ jid, err }, 'Failed to send message to IM channel');
      }
    }

    // Persist assistant reply so Web polling can render it and clear waiting state.
    // Prefer the IM-returned message ID (e.g. Feishu om_xxx) so inbound reply_to references can match.
    const msgId = options.externalMsgId || externalMsgId || crypto.randomUUID();
    const timestamp = new Date().toISOString();
    ensureChatExists(jid);
    storeMessageDirect(
      msgId,
      jid,
      'happyclaw-agent',
      ASSISTANT_NAME,
      text,
      timestamp,
      true,
    );

    broadcastNewMessage(jid, {
      id: msgId,
      chat_jid: jid,
      sender: 'happyclaw-agent',
      sender_name: ASSISTANT_NAME,
      content: text,
      timestamp,
      is_from_me: true,
    });
    logger.info({ jid, length: text.length, sendToIM }, 'Message sent');
    broadcastToWebClients(jid, text);
    return msgId;
  } catch (err) {
    logger.error({ jid, err }, 'Failed to send message');
    return undefined;
  }
}

/**
 * Check if a source group is authorized to send IPC messages to a target group.
 * - Admin home can send to any group.
 * - Non-home groups can only send to groups sharing the same folder.
 * - Member home groups can send to groups created by the same user.
 */
function canSendCrossGroupMessage(
  isAdminHome: boolean,
  isHome: boolean,
  sourceFolder: string,
  sourceGroupEntry: RegisteredGroup | undefined,
  targetGroup: RegisteredGroup | undefined,
): boolean {
  if (isAdminHome) return true;
  if (targetGroup && targetGroup.folder === sourceFolder) return true;
  if (
    isHome &&
    targetGroup &&
    sourceGroupEntry?.created_by != null &&
    targetGroup.created_by === sourceGroupEntry.created_by
  )
    return true;
  return false;
}

function startIpcWatcher(): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    if (shuttingDown) return;
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      if (!shuttingDown) setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    for (const sourceGroup of groupFolders) {
      // Determine if this IPC directory belongs to an admin home group
      const sourceGroupEntry = Object.values(registeredGroups).find(
        (g) => g.folder === sourceGroup,
      );
      const isAdminHome = !!(
        sourceGroupEntry?.is_home && sourceGroup === MAIN_GROUP_FOLDER
      );
      const isHome = !!sourceGroupEntry?.is_home;

      // Collect all IPC roots: main group dir + agents/*/
      const groupIpcRoot = path.join(ipcBaseDir, sourceGroup);
      const ipcRoots = [groupIpcRoot];
      try {
        const agentsDir = path.join(groupIpcRoot, 'agents');
        if (fs.existsSync(agentsDir)) {
          for (const entry of fs.readdirSync(agentsDir, {
            withFileTypes: true,
          })) {
            if (entry.isDirectory()) {
              ipcRoots.push(path.join(agentsDir, entry.name));
            }
          }
        }
      } catch {
        /* ignore */
      }

      for (const ipcRoot of ipcRoots) {
        const messagesDir = path.join(ipcRoot, 'messages');
        const tasksDir = path.join(ipcRoot, 'tasks');

        // Process messages from this group's IPC directory
        try {
          if (fs.existsSync(messagesDir)) {
            const messageFiles = fs
              .readdirSync(messagesDir)
              .filter((f) => f.endsWith('.json'));
            for (const file of messageFiles) {
              const filePath = path.join(messagesDir, file);
              try {
                const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
                if (data.type === 'message' && data.chatJid && data.text) {
                  const targetGroup = registeredGroups[data.chatJid];
                  if (
                    canSendCrossGroupMessage(
                      isAdminHome,
                      isHome,
                      sourceGroup,
                      sourceGroupEntry,
                      targetGroup,
                    )
                  ) {
                    // 模型指定了 IM 渠道 — 发送到 IM
                    if (data.targetChannel) {
                      const localImagePaths = extractLocalImImagePaths(
                        data.text,
                        sourceGroup,
                        resolveSessionOwnerKey(sourceGroup),
                      );
                      // Resolve reply target: in 'agent' mode, prefer agent-supplied replyToMsgId;
                      // in 'auto' mode (or fallback), use trigger map → DB lookup.
                      // Agent reply mode only applies to Feishu channels.
                      const isFeishuTarget = data.targetChannel.startsWith('feishu:');
                      const ownerUserId = resolveSessionOwnerKey(sourceGroup);
                      const agentReplyMode = isFeishuTarget && ownerUserId
                        ? getUserFeishuConfig(ownerUserId)?.replyThreadingMode === 'agent'
                        : false;
                      const triggerMap = triggerMessagesByFolder.get(sourceGroup);
                      const triggerMsg = triggerMap?.get(data.targetChannel);
                      const lastInbound = triggerMsg || getLastInboundMessage(
                        data.chatJid,
                        data.targetChannel, // source_jid = the IM channel
                      );
                      const sendOptions: IMSendOptions = {};
                      // Agent-driven reply: use agent-specified ID if available and mode is 'agent'
                      if (agentReplyMode && data.replyToMsgId) {
                        sendOptions.replyToMsgId = data.replyToMsgId;
                      } else if (lastInbound?.id) {
                        sendOptions.replyToMsgId = lastInbound.id;
                      }
                      if (data.urgent && lastInbound?.sender) {
                        sendOptions.urgent = true;
                        sendOptions.urgentUserIds = [lastInbound.sender];
                      }
                      // Await IM send to capture external message ID (e.g. Feishu om_xxx)
                      // so DB stores the platform ID for reply-to matching.
                      let imMsgId: string | undefined;
                      try {
                        imMsgId = await imManager.sendMessage(
                          data.targetChannel,
                          data.text,
                          localImagePaths,
                          Object.keys(sendOptions).length > 0
                            ? sendOptions
                            : undefined,
                        );
                        imSendFailCounts.delete(data.targetChannel);
                      } catch (err) {
                        logger.warn({ imJid: data.targetChannel, err }, 'Failed to relay message to IM');
                        const count = (imSendFailCounts.get(data.targetChannel) ?? 0) + 1;
                        imSendFailCounts.set(data.targetChannel, count);
                        if (count >= IM_SEND_FAIL_THRESHOLD && shouldAutoUnbindOnFailure(data.targetChannel)) {
                          try {
                            unbindImGroup(data.targetChannel, 'Auto-unbound IM group after consecutive send failures');
                          } catch (unbindErr) {
                            logger.error({ imJid: data.targetChannel, unbindErr }, 'Failed to auto-unbind IM group');
                          }
                        }
                      }
                      // 存 DB + 广播 Web（不发 IM），用 IM 平台返回的消息 ID
                      await sendMessage(data.chatJid, data.text, {
                        sendToIM: false,
                        externalMsgId: imMsgId,
                      });
                    } else {
                      // No IM target — just store in DB + broadcast Web
                      await sendMessage(data.chatJid, data.text, {
                        sendToIM: false,
                      });
                    }
                    logger.info(
                      {
                        chatJid: data.chatJid,
                        sourceGroup,
                        targetChannel: data.targetChannel,
                      },
                      'IPC message sent',
                    );
                  } else {
                    logger.warn(
                      { chatJid: data.chatJid, sourceGroup },
                      'Unauthorized IPC message attempt blocked',
                    );
                  }
                } else if (
                  data.type === 'image' &&
                  data.chatJid &&
                  data.imageBase64
                ) {
                  // Handle image IPC messages from send_image MCP tool
                  const targetGroup = registeredGroups[data.chatJid];
                  if (
                    canSendCrossGroupMessage(
                      isAdminHome,
                      isHome,
                      sourceGroup,
                      sourceGroupEntry,
                      targetGroup,
                    )
                  ) {
                    try {
                      const imageBuffer = Buffer.from(
                        data.imageBase64,
                        'base64',
                      );
                      const mimeType = data.mimeType || 'image/png';
                      const caption = data.caption || undefined;
                      const fileName = data.fileName || undefined;

                      // 只在有 targetChannel 时发送到 IM
                      if (data.targetChannel) {
                        // Resolve reply target for Feishu images (same logic as send_message)
                        let imageReplyToMsgId: string | undefined;
                        const isFeishuTarget = data.targetChannel.startsWith('feishu:');
                        if (isFeishuTarget) {
                          const ownerUserId = resolveSessionOwnerKey(sourceGroup);
                          const agentReplyMode = ownerUserId
                            ? getUserFeishuConfig(ownerUserId)?.replyThreadingMode === 'agent'
                            : false;
                          if (agentReplyMode && data.replyToMsgId) {
                            imageReplyToMsgId = data.replyToMsgId;
                          } else {
                            const triggerMap = triggerMessagesByFolder.get(sourceGroup);
                            const triggerMsg = triggerMap?.get(data.targetChannel);
                            const lastInbound = triggerMsg || getLastInboundMessage(
                              data.chatJid,
                              data.targetChannel,
                            );
                            if (lastInbound?.id) {
                              imageReplyToMsgId = lastInbound.id;
                            }
                          }
                        }
                        await imManager.sendImage(
                          data.targetChannel,
                          imageBuffer,
                          mimeType,
                          caption,
                          fileName,
                          imageReplyToMsgId,
                        );
                      }

                      // 始终在 Web 记录图片消息（文本占位符）
                      const displayText = caption
                        ? `[图片: ${fileName || 'image'}]\n${caption}`
                        : `[图片: ${fileName || 'image'}]`;
                      const imgMsgId = crypto.randomUUID();
                      const imgTimestamp = new Date().toISOString();
                      ensureChatExists(data.chatJid);
                      storeMessageDirect(
                        imgMsgId,
                        data.chatJid,
                        'happyclaw-agent',
                        ASSISTANT_NAME,
                        displayText,
                        imgTimestamp,
                        true,
                      );
                      broadcastNewMessage(data.chatJid, {
                        id: imgMsgId,
                        chat_jid: data.chatJid,
                        sender: 'happyclaw-agent',
                        sender_name: ASSISTANT_NAME,
                        content: displayText,
                        timestamp: imgTimestamp,
                        is_from_me: true,
                      });
                      broadcastToWebClients(data.chatJid, displayText);

                      logger.info(
                        {
                          chatJid: data.chatJid,
                          sourceGroup,
                          targetChannel: data.targetChannel,
                          mimeType,
                          size: imageBuffer.length,
                        },
                        'IPC image sent',
                      );
                    } catch (err) {
                      logger.error(
                        { chatJid: data.chatJid, sourceGroup, err },
                        'Failed to process IPC image',
                      );
                    }
                  } else {
                    logger.warn(
                      { chatJid: data.chatJid, sourceGroup },
                      'Unauthorized IPC image attempt blocked',
                    );
                  }
                }
                fs.unlinkSync(filePath);
              } catch (err) {
                logger.error(
                  { file, sourceGroup, err },
                  'Error processing IPC message',
                );
                const errorDir = path.join(ipcBaseDir, 'errors');
                fs.mkdirSync(errorDir, { recursive: true });
                try {
                  fs.renameSync(
                    filePath,
                    path.join(errorDir, `${sourceGroup}-${file}`),
                  );
                } catch (renameErr) {
                  logger.error(
                    { file, sourceGroup, renameErr },
                    'Failed to move IPC message to error directory, deleting',
                  );
                  try {
                    fs.unlinkSync(filePath);
                  } catch {
                    /* ignore */
                  }
                }
              }
            }
          }
        } catch (err) {
          logger.error(
            { err, sourceGroup },
            'Error reading IPC messages directory',
          );
        }

        // Process tasks from this group's IPC directory
        try {
          if (fs.existsSync(tasksDir)) {
            const allEntries = fs.readdirSync(tasksDir, {
              withFileTypes: true,
            });

            const taskFiles = allEntries
              .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
              .map((entry) => entry.name);
            for (const file of taskFiles) {
              const filePath = path.join(tasksDir, file);
              try {
                const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
                // Pass source group identity to processTaskIpc for authorization
                await processTaskIpc(
                  data,
                  sourceGroup,
                  isAdminHome,
                  isHome,
                  sourceGroupEntry,
                );
                fs.unlinkSync(filePath);
              } catch (err) {
                logger.error(
                  { file, sourceGroup, err },
                  'Error processing IPC task',
                );
                const errorDir = path.join(ipcBaseDir, 'errors');
                fs.mkdirSync(errorDir, { recursive: true });
                try {
                  fs.renameSync(
                    filePath,
                    path.join(errorDir, `${sourceGroup}-${file}`),
                  );
                } catch (renameErr) {
                  logger.error(
                    { file, sourceGroup, renameErr },
                    'Failed to move IPC task to error directory, deleting',
                  );
                  try {
                    fs.unlinkSync(filePath);
                  } catch {
                    /* ignore */
                  }
                }
              }
            }
          }
        } catch (err) {
          logger.error(
            { err, sourceGroup },
            'Error reading IPC tasks directory',
          );
        }
      } // end for (const ipcRoot of ipcRoots)
    }

    if (!shuttingDown) setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

// Module-level reference set after MemoryAgentManager creation, used by processTaskIpc.
let memoryAgentManagerRef: MemoryAgentManager | null = null;
let memoryOrchestratorRef: MemoryOrchestrator | null = null;

async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    userId?: string;
    schedule_value?: string;
    context_mode?: string;
    execution_type?: string;
    script_command?: string;
    model?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    containerConfig?: RegisteredGroup['containerConfig'];
    // For send_file
    filePath?: string;
    fileName?: string;
    // For targetChannel routing (send_file via model-controlled channel)
    targetChannel?: string;
  },
  sourceGroup: string, // Verified identity from IPC directory
  isAdminHome: boolean, // Whether source is admin home container
  isHome: boolean, // Whether source is a home container
  sourceGroupEntry: RegisteredGroup | undefined, // Source group's registered entry
): Promise<void> {
  switch (data.type) {
    case 'schedule_task':
      if (data.schedule_type && data.schedule_value && data.targetJid) {
        const execType =
          data.execution_type === 'script'
            ? ('script' as const)
            : ('agent' as const);

        // Script tasks require prompt OR script_command; agent tasks require prompt
        if (execType === 'agent' && !data.prompt) {
          logger.warn('schedule_task: agent mode requires prompt');
          break;
        }
        if (execType === 'script' && !data.script_command) {
          logger.warn('schedule_task: script mode requires script_command');
          break;
        }

        // Only admin home can create script tasks
        if (execType === 'script' && !isAdminHome) {
          logger.warn(
            { sourceGroup },
            'Non-admin container attempted to create script task',
          );
          break;
        }

        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-admin-home groups can only schedule for themselves
        if (!isAdminHome && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const scheduled = new Date(data.schedule_value);
          if (isNaN(scheduled.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = scheduled.toISOString();
        }

        const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt || '',
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          execution_type: execType,
          script_command: data.script_command ?? null,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
          model: data.model ?? undefined,
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode, execType },
          'Task created via IPC',
        );
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isAdminHome || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isAdminHome || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isAdminHome || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'refresh_groups':
      // Only admin home group can request a refresh
      if (isAdminHome) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await syncGroupMetadata(true);
        // Write updated snapshot immediately
        const availableGroups = getAvailableGroups();
        writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only admin home group can register new groups
      if (!isAdminHome) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder) {
        // Keep legacy owner metadata aligned with the target session owner when possible.
        const sourceEntry = Object.values(registeredGroups).find(
          (g) => g.folder === sourceGroup,
        );
        registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          created_by: resolveSessionOwnerKey(data.folder) || sourceEntry?.created_by,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    case 'send_file':
      if (data.chatJid && data.filePath && data.fileName) {
        // Cross-group authorization check (same as send_message)
        const targetGroup = registeredGroups[data.chatJid];
        if (
          !canSendCrossGroupMessage(
            isAdminHome,
            isHome,
            sourceGroup,
            sourceGroupEntry,
            targetGroup,
          )
        ) {
          logger.warn(
            { chatJid: data.chatJid, sourceGroup },
            'Unauthorized IPC send_file attempt blocked',
          );
          break;
        }

        try {
          let resolvedPath: string;
          if (path.isAbsolute(data.filePath)) {
            // Absolute paths are allowed intentionally: agents need to send files
            // from outside the workspace (e.g. shared expression images in user-global/).
            // No additional path restriction is enforced here because agents already
            // have full filesystem read access via Bash/Read tools.
            resolvedPath = path.resolve(data.filePath);
          } else {
            // Relative paths resolved against source group directory
            const fullPath = path.join(GROUPS_DIR, sourceGroup, data.filePath);
            resolvedPath = path.resolve(fullPath);
            const safeRoot = path.resolve(GROUPS_DIR, sourceGroup) + path.sep;
            if (!resolvedPath.startsWith(safeRoot)) {
              logger.warn(
                { sourceGroup, filePath: data.filePath, resolvedPath },
                'Path traversal attempt blocked in send_file IPC',
              );
              break;
            }
          }

          if (!fs.existsSync(resolvedPath)) {
            logger.warn(
              { sourceGroup, filePath: data.filePath, resolvedPath },
              'File not found in send_file IPC',
            );
            break;
          }

          // 只在有 targetChannel 时发送到 IM（文件只能发 IM）
          if (data.targetChannel) {
            await imManager.sendFile(
              data.targetChannel,
              resolvedPath,
              data.fileName,
            );
          }
          logger.info(
            {
              sourceGroup,
              chatJid: data.chatJid,
              targetChannel: data.targetChannel,
              fileName: data.fileName,
            },
            'File sent via IPC',
          );
        } catch (err) {
          logger.error({ err, data }, 'Failed to send file via IPC');
        }
      } else {
        logger.warn(
          { data },
          'Invalid send_file request - missing required fields',
        );
      }
      break;

    case 'session_wrapup':
      if (
        data.userId &&
        data.groupFolder &&
        memoryOrchestratorRef &&
        resolveSessionOwnerKey(data.groupFolder) === data.userId
      ) {
        const allJids = getJidsByFolder(data.groupFolder);
        memoryOrchestratorRef.exportTranscripts(
          data.userId,
          data.groupFolder,
          allJids,
        ).catch((err) => {
          logger.warn(
            { groupFolder: data.groupFolder, err },
            'session_wrapup via PreCompact IPC failed',
          );
        });
      }
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}

/**
 * Process messages for a user-created conversation agent.
 * Similar to processGroupMessages but uses agent-specific session/IPC and virtual JID.
 * The agent process stays alive for idleTimeout, cycling idle→running.
 */
async function processAgentConversation(
  chatJid: string,
  agentId: string,
): Promise<void> {
  const agent = getAgent(agentId);
  if (!agent || agent.kind !== 'conversation') {
    logger.warn(
      { chatJid, agentId },
      'processAgentConversation: agent not found or not a conversation',
    );
    return;
  }

  let group = registeredGroups[chatJid];
  if (!group) {
    registeredGroups = getAllRegisteredGroups();
    group = registeredGroups[chatJid];
  }
  if (!group) return;

  const { effectiveGroup } = resolveEffectiveGroup(group);

  const virtualChatJid = `${chatJid}#agent:${agentId}`;
  const virtualJid = virtualChatJid; // used as queue key

  // Get pending messages
  const sinceCursor = lastAgentTimestamp[virtualChatJid] || EMPTY_CURSOR;
  const missedMessages = getMessagesSince(virtualChatJid, sinceCursor);
  if (missedMessages.length === 0) return;

  const isHome = !!effectiveGroup.is_home;
  const isAdminHome = isHome && effectiveGroup.folder === MAIN_GROUP_FOLDER;

  // Update agent status → running
  updateAgentStatus(agentId, 'running');
  broadcastAgentStatus(chatJid, agentId, 'running', agent.name, agent.prompt);

  const prompt = formatMessages(missedMessages, false);
  const images = collectMessageImages(virtualChatJid, missedMessages);
  const imagesForAgent = images.length > 0 ? images : undefined;
  // Track idle timer
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { agentId, chatJid },
        'Agent conversation idle timeout, closing stdin',
      );
      queue.closeStdin(virtualJid);
    }, getSystemSettings().idleTimeout);
  };

  let cursorCommitted = false;
  let hadError = false;
  let lastError = '';
  let lastAgentReplyMsgId: string | undefined;
  const lastProcessed = missedMessages[missedMessages.length - 1];
  const commitCursor = (): void => {
    if (cursorCommitted) return;
    lastAgentTimestamp[virtualChatJid] = { rowid: lastProcessed.rowid };
    saveState();
    cursorCommitted = true;
  };

  // Get or use agent-specific session
  const runtimeBootstrap = getRuntimeBootstrapState(
    effectiveGroup.folder,
    agentId,
  );
  const sessionId = runtimeBootstrap.providerSessionId;
  const sessionRecordId = buildWorkerSessionRecordId(agentId);
  const sessionRecord = getSessionRecord(sessionRecordId);

  // Load context summary if session was compressed (no active session)
  let contextSummary: string | undefined;
  if (!sessionId) {
    const summary = getContextSummary(effectiveGroup.folder, chatJid);
    if (summary) {
      contextSummary = summary.summary;
    }
  }

  const wrappedOnOutput = async (output: RuntimeOutput) => {
    if (output.runtimeState) {
      persistRuntimeStateForSession(effectiveGroup.folder, output.runtimeState, agentId);
    }
    // Track session
    if (output.newSessionId && output.status !== 'error') {
      setSession(effectiveGroup.folder, output.newSessionId, agentId);
    }

    // Stream events
    if (output.status === 'stream' && output.streamEvent) {
      broadcastStreamEvent(chatJid, output.streamEvent, agentId);
      if (
        output.streamEvent.eventType === 'status' &&
        output.streamEvent.statusText === 'ipc_message_received'
      ) {
        ackIpcDeliveries(collectIpcAckKeys([virtualJid], output.streamEvent));
      }

      // Persist token usage for agent conversations
      if (
        output.streamEvent.eventType === 'usage' &&
        output.streamEvent.usage
      ) {
        try {
          updateLatestMessageTokenUsage(
            virtualChatJid,
            JSON.stringify(output.streamEvent.usage),
            lastAgentReplyMsgId,
          );

          // Write to usage_records + usage_daily_summary
          writeUsageRecords({
            userId:
              sessionRecord?.owner_key ||
              resolveStableSessionOwnerKey(effectiveGroup.folder, agentId) ||
              'system',
            groupFolder: effectiveGroup.folder,
            agentId,
            messageId: lastAgentReplyMsgId,
            usage: output.streamEvent.usage,
          });
        } catch (err) {
          logger.warn(
            { err, chatJid, agentId },
            'Failed to persist agent conversation token usage',
          );
        }
      }
      return;
    }

    // Agent reply — Web 存储 + 广播，不发 IM（模型通过 send_message 工具主动发 IM）
    if (output.result) {
      const raw =
        typeof output.result === 'string'
          ? output.result
          : JSON.stringify(output.result);
      const text = raw.trim();
      if (text) {
        const msgId = crypto.randomUUID();
        lastAgentReplyMsgId = msgId;
        const timestamp = new Date().toISOString();
        ensureChatExists(virtualChatJid);
        storeMessageDirect(
          msgId,
          virtualChatJid,
          'happyclaw-agent',
          ASSISTANT_NAME,
          text,
          timestamp,
          true,
        );
        broadcastNewMessage(
          virtualChatJid,
          {
            id: msgId,
            chat_jid: virtualChatJid,
            sender: 'happyclaw-agent',
            sender_name: ASSISTANT_NAME,
            content: text,
            timestamp,
            is_from_me: true,
          },
          agentId,
        );

        commitCursor();
        resetIdleTimer();
      }
    }

    if (output.status === 'error') {
      hadError = true;
      if (output.error) lastError = output.error;
    }
  };

  try {
    const onProcessCb = (proc: ChildProcess, identifier: string) => {
      queue.registerProcess(
        virtualJid,
        proc,
        null,
        effectiveGroup.folder,
        identifier,
        agentId,
      );
    };

    const runtimeInput: RuntimeInput = {
      prompt,
      sessionId,
      resumeAnchor: runtimeBootstrap.resumeAnchor,
      sessionRecordId,
      groupFolder: effectiveGroup.folder,
      chatJid,
      isHome,
      isAdminHome,
      agentId,
      agentName: agent.name,
      images: imagesForAgent,
      userId:
        sessionRecord?.owner_key
        || resolveStableSessionOwnerKey(effectiveGroup.folder, agentId),
      contextSummary,
      bootstrapState: runtimeBootstrap.bootstrapState,
    };

    // Write tasks/groups snapshots
    const tasks = getAllTasks();
    writeTasksSnapshot(
      effectiveGroup.folder,
      isAdminHome,
      tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      })),
    );
    const availableGroups = getAvailableGroups();
    writeGroupsSnapshot(
      effectiveGroup.folder,
      isAdminHome,
      availableGroups,
      new Set(Object.keys(registeredGroups)),
    );

    const ownerHomeFolder = resolveOwnerHomeFolder(effectiveGroup);

    const output = await runSessionAgent(
      effectiveGroup,
      runtimeInput,
      onProcessCb,
      wrappedOnOutput,
      ownerHomeFolder,
    );

    // Finalize session
    if (output.runtimeState) {
      persistRuntimeStateForSession(
        effectiveGroup.folder,
        output.runtimeState,
        agentId,
      );
    }
    if (output.newSessionId && output.status !== 'error') {
      setSession(effectiveGroup.folder, output.newSessionId, agentId);
    }

    // 不可恢复的转录错误（如超大图片/MIME 错配被固化在会话历史中）
    const errorForReset = [lastError, output.error].filter(Boolean).join(' ');
    if (
      (output.status === 'error' || hadError) &&
      errorForReset.includes('unrecoverable_transcript:')
    ) {
      const detail = (lastError || output.error || '').replace(
        /.*unrecoverable_transcript:\s*/,
        '',
      );
      logger.warn(
        { chatJid, agentId, folder: effectiveGroup.folder, error: detail },
        'Unrecoverable transcript error in conversation agent, auto-resetting session',
      );

      await clearSessionRuntimeFiles(effectiveGroup.folder, agentId);
      try {
        deleteSession(effectiveGroup.folder, agentId);
      } catch (err) {
        logger.error(
          { chatJid, agentId, folder: effectiveGroup.folder, err },
          'Failed to clear agent session state during auto-reset',
        );
      }

      sendSystemMessage(
        virtualChatJid,
        'context_reset',
        `会话已自动重置：${detail}`,
      );
    }

    commitCursor();
  } catch (err) {
    hadError = true;
    logger.error({ agentId, chatJid, err }, 'Agent conversation error');
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
  }

  // Process ended → set status back to idle (conversation agents persist)
  updateAgentStatus(agentId, 'idle');
  broadcastAgentStatus(chatJid, agentId, 'idle', agent.name, agent.prompt);
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info('happyclaw running');

  while (!shuttingDown) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newCursor } = getNewMessages(jids, globalMessageCursor);

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        globalMessageCursor = newCursor;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, DbMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          let group = registeredGroups[chatJid];
          if (!group) {
            const dbGroup = getRegisteredGroup(chatJid);
            if (dbGroup) {
              registeredGroups[chatJid] = dbGroup;
              group = dbGroup;
            }
          }
          if (!group) continue;

          // Skip groups already bound to worker sessions — their messages are
          // routed to conversation agents at IM ingestion time.
          if (getChatBindingPolicy(chatJid).sessionId?.startsWith('worker:')) continue;

          // Billing quota check before processing
          const ownerUserId = resolveChatOwnerKey(chatJid, group);
          if (ownerUserId) {
            const owner = getUserById(ownerUserId);
            if (owner && owner.role !== 'admin') {
              const accessResult = checkBillingAccessFresh(
                ownerUserId,
                owner.role,
              );
              if (!accessResult.allowed) {
                logger.info(
                  {
                    chatJid,
                    userId: ownerUserId,
                    reason: accessResult.reason,
                    blockType: accessResult.blockType,
                    exceededWindow: accessResult.exceededWindow,
                  },
                  'Billing access denied, blocking message processing',
                );
                const sysMsg = formatBillingAccessDeniedMessage(accessResult);
                sendBillingDeniedMessage(chatJid, sysMsg);

                // Notify IM channel if the message came from an IM source
                const lastSourceJid =
                  groupMessages[groupMessages.length - 1]?.source_jid;
                const imSourceJid = lastSourceJid || chatJid;
                if (getChannelType(imSourceJid)) {
                  imManager
                    .sendMessage(imSourceJid, sysMsg)
                    .catch((err) =>
                      logger.warn(
                        { err, jid: imSourceJid },
                        'Failed to send quota exceeded notice to IM',
                      ),
                    );
                }

                // Advance cursor past these messages so they aren't re-processed
                const lastMsg = groupMessages[groupMessages.length - 1];
                lastAgentTimestamp[chatJid] = { rowid: lastMsg.rowid };
                saveState();
                continue;
              }
            }
          }

          // Use only the new messages from this poll cycle.
          // processGroupMessages() handles the initial full fetch from
          // lastAgentTimestamp when the agent starts.  Subsequent inject/IPC
          // paths must NOT re-fetch from lastAgentTimestamp because it may
          // still point to before processGroupMessages' batch, which would
          // cause duplicate delivery of already-sent messages.
          const messagesToSend = groupMessages;

          // --- Turn-based routing ---
          const channel = resolveChannel(messagesToSend);
          const folder = resolveGroupFolder(chatJid);
          const messageIds = messagesToSend.map((m) => m.id);
          const route = turnManager.routeMessage(
            folder,
            chatJid,
            channel,
            messageIds,
          );

          if (route.action === 'already_queued') {
            logger.info(
              { chatJid, channel, folder },
              'Turn: message already queued, waiting for pending handoff',
            );
            // Message's chatJid is already in the pending queue — skip
            continue;
          }

          if (route.action === 'queue') {
            // Different channel or outside batch window — queue for later
            // Do NOT advance cursor so these messages are re-read when drained
            if (route.needsDrain) {
              queue.sendDrain(chatJid);
            }
            syncPendingTurnObservability(folder);
            logger.info(
              { chatJid, channel, folder, needsDrain: route.needsDrain },
              'Turn: message queued (different channel or window expired)',
            );
            continue;
          }

          // action === 'start_new' or 'inject'
          const shared = !group.is_home && isGroupShared(group.folder);
          const formatted = formatMessages(messagesToSend, shared);

          const images = collectMessageImages(chatJid, messagesToSend);
          const imagesForAgent = images.length > 0 ? images : undefined;

          const lastRawText = messagesToSend[messagesToSend.length - 1].content;
          const intent = analyzeIntent(lastRawText);

          // Helper: update trigger message map so IPC reply handler threads
          // to the latest message the agent actually sees.
          const updateTriggerMap = () => {
            const existingTrigger = triggerMessagesByFolder.get(group.folder);
            if (existingTrigger) {
              for (const m of messagesToSend) {
                const srcJid = m.source_jid || m.chat_jid;
                existingTrigger.set(srcJid, { id: m.id, sender: m.sender });
              }
            }
          };

          if (route.action === 'inject') {
            // Same channel, within window — inject into running agent
            turnObservabilityManager.syncTurn(
              folder,
              turnManager.getActiveTurn(folder),
            );
            syncPendingTurnObservability(folder);
            const sendResult = queue.sendMessage(
              chatJid,
              formatted,
              imagesForAgent,
              intent,
            );
            if (sendResult === 'sent') {
              updateTriggerMap();
              logger.info(
                {
                  chatJid,
                  count: messagesToSend.length,
                  imageCount: images.length,
                  turnId: route.turnId,
                },
                'Turn: injected messages into active turn via IPC',
              );
              trackIpcDeliveries(
                collectIpcDeliveryKeys(chatJid, messagesToSend),
              );
              const lastProcessed = messagesToSend[messagesToSend.length - 1];
              lastAgentTimestamp[chatJid] = { rowid: lastProcessed.rowid };
              saveState();
            } else if (sendResult === 'interrupted_stop') {
              const lastProcessed = messagesToSend[messagesToSend.length - 1];
              lastAgentTimestamp[chatJid] = { rowid: lastProcessed.rowid };
              saveState();
              broadcastInterruptedTurn(folder, chatJid, '用户主动中断');
            } else if (sendResult === 'interrupted_correction') {
              const lastProcessed = messagesToSend[messagesToSend.length - 1];
              lastAgentTimestamp[chatJid] = { rowid: lastProcessed.rowid };
              saveState();
            } else {
              // no_active — shouldn't happen if TurnManager thinks there's an active turn,
              // but handle gracefully by treating as start_new
              broadcastRunnerState(chatJid, 'queued', '当前 Turn 尚未接管，请稍候');
              queue.enqueueMessageCheck(chatJid);
            }
          } else {
            // start_new — new Turn created
            const activeTurn = turnManager.getActiveTurn(folder);
            if (activeTurn) {
              turnObservabilityManager.beginTurn(folder, activeTurn);
              syncPendingTurnObservability(folder);
            }
            broadcastTurnEvent(chatJid, {
              eventType: 'turn_started',
              turnId: route.turnId,
              turnStatus: 'started',
              turnChannel: channel,
              turnMessageCount: messageIds.length,
            });

            // Try to inject into an already-running agent first.
            // An agent might be idle in waitForIpcMessage() from a previous Turn
            // or from before the Turn system was deployed.
            const sendResult = queue.sendMessage(
              chatJid,
              formatted,
              imagesForAgent,
              intent,
            );
            if (sendResult === 'sent') {
              updateTriggerMap();
              logger.info(
                {
                  chatJid,
                  count: messagesToSend.length,
                  turnId: route.turnId,
                },
                'Turn: start_new but agent already running, injected via IPC',
              );
              // Create a progress card for IPC-injected Feishu chats that don't
              // have one yet. Use `channel` (original source JID, e.g.
              // "feishu:oc_8e1a...") as key, NOT `chatJid` which may be
              // the resolved effective JID (e.g. "web:main") — that would
              // collide with the Web progress session and skip creation.
              if (
                getChannelType(channel) === 'feishu' &&
                !hasActiveProgressSession(channel)
              ) {
                const resolved = resolveEffectiveGroup(group);
                const ownerId =
                  resolveSessionOwnerKey(resolved.effectiveGroup.folder)
                  || resolved.effectiveGroup.created_by;
                const fc = ownerId ? getUserFeishuConfig(ownerId) : null;
                if (fc?.streamingCard) {
                  const card = imManager.createProgressCard(channel);
                  if (card) {
                    registerProgressSession(channel, card, folder);
                  }
                }
              }
              trackIpcDeliveries(
                collectIpcDeliveryKeys(chatJid, messagesToSend),
              );
              const lastProcessed = messagesToSend[messagesToSend.length - 1];
              lastAgentTimestamp[chatJid] = { rowid: lastProcessed.rowid };
              saveState();
            } else if (sendResult === 'interrupted_stop') {
              const lastProcessed = messagesToSend[messagesToSend.length - 1];
              lastAgentTimestamp[chatJid] = { rowid: lastProcessed.rowid };
              saveState();
              broadcastInterruptedTurn(folder, chatJid, '用户主动中断');
            } else if (sendResult === 'interrupted_correction') {
              const lastProcessed = messagesToSend[messagesToSend.length - 1];
              lastAgentTimestamp[chatJid] = { rowid: lastProcessed.rowid };
              saveState();
            } else {
              // no_active — truly no agent running, start a new one
              broadcastRunnerState(chatJid, 'queued', '等待当前工作区开始处理这一轮');
              queue.enqueueMessageCheck(chatJid);
            }
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

// ─── Active Groups Store ─────────────────────────────────────
// Tracks which groups had running agents, so we can auto-resume after restart.
// Uses atomic write (tmp + rename) to avoid corruption on hard crash.

const ACTIVE_GROUPS_STORE_PATH = path.join(DATA_DIR, 'state', 'active-groups.json');

interface ActiveGroupEntry {
  chatJid: string;
  folder: string;
  startedAt: number;
}

function loadActiveGroupsStore(): ActiveGroupEntry[] {
  try {
    const data = fs.readFileSync(ACTIVE_GROUPS_STORE_PATH, 'utf-8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

function saveActiveGroupsStore(entries: ActiveGroupEntry[]): void {
  try {
    const dir = path.dirname(ACTIVE_GROUPS_STORE_PATH);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = ACTIVE_GROUPS_STORE_PATH + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(entries), 'utf-8');
    fs.renameSync(tmpPath, ACTIVE_GROUPS_STORE_PATH);
  } catch (err) {
    logger.warn({ err }, 'Failed to save active groups store');
  }
}

function addActiveGroup(chatJid: string, folder: string): void {
  const entries = loadActiveGroupsStore().filter((e) => e.chatJid !== chatJid);
  entries.push({ chatJid, folder, startedAt: Date.now() });
  saveActiveGroupsStore(entries);
}

function removeActiveGroup(chatJid: string): void {
  const entries = loadActiveGroupsStore().filter((e) => e.chatJid !== chatJid);
  saveActiveGroupsStore(entries);
}

/**
 * Startup recovery: check for unprocessed messages in registered groups,
 * AND auto-resume groups that had active agents before restart.
 */
function recoverPendingMessages(): void {
  const recoveredJids = new Set<string>();

  // Phase 1: recover groups that had active agents before restart
  const activeEntries = loadActiveGroupsStore();
  if (activeEntries.length > 0) {
    const maxAge = getSystemSettings().runtimeTimeout * 2; // 2x timeout = stale
    const now = Date.now();
    // Deduplicate by folder — multiple JIDs can map to the same folder
    const seenFolders = new Set<string>();

    logger.info(
      { count: activeEntries.length, groups: activeEntries.map((e) => e.folder) },
      'Recovery: found previously active groups, injecting resume messages',
    );
    for (const entry of activeEntries) {
      if (!registeredGroups[entry.chatJid]) continue;
      // Skip stale entries (crashed long ago, likely not useful to resume)
      if (now - entry.startedAt > maxAge) {
        logger.info(
          { folder: entry.folder, age: now - entry.startedAt },
          'Recovery: skipping stale active group entry',
        );
        continue;
      }
      // Deduplicate by folder — only recover the first JID per folder
      if (seenFolders.has(entry.folder)) continue;
      seenFolders.add(entry.folder);

      // Inject a system message to trigger the agent
      const msgId = `recovery-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
      ensureChatExists(entry.chatJid);
      storeMessageDirect(
        msgId,
        entry.chatJid,
        '__system__',
        '[系统]',
        '服务已重启，请继续之前的工作。',
        new Date().toISOString(),
        false,
      );
      broadcastRunnerState(entry.chatJid, 'queued', '服务重启后自动恢复');
      queue.enqueueMessageCheck(entry.chatJid);
      recoveredJids.add(entry.chatJid);
    }
    // Clear the store — these groups will be re-added when they start running
    saveActiveGroupsStore([]);
  }

  // Phase 2: recover groups with unprocessed messages (existing logic)
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    if (recoveredJids.has(chatJid)) continue; // already recovered above
    const sinceCursor = lastAgentTimestamp[chatJid] || EMPTY_CURSOR;
    const pending = getMessagesSince(chatJid, sinceCursor);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      broadcastRunnerState(chatJid, 'queued', '发现未处理消息，等待重新接管');
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

/**
 * Build the onNewChat callback for IM connections.
 * Feishu/Telegram chats auto-register to the user's home group folder.
 *
 * When the same Feishu app is transferred between users (e.g., admin disables
 * their channel and a member enables the same credentials), existing chats
 * are re-routed to the new user's home folder on first message receipt.
 */
function buildOnNewChat(
  userId: string,
  homeFolder: string,
): (chatJid: string, chatName: string, chatType?: 'p2p' | 'group') => void {
  return (chatJid, chatName, chatType) => {
    const existing = registeredGroups[chatJid];
    if (existing) {
      const binding = getExplicitSessionBinding(chatJid, existing);
      const existingOwnerKey = resolveChatOwnerKey(chatJid, existing);
      // Already owned by this user — update names if we now have a better name
      if (existingOwnerKey === userId) {
        if (chatName && chatName !== '飞书群聊' && chatName !== '飞书私聊') {
          // Update the IM chat name (chats table)
          updateChatName(chatJid, chatName);
          // Update the bound workspace name if it still has the generic name
          const boundSession = binding ? getSessionRecord(binding.session_id) : null;
          const targetFolder = boundSession?.kind === 'main'
            ? boundSession.id.slice('main:'.length)
            : boundSession?.parent_session_id?.startsWith('main:')
              ? boundSession.parent_session_id.slice('main:'.length)
              : null;
          const targetJid = targetFolder
            ? (findWebJidForFolder(targetFolder) || `web:${targetFolder}`)
            : null;
          if (targetJid && targetJid !== `web:${homeFolder}`) {
            const targetGroup = registeredGroups[targetJid] ?? getRegisteredGroup(targetJid);
            if (targetGroup && (!targetGroup.name || targetGroup.name === '飞书群聊')) {
              // Update registered_groups name (used by /api/groups)
              targetGroup.name = chatName;
              setRegisteredGroup(targetJid, targetGroup);
              // Update chats table name (used by some UI paths)
              updateChatName(targetJid, chatName);
            }
          }
        }
        return;
      }

      // Don't override groups with explicit agent routing configured.
      if (binding?.session_id.startsWith('worker:')) return;

      // Different user's connection now owns this IM app.
      // Re-route the chat to the current user's home folder.
      // This handles the common case where the same Feishu app credentials
      // are moved from one user to another (e.g., admin → member for testing).
      if (!existing.is_home) {
        const previousFolder = existing.folder;
        const previousOwnerKey = existingOwnerKey;
        existing.folder = homeFolder;
        existing.target_main_jid = undefined;
        setRegisteredGroup(chatJid, existing);
        applyExplicitChatBinding(chatJid, existing, `main:${homeFolder}`);
        registeredGroups[chatJid] = existing;
        logger.info(
          {
            chatJid,
            chatName,
            userId,
            homeFolder,
            previousFolder,
            previousOwnerKey,
          },
          'Re-routed IM chat to new user (IM credentials transferred)',
        );
      }
      return;
    }

    // Auto-create independent workspace for group chats if preference is on
    const prefs = getUserIMPreferences(userId);
    const shouldAutoCreate =
      chatType === 'group' &&
      prefs.autoCreateWorkspaceForGroups === true;

    if (shouldAutoCreate) {
      // 1. Create a new workspace
      const newJid = `web:${crypto.randomUUID()}`;
      const folder = `flow-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const now = new Date().toISOString();

      const newGroup: RegisteredGroup = {
        name: chatName,
        folder,
        added_at: now,
        executionMode: 'local',
        created_by: userId,
      };
      registerGroup(newJid, newGroup);
      ensureChatExists(newJid);
      updateChatName(newJid, chatName);
      addGroupMember(folder, userId, 'owner', userId);

      // 2. Register the IM group and bind to the new workspace
      registerGroup(chatJid, {
        name: chatName,
        folder: homeFolder,
        added_at: now,
        reply_policy: 'source_only',
      });
      applyExplicitChatBinding(
        chatJid,
        registeredGroups[chatJid] ?? getRegisteredGroup(chatJid)!,
        `main:${folder}`,
        'source_only',
      );

      logger.info(
        { chatJid, chatName, userId, newFolder: folder, newJid },
        'Auto-created workspace for IM group chat',
      );

      // 如果群名未能获取（通用名），在工作区写一条系统提示
      if (chatName === '飞书群聊') {
        storeMessageDirect(
          `system-${Date.now()}`,
          newJid,
          'system',
          '系统',
          '⚠️ 无法获取飞书群名称，工作区暂时命名为"飞书群聊"。请在飞书开放平台为应用开通 `im:chat:readonly` 权限后，发送新消息即可自动更新名称。',
          now,
          true,
        );
        broadcastToWebClients(newJid,
          '⚠️ 无法获取飞书群名称，工作区暂时命名为"飞书群聊"。请在飞书开放平台为应用开通 `im:chat:readonly` 权限后，发送新消息即可自动更新名称。',
        );
      }
    } else {
      // Default: route to home
      registerGroup(chatJid, {
        name: chatName,
        folder: homeFolder,
        added_at: new Date().toISOString(),
      });
      applyExplicitChatBinding(
        chatJid,
        registeredGroups[chatJid] ?? getRegisteredGroup(chatJid)!,
        `main:${homeFolder}`,
        'source_only',
      );
      logger.info(
        { chatJid, chatName, userId, homeFolder },
        'Auto-registered IM chat',
      );
    }
  };
}

/**
 * Build the onBotRemovedFromGroup callback.
 * When bot is removed from a Feishu group or the group is disbanded,
 * clear any IM binding (agent or main conversation).
 */
function buildOnBotRemovedFromGroup(): (chatJid: string) => void {
  return (chatJid: string) => {
    unbindImGroup(
      chatJid,
      'Auto-unbound IM group: bot removed or group disbanded',
    );
  };
}

/**
 * Build Telegram-specific bot-added-to-group handler.
 * Auto-registers the group (via buildOnNewChat) then sends a welcome message
 * guiding the user to bind or create a workspace.
 */
function buildTelegramBotAddedHandler(
  userId: string,
  homeFolder: string,
): (chatJid: string, chatName: string) => void {
  const onNewChat = buildOnNewChat(userId, homeFolder);
  return (chatJid: string, chatName: string) => {
    onNewChat(chatJid, chatName, 'group'); // bot-added is always a group
    const welcome =
      `已加入「${chatName}」！当前绑定到默认工作区。\n\n` +
      `/new <名称> — 新建工作区并绑定此群\n` +
      `/bind <工作区> — 绑定到已有工作区\n` +
      `/list — 查看所有工作区\n\n` +
      `也可以直接发消息，我会在默认工作区回复。`;
    imManager
      .sendMessage(chatJid, welcome)
      .catch((err) =>
        logger.warn(
          { chatJid, err },
          'Failed to send Telegram group welcome message',
        ),
      );
  };
}

function buildIsChatAuthorized(userId: string): (jid: string) => boolean {
  return (jid) => {
    const group = registeredGroups[jid];
    return !!group && resolveChatOwnerKey(jid, group) === userId;
  };
}

function buildOnPairAttempt(
  userId: string,
): (jid: string, chatName: string, code: string) => Promise<boolean> {
  return async (jid, chatName, code) => {
    const result = verifyPairingCode(code);
    if (!result) return false;
    if (result.userId !== userId) return false;
    const pairingUserHome = getUserHomeGroup(result.userId);
    if (!pairingUserHome) return false;
    buildOnNewChat(result.userId, pairingUserHome.folder)(jid, chatName);
    return true;
  };
}

/**
 * Build callback that resolves an IM chatJid to a bound target JID.
 * Returns null if the chatJid has no session binding configured.
 */
function buildResolveEffectiveChatJid(): (
  chatJid: string,
) => { effectiveJid: string; agentId: string | null } | null {
  return (chatJid: string) => {
    const target = resolveBoundSessionTarget(chatJid);
    if (target.sessionId && target.effectiveJid) {
      return {
        effectiveJid: target.effectiveJid,
        agentId: target.boundAgentId,
      };
    }
    return null;
  };
}

/**
 * Build callback that triggers processAgentConversation when an IM message is routed to an agent.
 */
function buildOnAgentMessage(): (baseChatJid: string, agentId: string) => void {
  return (baseChatJid: string, agentId: string) => {
    const group =
      registeredGroups[baseChatJid] ?? getRegisteredGroup(baseChatJid);
    if (!group) return;

    // Use the agent's actual chat_jid (the workspace's registered JID) as the
    // base.  Previously we used web:${folder} which doesn't match any registered
    // group for non-main workspaces (their JID is web:{uuid}, not web:{folder}).
    const agent = getAgent(agentId);
    const homeChatJid = agent?.chat_jid || `web:${group.folder}`;
    const virtualChatJid = `${homeChatJid}#agent:${agentId}`;

    // Fetch pending messages
    const sinceCursor = lastAgentTimestamp[virtualChatJid] || EMPTY_CURSOR;
    const missedMessages = getMessagesSince(virtualChatJid, sinceCursor);

    // IM messages must force-restart the agent process so reply routing
    // (replySourceImJid) is recalculated from the latest batch.  This mirrors
    // the home-folder force-restart for the main conversation.
    const lastSourceJid = missedMessages[missedMessages.length - 1]?.source_jid;
    const isImSource =
      !!lastSourceJid && getChannelType(lastSourceJid) !== null;

    if (isImSource) {
      // Force close running process then enqueue fresh start.
      // Use a stable taskId so rapid-fire IM messages deduplicate into a
      // single queued restart instead of N separate restarts.
      queue.closeStdin(virtualChatJid);
      const taskId = `agent-im-restart:${agentId}`;
      queue.enqueueTask(virtualChatJid, taskId, async () => {
        await processAgentConversation(homeChatJid, agentId);
      });
    } else {
      // Web-origin: try to pipe into running agent process
      const formatted =
        missedMessages.length > 0 ? formatMessages(missedMessages, false) : '';
      const images = collectMessageImages(virtualChatJid, missedMessages);
      const imagesForAgent = images.length > 0 ? images : undefined;

      const sendResult = formatted
        ? queue.sendMessage(
            virtualChatJid,
            formatted,
            imagesForAgent,
            undefined,
          )
        : 'no_active';
      if (sendResult === 'no_active') {
        const taskId = `agent-conv:${agentId}:${Date.now()}`;
        queue.enqueueTask(virtualChatJid, taskId, async () => {
          await processAgentConversation(homeChatJid, agentId);
        });
      }
    }
    logger.info(
      {
        baseChatJid,
        homeChatJid,
        agentId,
        messageCount: missedMessages.length,
      },
      'IM message triggered agent conversation processing',
    );
  };
}

/**
 * Mention gating callback: when bot is NOT @mentioned in a group chat,
 * return true to process the message anyway, false to drop it.
 */
function shouldProcessGroupMessage(chatJid: string): boolean {
  const policy = getChatBindingPolicy(chatJid);

  // activation_mode 优先于 require_mention
  const mode = policy.activationMode;
  switch (mode) {
    case 'always':
      return true; // 群聊不需要 @bot
    case 'when_mentioned':
      return false; // 必须 @bot
    case 'disabled':
      return false; // 忽略所有消息（在调用方处理 disabled 的 DM 忽略）
    case 'auto':
    default:
      // 兼容旧行为：require_mention defaults to false; if true → only process @mentions
      return policy.requireMention !== true;
  }
}

/**
 * 中断 fast-path 回调：IM 消息到达时立即触发中断，绕过 2s 轮询延迟。
 * 模块级函数，所有 IM 连接共享。
 */
function handleIMInterruptRequest(
  chatJid: string,
  intent: 'stop' | 'correction',
): void {
  const interrupted = queue.interruptQuery(chatJid);
  if (interrupted) {
    logger.info(
      { chatJid, intent },
      'Interrupt fast-path: query interrupted immediately',
    );
  }
}

/**
 * Connect IM channels for a specific user via imManager.
 * Reads the user's IM config and connects if enabled.
 */
async function connectUserIMChannels(
  userId: string,
  homeFolder: string,
  feishuConfig?: FeishuConnectConfig | null,
  telegramConfig?: TelegramConnectConfig | null,
  qqConfig?: QQConnectConfig | null,
  wechatConfig?: WeChatConnectConfig | null,
  ignoreMessagesBefore?: number,
): Promise<{ feishu: boolean; telegram: boolean; qq: boolean; wechat: boolean }> {
  const onNewChat = buildOnNewChat(userId, homeFolder);
  const resolveGroupFolder = (chatJid: string): string | undefined => {
    return resolveEffectiveFolder(chatJid);
  };
  const resolveEffectiveChatJid = buildResolveEffectiveChatJid();
  const onAgentMessage = buildOnAgentMessage();
  const onBotAddedToGroup = (chatJid: string, chatName: string) =>
    onNewChat(chatJid, chatName, 'group'); // bot-added is always a group
  const onBotRemovedFromGroup = buildOnBotRemovedFromGroup();

  let feishu = false;
  let telegram = false;
  let qq = false;
  let wechat = false;

  if (
    feishuConfig &&
    feishuConfig.enabled !== false &&
    feishuConfig.appId &&
    feishuConfig.appSecret
  ) {
    feishu = await imManager.connectUserFeishu(
      userId,
      feishuConfig,
      onNewChat,
      {
        ignoreMessagesBefore,
        onCommand: handleCommand,
        resolveGroupFolder,
        resolveEffectiveChatJid,
        onAgentMessage,
        onBotAddedToGroup,
        onBotRemovedFromGroup,
        shouldProcessGroupMessage,
        onInterruptRequest: handleIMInterruptRequest,
      },
    );
  }

  if (
    telegramConfig &&
    telegramConfig.enabled !== false &&
    telegramConfig.botToken
  ) {
    telegram = await imManager.connectUserTelegram(
      userId,
      telegramConfig,
      onNewChat,
      buildIsChatAuthorized(userId),
      buildOnPairAttempt(userId),
      {
        onCommand: handleCommand,
        resolveGroupFolder,
        resolveEffectiveChatJid,
        onAgentMessage,
        onBotAddedToGroup: buildTelegramBotAddedHandler(userId, homeFolder),
        onBotRemovedFromGroup,
        onInterruptRequest: handleIMInterruptRequest,
      },
    );
  }

  if (
    qqConfig &&
    qqConfig.enabled !== false &&
    qqConfig.appId &&
    qqConfig.appSecret
  ) {
    qq = await imManager.connectUserQQ(
      userId,
      qqConfig,
      onNewChat,
      buildIsChatAuthorized(userId),
      buildOnPairAttempt(userId),
      {
        onCommand: handleCommand,
        resolveGroupFolder,
        resolveEffectiveChatJid,
        onAgentMessage,
        onInterruptRequest: handleIMInterruptRequest,
      },
    );
  }

  if (
    wechatConfig &&
    wechatConfig.enabled !== false &&
    wechatConfig.botToken &&
    wechatConfig.ilinkBotId
  ) {
    wechat = await imManager.connectUserWeChat(
      userId,
      wechatConfig,
      onNewChat,
      {
        onCommand: handleCommand,
        resolveGroupFolder,
        resolveEffectiveChatJid,
        onAgentMessage,
      },
    );
  }

  return { feishu, telegram, qq, wechat };
}

function movePathWithFallback(src: string, dst: string): void {
  try {
    fs.renameSync(src, dst);
  } catch (err: unknown) {
    // Cross-device rename fallback.
    if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
      fs.cpSync(src, dst, { recursive: true });
      fs.rmSync(src, { recursive: true, force: true });
      return;
    }
    throw err;
  }
}

/**
 * One-shot migration: move legacy top-level directories into data/.
 * - store/messages.db* → data/db/messages.db*
 * - groups/            → data/groups/
 * Also supports partial migrations (old+new paths both exist).
 */
function migrateDataDirectories(): void {
  const projectRoot = process.cwd();

  // 1. Migrate store/ → data/db/
  const oldStoreDir = path.join(projectRoot, 'store');
  if (fs.existsSync(oldStoreDir)) {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    // Move messages.db and WAL files
    for (const file of ['messages.db', 'messages.db-wal', 'messages.db-shm']) {
      const src = path.join(oldStoreDir, file);
      const dst = path.join(STORE_DIR, file);
      if (fs.existsSync(src) && !fs.existsSync(dst)) {
        movePathWithFallback(src, dst);
        logger.info({ src, dst }, 'Migrated database file');
      }
    }
    // Remove old store/ if empty
    try {
      fs.rmdirSync(oldStoreDir);
    } catch {
      // Not empty — leave it
    }
  }

  // 2. Migrate groups/ → data/groups/
  const oldGroupsDir = path.join(projectRoot, 'groups');
  if (fs.existsSync(oldGroupsDir)) {
    fs.mkdirSync(path.dirname(GROUPS_DIR), { recursive: true });
    if (!fs.existsSync(GROUPS_DIR)) {
      movePathWithFallback(oldGroupsDir, GROUPS_DIR);
      logger.info(
        { src: oldGroupsDir, dst: GROUPS_DIR },
        'Migrated groups directory',
      );
    } else {
      // Partial migration: move missing entries one-by-one.
      const entries = fs.readdirSync(oldGroupsDir, { withFileTypes: true });
      for (const entry of entries) {
        const src = path.join(oldGroupsDir, entry.name);
        const dst = path.join(GROUPS_DIR, entry.name);
        if (!fs.existsSync(dst)) {
          movePathWithFallback(src, dst);
          logger.info({ src, dst }, 'Migrated legacy group entry');
        }
      }
      try {
        fs.rmdirSync(oldGroupsDir);
      } catch {
        // Not empty — leave it
      }
    }
  }
}

async function main(): Promise<void> {
  migrateDataDirectories();
  initDatabase();
  logger.info('Database initialized');

  // Clean up stale completed task agents (older than 1 hour) to prevent DB bloat
  try {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const cleaned = deleteCompletedTaskAgents(oneHourAgo);
    if (cleaned > 0) {
      logger.info({ cleaned }, 'Cleaned up stale completed task agents');
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up stale task agents');
  }

  // After process restart there cannot be truly running SDK tasks.
  // Mark all persisted running tasks as error to avoid stale "running" tabs.
  try {
    const marked = markAllRunningTaskAgentsAsError();
    if (marked > 0) {
      logger.warn(
        { marked },
        'Marked stale running task agents as error at startup',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to mark stale running tasks at startup');
  }

  // Migrate system-level IM config → admin's per-user config (one-time)
  migrateSystemIMToPerUser();

  loadState();

  // --- Memory Agent Manager ---
  const memoryAgentManager = new MemoryAgentManager();
  const memoryOrchestrator = new MemoryOrchestrator(memoryAgentManager);
  memoryAgentManagerRef = memoryAgentManager;
  memoryOrchestratorRef = memoryOrchestrator;
  const memoryAgentToken = crypto.randomBytes(32).toString('hex');
  injectMemoryAgentDeps({
    manager: memoryAgentManager,
    token: memoryAgentToken,
  });
  injectFeishuApiDeps({ token: memoryAgentToken }); // Reuse same internal token
  injectMemoryDeps({ orchestrator: memoryOrchestrator, queue });
  memoryOrchestrator.start();
  logger.info('Memory orchestrator initialized');

  // --- Memory Agent: transcript export on container exit ---
  queue.addOnRuntimeExitListener((groupJid: string) => {
    const ownerContext = resolveRuntimeOwnerContext(groupJid);
    if (!ownerContext) return;

    const allJids = getJidsByFolder(ownerContext.folder);
    memoryOrchestrator.exportTranscripts(
      ownerContext.userId,
      ownerContext.folder,
      allJids,
    ).catch((err) => {
      logger.warn(
        { groupJid, err },
        'Memory Agent session_wrapup failed (non-blocking)',
      );
    });
  });

  // --- Channel reload helpers (hot-reload on config save) ---

  let feishuSyncInterval: ReturnType<typeof setInterval> | null = null;

  // Graceful shutdown handlers
  let shutdownInProgress = false;
  const shutdown = async (signal: string) => {
    if (shutdownInProgress) {
      logger.warn('Force exit (second signal)');
      process.exit(1);
    }
    shutdownInProgress = true;
    shuttingDown = true;
    logger.info({ signal }, 'Shutdown signal received, cleaning up...');

    if (feishuSyncInterval) {
      clearInterval(feishuSyncInterval);
      feishuSyncInterval = null;
    }

    try {
      shutdownTerminals();
    } catch (err) {
      logger.warn({ err }, 'Error shutting down terminals');
    }
    // Abort all active streaming/progress cards before disconnecting IM,
    // so users see "服务维护中" instead of a stuck card.
    try {
      await Promise.allSettled([
        abortAllStreamingSessions('服务维护中'),
        abortAllProgressSessions('服务维护中'),
      ]);
    } catch (err) {
      logger.warn({ err }, 'Error aborting streaming/progress sessions');
    }
    try {
      await imManager.disconnectAll();
    } catch (err) {
      logger.warn({ err }, 'Error disconnecting IM connections');
    }
    try {
      await shutdownWebServer();
    } catch (err) {
      logger.warn({ err }, 'Error shutting down web server');
    }
    try {
      await memoryOrchestrator.shutdownAll();
    } catch (err) {
      logger.warn({ err }, 'Error shutting down Memory Agents');
    }
    try {
      await queue.shutdown(10000);
    } catch (err) {
      logger.warn({ err }, 'Error shutting down queue');
    }
    try {
      markStaleTurnsAsError();
    } catch (err) {
      logger.warn({ err }, 'Error marking stale turns as error');
    }
    try {
      closeDatabase();
    } catch (err) {
      logger.warn({ err }, 'Error closing database');
    }

    logger.info('Shutdown complete');
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Reload Feishu connection for a specific user (hot-reload on config save)
  const reloadFeishuConnection = async (config: {
    appId: string;
    appSecret: string;
    enabled?: boolean;
  }): Promise<boolean> => {
    // Find admin user's home folder (legacy global config routes to admin)
    const adminUsers = listUsers({
      status: 'active',
      role: 'admin',
      page: 1,
      pageSize: 1,
    }).users;
    const adminUser = adminUsers[0];
    if (!adminUser) {
      logger.warn('No admin user found for Feishu reload');
      return false;
    }

    // Disconnect existing admin Feishu connection
    await imManager.disconnectUserFeishu(adminUser.id);
    if (feishuSyncInterval) {
      clearInterval(feishuSyncInterval);
      feishuSyncInterval = null;
    }

    if (config.enabled !== false && config.appId && config.appSecret) {
      const homeGroup = getUserHomeGroup(adminUser.id);
      const homeFolder = homeGroup?.folder || MAIN_GROUP_FOLDER;
      const onNewChat = buildOnNewChat(adminUser.id, homeFolder);
      const connected = await imManager.connectUserFeishu(
        adminUser.id,
        config,
        onNewChat,
        {
          ignoreMessagesBefore: Date.now(),
          onCommand: handleCommand,
          resolveGroupFolder: (chatJid: string) =>
            resolveEffectiveFolder(chatJid),
          resolveEffectiveChatJid: buildResolveEffectiveChatJid(),
          onAgentMessage: buildOnAgentMessage(),
          onBotAddedToGroup: (chatJid: string, chatName: string) =>
            onNewChat(chatJid, chatName, 'group'),
          onBotRemovedFromGroup: buildOnBotRemovedFromGroup(),
          shouldProcessGroupMessage,
          onInterruptRequest: handleIMInterruptRequest,
        },
      );
      if (connected) {
        syncGroupMetadata().catch((err) =>
          logger.error({ err }, 'Group sync after Feishu reconnect failed'),
        );
        feishuSyncInterval = setInterval(() => {
          syncGroupMetadata().catch((err) =>
            logger.error({ err }, 'Periodic group sync failed'),
          );
        }, GROUP_SYNC_INTERVAL_MS);
      }
      return connected;
    }
    logger.info('Feishu channel disabled via hot-reload');
    return false;
  };

  const reloadTelegramConnection = async (config: {
    botToken: string;
    proxyUrl?: string;
    enabled?: boolean;
  }): Promise<boolean> => {
    // Find admin user
    const adminUsers = listUsers({
      status: 'active',
      role: 'admin',
      page: 1,
      pageSize: 1,
    }).users;
    const adminUser = adminUsers[0];
    if (!adminUser) {
      logger.warn('No admin user found for Telegram reload');
      return false;
    }

    await imManager.disconnectUserTelegram(adminUser.id);

    if (config.enabled !== false && config.botToken) {
      const homeGroup = getUserHomeGroup(adminUser.id);
      const homeFolder = homeGroup?.folder || MAIN_GROUP_FOLDER;
      const onNewChat = buildOnNewChat(adminUser.id, homeFolder);
      const connected = await imManager.connectUserTelegram(
        adminUser.id,
        config,
        onNewChat,
        buildIsChatAuthorized(adminUser.id),
        buildOnPairAttempt(adminUser.id),
        {
          onCommand: handleCommand,
          resolveGroupFolder: (chatJid) => resolveEffectiveFolder(chatJid),
          resolveEffectiveChatJid: buildResolveEffectiveChatJid(),
          onAgentMessage: buildOnAgentMessage(),
          onBotAddedToGroup: buildTelegramBotAddedHandler(
            adminUser.id,
            homeFolder,
          ),
          onBotRemovedFromGroup: buildOnBotRemovedFromGroup(),
          onInterruptRequest: handleIMInterruptRequest,
        },
      );
      return connected;
    }
    logger.info('Telegram channel disabled via hot-reload');
    return false;
  };

  // Reload a per-user IM channel (hot-reload on user-im config save)
  const reloadUserIMConfig = async (
    userId: string,
    channel: 'feishu' | 'telegram' | 'qq' | 'wechat',
  ): Promise<boolean> => {
    const homeGroup = getUserHomeGroup(userId);
    if (!homeGroup) {
      logger.warn(
        { userId, channel },
        'No home group found for user IM reload',
      );
      return false;
    }
    const homeFolder = homeGroup.folder;
    const onNewChat = buildOnNewChat(userId, homeFolder);
    const ignoreMessagesBefore = Date.now();

    if (channel === 'feishu') {
      await imManager.disconnectUserFeishu(userId);
      const config = getUserFeishuConfig(userId);
      if (
        config &&
        config.enabled !== false &&
        config.appId &&
        config.appSecret
      ) {
        const connected = await imManager.connectUserFeishu(
          userId,
          config,
          onNewChat,
          {
            ignoreMessagesBefore,
            onCommand: handleCommand,
            resolveGroupFolder: (chatJid: string) =>
              resolveEffectiveFolder(chatJid),
            resolveEffectiveChatJid: buildResolveEffectiveChatJid(),
            onAgentMessage: buildOnAgentMessage(),
            onBotAddedToGroup: (chatJid: string, chatName: string) =>
              onNewChat(chatJid, chatName, 'group'),
            onBotRemovedFromGroup: buildOnBotRemovedFromGroup(),
            shouldProcessGroupMessage,
            onInterruptRequest: handleIMInterruptRequest,
          },
        );
        logger.info(
          { userId, connected },
          'User Feishu connection hot-reloaded',
        );
        return connected;
      }
      logger.info({ userId }, 'User Feishu channel disabled via hot-reload');
      return false;
    } else if (channel === 'telegram') {
      await imManager.disconnectUserTelegram(userId);
      const config = getUserTelegramConfig(userId);
      const globalTelegramConfig = getTelegramProviderConfig();
      if (config && config.enabled !== false && config.botToken) {
        const connected = await imManager.connectUserTelegram(
          userId,
          {
            ...config,
            proxyUrl: config.proxyUrl || globalTelegramConfig.proxyUrl,
          },
          onNewChat,
          buildIsChatAuthorized(userId),
          buildOnPairAttempt(userId),
          {
            onCommand: handleCommand,
            resolveGroupFolder: (chatJid: string) =>
              resolveEffectiveFolder(chatJid),
            resolveEffectiveChatJid: buildResolveEffectiveChatJid(),
            onAgentMessage: buildOnAgentMessage(),
            onBotAddedToGroup: buildTelegramBotAddedHandler(userId, homeFolder),
            onBotRemovedFromGroup: buildOnBotRemovedFromGroup(),
            onInterruptRequest: handleIMInterruptRequest,
          },
        );
        logger.info(
          { userId, connected },
          'User Telegram connection hot-reloaded',
        );
        return connected;
      }
      logger.info({ userId }, 'User Telegram channel disabled via hot-reload');
      return false;
    } else if (channel === 'qq') {
      await imManager.disconnectUserQQ(userId);
      const config = getUserQQConfig(userId);
      if (
        config &&
        config.enabled !== false &&
        config.appId &&
        config.appSecret
      ) {
        const connected = await imManager.connectUserQQ(
          userId,
          config,
          onNewChat,
          buildIsChatAuthorized(userId),
          buildOnPairAttempt(userId),
          {
            onCommand: handleCommand,
            resolveGroupFolder: (chatJid: string) =>
              resolveEffectiveFolder(chatJid),
            resolveEffectiveChatJid: buildResolveEffectiveChatJid(),
            onAgentMessage: buildOnAgentMessage(),
            onInterruptRequest: handleIMInterruptRequest,
          },
        );
        logger.info({ userId, connected }, 'User QQ connection hot-reloaded');
        return connected;
      }
      logger.info({ userId }, 'User QQ channel disabled via hot-reload');
      return false;
    } else {
      // WeChat
      await imManager.disconnectUserWeChat(userId);
      const config = getUserWeChatConfig(userId);
      if (
        config &&
        config.enabled !== false &&
        config.botToken &&
        config.ilinkBotId
      ) {
        const connected = await imManager.connectUserWeChat(
          userId,
          {
            botToken: config.botToken,
            ilinkBotId: config.ilinkBotId,
            baseUrl: config.baseUrl,
            cdnBaseUrl: config.cdnBaseUrl,
            getUpdatesBuf: config.getUpdatesBuf,
          },
          onNewChat,
          {
            onCommand: handleCommand,
            resolveGroupFolder: (chatJid: string) =>
              resolveEffectiveFolder(chatJid),
            resolveEffectiveChatJid: buildResolveEffectiveChatJid(),
            onAgentMessage: buildOnAgentMessage(),
          },
        );
        logger.info(
          { userId, connected },
          'User WeChat connection hot-reloaded',
        );
        return connected;
      }
      logger.info({ userId }, 'User WeChat channel disabled via hot-reload');
      return false;
    }
  };

  // Start Web server early so frontend auth/API isn't blocked by Feishu readiness.
  startWebServer({
    queue,
    getRegisteredGroups: () => registeredGroups,
    getSessions: () => sessions,
    processGroupMessages,
    ensureTerminalRuntimeStarted,
    formatMessages,
    getLastAgentTimestamp: () => lastAgentTimestamp,
    setLastAgentTimestamp: (jid: string, cursor: MessageCursor) => {
      lastAgentTimestamp[jid] = cursor;
      saveState();
    },
    advanceGlobalCursor: (cursor: MessageCursor) => {
      if (isCursorAfter(cursor, globalMessageCursor)) {
        globalMessageCursor = cursor;
        saveState();
      }
    },
    trackIpcDelivery,
    reloadFeishuConnection,
    reloadTelegramConnection,
    reloadUserIMConfig,
    isFeishuConnected: () => imManager.isAnyFeishuConnected(),
    isTelegramConnected: () => imManager.isAnyTelegramConnected(),
    isUserFeishuConnected: (userId: string) =>
      imManager.isFeishuConnected(userId),
    isUserTelegramConnected: (userId: string) =>
      imManager.isTelegramConnected(userId),
    isUserQQConnected: (userId: string) => imManager.isQQConnected(userId),
    isUserWeChatConnected: (userId: string) =>
      imManager.isWeChatConnected(userId),
    processAgentConversation,
    getFeishuChatInfo: (userId: string, chatId: string) =>
      imManager.getFeishuChatInfo(userId, chatId),
    clearImFailCounts: (jid: string) => {
      imHealthCheckFailCounts.delete(jid);
    },
    triggerSessionWrapup: async (folder: string) => {
      const ownerKey = resolveSessionOwnerKey(folder);
      if (!ownerKey) return;
      const allJids = getJidsByFolder(folder);
      await memoryOrchestrator.exportTranscripts(
        ownerKey,
        folder,
        allJids,
      );
    },
    getActiveTurnRuntime: (folder: string) => turnManager.getActiveTurn(folder),
    getPendingTurnCounts: (folder: string) => turnManager.getPendingCounts(folder),
    getTurnObservability: (folder: string) => turnObservabilityManager.get(folder),
    buildCompressOptions,
  });

  // Clean expired sessions every hour
  setInterval(
    () => {
      try {
        const deleted = deleteExpiredSessions();
        if (deleted > 0) {
          logger.info({ deleted }, 'Cleaned expired user sessions');
        }
      } catch (err) {
        logger.error({ err }, 'Failed to clean expired sessions');
      }
    },
    60 * 60 * 1000,
  );

  // Billing: check expired subscriptions every hour
  setInterval(
    () => {
      checkAndExpireSubscriptions();
    },
    60 * 60 * 1000,
  );

  // Billing: reconcile monthly usage every 6 hours
  setInterval(
    () => {
      if (!isBillingEnabled()) return;
      try {
        const month = new Date().toISOString().slice(0, 7);
        // Reconcile all non-admin users with pagination
        let page = 1;
        const pageSize = 200;
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const batch = listUsers({ status: 'active', pageSize, page });
          for (const u of batch.users) {
            if (u.role === 'admin') continue;
            reconcileMonthlyUsage(u.id, month);
          }
          if (batch.users.length < pageSize) break;
          page++;
        }
      } catch (err) {
        logger.error({ err }, 'Failed to run monthly usage reconciliation');
      }
    },
    6 * 60 * 60 * 1000,
  );

  // Billing: cleanup old daily_usage and billing_audit_log every 24 hours
  setInterval(
    () => {
      try {
        const deletedDaily = cleanupOldDailyUsage();
        const deletedAudit = cleanupOldBillingAuditLog();
        if (deletedDaily > 0 || deletedAudit > 0) {
          logger.info(
            { deletedDaily, deletedAudit },
            'Cleaned up old billing data',
          );
        }
      } catch (err) {
        logger.error({ err }, 'Failed to cleanup old billing data');
      }
      // Cleanup old turns and trace files
      try {
        const retentionDays = getSystemSettings().traceRetentionDays;
        const deletedTurns = cleanupOldTurns(retentionDays);
        const deletedTraces = cleanupOldTraces(retentionDays);
        if (deletedTurns > 0 || deletedTraces > 0) {
          logger.info(
            { deletedTurns, deletedTraces, retentionDays },
            'Cleaned up old turn data',
          );
        }
      } catch (err) {
        logger.error({ err }, 'Failed to cleanup old turn data');
      }
    },
    24 * 60 * 60 * 1000,
  );

  queue.setProcessMessagesFn(processGroupMessages);
  queue.setLifecycleEmitter((groupJid, state, detail) => {
    broadcastRunnerState(groupJid, state, detail);
    const folder = resolveGroupFolder(groupJid);
    turnObservabilityManager.setRunnerState(
      folder,
      state as
        | 'queued'
        | 'capacity_wait'
        | 'starting'
        | 'running'
        | 'interrupted'
        | 'completed'
        | 'error'
        | 'drained',
      detail,
      turnManager.getActiveTurn(folder),
    );
    syncPendingTurnObservability(folder);

    // Track active groups for restart recovery (only on 'starting' to avoid redundant writes)
    if (state === 'starting') {
      addActiveGroup(groupJid, folder);
    }
  });
  queue.addOnRuntimeExitListener((groupJid) => {
    removeActiveGroup(groupJid);
  });
  queue.setHostModeChecker(() => false);
  queue.setSerializationKeyResolver((groupJid: string) => {
    // Agent virtual JIDs: {chatJid}#agent:{agentId} → separate serialization key
    const agentSep = groupJid.indexOf('#agent:');
    if (agentSep >= 0) {
      const baseJid = groupJid.slice(0, agentSep);
      const agentId = groupJid.slice(agentSep + 7);
      const group = registeredGroups[baseJid];
      const folder = group?.folder || baseJid;
      return `${folder}#${agentId}`;
    }
    const group = registeredGroups[groupJid];
    return group?.folder || groupJid;
  });
  queue.setOnMaxRetriesExceeded((groupJid: string) => {
    const group = registeredGroups[groupJid];
    const name = group?.name || groupJid;
    sendSystemMessage(
      groupJid,
      'agent_max_retries',
      `${name} 处理失败，已达最大重试次数`,
    );
    setTyping(groupJid, false);
  });
  // Billing: user-level concurrent container limit
  queue.setUserConcurrentLimitChecker((groupJid: string) => {
    if (!isBillingEnabled()) return { allowed: true };
    const ownerContext = resolveRuntimeOwnerContext(groupJid);
    if (!ownerContext) return { allowed: true };
    const owner = getUserById(ownerContext.userId);
    if (!owner || owner.role === 'admin') return { allowed: true };
    const limit = getUserConcurrentContainerLimit(owner.id, owner.role);
    if (limit == null) return { allowed: true };
    // Count active runtimes for this user, including conversation workers.
    let userActive = 0;
    for (const runtime of queue.getRuntimeStatus().groups) {
      if (!runtime.active) continue;
      if (resolveRuntimeOwnerContext(runtime.jid)?.userId === owner.id) {
        userActive++;
      }
    }
    return { allowed: userActive < limit };
  });
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    broadcastNewMessage,
    sendMessage,
    assistantName: ASSISTANT_NAME,
    globalSleepDeps: {
      manager: memoryAgentManager,
      queue,
    },
  });
  startIpcWatcher();
  // Mark any turns that were running when the process crashed/restarted
  try {
    markStaleTurnsAsError();
  } catch (err) {
    logger.warn({ err }, 'Failed to recover stale turns');
  }
  turnManager.recoverOnStartup();
  recoverPendingMessages();
  startMessageLoop();

  // --- IM Connection Pool: connect per-user IM channels ---
  // Load global IM config (backward compat: used for admin if no per-user config exists)
  const globalFeishuConfig = getFeishuProviderConfigWithSource();
  const globalTelegramConfig = getTelegramProviderConfigWithSource();

  // Paginate through all active users (listUsers caps at 200 per page)
  let allActiveUsers: typeof listUsers extends (...args: any) => {
    users: infer U;
  }
    ? U
    : never = [];
  {
    let page = 1;
    while (true) {
      const result = listUsers({ status: 'active', page, pageSize: 200 });
      allActiveUsers = allActiveUsers.concat(result.users);
      if (allActiveUsers.length >= result.total) break;
      page++;
    }
  }

  // Register admin users for fallback IM routing
  for (const user of allActiveUsers) {
    if (user.role === 'admin') imManager.registerAdminUser(user.id);
  }

  let anyFeishuConnected = false;

  for (const user of allActiveUsers) {
    const homeGroup = getUserHomeGroup(user.id);
    if (!homeGroup) continue;

    // Per-user IM config takes precedence; fall back to global config for admin
    const userFeishu = getUserFeishuConfig(user.id);
    const userTelegram = getUserTelegramConfig(user.id);
    const userQQ = getUserQQConfig(user.id);
    const userWeChat = getUserWeChatConfig(user.id);

    // Determine effective Feishu config: per-user > global (admin only)
    let effectiveFeishu: FeishuConnectConfig | null = null;
    if (userFeishu && userFeishu.appId && userFeishu.appSecret) {
      effectiveFeishu = {
        appId: userFeishu.appId,
        appSecret: userFeishu.appSecret,
        enabled: userFeishu.enabled,
      };
    } else if (user.role === 'admin' && globalFeishuConfig.source !== 'none') {
      const gc = globalFeishuConfig.config;
      effectiveFeishu = {
        appId: gc.appId,
        appSecret: gc.appSecret,
        enabled: gc.enabled,
      };
    }

    // Determine effective Telegram config: per-user > global (admin only)
    let effectiveTelegram: TelegramConnectConfig | null = null;
    if (userTelegram && userTelegram.botToken) {
      effectiveTelegram = {
        botToken: userTelegram.botToken,
        proxyUrl: userTelegram.proxyUrl || globalTelegramConfig.config.proxyUrl,
        enabled: userTelegram.enabled,
      };
    } else if (
      user.role === 'admin' &&
      globalTelegramConfig.source !== 'none'
    ) {
      const gc = globalTelegramConfig.config;
      effectiveTelegram = {
        botToken: gc.botToken,
        proxyUrl: gc.proxyUrl,
        enabled: gc.enabled,
      };
    }

    // Determine effective QQ config: per-user only (no global fallback)
    let effectiveQQ: QQConnectConfig | null = null;
    if (userQQ && userQQ.appId && userQQ.appSecret) {
      effectiveQQ = {
        appId: userQQ.appId,
        appSecret: userQQ.appSecret,
        enabled: userQQ.enabled,
      };
    }

    // Determine effective WeChat config: per-user only (no global fallback)
    let effectiveWeChat: WeChatConnectConfig | null = null;
    if (userWeChat && userWeChat.botToken && userWeChat.ilinkBotId) {
      effectiveWeChat = {
        botToken: userWeChat.botToken,
        ilinkBotId: userWeChat.ilinkBotId,
        baseUrl: userWeChat.baseUrl,
        cdnBaseUrl: userWeChat.cdnBaseUrl,
        getUpdatesBuf: userWeChat.getUpdatesBuf,
        enabled: userWeChat.enabled,
      };
    }

    if (!effectiveFeishu && !effectiveTelegram && !effectiveQQ && !effectiveWeChat) continue;

    try {
      const result = await connectUserIMChannels(
        user.id,
        homeGroup.folder,
        effectiveFeishu,
        effectiveTelegram,
        effectiveQQ,
        effectiveWeChat,
      );
      if (result.feishu) anyFeishuConnected = true;
      logger.info(
        {
          userId: user.id,
          feishu: result.feishu,
          telegram: result.telegram,
          qq: result.qq,
          wechat: result.wechat,
        },
        'User IM channels connected',
      );
    } catch (err) {
      logger.error(
        { userId: user.id, err },
        'Failed to connect user IM channels',
      );
    }
  }

  // Clean up progress cards left over from previous process
  if (anyFeishuConnected) {
    cleanupStaleProgressCards(() => imManager.getAnyLarkClient()).catch((err) =>
      logger.warn({ err }, 'Failed to clean up stale progress cards'),
    );
  }

  // Start Feishu group sync if any connection is active
  if (anyFeishuConnected) {
    syncGroupMetadata().catch((err) =>
      logger.error({ err }, 'Initial group sync failed'),
    );
    feishuSyncInterval = setInterval(() => {
      syncGroupMetadata().catch((err) =>
        logger.error({ err }, 'Periodic group sync failed'),
      );
    }, GROUP_SYNC_INTERVAL_MS);
  } else if (
    globalFeishuConfig.config.enabled !== false &&
    globalFeishuConfig.source !== 'none'
  ) {
    logger.warn(
      'Feishu is not connected. Configure credentials in Settings to enable Feishu sync.',
    );
  }

  // Run health check once on startup to clean up orphaned bindings, then periodically
  void checkImBindingsHealth();
  const IM_BINDING_HEALTH_CHECK_INTERVAL = 30 * 60 * 1000; // 30 min
  setInterval(() => {
    void checkImBindingsHealth();
  }, IM_BINDING_HEALTH_CHECK_INTERVAL);
}

async function checkImBindingsHealth(): Promise<void> {
  const boundEntries = listSessionBindings()
    .map((binding) => {
      const group =
        registeredGroups[binding.channel_jid] ??
        getRegisteredGroup(binding.channel_jid);
      if (isImplicitDefaultSessionBinding(binding.channel_jid, group, binding)) {
        deleteSessionBinding(binding.channel_jid);
        return null;
      }
      return group
        ? { jid: binding.channel_jid, group, sessionId: binding.session_id }
        : null;
    })
    .filter(
      (
        entry,
      ): entry is {
        jid: string;
        group: RegisteredGroup;
        sessionId: string;
      } => entry !== null,
    );

  if (boundEntries.length === 0) return;
  logger.debug(
    { count: boundEntries.length },
    'Running IM binding health check',
  );

  for (const { jid, group, sessionId } of boundEntries) {
    const boundSession = getSessionRecord(sessionId);
    if (!boundSession) {
      unbindImGroup(jid, `Orphaned session binding: session ${sessionId} no longer exists`);
      continue;
    }

    const resolvedTarget = resolveBoundSessionTarget(jid, group);
    if (!resolvedTarget.effectiveJid) {
      unbindImGroup(
        jid,
        `Broken session binding: session ${sessionId} has no reachable target`,
      );
      continue;
    }

    try {
      const info = await imManager.getChatInfo(jid);
      if (info === null) {
        // Chat not reachable — could be temporary (connection down, API permission issue)
        const count = (imHealthCheckFailCounts.get(jid) ?? 0) + 1;
        imHealthCheckFailCounts.set(jid, count);
        if (count >= IM_HEALTH_CHECK_FAIL_THRESHOLD && shouldAutoUnbindOnFailure(jid)) {
          unbindImGroup(
            jid,
            'IM group not reachable after multiple checks, auto-unbinding',
          );
        } else if (count >= IM_HEALTH_CHECK_FAIL_THRESHOLD) {
          logger.warn({ jid, count }, 'IM health check threshold reached but auto-unbind disabled');
        } else {
          logger.debug(
            {
              jid,
              failCount: count,
              threshold: IM_HEALTH_CHECK_FAIL_THRESHOLD,
            },
            'IM health check failed, will retry before unbinding',
          );
        }
      } else {
        // Chat is reachable — reset failure counter
        imHealthCheckFailCounts.delete(jid);
      }
    } catch (err) {
      // API error — could be temporary, don't unbind on single failure
      logger.debug({ jid, err }, 'IM binding health check failed for group');
    }
  }
}

main().catch((err) => {
  logger.error({ err }, 'Failed to start happyclaw');
  process.exit(1);
});
