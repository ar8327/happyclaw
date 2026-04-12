// Task management routes

import { Hono } from 'hono';
import * as crypto from 'node:crypto';
import { CronExpressionParser } from 'cron-parser';
import type { Variables } from '../web-context.js';
import { authMiddleware } from '../middleware/auth.js';
import { TaskCreateSchema, TaskPatchSchema } from '../schemas.js';
import {
  getAllTasks,
  getTaskById,
  createTask,
  updateTask,
  deleteTask,
  getTaskRunLogs,
  getRegisteredGroup,
  getSessionRecord,
  getJidsByFolder,
} from '../db.js';
import type { AuthUser, ScheduledTask, SessionRecord } from '../types.js';
import { TIMEZONE } from '../config.js';
import {
  isHostExecutionGroup,
  hasHostExecutionPermission,
  canAccessGroup,
} from '../web-context.js';

const tasksRoutes = new Hono<{ Variables: Variables }>();

function resolveTaskSession(id: string): SessionRecord | undefined {
  const direct = getSessionRecord(id);
  if (direct) return direct;
  const backingGroup = getRegisteredGroup(id);
  if (!backingGroup || !id.startsWith('web:')) return undefined;
  return getSessionRecord(`main:${backingGroup.folder}`);
}

function getFolderForTaskSession(session: SessionRecord): string | null {
  if (session.id.startsWith('main:')) return session.id.slice('main:'.length);
  if (session.parent_session_id?.startsWith('main:')) {
    return session.parent_session_id.slice('main:'.length);
  }
  return null;
}

function resolveTaskTarget(
  sessionId: string,
): {
  session: SessionRecord;
  group: NonNullable<ReturnType<typeof getRegisteredGroup>>;
  chatJid: string;
  groupFolder: string;
} | null {
  const session = resolveTaskSession(sessionId);
  if (!session) return null;
  if (session.kind !== 'main' && session.kind !== 'workspace') return null;

  const folder = getFolderForTaskSession(session);
  if (!folder) return null;
  const chatJid = getJidsByFolder(folder).find((jid) => jid.startsWith('web:'));
  if (!chatJid) return null;
  const group = getRegisteredGroup(chatJid);
  if (!group) return null;
  return { session, group, chatJid, groupFolder: folder };
}

function buildTaskPayload(task: ScheduledTask): ScheduledTask {
  const sessionId = task.session_id?.trim() || `main:${task.group_folder}`;
  const session = resolveTaskSession(sessionId);
  return {
    ...task,
    session_id: session?.id || sessionId,
    session_name: session?.name || getRegisteredGroup(task.chat_jid)?.name || null,
  };
}

function resolveStoredTaskTarget(
  task: ScheduledTask,
): {
  session: SessionRecord;
  group: NonNullable<ReturnType<typeof getRegisteredGroup>>;
  chatJid: string;
  groupFolder: string;
} | null {
  const sessionId = task.session_id?.trim();
  if (sessionId) {
    const target = resolveTaskTarget(sessionId);
    if (target) return target;
  }

  const legacyGroup = getRegisteredGroup(task.chat_jid);
  if (!legacyGroup || legacyGroup.folder !== task.group_folder) return null;
  const session = getSessionRecord(`main:${task.group_folder}`);
  return session
    ? {
        session,
        group: legacyGroup,
        chatJid: task.chat_jid,
        groupFolder: task.group_folder,
      }
    : null;
}

// --- Routes ---

tasksRoutes.get('/', authMiddleware, (c) => {
  const authUser = c.get('user') as AuthUser;
  const tasks = getAllTasks().filter((task) => {
    const group =
      resolveStoredTaskTarget(task)?.group || getRegisteredGroup(task.chat_jid);
    // Conservative: if group can't be resolved, only admin can see (may be orphaned task)
    if (!group) return authUser.role === 'admin';
    if (!canAccessGroup({ id: authUser.id, role: authUser.role }, group))
      return false;
    if (isHostExecutionGroup(group) && !hasHostExecutionPermission(authUser))
      return false;
    return true;
  });
  return c.json({ tasks: tasks.map(buildTaskPayload) });
});

tasksRoutes.post('/', authMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({}));

  const validation = TaskCreateSchema.safeParse(body);
  if (!validation.success) {
    return c.json(
      { error: 'Invalid request body', details: validation.error.format() },
      400,
    );
  }

  const {
    session_id,
    group_folder,
    chat_jid,
    prompt,
    schedule_type,
    schedule_value,
    context_mode,
    execution_type,
    script_command,
    model,
  } = validation.data;
  const target = session_id
    ? resolveTaskTarget(session_id)
    : (
      chat_jid && group_folder
        ? (() => {
            const legacyGroup = getRegisteredGroup(chat_jid);
            if (!legacyGroup || legacyGroup.folder !== group_folder) return null;
            const session = getSessionRecord(`main:${group_folder}`);
            return session
              ? {
                  session,
                  group: legacyGroup,
                  chatJid: chat_jid,
                  groupFolder: group_folder,
                }
              : null;
          })()
        : null
    );
  if (!target) {
    return c.json({ error: 'Session not found or cannot accept tasks' }, 404);
  }
  const { session, group, chatJid, groupFolder } = target;
  if (
    session_id &&
    group_folder &&
    groupFolder !== group_folder
  ) {
    return c.json({ error: 'session_id does not match group_folder' }, 400);
  }
  if (
    session_id &&
    chat_jid &&
    chatJid !== chat_jid
  ) {
    return c.json({ error: 'session_id does not match chat_jid' }, 400);
  }
  const authUser = c.get('user') as AuthUser;
  if (!canAccessGroup({ id: authUser.id, role: authUser.role }, group)) {
    return c.json({ error: 'Group not found' }, 404);
  }
  if (isHostExecutionGroup(group) && !hasHostExecutionPermission(authUser)) {
    return c.json(
      { error: 'Insufficient permissions for local runtime workspace access' },
      403,
    );
  }

  // Only admin can create script tasks
  const execType = execution_type || 'agent';
  if (execType === 'script' && authUser.role !== 'admin') {
    return c.json({ error: '只有管理员可以创建脚本类型任务' }, 403);
  }

  const taskId = crypto.randomUUID();
  const now = new Date().toISOString();

  let nextRun: string;
  if (schedule_type === 'cron') {
    nextRun =
      CronExpressionParser.parse(schedule_value, { tz: TIMEZONE })
        .next()
        .toISOString() ?? new Date().toISOString();
  } else if (schedule_type === 'interval') {
    nextRun = new Date(Date.now() + parseInt(schedule_value, 10)).toISOString();
  } else {
    // once — use the target time from schedule_value
    nextRun = new Date(schedule_value).toISOString();
  }

  createTask({
    id: taskId,
    session_id: session.id,
    group_folder: groupFolder,
    chat_jid: chatJid,
    prompt: prompt || '',
    schedule_type,
    schedule_value,
    context_mode: context_mode || 'isolated',
    execution_type: execType,
    script_command: script_command ?? null,
    next_run: nextRun,
    status: 'active',
    created_at: now,
    created_by: authUser.id,
    model: model ?? undefined,
  });

  return c.json({ success: true, taskId });
});

tasksRoutes.patch('/:id', authMiddleware, async (c) => {
  const id = c.req.param('id');
  const existing = getTaskById(id);
  if (!existing) return c.json({ error: 'Task not found' }, 404);
  const authUser = c.get('user') as AuthUser;
  const group =
    resolveStoredTaskTarget(existing)?.group || getRegisteredGroup(existing.chat_jid);
  if (!group) {
    if (authUser.role !== 'admin')
      return c.json({ error: 'Task not found' }, 404);
  } else {
    if (!canAccessGroup({ id: authUser.id, role: authUser.role }, group)) {
      return c.json({ error: 'Task not found' }, 404);
    }
    if (isHostExecutionGroup(group) && !hasHostExecutionPermission(authUser)) {
      return c.json(
        { error: 'Insufficient permissions for local runtime workspace access' },
        403,
      );
    }
  }
  const body = await c.req.json().catch(() => ({}));

  const validation = TaskPatchSchema.safeParse(body);
  if (!validation.success) {
    return c.json(
      { error: 'Invalid request body', details: validation.error.format() },
      400,
    );
  }

  // Only admin can create/modify script tasks
  const isScriptTask =
    validation.data.execution_type === 'script' ||
    (existing.execution_type === 'script' &&
      validation.data.script_command !== undefined);
  if (isScriptTask && authUser.role !== 'admin') {
    return c.json({ error: '只有管理员可以创建或修改脚本类型任务' }, 403);
  }

  updateTask(id, validation.data);

  return c.json({ success: true });
});

tasksRoutes.delete('/:id', authMiddleware, (c) => {
  const id = c.req.param('id');
  const existing = getTaskById(id);
  if (!existing) return c.json({ error: 'Task not found' }, 404);
  const authUser = c.get('user') as AuthUser;
  const group =
    resolveStoredTaskTarget(existing)?.group || getRegisteredGroup(existing.chat_jid);
  if (!group) {
    if (authUser.role !== 'admin')
      return c.json({ error: 'Task not found' }, 404);
  } else {
    if (!canAccessGroup({ id: authUser.id, role: authUser.role }, group)) {
      return c.json({ error: 'Task not found' }, 404);
    }
    if (isHostExecutionGroup(group) && !hasHostExecutionPermission(authUser)) {
      return c.json(
        { error: 'Insufficient permissions for local runtime workspace access' },
        403,
      );
    }
  }
  deleteTask(id);
  return c.json({ success: true });
});

tasksRoutes.get('/:id/logs', authMiddleware, (c) => {
  const id = c.req.param('id');
  const existing = getTaskById(id);
  if (!existing) return c.json({ error: 'Task not found' }, 404);
  const authUser = c.get('user') as AuthUser;
  const group =
    resolveStoredTaskTarget(existing)?.group || getRegisteredGroup(existing.chat_jid);
  if (!group) {
    if (authUser.role !== 'admin')
      return c.json({ error: 'Task not found' }, 404);
  } else {
    if (!canAccessGroup({ id: authUser.id, role: authUser.role }, group)) {
      return c.json({ error: 'Task not found' }, 404);
    }
    if (isHostExecutionGroup(group) && !hasHostExecutionPermission(authUser)) {
      return c.json(
        { error: 'Insufficient permissions for local runtime workspace access' },
        403,
      );
    }
  }
  const limitRaw = parseInt(c.req.query('limit') || '20', 10);
  const limit = Math.min(
    Number.isFinite(limitRaw) ? Math.max(1, limitRaw) : 20,
    200,
  );
  const logs = getTaskRunLogs(id, limit);
  return c.json({ logs });
});

export default tasksRoutes;
