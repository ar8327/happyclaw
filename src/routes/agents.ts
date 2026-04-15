import { Hono } from 'hono';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Variables } from '../web-context.js';
import { getWebDeps } from '../web-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { canAccessGroup } from '../web-context.js';
import {
  deleteSessionBinding,
  getRegisteredGroup,
  getAllRegisteredGroups,
  getSessionBinding,
  getSessionRecord,
  listAgentsByJid,
  getAgent,
  deleteAgent,
  updateAgentStatus,
  createAgent,
  ensureChatExists,
  deleteMessagesForChatJid,
  deleteSession,
  getGroupsByTargetAgent,
  saveSessionBinding,
  setRegisteredGroup,
  getJidsByFolder,
} from '../db.js';
import { DATA_DIR } from '../config.js';
import type { RegisteredGroup, SubAgent } from '../types.js';
import { logger } from '../logger.js';
import { getChannelType, extractChatId } from '../im-channel.js';
import {
  buildWorkerConversationJid,
  buildWorkerSessionId,
  extractAgentIdFromWorkerSessionId,
} from '../worker-session.js';

const router = new Hono<{ Variables: Variables }>();

function syncImGroupCache(imJid: string, updated: RegisteredGroup): void {
  const deps = getWebDeps();
  if (!deps) return;
  const groups = deps.getRegisteredGroups();
  if (groups[imJid]) groups[imJid] = updated;
}

function upsertImBinding(
  imJid: string,
  imGroup: RegisteredGroup,
  sessionId: string,
  replyPolicy: 'source_only' | 'mirror',
): void {
  const current = getSessionBinding(imJid);
  const now = new Date().toISOString();
  const session = getSessionRecord(sessionId);
  saveSessionBinding({
    channel_jid: imJid,
    session_id: sessionId,
    binding_mode:
      replyPolicy === 'mirror'
        ? 'mirror'
        : session?.kind === 'worker'
          ? 'direct'
          : 'source_only',
    activation_mode: imGroup.activation_mode ?? 'auto',
    require_mention: imGroup.require_mention === true,
    display_name: imGroup.name,
    reply_policy: replyPolicy,
    created_at: current?.created_at || imGroup.added_at || now,
    updated_at: now,
  });
}

function isImplicitDefaultSessionBinding(
  imGroup: RegisteredGroup,
  binding: ReturnType<typeof getSessionBinding> | undefined,
): boolean {
  return !!binding
    && binding.session_id === `main:${imGroup.folder}`;
}

function getExplicitSessionBinding(
  imJid: string,
  imGroup: RegisteredGroup,
): ReturnType<typeof getSessionBinding> | undefined {
  const binding = getSessionBinding(imJid);
  return isImplicitDefaultSessionBinding(imGroup, binding) ? undefined : binding;
}

function resolveRouteGroup(
  id: string,
): { accessJid: string; group: RegisteredGroup } | null {
  const direct = getRegisteredGroup(id);
  if (direct && id.startsWith('web:')) {
    return { accessJid: id, group: direct };
  }

  const session = getSessionRecord(id);
  if (!session) return null;

  const folder = session.id.startsWith('main:')
    ? session.id.slice('main:'.length)
    : session.parent_session_id?.startsWith('main:')
      ? session.parent_session_id.slice('main:'.length)
      : null;
  if (!folder) return null;

  const accessJid = getJidsByFolder(folder).find((jid) => jid.startsWith('web:'));
  if (!accessJid) return null;
  const group = getRegisteredGroup(accessJid);
  return group ? { accessJid, group } : null;
}

// GET /api/sessions/:jid/agents — list all agents for a session
router.get('/:jid/agents', authMiddleware, async (c) => {
  const jid = decodeURIComponent(c.req.param('jid'));
  const user = c.get('user');
  const resolved = resolveRouteGroup(jid);
  if (!resolved) {
    return c.json({ error: 'Group not found' }, 404);
  }
  const { accessJid, group } = resolved;

  if (!canAccessGroup(user, { ...group, jid: accessJid })) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const agents = listAgentsByJid(accessJid);
  return c.json({
    agents: agents.map((a) => {
      const base = {
        id: a.id,
        session_id: a.kind === 'conversation' ? buildWorkerSessionId(a.id) : undefined,
        name: a.name,
        prompt: a.prompt,
        status: a.status,
        kind: a.kind,
        created_at: a.created_at,
        completed_at: a.completed_at,
        result_summary: a.result_summary,
      };
      if (a.kind === 'conversation') {
        const linked = getGroupsByTargetAgent(a.id);
        return {
          ...base,
          linked_im_groups: linked.map((l) => ({
            jid: l.jid,
            name: l.group.name,
          })),
        };
      }
      return base;
    }),
  });
});

// POST /api/sessions/:jid/agents — create a user conversation
router.post('/:jid/agents', authMiddleware, async (c) => {
  const jid = decodeURIComponent(c.req.param('jid'));
  const user = c.get('user');
  const resolved = resolveRouteGroup(jid);
  if (!resolved) {
    return c.json({ error: 'Group not found' }, 404);
  }
  const { accessJid, group } = resolved;

  if (!canAccessGroup(user, { ...group, jid: accessJid })) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const body = await c.req.json().catch(() => ({}));
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > 40) {
    return c.json({ error: 'Name is required (max 40 chars)' }, 400);
  }
  const description =
    typeof body.description === 'string' ? body.description.trim() : '';

  const agentId = crypto.randomUUID();
  const now = new Date().toISOString();

  const agent: SubAgent = {
    id: agentId,
    group_folder: group.folder,
    chat_jid: accessJid,
    name,
    prompt: description,
    status: 'idle',
    kind: 'conversation',
    created_by: user.id,
    created_at: now,
    completed_at: null,
    result_summary: null,
  };

  createAgent(agent);

  // Create IPC directories for this conversation agent
  const agentIpcDir = path.join(
    DATA_DIR,
    'ipc',
    group.folder,
    'agents',
    agentId,
  );
  fs.mkdirSync(path.join(agentIpcDir, 'input'), { recursive: true });
  fs.mkdirSync(path.join(agentIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(agentIpcDir, 'tasks'), { recursive: true });

  // Create session directory
  const agentSessionDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    'agents',
    agentId,
    '.claude',
  );
  fs.mkdirSync(agentSessionDir, { recursive: true });

  // Create virtual chat record for this agent's messages
  const virtualChatJid = buildWorkerConversationJid(accessJid, agentId);
  ensureChatExists(virtualChatJid);

  // Broadcast agent_status (idle) via WebSocket
  // Import dynamically to avoid circular deps
  const { broadcastAgentStatus } = await import('../web.js');
  broadcastAgentStatus(accessJid, agentId, 'idle', name, description);

  logger.info(
    { agentId, jid: accessJid, name, userId: user.id },
    'User conversation created',
  );

  return c.json({
    agent: {
      id: agent.id,
      session_id: buildWorkerSessionId(agent.id),
      name: agent.name,
      prompt: agent.prompt,
      status: agent.status,
      kind: agent.kind,
      created_at: agent.created_at,
    },
  });
});

// DELETE /api/sessions/:jid/agents/:agentId — stop and delete an agent
router.delete('/:jid/agents/:agentId', authMiddleware, async (c) => {
  const jid = decodeURIComponent(c.req.param('jid'));
  const agentId = c.req.param('agentId');
  const user = c.get('user');
  const resolved = resolveRouteGroup(jid);
  if (!resolved) {
    return c.json({ error: 'Group not found' }, 404);
  }
  const { accessJid, group } = resolved;

  if (!canAccessGroup(user, { ...group, jid: accessJid })) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const agent = getAgent(agentId);
  if (!agent || agent.chat_jid !== accessJid) {
    return c.json({ error: 'Agent not found' }, 404);
  }

  // Block deletion if conversation agent has active IM bindings
  if (agent.kind === 'conversation') {
    const linkedImGroups = getGroupsByTargetAgent(agentId);
    if (linkedImGroups.length > 0) {
      return c.json(
        {
          error:
            'Agent has active IM bindings. Unbind all IM groups before deleting.',
          linked_im_groups: linkedImGroups.map(
            ({ jid: imJid, group: imGroup }) => ({
              jid: imJid,
              name: imGroup.name,
            }),
          ),
        },
        409,
      );
    }
  }

  // If the agent is still running or idle, stop the process
  if (agent.status === 'running' || agent.status === 'idle') {
    updateAgentStatus(agentId, 'error', '用户手动停止');
    // Stop running process via queue
    const deps = getWebDeps();
    if (deps) {
      deps.queue.stopSession(buildWorkerSessionId(agentId));
    }
  }

  // Clean up IPC/session directories
  const agentIpcDir = path.join(
    DATA_DIR,
    'ipc',
    group.folder,
    'agents',
    agentId,
  );
  try {
    fs.rmSync(agentIpcDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  const agentSessionDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    'agents',
    agentId,
  );
  try {
    fs.rmSync(agentSessionDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  // Delete virtual chat messages for conversation agents
  if (agent.kind === 'conversation') {
    const virtualChatJid = buildWorkerConversationJid(accessJid, agentId);
    deleteMessagesForChatJid(virtualChatJid);

    // Note: IM bindings are checked above and block deletion if present.
    // No auto-clear here — user must unbind explicitly before deleting.
  }

  // Delete session records
  deleteSession(group.folder, agentId);

  deleteAgent(agentId);

  // Broadcast removal
  const { broadcastAgentStatus } = await import('../web.js');
  broadcastAgentStatus(
    accessJid,
    agentId,
    'error',
    agent.name,
    agent.prompt,
    '__removed__',
  );

  logger.info({ agentId, jid: accessJid, userId: user.id }, 'Agent deleted by user');
  return c.json({ success: true });
});

// Helper: check if a Telegram JID is a private/P2P chat
function isTelegramPrivateChat(jid: string): boolean {
  if (!jid.startsWith('telegram:')) return false;
  const id = jid.slice('telegram:'.length);
  return !id.startsWith('-');
}

// GET /api/sessions/:jid/im-groups — list available IM group chats for this folder
router.get('/:jid/im-groups', authMiddleware, async (c) => {
  const jid = decodeURIComponent(c.req.param('jid'));
  const user = c.get('user');
  const resolved = resolveRouteGroup(jid);
  if (!resolved) {
    return c.json({ error: 'Group not found' }, 404);
  }
  const { accessJid, group } = resolved;
  if (!canAccessGroup(user, { ...group, jid: accessJid })) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  // Find all IM groups this user can access (across all folders).
  const allGroups = getAllRegisteredGroups();
  const imJids = Object.keys(allGroups)
    .filter((j) => {
      if (j.startsWith('web:')) return false;
      return canAccessGroup(user, { ...allGroups[j], jid: j });
    })
    .filter((j) => !isTelegramPrivateChat(j));

  // Build candidate list
  interface ImGroupCandidate {
    jid: string;
    name: string;
    bound_session_id: string | null;
    bound_session_kind: 'main' | 'workspace' | 'worker' | 'memory' | null;
    binding_mode: 'direct' | 'source_only' | 'mirror';
    reply_policy: 'source_only' | 'mirror';
    activation_mode: 'auto' | 'always' | 'when_mentioned' | 'disabled';
    require_mention: boolean;
    bound_target_name: string | null;
    bound_workspace_name: string | null;
    avatar?: string;
    member_count?: number;
    channel_type: string;
    chat_mode?: string; // 'p2p' | 'group' — from Feishu API (distinguishes P2P vs group chat)
  }

  const candidates: ImGroupCandidate[] = [];
  for (const j of imJids) {
    const g = allGroups[j];
    const binding = getExplicitSessionBinding(j, g);
    const boundSession = binding?.session_id
      ? getSessionRecord(binding.session_id)
      : null;

    // Resolve bound target name for display
    let boundTargetName: string | null = null;
    let boundWorkspaceName: string | null = null;
    if (boundSession) {
      if (boundSession.kind === 'worker') {
        const agentId = extractAgentIdFromWorkerSessionId(boundSession.id) || '';
        const boundAgent = agentId ? getAgent(agentId) : undefined;
        if (boundAgent) {
          boundTargetName = boundAgent.name;
          const ownerGroup = getRegisteredGroup(boundAgent.chat_jid);
          if (ownerGroup) boundWorkspaceName = ownerGroup.name;
        }
      } else if (
        (boundSession.kind === 'main' || boundSession.kind === 'workspace')
      ) {
        const backingJid = boundSession.id.startsWith('main:')
          ? getJidsByFolder(boundSession.id.slice('main:'.length)).find((jid) =>
              jid.startsWith('web:'),
            ) || `web:${boundSession.id.slice('main:'.length)}`
          : null;
        const boundGroup = backingJid ? getRegisteredGroup(backingJid) : null;
        if (boundGroup) boundTargetName = boundGroup.name;
      }
    }

    candidates.push({
      jid: j,
      name: g.name,
      bound_session_id: binding?.session_id || null,
      bound_session_kind: boundSession?.kind || null,
      binding_mode: binding?.binding_mode || 'source_only',
      reply_policy: binding?.reply_policy || 'source_only',
      activation_mode: binding?.activation_mode || g.activation_mode || 'auto',
      require_mention: binding?.require_mention ?? g.require_mention === true,
      bound_target_name: boundTargetName,
      bound_workspace_name: boundWorkspaceName,
      channel_type: getChannelType(j) ?? 'unknown',
    });
  }

  // Enrich Feishu groups with avatar, member count, and chat_mode
  const deps = getWebDeps();
  if (deps?.getFeishuChatInfo) {
    const feishuCandidates = candidates.filter(
      (g) => g.channel_type === 'feishu',
    );
    const chatInfoPromises = feishuCandidates.map(async (g) => {
      const chatId = extractChatId(g.jid);
      const info = await deps.getFeishuChatInfo!(user.id, chatId);
      if (info) {
        g.avatar = info.avatar;
        g.chat_mode = info.chat_mode;
        if (info.user_count != null) {
          const count = parseInt(info.user_count, 10);
          if (!isNaN(count)) g.member_count = count;
        }
        if (info.name && info.name !== g.name) g.name = info.name;
      }
    });
    await Promise.allSettled(chatInfoPromises);
  }

  // Feishu chat_mode: 'group' = group chat, 'p2p' = private chat
  // If chat_mode is available, use it directly. When API data is completely
  // missing (permissions not enabled), default to keeping the group rather
  // than filtering it out. Only filter when chat_mode is explicitly 'p2p'.
  const imGroups = candidates
    .filter((g) => {
      if (g.channel_type === 'feishu') {
        if (g.chat_mode === 'p2p') return false;
        // Exclude groups with only the bot (user_count=0 means no real users, just bot)
        if (g.member_count !== undefined && g.member_count < 1) return false;
        // chat_mode is 'group' or API data completely missing — keep the group
        return true;
      }
      return true;
    })
    .map(({ chat_mode: _, ...rest }) => rest);

  return c.json({ imGroups });
});

// PUT /api/sessions/:jid/agents/:agentId/im-binding — bind an IM group to this agent
router.put('/:jid/agents/:agentId/im-binding', authMiddleware, async (c) => {
  const jid = decodeURIComponent(c.req.param('jid'));
  const agentId = c.req.param('agentId');
  const user = c.get('user');
  const resolved = resolveRouteGroup(jid);
  if (!resolved) {
    return c.json({ error: 'Group not found' }, 404);
  }
  const { accessJid, group } = resolved;
  if (!canAccessGroup(user, { ...group, jid: accessJid })) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const agent = getAgent(agentId);
  if (!agent || agent.chat_jid !== accessJid) {
    return c.json({ error: 'Agent not found' }, 404);
  }
  if (agent.kind !== 'conversation') {
    return c.json(
      { error: 'Only conversation agents can bind IM groups' },
      400,
    );
  }

  const body = await c.req.json().catch(() => ({}));
  const imJid = typeof body.im_jid === 'string' ? body.im_jid.trim() : '';
  if (!imJid) {
    return c.json({ error: 'im_jid is required' }, 400);
  }

  const imGroup = getRegisteredGroup(imJid);
  if (!imGroup) {
    return c.json({ error: 'IM group not found' }, 404);
  }
  if (!canAccessGroup(user, { ...imGroup, jid: imJid })) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  const force = body.force === true;
  const replyPolicy = body.reply_policy === 'mirror' ? 'mirror' : 'source_only';
  const currentBinding = getExplicitSessionBinding(imJid, imGroup);
  const targetSessionId = buildWorkerSessionId(agentId);
  const hasConflict =
    !!currentBinding && currentBinding.session_id !== targetSessionId;
  if (hasConflict && !force) {
    return c.json({ error: 'IM group is already bound elsewhere' }, 409);
  }

  // Explicit bindings now persist through session_bindings only.
  const updated: RegisteredGroup = {
    ...imGroup,
    reply_policy: replyPolicy,
    activation_mode:
      imGroup.activation_mode === 'disabled' ? 'auto' : imGroup.activation_mode,
  };
  setRegisteredGroup(imJid, updated);
  upsertImBinding(imJid, updated, targetSessionId, replyPolicy);
  syncImGroupCache(imJid, updated);

  logger.info({ imJid, agentId, userId: user.id }, 'IM group bound to agent');
  return c.json({ success: true });
});

// DELETE /api/sessions/:jid/agents/:agentId/im-binding/:imJid — unbind an IM group
router.delete(
  '/:jid/agents/:agentId/im-binding/:imJid',
  authMiddleware,
  async (c) => {
  const jid = decodeURIComponent(c.req.param('jid'));
  const agentId = c.req.param('agentId');
  const imJid = decodeURIComponent(c.req.param('imJid'));
  const user = c.get('user');
  const resolved = resolveRouteGroup(jid);
    if (!resolved) {
      return c.json({ error: 'Group not found' }, 404);
    }
    const { accessJid, group } = resolved;
    if (!canAccessGroup(user, { ...group, jid: accessJid })) {
      return c.json({ error: 'Forbidden' }, 403);
    }

    const agent = getAgent(agentId);
    if (!agent || agent.chat_jid !== accessJid) {
      return c.json({ error: 'Agent not found' }, 404);
    }

    const imGroup = getRegisteredGroup(imJid);
    if (!imGroup) {
      return c.json({ error: 'IM group not found' }, 404);
    }
    if (!canAccessGroup(user, { ...imGroup, jid: imJid })) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    const currentBinding = getExplicitSessionBinding(imJid, imGroup);
    if (currentBinding?.session_id !== buildWorkerSessionId(agentId)) {
      return c.json({ error: 'IM group is not bound to this agent' }, 400);
    }

    // Update DB + in-memory cache
    const updated = {
      ...imGroup,
      activation_mode: 'disabled' as const,
    };
    setRegisteredGroup(imJid, updated);
    deleteSessionBinding(imJid);
    syncImGroupCache(imJid, updated);

    logger.info(
      { imJid, agentId, userId: user.id },
      'IM group unbound from agent',
    );
    return c.json({ success: true });
  },
);

// PUT /api/sessions/:jid/im-binding — bind an IM group to this workspace's main conversation
router.put('/:jid/im-binding', authMiddleware, async (c) => {
  const jid = decodeURIComponent(c.req.param('jid'));
  const user = c.get('user');
  const resolved = resolveRouteGroup(jid);
  if (!resolved) {
    return c.json({ error: 'Group not found' }, 404);
  }
  const { accessJid, group } = resolved;
  if (!canAccessGroup(user, { ...group, jid: accessJid })) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  if (group.is_home) {
    return c.json(
      { error: 'Home workspace main conversation uses default IM routing' },
      400,
    );
  }

  const body = await c.req.json().catch(() => ({}));
  const imJid = typeof body.im_jid === 'string' ? body.im_jid.trim() : '';
  if (!imJid) {
    return c.json({ error: 'im_jid is required' }, 400);
  }

  const imGroup = getRegisteredGroup(imJid);
  if (!imGroup) {
    return c.json({ error: 'IM group not found' }, 404);
  }
  if (!canAccessGroup(user, { ...imGroup, jid: imJid })) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  const force = body.force === true;
  const replyPolicy = body.reply_policy === 'mirror' ? 'mirror' : 'source_only';
  const currentBinding = getExplicitSessionBinding(imJid, imGroup);
  const targetSessionId = `main:${group.folder}`;
  const hasConflict =
    !!currentBinding && currentBinding.session_id !== targetSessionId;
  if (hasConflict && !force) {
    return c.json({ error: 'IM group is already bound elsewhere' }, 409);
  }

  // Explicit bindings now persist through session_bindings only.
  const updated: RegisteredGroup = {
    ...imGroup,
    reply_policy: replyPolicy,
    activation_mode:
      imGroup.activation_mode === 'disabled' ? 'auto' : imGroup.activation_mode,
  };
  setRegisteredGroup(imJid, updated);
  upsertImBinding(imJid, updated, targetSessionId, replyPolicy);
  syncImGroupCache(imJid, updated);

  logger.info(
    { imJid, sessionId: targetSessionId, userId: user.id },
    'IM group bound to workspace main conversation',
  );
  return c.json({ success: true });
});

// DELETE /api/sessions/:jid/im-binding/:imJid — unbind an IM group from this workspace's main conversation
router.delete('/:jid/im-binding/:imJid', authMiddleware, async (c) => {
  const jid = decodeURIComponent(c.req.param('jid'));
  const imJid = decodeURIComponent(c.req.param('imJid'));
  const user = c.get('user');
  const resolved = resolveRouteGroup(jid);
  if (!resolved) {
    return c.json({ error: 'Group not found' }, 404);
  }
  const { accessJid, group } = resolved;
  if (!canAccessGroup(user, { ...group, jid: accessJid })) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const imGroup = getRegisteredGroup(imJid);
  if (!imGroup) {
    return c.json({ error: 'IM group not found' }, 404);
  }
  if (!canAccessGroup(user, { ...imGroup, jid: imJid })) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  const currentBinding = getExplicitSessionBinding(imJid, imGroup);
  if (currentBinding?.session_id !== `main:${group.folder}`) {
    return c.json({ error: 'IM group is not bound to this workspace' }, 400);
  }

  // Update DB + in-memory cache
  const updated = {
    ...imGroup,
    activation_mode: 'disabled' as const,
  };
  setRegisteredGroup(imJid, updated);
  deleteSessionBinding(imJid);
  syncImGroupCache(imJid, updated);

  logger.info(
    { imJid, sessionId: `main:${group.folder}`, userId: user.id },
    'IM group unbound from workspace main conversation',
  );
  return c.json({ success: true });
});

export default router;
