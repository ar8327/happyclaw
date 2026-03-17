import crypto from 'node:crypto';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR, SCHEDULER_POLL_INTERVAL, TIMEZONE } from './config.js';
import type { DailySummaryDeps } from './daily-summary.js';
import { GlobalSleepDeps, runMemoryGlobalSleepIfNeeded } from './memory-agent.js';
import {
  cleanupOldTaskRunLogs,
  cleanupStaleRunningLogs,
  deleteGroupData,
  ensureChatExists,
  getAllTasks,
  getDueTasks,
  getTaskById,
  getUserById,
  logTaskRun,
  logTaskRunStart,
  storeMessageDirect,
  updateTaskAfterRun,
} from './db.js';
import { logger } from './logger.js';
import { removeFlowArtifacts } from './file-manager.js';
import { hasScriptCapacity, runScript } from './script-runner.js';
import { checkBillingAccessFresh, isBillingEnabled } from './billing.js';
import { NewMessage, RegisteredGroup, ScheduledTask } from './types.js';

/**
 * Resolve the actual group JID to send a task to.
 * Falls back from the task's stored chat_jid to any group matching the same folder.
 */
function resolveTargetGroupJid(
  task: ScheduledTask,
  groups: Record<string, RegisteredGroup>,
): string {
  const directTarget = groups[task.chat_jid];
  if (directTarget && directTarget.folder === task.group_folder) {
    return task.chat_jid;
  }
  const sameFolder = Object.entries(groups).filter(
    ([, g]) => g.folder === task.group_folder,
  );
  const preferred =
    sameFolder.find(([jid]) => jid.startsWith('web:')) || sameFolder[0];
  return preferred?.[0] || '';
}

export interface SchedulerDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  broadcastNewMessage: (
    chatJid: string,
    msg: NewMessage & { is_from_me?: boolean },
  ) => void;
  sendMessage: (
    jid: string,
    text: string,
    options?: { source?: string },
  ) => Promise<string | undefined | void>;
  assistantName: string;
  dailySummaryDeps?: DailySummaryDeps;
  globalSleepDeps?: GlobalSleepDeps;
}

const runningTaskIds = new Set<string>();

export function getRunningTaskIds(): string[] {
  return [...runningTaskIds];
}

function computeNextRun(task: ScheduledTask): string | null {
  if (task.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(task.schedule_value, {
      tz: TIMEZONE,
    });
    return interval.next().toISOString();
  }
  if (task.schedule_type === 'interval') {
    const ms = Number(task.schedule_value);
    if (!Number.isFinite(ms) || ms <= 0) return null;
    const anchor = task.next_run
      ? new Date(task.next_run).getTime()
      : Date.now();
    const now = Date.now();
    const elapsed = now - anchor;
    const periods = elapsed > 0 ? Math.ceil(elapsed / ms) : 1;
    return new Date(anchor + periods * ms).toISOString();
  }
  return null;
}

/**
 * Re-check DB before running — task may have been cancelled/paused while queued.
 * Returns true if the task is still active and should proceed.
 */
function isTaskStillActive(taskId: string, label?: string): boolean {
  const currentTask = getTaskById(taskId);
  if (!currentTask || currentTask.status !== 'active') {
    logger.info(
      { taskId },
      `Skipping ${label ?? 'task'}: deleted or no longer active since enqueue`,
    );
    return false;
  }
  return true;
}

/**
 * Inject an agent task into the target chat as a synthetic user message.
 * This keeps scheduled task execution on the normal message-processing path.
 */
function triggerAgentTask(
  staleTask: ScheduledTask,
  deps: SchedulerDependencies,
  targetGroupJid: string,
  manualRun = false,
): void {
  if (!manualRun && !isTaskStillActive(staleTask.id, 'task')) return;

  const task = getTaskById(staleTask.id);
  if (!task) return;
  if (runningTaskIds.has(task.id)) return;

  runningTaskIds.add(task.id);
  const startTime = Date.now();
  const nextRun = manualRun ? task.next_run : computeNextRun(task);

  try {
    ensureChatExists(targetGroupJid);
    const msgId = `task-${task.id}-${crypto.randomUUID()}`;
    const timestamp = new Date().toISOString();
    const content = `[task:${task.id}] ${task.prompt}`;

    storeMessageDirect(
      msgId,
      targetGroupJid,
      '__task__',
      '[定时任务]',
      content,
      timestamp,
      false,
      {
        sourceJid: targetGroupJid,
        meta: {
          sourceKind: 'scheduled_task_prompt',
        },
      },
    );

    deps.broadcastNewMessage(targetGroupJid, {
      id: msgId,
      chat_jid: targetGroupJid,
      source_jid: targetGroupJid,
      sender: '__task__',
      sender_name: '[定时任务]',
      content,
      timestamp,
      source_kind: 'scheduled_task_prompt',
      is_from_me: false,
    });

    logTaskRun({
      task_id: task.id,
      run_at: timestamp,
      duration_ms: Date.now() - startTime,
      status: 'success',
      result: manualRun ? '已手动触发' : '已触发',
      error: null,
    });
    updateTaskAfterRun(
      task.id,
      nextRun,
      manualRun ? '已手动触发' : '已触发',
    );

    logger.info(
      { taskId: task.id, groupJid: targetGroupJid, manualRun, nextRun },
      'Scheduled agent task injected as message',
    );
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error,
    });
    updateTaskAfterRun(task.id, nextRun, `Error: ${error}`);
    logger.error({ taskId: task.id, error }, 'Failed to inject scheduled task');
  } finally {
    runningTaskIds.delete(task.id);
  }
}

async function runScriptTask(
  staleTask: ScheduledTask,
  deps: SchedulerDependencies,
  groupJid: string,
  manualRun = false,
): Promise<void> {
  if (!manualRun && !isTaskStillActive(staleTask.id, 'script task')) return;

  const task = getTaskById(staleTask.id);
  if (!task) return;

  runningTaskIds.add(task.id);
  const startTime = Date.now();
  const runLogId = logTaskRunStart(task.id);

  logger.info(
    { taskId: task.id, group: task.group_folder, executionType: 'script' },
    'Running script task',
  );

  if (isBillingEnabled() && task.group_folder) {
    const groups = deps.registeredGroups();
    const group = groups[groupJid];
    if (group?.created_by) {
      const owner = getUserById(group.created_by);
      if (owner && owner.role !== 'admin') {
        const accessResult = checkBillingAccessFresh(group.created_by, owner.role);
        if (!accessResult.allowed) {
          const reason = accessResult.reason || '当前账户不可用';
          logger.info(
            {
              taskId: task.id,
              userId: group.created_by,
              reason,
              blockType: accessResult.blockType,
            },
            'Billing access denied, blocking script task',
          );
          logTaskRun({
            task_id: task.id,
            run_at: new Date().toISOString(),
            duration_ms: Date.now() - startTime,
            status: 'error',
            result: null,
            error: `计费限制: ${reason}`,
          });
          const nextRun = manualRun ? task.next_run : computeNextRun(task);
          updateTaskAfterRun(task.id, nextRun, `Error: 计费限制: ${reason}`);
          return;
        }
      }
    }
  }

  const groupDir = path.join(GROUPS_DIR, task.group_folder);
  fs.mkdirSync(groupDir, { recursive: true });

  if (!task.script_command) {
    logger.error(
      { taskId: task.id },
      'Script task has no script_command, skipping',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: 'script_command is empty',
    });
    runningTaskIds.delete(task.id);
    return;
  }

  let result: string | null = null;
  let error: string | null = null;

  try {
    const scriptResult = await runScript(
      task.script_command,
      task.group_folder,
    );

    if (scriptResult.timedOut) {
      error = `脚本执行超时 (${Math.round(scriptResult.durationMs / 1000)}s)`;
    } else if (scriptResult.exitCode !== 0) {
      error = scriptResult.stderr.trim() || `退出码: ${scriptResult.exitCode}`;
      result = scriptResult.stdout.trim() || null;
    } else {
      result = scriptResult.stdout.trim() || null;
    }

    if (error || result) {
      const text = error
        ? `[脚本] 执行失败: ${error}${result ? `\n输出:\n${result.slice(0, 500)}` : ''}`
        : `[脚本] ${result!.slice(0, 1000)}`;

      await deps.sendMessage(groupJid, `${deps.assistantName}: ${text}`, {
        source: 'scheduled_task',
      });
    }

    logger.info(
      {
        taskId: task.id,
        durationMs: Date.now() - startTime,
        exitCode: scriptResult.exitCode,
      },
      'Script task completed',
    );
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    logger.error({ taskId: task.id, error }, 'Script task failed');
  } finally {
    runningTaskIds.delete(task.id);
  }

  const durationMs = Date.now() - startTime;

  logTaskRun({
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: durationMs,
    status: error ? 'error' : 'success',
    result,
    error,
  });

  const nextRun = manualRun ? task.next_run : computeNextRun(task);
  const resultSummary = error
    ? `Error: ${error}`
    : result
      ? result.slice(0, 200)
      : 'Completed';
  updateTaskAfterRun(task.id, nextRun, resultSummary);
}

let schedulerRunning = false;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
let lastCleanupTime = 0;

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;

  runningTaskIds.clear();
  try {
    const cleaned = cleanupStaleRunningLogs();
    if (cleaned > 0) {
      logger.info({ cleaned }, 'Cleaned up stale running task logs from previous session');
    }
  } catch (err) {
    logger.error({ err }, 'Failed to cleanup stale running task logs');
  }

  try {
    const allTasks = getAllTasks();
    const groups = deps.registeredGroups();
    let cleaned = 0;
    for (const task of allTasks) {
      if (
        task.schedule_type === 'once' &&
        task.status === 'completed' &&
        task.workspace_jid &&
        task.workspace_folder &&
        groups[task.workspace_jid]
      ) {
        deleteGroupData(task.workspace_jid, task.workspace_folder);
        delete groups[task.workspace_jid];
        removeFlowArtifacts(task.workspace_folder);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      logger.info({ cleaned }, 'Cleaned up orphaned once-task workspaces from previous session');
    }
  } catch (err) {
    logger.error({ err }, 'Failed to cleanup orphaned once-task workspaces');
  }

  logger.info('Scheduler loop started');

  const loop = async () => {
    try {
      const now = Date.now();
      if (now - lastCleanupTime >= CLEANUP_INTERVAL_MS) {
        lastCleanupTime = now;
        try {
          const deleted = cleanupOldTaskRunLogs();
          if (deleted > 0) {
            logger.info({ deleted }, 'Cleaned up old task run logs');
          }
        } catch (err) {
          logger.error({ err }, 'Failed to cleanup old task run logs');
        }
      }

      if (deps.globalSleepDeps) {
        try {
          runMemoryGlobalSleepIfNeeded(deps.globalSleepDeps);
        } catch (err) {
          logger.error({ err }, 'Memory global_sleep check failed');
        }
      }

      const dueTasks = getDueTasks();
      if (dueTasks.length > 0) {
        logger.info({ count: dueTasks.length }, 'Found due tasks');
      }

      for (const task of dueTasks) {
        const currentTask = getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') continue;
        if (runningTaskIds.has(currentTask.id)) continue;

        const groups = deps.registeredGroups();
        const targetGroupJid = resolveTargetGroupJid(currentTask, groups);

        if (!targetGroupJid) {
          logger.error(
            { taskId: currentTask.id, groupFolder: currentTask.group_folder },
            'Target group not registered, skipping scheduled task',
          );
          continue;
        }

        if (currentTask.execution_type === 'script') {
          if (!hasScriptCapacity()) {
            logger.debug(
              { taskId: currentTask.id },
              'Script concurrency limit reached, skipping',
            );
            continue;
          }
          runScriptTask(currentTask, deps, targetGroupJid).catch((err) => {
            logger.error(
              { taskId: currentTask.id, err },
              'Unhandled error in runScriptTask',
            );
          });
        } else {
          triggerAgentTask(currentTask, deps, targetGroupJid);
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}

/**
 * Manually trigger a task to run now (fire-and-forget).
 * Does not change next_run — the task continues its normal schedule.
 */
export function triggerTaskNow(
  taskId: string,
  deps: SchedulerDependencies,
): { success: boolean; error?: string } {
  const task = getTaskById(taskId);
  if (!task) return { success: false, error: 'Task not found' };
  if (task.status === 'completed') {
    return { success: false, error: 'Task already completed' };
  }
  if (task.status === 'paused') {
    return { success: false, error: '任务已暂停，请先恢复后再运行' };
  }
  if (runningTaskIds.has(taskId)) {
    return { success: false, error: 'Task is already running' };
  }

  const groups = deps.registeredGroups();
  const targetGroupJid = resolveTargetGroupJid(task, groups);
  if (!targetGroupJid) {
    return { success: false, error: 'Target group not registered' };
  }

  if (task.execution_type === 'script') {
    if (!hasScriptCapacity()) {
      return { success: false, error: 'Script concurrency limit reached' };
    }
    runScriptTask(task, deps, targetGroupJid, true).catch((err) =>
      logger.error({ taskId, err }, 'Manual script task failed'),
    );
  } else {
    triggerAgentTask(task, deps, targetGroupJid, true);
  }

  return { success: true };
}
