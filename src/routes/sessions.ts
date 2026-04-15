import crypto from 'crypto';
import { execFile } from 'child_process';
import fs from 'fs';
import net from 'node:net';
import path from 'path';
import { promisify } from 'util';

import { Hono } from 'hono';

import type { Variables } from '../web-context.js';
import { authMiddleware } from '../middleware/auth.js';
import agentRoutes from './agents.js';
import {
  canAccessGroup,
  canDeleteGroup,
  hasHostExecutionPermission,
  canModifyGroup,
  getWebDeps,
} from '../web-context.js';
import { ContainerEnvSchema, GroupCreateSchema } from '../schemas.js';
import {
  clearWorkerArtifactsForFolder,
  deleteChatHistory,
  deleteMessage,
  deleteGroupData,
  deleteRegisteredGroup,
  deleteRunnerProfile,
  deleteSessionBinding,
  deleteSession,
  ensureChatExists,
  getAllChats,
  getContextSummary,
  getJidsByFolder,
  getMessage,
  getMessageIdsWithTrace,
  getMessagesAfter,
  getMessagesAfterMulti,
  getMessagesPage,
  getMessagesPageMulti,
  getRegisteredGroup,
  getRunnerProfile,
  getSessionBinding,
  getSessionRecord,
  getSessionRuntimeState,
  getTurnByResultMessageId,
  getWorkerSessionRecord,
  listSessionBindings,
  listRunnerProfiles,
  listSessionRecords,
  saveRunnerProfile,
  saveSessionBinding,
  saveSessionRecord,
  searchMessages,
  countSearchResults,
  deleteSessionRuntimeState,
  setRegisteredGroup,
  storeMessageDirect,
  upsertSessionRuntimeState,
  updateSessionBindingPolicies,
  updateChatName,
} from '../db.js';
import {
  canServeAsMemoryRunner,
  explainRunnerDegradation,
  getDefaultRunnerId,
  getRunnerDescriptor,
  listRunnerDescriptors,
} from '../runner-registry.js';
import { compressContext, isCompressing } from '../context-compressor.js';
import { DATA_DIR, GROUPS_DIR } from '../config.js';
import {
  deleteRuntimeEnvConfig,
  getRuntimeEnvConfig,
  getSessionRuntimeEnvConfig,
  saveRuntimeEnvConfig,
  saveSessionRuntimeEnvConfig,
  toPublicRuntimeEnvConfig,
} from '../runtime-config.js';
import { executeSessionReset } from '../commands.js';
import { loadTurnTrace } from '../turn-trace.js';
import {
  findAllowedRoot,
  loadMountAllowlist,
  matchesBlockedPattern,
} from '../mount-security.js';
import { initializeWorkspaceFromLocalDirectory } from '../workspace-init.js';
import {
  buildWorkerConversationJid,
  buildWorkerSessionId,
  extractAgentIdFromWorkerSessionId,
} from '../worker-session.js';
import type {
  AuthUser,
  RegisteredGroup,
  RunnerProfileRecord,
  SessionRecord,
} from '../types.js';

const sessionRoutes = new Hono<{ Variables: Variables }>();
const execFileAsync = promisify(execFile);

function canManageRunnerProfiles(user: AuthUser): boolean {
  return user.role === 'admin';
}

function isPrivateHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  const cleaned = hostname.replace(/^\[|\]$/g, '');

  if (net.isIPv6(cleaned)) {
    const lower = cleaned.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fd') || lower.startsWith('fe80')) return true;
    if (lower.startsWith('::ffff:')) {
      return isPrivateIPv4(lower.slice(7));
    }
    return false;
  }

  if (net.isIPv4(cleaned)) {
    return isPrivateIPv4(cleaned);
  }

  return false;
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return false;
  const [a, b] = parts;
  if (a === 127) return true;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 0) return true;
  return false;
}

function getFolderForSession(session: SessionRecord): string {
  if (session.id.startsWith('main:')) return session.id.slice('main:'.length);
  if (session.parent_session_id?.startsWith('main:')) {
    return session.parent_session_id.slice('main:'.length);
  }
  return path.basename(session.cwd);
}

function resolveBackingJid(session: SessionRecord): string | null {
  if (!session.id.startsWith('main:')) return null;
  const folder = session.id.slice('main:'.length);
  return (
    getJidsByFolder(folder).find((jid) => jid.startsWith('web:')) ||
    `web:${folder}`
  );
}

function resolveSessionRouteAlias(id: string): string {
  const group = getRegisteredGroup(id);
  if (!group || !id.startsWith('web:')) return id;
  return `main:${group.folder}`;
}

function getSessionById(id: string): SessionRecord | undefined {
  return getSessionRecord(id) || getSessionRecord(resolveSessionRouteAlias(id));
}

function resolveSessionOrThrow(user: AuthUser, id: string): SessionRecord | null {
  const session = getSessionById(id);
  if (!session) return null;
  return canAccessSession(user, session) ? session : null;
}

function normalizeRegisteredRunnerId(
  raw: unknown,
): SessionRecord['runner_id'] | null {
  if (typeof raw !== 'string') return null;
  const runnerId = raw.trim();
  if (!runnerId) return null;
  return getRunnerDescriptor(runnerId)?.id ?? null;
}

function normalizeRunnerId(
  runnerId: unknown,
  llmProvider: unknown,
  fallback: SessionRecord['runner_id'],
): SessionRecord['runner_id'] {
  const normalizedRunnerId = normalizeRegisteredRunnerId(runnerId);
  if (normalizedRunnerId) return normalizedRunnerId;
  if (llmProvider === 'openai') return 'codex';
  if (llmProvider === 'claude') return 'claude';
  return fallback;
}

function mapLegacyLlmProvider(
  runnerId: SessionRecord['runner_id'],
  fallback?: RegisteredGroup['llm_provider'],
): RegisteredGroup['llm_provider'] | undefined {
  if (runnerId === 'codex') return 'openai';
  if (runnerId === 'claude') return 'claude';
  return fallback;
}

function normalizeSelectedSkills(
  raw: unknown,
): string[] | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (!Array.isArray(raw)) {
    throw new Error('selected_skills 必须是数组或 null');
  }
  if (raw.length > 200) {
    throw new Error('selected_skills 最多允许 200 项');
  }
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') {
      throw new Error('selected_skills 只能包含字符串');
    }
    const skillId = item.trim();
    if (!skillId || skillId.length > 128 || !/^[\w-]+$/.test(skillId)) {
      throw new Error(`非法 skill id: ${item}`);
    }
    out.push(skillId);
  }
  return out;
}

function normalizeActivationMode(
  raw: unknown,
): 'auto' | 'always' | 'when_mentioned' | 'disabled' | undefined {
  if (
    raw === 'auto' ||
    raw === 'always' ||
    raw === 'when_mentioned' ||
    raw === 'disabled'
  ) {
    return raw;
  }
  return undefined;
}

function resolveBackingGroupForSession(
  session: SessionRecord,
): { backingJid: string; backingGroup: NonNullable<ReturnType<typeof getRegisteredGroup>> } | null {
  const backingJid = resolveBackingJid(session);
  if (!backingJid) return null;
  const backingGroup = getRegisteredGroup(backingJid);
  if (!backingGroup) return null;
  return { backingJid, backingGroup };
}

function removeSessionArtifacts(folder: string): void {
  fs.rmSync(path.join(GROUPS_DIR, folder), { recursive: true, force: true });
  fs.rmSync(path.join(DATA_DIR, 'sessions', folder), {
    recursive: true,
    force: true,
  });
  fs.rmSync(path.join(DATA_DIR, 'ipc', folder), {
    recursive: true,
    force: true,
  });
  fs.rmSync(path.join(DATA_DIR, 'env', folder), {
    recursive: true,
    force: true,
  });
  fs.rmSync(path.join(DATA_DIR, 'memory', folder), {
    recursive: true,
    force: true,
  });
  deleteRuntimeEnvConfig(folder);
}

function annotateMessagesWithTrace(
  messages: Array<{ id: string; is_from_me: boolean; has_trace?: boolean }>,
): void {
  const aiMsgIds = messages
    .filter((message) => message.is_from_me)
    .map((message) => message.id);
  if (aiMsgIds.length === 0) return;
  const traceSet = getMessageIdsWithTrace(aiMsgIds);
  for (const message of messages) {
    if (traceSet.has(message.id)) {
      message.has_trace = true;
    }
  }
}

function resetWorkspaceForSession(folder: string): void {
  const groupDir = path.join(GROUPS_DIR, folder);
  fs.rmSync(groupDir, { recursive: true, force: true });
  fs.mkdirSync(groupDir, { recursive: true });

  fs.rmSync(path.join(DATA_DIR, 'sessions', folder), {
    recursive: true,
    force: true,
  });

  const ipcDir = path.join(DATA_DIR, 'ipc', folder);
  fs.rmSync(ipcDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(ipcDir, 'input'), { recursive: true });
  fs.mkdirSync(path.join(ipcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(ipcDir, 'tasks'), { recursive: true });

  fs.rmSync(path.join(DATA_DIR, 'memory', folder), {
    recursive: true,
    force: true,
  });
}

function validateRunnerProfile(
  runnerProfileId: string | null,
  runnerId: SessionRecord['runner_id'],
): string | null {
  if (!runnerProfileId) return null;
  const profile = getRunnerProfile(runnerProfileId);
  if (!profile) {
    throw new Error('runner_profile_id 不存在');
  }
  if (profile.runner_id !== runnerId) {
    throw new Error('runner_profile_id 与 runner_id 不匹配');
  }
  return runnerProfileId;
}

function normalizeSessionCwd(
  requestedCwd: string,
): string {
  if (!path.isAbsolute(requestedCwd)) {
    throw new Error('cwd 必须是绝对路径');
  }

  let realPath: string;
  try {
    realPath = fs.realpathSync(requestedCwd);
  } catch {
    throw new Error('cwd 不存在或无法解析');
  }
  if (!fs.statSync(realPath).isDirectory()) {
    throw new Error('cwd 必须是目录');
  }

  const allowlist = loadMountAllowlist();
  if (allowlist?.allowedRoots?.length) {
    const allowedRoot = findAllowedRoot(realPath, allowlist.allowedRoots);
    if (!allowedRoot) {
      const allowedPaths = allowlist.allowedRoots.map((root) => root.path).join(', ');
      throw new Error(
        `cwd 不在允许目录内。允许根目录: ${allowedPaths}`,
      );
    }
    const blockedMatch = matchesBlockedPattern(
      realPath,
      allowlist.blockedPatterns,
    );
    if (blockedMatch) {
      throw new Error(`cwd 命中了禁止规则 "${blockedMatch}"`);
    }
  }

  return realPath;
}

function toPublicRuntimeEnvForUser(
  config: ReturnType<typeof getRuntimeEnvConfig>,
  user: AuthUser,
) {
  const base = toPublicRuntimeEnvConfig(config);
  if (
    user.role === 'admin' ||
    (user.permissions && user.permissions.includes('manage_group_env'))
  ) {
    return base;
  }
  return {
    ...base,
    customEnv: {},
    codexCustomEnv: {},
  };
}

function syncRegisteredGroupCache(jid: string, group: RegisteredGroup): void {
  const deps = getWebDeps();
  if (!deps) return;
  const groups = deps.getRegisteredGroups();
  if (groups[jid]) groups[jid] = group;
}

function buildCompatibilityGroupForSession(
  session: SessionRecord,
  options: {
    folder: string;
    addedAt: string;
    ownerKey: string | null;
    initSourcePath?: string;
    initGitUrl?: string;
    existing?: RegisteredGroup | null;
    selectedSkills?: string[] | null;
    activationMode?: RegisteredGroup['activation_mode'];
  },
): RegisteredGroup {
  const existing = options.existing ?? undefined;
  const defaultCwd = path.join(GROUPS_DIR, options.folder);
  return {
    ...existing,
    name: session.name,
    folder: options.folder,
    added_at: existing?.added_at || options.addedAt,
    executionMode: 'local',
    initSourcePath: options.initSourcePath ?? existing?.initSourcePath,
    initGitUrl: options.initGitUrl ?? existing?.initGitUrl,
    created_by: options.ownerKey ?? existing?.created_by,
    is_home: session.kind === 'main' ? true : existing?.is_home,
    llm_provider: mapLegacyLlmProvider(session.runner_id, existing?.llm_provider),
    model: session.model ?? undefined,
    thinking_effort: session.thinking_effort ?? undefined,
    context_compression: session.context_compression,
    knowledge_extraction: session.knowledge_extraction,
    customCwd:
      path.resolve(session.cwd) === path.resolve(defaultCwd)
        ? undefined
        : session.cwd,
    selected_skills:
      options.selectedSkills !== undefined
        ? options.selectedSkills
        : existing?.selected_skills,
    activation_mode:
      options.activationMode !== undefined
        ? options.activationMode
        : existing?.activation_mode,
  };
}

function buildUpdatedImGroupForSessionBinding(
  imGroup: RegisteredGroup,
  targetSession: SessionRecord | null,
  options: {
    replyPolicy?: 'source_only' | 'mirror';
    activationMode?: 'auto' | 'always' | 'when_mentioned' | 'disabled';
    requireMention?: boolean;
  },
): RegisteredGroup {
  const nextActivationMode =
    options.activationMode !== undefined
      ? options.activationMode
      : targetSession
        ? (imGroup.activation_mode === 'disabled' ? 'auto' : imGroup.activation_mode)
        : 'disabled';
  const updated: RegisteredGroup = {
    ...imGroup,
    reply_policy: options.replyPolicy ?? imGroup.reply_policy,
    activation_mode: nextActivationMode,
    require_mention:
      options.requireMention !== undefined
        ? options.requireMention
        : imGroup.require_mention,
    target_agent_id: undefined,
    target_main_jid: undefined,
  };

  const defaultSessionId = `main:${imGroup.folder}`;
  if (!targetSession || targetSession.id === defaultSessionId) return updated;

  if (targetSession.kind === 'worker') {
    const worker = getWorkerSessionRecord(targetSession.id);
    const agentId = extractAgentIdFromWorkerSessionId(targetSession.id) || '';
    if (!worker || worker.kind !== 'conversation' || !agentId) {
      throw new Error('Only conversation worker sessions can bind IM channels');
    }
    return updated;
  }

  if (targetSession.kind === 'main' || targetSession.kind === 'workspace') {
    return updated;
  }

  throw new Error('Memory session does not support IM binding');
}

function isImplicitDefaultSessionBinding(
  imGroup: RegisteredGroup,
  binding: ReturnType<typeof getSessionBinding> | undefined,
): boolean {
  return !!binding
    && binding.session_id === `main:${imGroup.folder}`;
}

function getExplicitSessionBinding(
  channelJid: string,
  imGroup: RegisteredGroup,
): ReturnType<typeof getSessionBinding> | undefined {
  const binding = getSessionBinding(channelJid);
  return isImplicitDefaultSessionBinding(imGroup, binding) ? undefined : binding;
}

function syncExplicitSessionBinding(
  channelJid: string,
  imGroup: RegisteredGroup,
  sessionId: string | null,
  options: {
    replyPolicy?: 'source_only' | 'mirror';
    activationMode?: 'auto' | 'always' | 'when_mentioned' | 'disabled';
    requireMention?: boolean;
  },
): void {
  const now = new Date().toISOString();
  const current = getSessionBinding(channelJid);
  const nextReplyPolicy = options.replyPolicy ?? imGroup.reply_policy ?? 'source_only';
  const nextActivationMode = options.activationMode ?? imGroup.activation_mode ?? 'auto';
  const nextRequireMention =
    options.requireMention !== undefined
      ? options.requireMention
      : imGroup.require_mention === true;

  if (!sessionId) {
    deleteSessionBinding(channelJid);
    return;
  }

  const session = getSessionRecord(sessionId);
  saveSessionBinding({
    channel_jid: channelJid,
    session_id: sessionId,
    binding_mode:
      nextReplyPolicy === 'mirror'
        ? 'mirror'
        : session?.kind === 'worker'
          ? 'direct'
          : 'source_only',
    activation_mode: nextActivationMode,
    require_mention: nextRequireMention,
    display_name: imGroup.name,
    reply_policy: nextReplyPolicy,
    created_at: current?.created_at || imGroup.added_at || now,
    updated_at: now,
  });
}

function buildSessionPayload(
  user: AuthUser,
  session: SessionRecord,
  bindings: ReturnType<typeof listSessionBindings>,
  latestMessages: Map<string, { content: string; timestamp: string }>,
  chatsByJid: Map<string, { jid: string; name?: string | null; last_message_time?: string | null }>,
) {
  const sessionBindings = bindings.filter(
    (binding) => binding.session_id === session.id,
  );
  const relevantJids = getRelevantChatJids(session, bindings);
  let latestAt: string | undefined;
  let lastMessage: string | undefined;
  for (const jid of relevantJids) {
    const latest = latestMessages.get(jid);
    const chatMeta = chatsByJid.get(jid);
    const candidateTs = latest?.timestamp || chatMeta?.last_message_time || undefined;
    if (!candidateTs) continue;
    if (!latestAt || candidateTs > latestAt) {
      latestAt = candidateTs;
      lastMessage = latest?.content;
    }
  }

  const backingJid = resolveBackingJid(session);
  const descriptor = getRunnerDescriptor(session.runner_id);
  const summary = backingJid ? getContextSummary(getFolderForSession(session), backingJid) : null;
  const backingGroup = backingJid ? getRegisteredGroup(backingJid) : undefined;
  const uniformActivationMode =
    sessionBindings.length > 0 &&
    sessionBindings.every(
      (binding) => binding.activation_mode === sessionBindings[0].activation_mode,
    )
      ? sessionBindings[0].activation_mode
      : null;

  return {
    id: session.id,
    name: session.name,
    folder: getFolderForSession(session),
    added_at: session.created_at,
    updated_at: session.updated_at,
    kind: session.kind,
    session_kind: session.kind,
    editable: session.kind === 'main' || session.kind === 'workspace',
    deletable:
      !!backingJid &&
      !!backingGroup &&
      canDeleteGroup(user, { ...backingGroup, jid: backingJid }),
    custom_cwd: session.cwd,
    cwd: session.cwd,
    backing_jid: backingJid,
    owner_key: session.owner_key,
    runner_id: session.runner_id,
    runner_profile_id: session.runner_profile_id,
    llm_provider: mapLegacyLlmProvider(session.runner_id, backingGroup?.llm_provider),
    model: session.model,
    thinking_effort: session.thinking_effort,
    context_compression: session.context_compression,
    knowledge_extraction: session.knowledge_extraction,
    binding_count: sessionBindings.length,
    binding_summary:
      sessionBindings.length > 0
        ? sessionBindings
            .map((binding) => binding.display_name || binding.channel_jid)
            .slice(0, 3)
            .join('、')
        : '无渠道绑定',
    bound_channels: sessionBindings.map((binding) => binding.channel_jid),
    lastMessage,
    lastMessageTime: latestAt,
    runner_label: descriptor?.label || session.runner_id,
    compatibility: descriptor?.compatibility || null,
    degradation_reasons: descriptor ? explainRunnerDegradation(descriptor) : [],
    has_summary: !!summary,
    summary_created_at: summary?.created_at ?? null,
    pinned_at: session.is_pinned ? session.updated_at : undefined,
    selected_skills: backingGroup?.selected_skills ?? null,
    activation_mode:
      uniformActivationMode || backingGroup?.activation_mode || 'auto',
  };
}

function canAccessSession(user: AuthUser, session: SessionRecord): boolean {
  if (session.kind === 'memory') {
    return user.role === 'admin' || session.owner_key === user.id;
  }

  if (session.kind === 'worker') {
    const worker = getWorkerSessionRecord(session.id);
    if (!worker) return false;
    const sourceGroup = getRegisteredGroup(worker.source_chat_jid);
    return !!sourceGroup && canAccessGroup(user, { ...sourceGroup, jid: worker.source_chat_jid });
  }

  const backingJid = resolveBackingJid(session);
  if (!backingJid) return false;
  const group = getRegisteredGroup(backingJid);
  return !!group && canAccessGroup(user, { ...group, jid: backingJid });
}

function getRelevantChatJids(
  session: SessionRecord,
  bindings = listSessionBindings(),
): string[] {
  const sessionBindings = bindings
    .filter((binding) => binding.session_id === session.id)
    .map((binding) => binding.channel_jid);

  if (session.kind === 'worker') {
    const worker = getWorkerSessionRecord(session.id);
    const agentId = extractAgentIdFromWorkerSessionId(session.id) || '';
    const chats = worker
      ? [buildWorkerConversationJid(worker.source_chat_jid, agentId), ...sessionBindings]
      : sessionBindings;
    return Array.from(new Set(chats));
  }

  if (session.id.startsWith('main:')) {
    const folder = session.id.slice('main:'.length);
    return Array.from(new Set([...getJidsByFolder(folder), ...sessionBindings]));
  }

  return sessionBindings;
}

function getWorkerRuntimeJids(parentSessionId: string): string[] {
  const queueJids = listSessionRecords()
    .filter((candidate) => candidate.parent_session_id === parentSessionId)
    .flatMap((candidate) => {
      const worker = getWorkerSessionRecord(candidate.id);
      const agentId = extractAgentIdFromWorkerSessionId(candidate.id) || '';
      if (!worker || !agentId) return [];
      return [buildWorkerSessionId(agentId)];
    });
  return Array.from(new Set(queueJids));
}

function parseSessionStateJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function persistPermissionModeSnapshot(
  sessionId: string,
  mode: 'bypassPermissions' | 'plan',
): void {
  const current = getSessionRuntimeState(sessionId);
  upsertSessionRuntimeState(sessionId, {
    providerSessionId: current?.provider_session_id || undefined,
    resumeAnchor: current?.resume_anchor || undefined,
    providerState: parseSessionStateJson<Record<string, unknown> | undefined>(
      current?.provider_state_json,
      undefined,
    ),
    recentImChannels: parseSessionStateJson<string[]>(
      current?.recent_im_channels_json,
      [],
    ),
    imChannelLastSeen: parseSessionStateJson<Record<string, number>>(
      current?.im_channel_last_seen_json,
      {},
    ),
    currentPermissionMode: mode,
    lastMessageCursor: current?.last_message_cursor ?? null,
  });
}

function buildBindingTargets(user: AuthUser) {
  const sessions = listSessionRecords().filter((session) =>
    canAccessSession(user, session),
  );

  const targets: Array<{
    type: 'main' | 'agent';
    session_id: string;
    groupJid: string;
    groupName: string;
    session_kind: SessionRecord['kind'];
    agentId?: string;
    agentName?: string;
  }> = [];

  for (const session of sessions) {
    if (session.kind === 'worker') {
      const worker = getWorkerSessionRecord(session.id);
      if (!worker || worker.kind !== 'conversation') continue;
      const parent = sessions.find((item) => item.id === session.parent_session_id);
      const parentBackingJid =
        (parent && resolveBackingJid(parent)) || resolveBackingJid(session);
      if (!parentBackingJid) continue;
      targets.push({
        type: 'agent',
        session_id: session.id,
        groupJid: parentBackingJid,
        groupName: parent?.name || worker.name,
        session_kind: session.kind,
        agentId:
          extractAgentIdFromWorkerSessionId(session.id) || worker.session_id,
        agentName: worker.name,
      });
      continue;
    }

    if (session.kind !== 'main' && session.kind !== 'workspace') continue;
    const backingJid = resolveBackingJid(session);
    if (!backingJid) continue;
    targets.push({
      type: 'main',
      session_id: session.id,
      groupJid: backingJid,
      groupName: session.name,
      session_kind: session.kind,
    });
  }

  targets.sort((a, b) => {
    if (a.groupName !== b.groupName) return a.groupName.localeCompare(b.groupName);
    if (a.type !== b.type) return a.type === 'main' ? -1 : 1;
    return (a.agentName || '').localeCompare(b.agentName || '');
  });
  return targets;
}

sessionRoutes.get('/binding-targets', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  return c.json({ targets: buildBindingTargets(user) });
});

sessionRoutes.put('/bindings/:channelJid', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const channelJid = decodeURIComponent(c.req.param('channelJid'));
  const imGroup = getRegisteredGroup(channelJid);
  if (!imGroup) return c.json({ error: 'IM group not found' }, 404);
  if (channelJid.startsWith('web:')) {
    return c.json(
      { error: 'Session bindings only support IM channels, not web session JIDs' },
      400,
    );
  }
  if (!canAccessGroup(user, { ...imGroup, jid: channelJid })) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const replyPolicy =
    body.reply_policy === 'mirror'
      ? 'mirror'
      : body.reply_policy === 'source_only'
        ? 'source_only'
        : undefined;
  const activationMode = normalizeActivationMode(body.activation_mode);
  const requireMention =
    typeof body.require_mention === 'boolean'
      ? body.require_mention
      : undefined;
  const currentBinding = getExplicitSessionBinding(channelJid, imGroup);

  let targetSession: SessionRecord | null = null;
  if (body.unbind !== true) {
    const requestedSessionId =
      typeof body.session_id === 'string' && body.session_id.trim()
        ? body.session_id.trim()
        : currentBinding?.session_id || `main:${imGroup.folder}`;
    targetSession = resolveSessionOrThrow(user, requestedSessionId);
    if (!targetSession && requestedSessionId !== `main:${imGroup.folder}`) {
      return c.json({ error: 'Target session not found' }, 404);
    }
  }

  try {
    const updated = buildUpdatedImGroupForSessionBinding(imGroup, targetSession, {
      replyPolicy,
      activationMode,
      requireMention,
    });
    setRegisteredGroup(channelJid, updated);
    syncRegisteredGroupCache(channelJid, updated);
    const explicitSessionId =
      targetSession
      && targetSession.id !== `main:${updated.folder}`
        ? targetSession.id
        : null;
    syncExplicitSessionBinding(channelJid, updated, explicitSessionId, {
      replyPolicy,
      activationMode,
      requireMention,
    });
    return c.json({
      success: true,
      binding: getExplicitSessionBinding(channelJid, updated) || null,
    });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : 'Failed to update binding' },
      400,
    );
  }
});

sessionRoutes.get('/runners', authMiddleware, (c) => {
  const runners = listRunnerDescriptors().map((descriptor) => ({
    id: descriptor.id,
    label: descriptor.label,
    capabilities: descriptor.capabilities,
    lifecycle: descriptor.lifecycle,
    prompt_contract: descriptor.promptContract,
    compatibility: descriptor.compatibility,
    can_serve_memory: canServeAsMemoryRunner(descriptor),
    degradation_reasons: explainRunnerDegradation(descriptor),
  }));
  return c.json({ runners });
});

sessionRoutes.get('/runner-profiles', authMiddleware, (c) => {
  const runnerId = normalizeRegisteredRunnerId(c.req.query('runner_id'));
  const profiles = listRunnerProfiles(
    runnerId || undefined,
  ).map((profile) => ({
    id: profile.id,
    runner_id: profile.runner_id,
    name: profile.name,
    config_json: profile.config_json,
    is_default: profile.is_default,
    created_at: profile.created_at,
    updated_at: profile.updated_at,
  }));
  return c.json({ profiles });
});

sessionRoutes.post('/runner-profiles', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  if (!canManageRunnerProfiles(user)) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const runnerId = normalizeRegisteredRunnerId(body.runner_id);
  if (!runnerId) {
    return c.json({ error: 'runner_id 必须是已注册 runner id' }, 400);
  }
  const rawName = typeof body.name === 'string' ? body.name.trim() : '';
  if (!rawName) {
    return c.json({ error: 'name 不能为空' }, 400);
  }
  let configJson = '{}';
  if (typeof body.config_json === 'string' && body.config_json.trim()) {
    try {
      JSON.parse(body.config_json);
      configJson = body.config_json.trim();
    } catch {
      return c.json({ error: 'config_json 必须是合法 JSON' }, 400);
    }
  }
  const now = new Date().toISOString();
  const profile: RunnerProfileRecord = {
    id: crypto.randomUUID(),
    runner_id: runnerId,
    name: rawName.slice(0, 100),
    config_json: configJson,
    is_default: body.is_default === true,
    created_at: now,
    updated_at: now,
  };
  saveRunnerProfile(profile);
  return c.json({ success: true, profile: getRunnerProfile(profile.id) });
});

sessionRoutes.patch('/runner-profiles/:id', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  if (!canManageRunnerProfiles(user)) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  const id = decodeURIComponent(c.req.param('id'));
  const existing = getRunnerProfile(id);
  if (!existing) return c.json({ error: 'Profile not found' }, 404);

  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const runnerId = normalizeRegisteredRunnerId(body.runner_id) || existing.runner_id;
  const nextName =
    typeof body.name === 'string' && body.name.trim()
      ? body.name.trim().slice(0, 100)
      : existing.name;
  let nextConfigJson = existing.config_json;
  if (typeof body.config_json === 'string') {
    const trimmed = body.config_json.trim() || '{}';
    try {
      JSON.parse(trimmed);
      nextConfigJson = trimmed;
    } catch {
      return c.json({ error: 'config_json 必须是合法 JSON' }, 400);
    }
  }

  saveRunnerProfile({
    ...existing,
    runner_id: runnerId,
    name: nextName,
    config_json: nextConfigJson,
    is_default: body.is_default === true ? true : body.is_default === false ? false : existing.is_default,
    updated_at: new Date().toISOString(),
  });
  return c.json({ success: true, profile: getRunnerProfile(id) });
});

sessionRoutes.delete('/runner-profiles/:id', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  if (!canManageRunnerProfiles(user)) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  const id = decodeURIComponent(c.req.param('id'));
  const existing = getRunnerProfile(id);
  if (!existing) return c.json({ error: 'Profile not found' }, 404);
  deleteRunnerProfile(id);
  return c.json({ success: true });
});

sessionRoutes.post('/', authMiddleware, async (c) => {
  const deps = getWebDeps();
  if (!deps) return c.json({ error: 'Server not initialized' }, 500);

  const user = c.get('user') as AuthUser;
  const body = await c.req.json().catch(() => ({}));
  const validation = GroupCreateSchema.safeParse(body);
  if (!validation.success) {
    return c.json({ error: 'Invalid request body' }, 400);
  }

  const name = validation.data.name.trim().slice(0, 100);
  if (!name) {
    return c.json({ error: 'Session name is required' }, 400);
  }

  const customCwd = validation.data.custom_cwd;
  if (customCwd) {
    return c.json(
      {
        error:
          'custom_cwd has moved to session settings. New sessions no longer accept it at creation time.',
      },
      400,
    );
  }

  if (
    body &&
    typeof body === 'object' &&
    Object.prototype.hasOwnProperty.call(body, 'execution_mode')
  ) {
    return c.json(
      {
        error:
          'execution_mode has been removed. New sessions always use the unified local runtime.',
      },
      400,
    );
  }

  const initSourcePath = validation.data.init_source_path;
  const initGitUrl = validation.data.init_git_url;
  if (initSourcePath && initGitUrl) {
    return c.json(
      { error: 'init_source_path and init_git_url are mutually exclusive' },
      400,
    );
  }

  if (initSourcePath) {
    if (!hasHostExecutionPermission(user)) {
      return c.json(
        { error: 'Insufficient permissions: init_source_path requires admin' },
        403,
      );
    }
    if (!path.isAbsolute(initSourcePath)) {
      return c.json({ error: 'init_source_path must be an absolute path' }, 400);
    }
    let realPath: string;
    try {
      const stat = fs.statSync(initSourcePath);
      if (!stat.isDirectory()) {
        return c.json(
          { error: 'init_source_path must be an existing directory' },
          400,
        );
      }
      realPath = fs.realpathSync(initSourcePath);
    } catch {
      return c.json(
        { error: 'init_source_path directory does not exist' },
        400,
      );
    }
    const allowlist = loadMountAllowlist();
    if (allowlist?.allowedRoots?.length) {
      const allowedRoot = findAllowedRoot(realPath, allowlist.allowedRoots);
      if (!allowedRoot) {
        const allowedPaths = allowlist.allowedRoots.map((root) => root.path).join(', ');
        return c.json(
          {
            error: `init_source_path must be under an allowed root. Allowed roots: ${allowedPaths}. Check config/mount-allowlist.json`,
          },
          403,
        );
      }
      const blockedMatch = matchesBlockedPattern(
        realPath,
        allowlist.blockedPatterns,
      );
      if (blockedMatch) {
        return c.json(
          {
            error: `init_source_path matches blocked pattern "${blockedMatch}"`,
          },
          403,
        );
      }
    }
  }

  if (initGitUrl) {
    if (!hasHostExecutionPermission(user)) {
      return c.json(
        { error: 'Insufficient permissions: init_git_url requires admin' },
        403,
      );
    }
    if (initGitUrl.length > 2000) {
      return c.json(
        { error: 'init_git_url is too long (max 2000 characters)' },
        400,
      );
    }
    let gitUrl: URL;
    try {
      gitUrl = new URL(initGitUrl);
    } catch {
      return c.json({ error: 'init_git_url is not a valid URL' }, 400);
    }
    if (gitUrl.protocol !== 'https:') {
      return c.json({ error: 'init_git_url must use https protocol' }, 400);
    }
    if (isPrivateHostname(gitUrl.hostname)) {
      return c.json(
        { error: 'init_git_url must not point to a private/internal address' },
        400,
      );
    }
  }

  const backingJid = `web:${crypto.randomUUID()}`;
  const folder = `flow-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const now = new Date().toISOString();
  const sessionDir = path.join(GROUPS_DIR, folder);
  try {
    if (initSourcePath) {
      await initializeWorkspaceFromLocalDirectory(initSourcePath, sessionDir);
    } else if (initGitUrl) {
      await execFileAsync(
        'git',
        ['clone', '--depth', '1', initGitUrl, sessionDir],
        { timeout: 120_000 },
      );
    }
  } catch (err) {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    deleteRegisteredGroup(backingJid);
    delete deps.getRegisteredGroups()[backingJid];
    return c.json(
      {
        error: `Session initialization failed: ${err instanceof Error ? err.message : String(err)}`,
      },
      500,
    );
  }

  const createdSession: SessionRecord = {
    id: `main:${folder}`,
    name,
    kind: 'workspace',
    parent_session_id: null,
    cwd: sessionDir,
    runner_id: getDefaultRunnerId(),
    runner_profile_id: null,
    runtime_mode: 'local',
    model: null,
    thinking_effort: null,
    context_compression: 'off',
    knowledge_extraction: false,
    is_pinned: false,
    archived: false,
    owner_key: user.id,
    created_at: now,
    updated_at: now,
  };
  saveSessionRecord(createdSession);

  const backingGroup = buildCompatibilityGroupForSession(createdSession, {
    folder,
    addedAt: now,
    ownerKey: user.id,
    initSourcePath,
    initGitUrl,
  });
  setRegisteredGroup(backingJid, backingGroup);
  updateChatName(backingJid, name);
  deps.getRegisteredGroups()[backingJid] = backingGroup;

  const payload = buildSessionPayload(
    user,
    createdSession,
    listSessionBindings(),
    new Map(),
    new Map(getAllChats().map((chat) => [chat.jid, chat])),
  );

  return c.json({
    success: true,
    jid: createdSession.id,
    group: payload,
    session: payload,
  });
});

sessionRoutes.get('/', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const sessions = listSessionRecords().filter((session) =>
    canAccessSession(user, session),
  );
  const bindings = listSessionBindings();
  const chatsByJid = new Map(getAllChats().map((chat) => [chat.jid, chat]));

  const allRelevantJids = Array.from(
    new Set(sessions.flatMap((session) => getRelevantChatJids(session, bindings))),
  );
  const latestMessages = new Map<string, { content: string; timestamp: string }>();
  if (allRelevantJids.length > 0) {
    const rows = getMessagesPageMulti(
      allRelevantJids,
      undefined,
      Math.max(allRelevantJids.length * 3, 30),
    );
    for (const row of rows) {
      if (!latestMessages.has(row.chat_jid)) {
        latestMessages.set(row.chat_jid, {
          content: row.content,
          timestamp: row.timestamp,
        });
      }
    }
  }

  const payload: Record<string, Record<string, unknown>> = {};
  for (const session of sessions) {
    payload[session.id] = buildSessionPayload(
      user,
      session,
      bindings,
      latestMessages,
      chatsByJid,
    );
  }

  return c.json({
    sessions: payload,
    groups: payload,
  });
});

sessionRoutes.get('/:id', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const id = decodeURIComponent(c.req.param('id'));
  const session = resolveSessionOrThrow(user, id);
  if (!session) return c.json({ error: 'Session not found' }, 404);

  const bindings = listSessionBindings();
  const chatsByJid = new Map(getAllChats().map((chat) => [chat.jid, chat]));
  const relevantJids = getRelevantChatJids(session, bindings);
  const latestMessages = new Map<string, { content: string; timestamp: string }>();
  if (relevantJids.length > 0) {
    const rows = getMessagesPageMulti(relevantJids, undefined, Math.max(relevantJids.length * 3, 30));
    for (const row of rows) {
      if (!latestMessages.has(row.chat_jid)) {
        latestMessages.set(row.chat_jid, {
          content: row.content,
          timestamp: row.timestamp,
        });
      }
    }
  }

  return c.json({
    session: buildSessionPayload(user, session, bindings, latestMessages, chatsByJid),
  });
});

sessionRoutes.patch('/:id', authMiddleware, async (c) => {
  const deps = getWebDeps();
  if (!deps) return c.json({ error: 'Server not initialized' }, 500);

  const user = c.get('user') as AuthUser;
  const id = decodeURIComponent(c.req.param('id'));
  const existing = resolveSessionOrThrow(user, id);
  if (!existing) return c.json({ error: 'Session not found' }, 404);
  if (existing.kind === 'worker') {
    return c.json({ error: 'Worker session is read-only' }, 400);
  }

  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(body, 'runtime_mode')) {
    return c.json(
      {
        error:
          'runtime_mode has been removed. Sessions always use the unified local runtime.',
      },
      400,
    );
  }
  const now = new Date().toISOString();

  const nextName =
    typeof body.name === 'string' && body.name.trim()
      ? body.name.trim().slice(0, 100)
      : existing.name;
  let nextRunnerId: SessionRecord['runner_id'];
  let nextRunnerProfileId: string | null;
  let nextSelectedSkills: string[] | null | undefined;
  let nextActivationMode: 'auto' | 'always' | 'when_mentioned' | 'disabled' | undefined;
  let validatedRunnerProfileId: string | null;
  try {
    nextRunnerId = normalizeRunnerId(
      body.runner_id,
      body.llm_provider,
      existing.runner_id,
    );
    nextRunnerProfileId =
      typeof body.runner_profile_id === 'string' && body.runner_profile_id.trim()
        ? body.runner_profile_id.trim()
        : body.runner_profile_id === null
          ? null
          : existing.runner_profile_id;
    nextSelectedSkills = normalizeSelectedSkills(body.selected_skills);
    nextActivationMode = normalizeActivationMode(body.activation_mode);
    validatedRunnerProfileId = validateRunnerProfile(
      nextRunnerProfileId,
      nextRunnerId,
    );
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : 'Invalid request body' },
      400,
    );
  }
  const nextModel =
    typeof body.model === 'string'
      ? body.model.trim() || null
      : body.model === null
        ? null
        : existing.model;
  const nextThinkingEffort =
    body.thinking_effort === 'low' ||
    body.thinking_effort === 'medium' ||
    body.thinking_effort === 'high'
      ? body.thinking_effort
      : body.thinking_effort === null
        ? null
        : existing.thinking_effort;
  const nextContextCompression =
    body.context_compression === 'off' ||
    body.context_compression === 'auto' ||
    body.context_compression === 'manual'
      ? body.context_compression
      : existing.context_compression;
  const nextKnowledgeExtraction =
    typeof body.knowledge_extraction === 'boolean'
      ? body.knowledge_extraction
      : existing.knowledge_extraction;
  const nextPinned =
    typeof body.is_pinned === 'boolean' ? body.is_pinned : existing.is_pinned;
  const requestedCwd =
    typeof body.cwd === 'string' && body.cwd.trim()
      ? body.cwd.trim()
      : undefined;
  const runnerChanged = nextRunnerId !== existing.runner_id;

  if (existing.kind === 'memory') {
    if (requestedCwd !== undefined) {
      return c.json({ error: 'Memory session does not support cwd override' }, 400);
    }
    if (nextSelectedSkills !== undefined || nextActivationMode !== undefined) {
      return c.json({ error: 'Memory session does not support binding policy fields' }, 400);
    }
    const memoryRunnerDescriptor = getRunnerDescriptor(nextRunnerId);
    if (!memoryRunnerDescriptor || !canServeAsMemoryRunner(memoryRunnerDescriptor)) {
      return c.json(
        { error: `Runner "${nextRunnerId}" cannot serve as memory runner` },
        400,
      );
    }
    saveSessionRecord({
      ...existing,
      name: nextName,
      runner_id: nextRunnerId,
      runner_profile_id: validatedRunnerProfileId,
      model: nextModel,
      thinking_effort: nextThinkingEffort,
      context_compression: nextContextCompression,
      knowledge_extraction: nextKnowledgeExtraction,
      is_pinned: nextPinned,
      updated_at: now,
    });
    if (nextRunnerId !== existing.runner_id) {
      deleteSessionRuntimeState(existing.id);
    }
  } else {
    const resolvedBacking = resolveBackingGroupForSession(existing);
    if (!resolvedBacking) {
      return c.json({ error: 'Session has no backing group' }, 400);
    }
    const { backingJid, backingGroup } = resolvedBacking;
    if (!backingGroup || !canModifyGroup(user, { ...backingGroup, jid: backingJid })) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    if (runnerChanged) {
      try {
        await deps.queue.stopSession(backingJid, { force: true });
      } catch (err) {
        return c.json(
          {
            error: `切换 runner 前停止旧 runtime 失败: ${
              err instanceof Error ? err.message : String(err)
            }`,
          },
          500,
        );
      }
    }

    const defaultCwd = path.join(GROUPS_DIR, backingGroup.folder);
    let nextCwd = existing.cwd;
    if (requestedCwd) {
      try {
        nextCwd = normalizeSessionCwd(requestedCwd);
      } catch (err) {
        return c.json(
          { error: err instanceof Error ? err.message : 'Invalid cwd' },
          400,
        );
      }
    }

    const updatedSession: SessionRecord = {
      ...existing,
      name: nextName,
      cwd: nextCwd,
      runner_id: nextRunnerId,
      runner_profile_id: validatedRunnerProfileId,
      model: nextModel,
      thinking_effort: nextThinkingEffort,
      context_compression: nextContextCompression,
      knowledge_extraction: nextKnowledgeExtraction,
      is_pinned: nextPinned,
      updated_at: now,
    };
    saveSessionRecord(updatedSession);
    if (runnerChanged) {
      deleteSessionRuntimeState(existing.id);
    }

    const updatedGroup = buildCompatibilityGroupForSession(updatedSession, {
      folder: backingGroup.folder,
      addedAt: backingGroup.added_at,
      ownerKey: updatedSession.owner_key,
      existing: backingGroup,
      selectedSkills:
        nextSelectedSkills !== undefined
          ? nextSelectedSkills
          : backingGroup.selected_skills,
      activationMode:
        nextActivationMode !== undefined
          ? nextActivationMode
          : backingGroup.activation_mode,
    });
    setRegisteredGroup(backingJid, updatedGroup);
    deps.getRegisteredGroups()[backingJid] = updatedGroup;
    if (nextActivationMode !== undefined) {
      updateSessionBindingPolicies(existing.id, {
        activation_mode: nextActivationMode,
      });
    }
    updateChatName(backingJid, nextName);
  }

  const session = getSessionById(id);
  if (!session) return c.json({ error: 'Session not found after update' }, 500);
  const bindings = listSessionBindings();
  const chatsByJid = new Map(getAllChats().map((chat) => [chat.jid, chat]));
  const relevantJids = getRelevantChatJids(session, bindings);
  const latestMessages = new Map<string, { content: string; timestamp: string }>();
  if (relevantJids.length > 0) {
    const rows = getMessagesPageMulti(relevantJids, undefined, Math.max(relevantJids.length * 3, 30));
    for (const row of rows) {
      if (!latestMessages.has(row.chat_jid)) {
        latestMessages.set(row.chat_jid, {
          content: row.content,
          timestamp: row.timestamp,
        });
      }
    }
  }

  return c.json({
    success: true,
    session: buildSessionPayload(user, session, bindings, latestMessages, chatsByJid),
  });
});

sessionRoutes.get('/:id/env', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const id = decodeURIComponent(c.req.param('id'));
  const session = resolveSessionOrThrow(user, id);
  if (!session) return c.json({ error: 'Session not found' }, 404);

  if (
    user.role !== 'admin' &&
    (!user.permissions || !user.permissions.includes('manage_group_env'))
  ) {
    return c.json({ error: 'Insufficient permissions' }, 403);
  }

  let config: ReturnType<typeof getRuntimeEnvConfig>;
  if (session.kind === 'memory') {
    config = getSessionRuntimeEnvConfig(session.id);
  } else {
    const resolvedBacking = resolveBackingGroupForSession(session);
    if (!resolvedBacking) {
      return c.json(
        { error: 'Only main/workspace and memory sessions support runtime env' },
        400,
      );
    }
    config = getRuntimeEnvConfig(resolvedBacking.backingGroup.folder);
  }
  return c.json(toPublicRuntimeEnvForUser(config, user));
});

sessionRoutes.put('/:id/env', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const id = decodeURIComponent(c.req.param('id'));
  const session = resolveSessionOrThrow(user, id);
  if (!session) return c.json({ error: 'Session not found' }, 404);
  if (
    user.role !== 'admin' &&
    (!user.permissions || !user.permissions.includes('manage_group_env'))
  ) {
    return c.json({ error: 'Insufficient permissions' }, 403);
  }

  const body = await c.req.json().catch(() => ({}));
  const validation = ContainerEnvSchema.safeParse(body);
  if (!validation.success) {
    return c.json({ error: 'Invalid request body' }, 400);
  }

  let resolvedBacking: ReturnType<typeof resolveBackingGroupForSession> = null;
  let current: ReturnType<typeof getRuntimeEnvConfig>;
  if (session.kind === 'memory') {
    current = getSessionRuntimeEnvConfig(session.id);
  } else {
    resolvedBacking = resolveBackingGroupForSession(session);
    if (!resolvedBacking) {
      return c.json(
        { error: 'Only main/workspace and memory sessions support runtime env' },
        400,
      );
    }
    if (
      !canAccessGroup(user, {
        ...resolvedBacking.backingGroup,
        jid: resolvedBacking.backingJid,
      })
    ) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    current = getRuntimeEnvConfig(resolvedBacking.backingGroup.folder);
  }
  const data = validation.data;
  const next = { ...current };
  if (data.anthropicBaseUrl !== undefined) next.anthropicBaseUrl = data.anthropicBaseUrl;
  if (data.anthropicAuthToken !== undefined) next.anthropicAuthToken = data.anthropicAuthToken;
  if (data.anthropicApiKey !== undefined) next.anthropicApiKey = data.anthropicApiKey;
  if (data.claudeCodeOauthToken !== undefined) next.claudeCodeOauthToken = data.claudeCodeOauthToken;
  if (data.happyclawModel !== undefined) next.happyclawModel = data.happyclawModel;
  if (data.customEnv !== undefined) next.customEnv = data.customEnv;
  if (data.codexBaseUrl !== undefined) next.codexBaseUrl = data.codexBaseUrl;
  if (data.codexDefaultModel !== undefined) next.codexDefaultModel = data.codexDefaultModel;
  if (data.codexCustomEnv !== undefined) next.codexCustomEnv = data.codexCustomEnv;

  try {
    if (session.kind === 'memory') {
      saveSessionRuntimeEnvConfig(session.id, next);
    } else {
      saveRuntimeEnvConfig(resolvedBacking!.backingGroup.folder, next);
      const deps = getWebDeps();
      if (deps) {
        await deps.queue.restartSession(resolvedBacking!.backingJid);
      }
    }
    return c.json(toPublicRuntimeEnvForUser(next, user));
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : 'Failed to save config' },
      500,
    );
  }
});

sessionRoutes.post('/:id/stop', authMiddleware, async (c) => {
  const deps = getWebDeps();
  if (!deps) return c.json({ error: 'Server not initialized' }, 500);

  const user = c.get('user') as AuthUser;
  const id = decodeURIComponent(c.req.param('id'));
  const session = resolveSessionOrThrow(user, id);
  if (!session) return c.json({ error: 'Session not found' }, 404);

  try {
    if (session.kind === 'worker') {
      const worker = getWorkerSessionRecord(session.id);
      const agentId = extractAgentIdFromWorkerSessionId(session.id) || '';
      if (!worker || !agentId) {
        return c.json({ error: 'Worker session is malformed' }, 400);
      }
      await deps.queue.stopSession(buildWorkerSessionId(agentId));
    } else {
      const backingJid = resolveBackingJid(session);
      if (!backingJid) {
        return c.json({ error: 'Session has no backing group' }, 400);
      }
      await deps.queue.stopSession(backingJid);
    }
    return c.json({ success: true });
  } catch (err) {
    return c.json(
      { error: `Failed to stop runtime: ${err instanceof Error ? err.message : String(err)}` },
      500,
    );
  }
});

sessionRoutes.post('/:id/interrupt', authMiddleware, async (c) => {
  const deps = getWebDeps();
  if (!deps) return c.json({ error: 'Server not initialized' }, 500);

  const user = c.get('user') as AuthUser;
  const id = decodeURIComponent(c.req.param('id'));
  const session = resolveSessionOrThrow(user, id);
  if (!session) return c.json({ error: 'Session not found' }, 404);

  if (session.kind === 'worker') {
    const worker = getWorkerSessionRecord(session.id);
    const agentId = extractAgentIdFromWorkerSessionId(session.id) || '';
    if (!worker || !agentId) {
      return c.json({ error: 'Worker session is malformed' }, 400);
    }
    return c.json({
      success: true,
      interrupted: deps.queue.interruptQuery(buildWorkerSessionId(agentId)),
    });
  }

  const backingJid = resolveBackingJid(session);
  if (!backingJid) {
    return c.json({ error: 'Session has no backing group' }, 400);
  }
  return c.json({
    success: true,
    interrupted: deps.queue.interruptQuery(backingJid),
  });
});

sessionRoutes.post('/:id/reset-session', authMiddleware, async (c) => {
  const deps = getWebDeps();
  if (!deps) return c.json({ error: 'Server not initialized' }, 500);

  const user = c.get('user') as AuthUser;
  const id = decodeURIComponent(c.req.param('id'));
  const session = resolveSessionOrThrow(user, id);
  if (!session) return c.json({ error: 'Session not found' }, 404);
  if (session.kind !== 'main' && session.kind !== 'workspace') {
    return c.json({ error: 'Only main/workspace sessions support reset' }, 400);
  }

  const resolvedBacking = resolveBackingGroupForSession(session);
  if (!resolvedBacking) {
    return c.json({ error: 'Session has no backing group' }, 400);
  }
  const { backingJid, backingGroup } = resolvedBacking;
  if (!canModifyGroup(user, { ...backingGroup, jid: backingJid })) {
    return c.json({ error: 'Session not found' }, 404);
  }

  let agentId: string | undefined;
  try {
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    if (typeof body.agentId === 'string' && body.agentId.trim()) {
      agentId = body.agentId.trim();
    }
  } catch {
    /* ignore */
  }

  if (agentId) {
    const workerSession = getSessionRecord(buildWorkerSessionId(agentId));
    if (!workerSession || workerSession.parent_session_id !== session.id) {
      return c.json({ error: 'Agent not found' }, 404);
    }
  } else if (deps.triggerSessionWrapup) {
    await deps.triggerSessionWrapup(backingGroup.folder).catch(() => {});
  }

  try {
    await executeSessionReset(
      backingJid,
      backingGroup.folder,
      {
        queue: deps.queue,
        sessions: deps.getSessions(),
        broadcast: () => {},
        setLastAgentTimestamp: deps.setLastAgentTimestamp,
      },
      agentId,
    );
  } catch (err) {
    return c.json(
      { error: `Failed to reset session: ${err instanceof Error ? err.message : String(err)}` },
      500,
    );
  }

  return c.json({ success: true, dividerMessageId: crypto.randomUUID() });
});

sessionRoutes.post('/:id/clear-history', authMiddleware, async (c) => {
  const deps = getWebDeps();
  if (!deps) return c.json({ error: 'Server not initialized' }, 500);

  const user = c.get('user') as AuthUser;
  const id = decodeURIComponent(c.req.param('id'));
  const session = resolveSessionOrThrow(user, id);
  if (!session) return c.json({ error: 'Session not found' }, 404);
  if (session.kind !== 'main' && session.kind !== 'workspace') {
    return c.json({ error: 'Only main/workspace sessions support clearing history' }, 400);
  }

  const resolvedBacking = resolveBackingGroupForSession(session);
  if (!resolvedBacking) {
    return c.json({ error: 'Session has no backing group' }, 400);
  }
  const { backingJid, backingGroup } = resolvedBacking;
  if (!canModifyGroup(user, { ...backingGroup, jid: backingJid })) {
    return c.json({ error: 'Session not found' }, 404);
  }

  const siblingJids = getJidsByFolder(backingGroup.folder);
  const workerRuntimeJids = getWorkerRuntimeJids(session.id);
  try {
    await Promise.all(
      [...siblingJids, ...workerRuntimeJids].map((jid) =>
        deps.queue.stopSession(jid, { force: true })
      ),
    );
    clearWorkerArtifactsForFolder(backingGroup.folder);
    resetWorkspaceForSession(backingGroup.folder);
    deleteSession(backingGroup.folder);
    delete deps.getSessions()[backingGroup.folder];
    for (const siblingJid of siblingJids) {
      deleteChatHistory(siblingJid);
      ensureChatExists(siblingJid);
      deps.setLastAgentTimestamp(siblingJid, { rowid: 0 });
    }
    for (const workerRuntimeJid of workerRuntimeJids) {
      deps.queue.removeGroupState(workerRuntimeJid);
      deps.setLastAgentTimestamp(workerRuntimeJid, { rowid: 0 });
    }
  } catch (err) {
    return c.json(
      { error: `Failed to clear history: ${err instanceof Error ? err.message : String(err)}` },
      500,
    );
  }

  return c.json({ success: true });
});

sessionRoutes.get('/:id/messages', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const id = decodeURIComponent(c.req.param('id'));
  const session = resolveSessionOrThrow(user, id);
  if (!session) return c.json({ error: 'Session not found' }, 404);

  const before = c.req.query('before');
  const after = c.req.query('after');
  const limitRaw = parseInt(c.req.query('limit') || '50', 10);
  const limit = Math.min(
    Number.isFinite(limitRaw) ? Math.max(1, limitRaw) : 50,
    200,
  );

  const queryJids = getRelevantChatJids(session);
  if (queryJids.length === 0) {
    return c.json({ messages: [], hasMore: false });
  }

  if (queryJids.length === 1) {
    const queryJid = queryJids[0];
    if (after) {
      const messages = getMessagesAfter(queryJid, after, limit);
      annotateMessagesWithTrace(messages);
      return c.json({ messages });
    }
    const rows = getMessagesPage(queryJid, before, limit + 1);
    const hasMore = rows.length > limit;
    const messages = hasMore ? rows.slice(0, limit) : rows;
    annotateMessagesWithTrace(messages);
    return c.json({ messages, hasMore });
  }

  if (after) {
    const messages = getMessagesAfterMulti(queryJids, after, limit);
    annotateMessagesWithTrace(messages);
    return c.json({ messages });
  }
  const rows = getMessagesPageMulti(queryJids, before, limit + 1);
  const hasMore = rows.length > limit;
  const messages = hasMore ? rows.slice(0, limit) : rows;
  annotateMessagesWithTrace(messages);
  return c.json({ messages, hasMore });
});

sessionRoutes.get('/:id/messages/search', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const id = decodeURIComponent(c.req.param('id'));
  const session = resolveSessionOrThrow(user, id);
  if (!session) return c.json({ error: 'Session not found' }, 404);

  const q = c.req.query('q')?.trim();
  if (!q) {
    return c.json({ error: 'Missing search query parameter "q"' }, 400);
  }

  const limitRaw = parseInt(c.req.query('limit') || '50', 10);
  const limit = Math.min(
    Number.isFinite(limitRaw) ? Math.max(1, limitRaw) : 50,
    200,
  );
  const offsetRaw = parseInt(c.req.query('offset') || '0', 10);
  const offset = Number.isFinite(offsetRaw) ? Math.max(0, offsetRaw) : 0;
  const daysRaw = parseInt(c.req.query('days') || '0', 10);
  const days = Number.isFinite(daysRaw) ? Math.max(0, daysRaw) : 0;
  const sinceTs = days > 0
    ? new Date(Date.now() - days * 86400000).toISOString()
    : undefined;

  const queryJids = getRelevantChatJids(session);
  const results = searchMessages(queryJids, q, limit, offset, sinceTs);
  const total = countSearchResults(queryJids, q, sinceTs);
  const hasMore = offset + results.length < total;
  return c.json({ results, total, hasMore });
});

sessionRoutes.get('/:id/messages/:messageId/trace', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const id = decodeURIComponent(c.req.param('id'));
  const messageId = c.req.param('messageId');
  const session = resolveSessionOrThrow(user, id);
  if (!session) return c.json({ blocks: [] });

  const turn = getTurnByResultMessageId(messageId);
  if (!turn?.trace_file) return c.json({ blocks: [] });
  const trace = loadTurnTrace(turn.trace_file);
  if (!trace) return c.json({ blocks: [] });
  return c.json({ blocks: trace.blocks });
});

sessionRoutes.delete('/:id/messages/:messageId', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const id = decodeURIComponent(c.req.param('id'));
  const messageId = c.req.param('messageId');
  const session = resolveSessionOrThrow(user, id);
  if (!session) return c.json({ error: 'Session not found' }, 404);

  const queryJids = getRelevantChatJids(session);
  let target = null as ReturnType<typeof getMessage>;
  for (const queryJid of queryJids) {
    const message = getMessage(queryJid, messageId);
    if (message) {
      target = message;
      break;
    }
  }

  if (!target) {
    return c.json({ error: 'Message not found' }, 404);
  }
  if (user.role !== 'admin') {
    if (target.is_from_me === 1 || (target.sender && target.sender !== user.id)) {
      return c.json({ error: 'Permission denied' }, 403);
    }
  }
  if (!deleteMessage(target.chat_jid, messageId)) {
    return c.json({ error: 'Message not found' }, 404);
  }
  return c.json({ success: true });
});

sessionRoutes.post('/:id/compress', authMiddleware, async (c) => {
  const deps = getWebDeps();
  if (!deps) return c.json({ error: 'Server not initialized' }, 500);

  const user = c.get('user') as AuthUser;
  const id = decodeURIComponent(c.req.param('id'));
  const session = resolveSessionOrThrow(user, id);
  if (!session) return c.json({ error: 'Session not found' }, 404);
  if (session.kind !== 'main' && session.kind !== 'workspace') {
    return c.json({ error: 'Only main/workspace sessions support compression' }, 400);
  }

  const resolvedBacking = resolveBackingGroupForSession(session);
  if (!resolvedBacking) {
    return c.json({ error: 'Session has no backing group' }, 400);
  }
  const { backingJid, backingGroup } = resolvedBacking;
  if (!canModifyGroup(user, { ...backingGroup, jid: backingJid })) {
    return c.json({ error: 'Session not found' }, 404);
  }
  if (deps.queue.hasDirectActiveRunner(backingJid)) {
    return c.json({ error: 'Agent 正在运行中，请等待完成后再压缩' }, 409);
  }
  if (isCompressing(backingGroup.folder)) {
    return c.json({ error: '压缩正在进行中，请稍后再试' }, 409);
  }

  const sessions = deps.getSessions();
  const sessionIdBefore = sessions[backingGroup.folder];
  const compressOpts = deps.buildCompressOptions?.(backingGroup) ?? {};
  compressOpts.beforeTimestamp = new Date().toISOString();
  const result = await compressContext(backingGroup.folder, backingJid, compressOpts);
  if (!result.success) {
    return c.json({ error: result.error }, 400);
  }
  if (sessions[backingGroup.folder] === sessionIdBefore) {
    delete sessions[backingGroup.folder];
  }

  return c.json({
    success: true,
    summary: result.summary,
    messageCount: result.messageCount,
    extractedKnowledge: result.extractedKnowledge,
  });
});

sessionRoutes.get('/:id/summary', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const id = decodeURIComponent(c.req.param('id'));
  const session = resolveSessionOrThrow(user, id);
  if (!session) return c.json({ error: 'Session not found' }, 404);
  if (session.kind !== 'main' && session.kind !== 'workspace') {
    return c.json({ summary: null });
  }

  const backingJid = resolveBackingJid(session);
  if (!backingJid) {
    return c.json({ summary: null });
  }
  return c.json({ summary: getContextSummary(getFolderForSession(session), backingJid) ?? null });
});

sessionRoutes.get('/:id/members', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const id = decodeURIComponent(c.req.param('id'));
  const session = resolveSessionOrThrow(user, id);
  if (!session) return c.json({ error: 'Session not found' }, 404);
  return c.json({
    members: [
      {
        user_id: user.id,
        role: 'owner',
        added_at: new Date().toISOString(),
        username: user.username,
        display_name: user.display_name,
      },
    ],
  });
});

sessionRoutes.get('/:id/members/search', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const id = decodeURIComponent(c.req.param('id'));
  const session = resolveSessionOrThrow(user, id);
  if (!session) return c.json({ error: 'Session not found' }, 404);
  return c.json({ users: [] });
});

sessionRoutes.post('/:id/members', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const id = decodeURIComponent(c.req.param('id'));
  const session = resolveSessionOrThrow(user, id);
  if (!session) return c.json({ error: 'Session not found' }, 404);
  return c.json(
    { error: 'Single-user mode does not support session members' },
    400,
  );
});

sessionRoutes.delete('/:id/members/:userId', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const id = decodeURIComponent(c.req.param('id'));
  const session = resolveSessionOrThrow(user, id);
  if (!session) return c.json({ error: 'Session not found' }, 404);
  return c.json(
    { error: 'Single-user mode does not support session members' },
    400,
  );
});

sessionRoutes.put('/:id/mode', authMiddleware, async (c) => {
  const deps = getWebDeps();
  if (!deps) return c.json({ error: 'Server not initialized' }, 500);

  const user = c.get('user') as AuthUser;
  const id = decodeURIComponent(c.req.param('id'));
  const session = resolveSessionOrThrow(user, id);
  if (!session) return c.json({ error: 'Session not found' }, 404);

  const body = await c.req.json().catch(() => ({})) as { mode?: string };
  const mode = body.mode;
  if (mode !== 'bypassPermissions' && mode !== 'plan') {
    return c.json(
      { error: 'Invalid mode. Must be one of: bypassPermissions, plan' },
      400,
    );
  }

  if (session.kind === 'worker') {
    const worker = getWorkerSessionRecord(session.id);
    const agentId = extractAgentIdFromWorkerSessionId(session.id) || '';
    if (!worker || !agentId) {
      return c.json({ error: 'Worker session is malformed' }, 400);
    }
    const applied = deps.queue.setPermissionMode(buildWorkerSessionId(agentId), mode);
    if (applied) {
      persistPermissionModeSnapshot(session.id, mode);
    }
    return c.json({
      success: true,
      mode,
      applied,
    });
  }

  const backingJid = resolveBackingJid(session);
  if (!backingJid) {
    return c.json({ error: 'Session has no backing group' }, 400);
  }
  const applied = deps.queue.setPermissionMode(backingJid, mode);
  if (applied) {
    persistPermissionModeSnapshot(session.id, mode);
  }
  return c.json({
    success: true,
    mode,
    applied,
  });
});

sessionRoutes.get('/:id/mcp', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const id = decodeURIComponent(c.req.param('id'));
  const session = resolveSessionOrThrow(user, id);
  if (!session) return c.json({ error: 'Session not found' }, 404);
  if (session.kind !== 'main' && session.kind !== 'workspace') {
    return c.json({ error: 'Only main/workspace sessions support MCP config' }, 400);
  }

  const resolvedBacking = resolveBackingGroupForSession(session);
  if (!resolvedBacking) {
    return c.json({ error: 'Session has no backing group' }, 400);
  }

  return c.json({
    mcp_mode: resolvedBacking.backingGroup.mcp_mode ?? 'inherit',
    selected_mcps: resolvedBacking.backingGroup.selected_mcps ?? null,
  });
});

sessionRoutes.put('/:id/mcp', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const id = decodeURIComponent(c.req.param('id'));
  const session = resolveSessionOrThrow(user, id);
  if (!session) return c.json({ error: 'Session not found' }, 404);
  if (session.kind !== 'main' && session.kind !== 'workspace') {
    return c.json({ error: 'Only main/workspace sessions support MCP config' }, 400);
  }

  const resolvedBacking = resolveBackingGroupForSession(session);
  if (!resolvedBacking) {
    return c.json({ error: 'Session has no backing group' }, 400);
  }
  const { backingJid, backingGroup } = resolvedBacking;
  if (!canAccessGroup(user, { ...backingGroup, jid: backingJid })) {
    return c.json({ error: 'Session not found' }, 404);
  }

  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const mcpMode = body.mcp_mode;
  const selectedMcps = body.selected_mcps;

  if (mcpMode !== undefined && mcpMode !== 'inherit' && mcpMode !== 'custom') {
    return c.json({ error: 'Invalid mcp_mode' }, 400);
  }
  if (selectedMcps !== undefined && selectedMcps !== null) {
    if (!Array.isArray(selectedMcps)) {
      return c.json({ error: 'selected_mcps must be an array' }, 400);
    }
    for (const mcp of selectedMcps) {
      if (typeof mcp !== 'string') {
        return c.json({ error: 'selected_mcps must contain strings' }, 400);
      }
    }
  }

  const updatedGroup: RegisteredGroup = {
    ...backingGroup,
    mcp_mode: (mcpMode as RegisteredGroup['mcp_mode']) ?? backingGroup.mcp_mode ?? 'inherit',
    selected_mcps:
      selectedMcps !== undefined
        ? (selectedMcps as string[] | null)
        : backingGroup.selected_mcps,
  };
  setRegisteredGroup(backingJid, updatedGroup);

  return c.json({
    success: true,
    mcp_mode: updatedGroup.mcp_mode,
    selected_mcps: updatedGroup.selected_mcps,
  });
});

function buildWorkerAgentProxyRequest(
  request: Request,
  parentSessionId: string,
  agentId: string,
): Request {
  const url = new URL(request.url);
  url.pathname = `/api/sessions/${encodeURIComponent(parentSessionId)}/agents/${encodeURIComponent(agentId)}`;
  return new Request(url, request);
}

sessionRoutes.delete('/:id', authMiddleware, async (c) => {
  const id = decodeURIComponent(c.req.param('id'));
  const session = getSessionById(id);
  if (!session) return c.json({ error: 'Session not found' }, 404);

  if (session.kind === 'worker') {
    const agentId = extractAgentIdFromWorkerSessionId(session.id) || '';
    if (!agentId || !session.parent_session_id) {
      return c.json({ error: 'Worker session is malformed' }, 400);
    }
    const proxied = buildWorkerAgentProxyRequest(
      c.req.raw,
      session.parent_session_id,
      agentId,
    );
    return agentRoutes.fetch(proxied, c.env, c.executionCtx);
  }

  if (session.kind === 'memory') {
    return c.json({ error: 'Memory session cannot be deleted' }, 400);
  }

  const backingJid = resolveBackingJid(session);
  if (!backingJid) {
    return c.json({ error: 'Session has no backing group' }, 400);
  }
  const backingGroup = getRegisteredGroup(backingJid);
  if (!backingGroup) {
    return c.json({ error: 'Session backing group not found' }, 404);
  }

  const user = c.get('user') as AuthUser;
  if (
    !canDeleteGroup(user, { ...backingGroup, jid: backingJid })
  ) {
    return c.json({ error: 'Session not found' }, 404);
  }

  const childSessionIds = new Set(
    listSessionRecords()
      .filter((candidate) => candidate.parent_session_id === session.id)
      .map((candidate) => candidate.id),
  );
  const blockingBindings = listSessionBindings().filter(
    (binding) => binding.session_id === session.id || childSessionIds.has(binding.session_id),
  );
  if (blockingBindings.length > 0) {
    return c.json(
      {
        error: '该会话仍绑定了 IM 渠道，请先解绑后再删除。',
        bound_channels: blockingBindings.map((binding) => ({
          jid: binding.channel_jid,
          name: binding.display_name || binding.channel_jid,
          session_id: binding.session_id,
        })),
      },
      409,
    );
  }

  const deps = getWebDeps();
  if (!deps) return c.json({ error: 'Server not initialized' }, 500);
  const workerRuntimeJids = getWorkerRuntimeJids(session.id);

  try {
    await Promise.all([
      deps.queue.stopSession(backingJid),
      ...workerRuntimeJids.map((jid) => deps.queue.stopSession(jid)),
    ]);
  } catch (err) {
    return c.json(
      {
        error: `Failed to stop runtime, session not deleted: ${err instanceof Error ? err.message : String(err)}`,
      },
      500,
    );
  }

  deleteGroupData(backingJid, backingGroup.folder);
  removeSessionArtifacts(backingGroup.folder);
  deps.queue.removeGroupState(backingJid);
  for (const workerRuntimeJid of workerRuntimeJids) {
    deps.queue.removeGroupState(workerRuntimeJid);
    deps.setLastAgentTimestamp(workerRuntimeJid, { rowid: 0 });
  }
  delete deps.getRegisteredGroups()[backingJid];
  delete deps.getSessions()[backingGroup.folder];
  deps.setLastAgentTimestamp(backingJid, { rowid: 0 });

  return c.json({ success: true });
});

export default sessionRoutes;
