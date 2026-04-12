import { CronExpressionParser } from 'cron-parser';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR, SCHEDULER_POLL_INTERVAL, TIMEZONE } from './config.js';
import { DailySummaryDeps, runDailySummaryIfNeeded } from './daily-summary.js';
import {
  GlobalSleepDeps,
  runMemoryGlobalSleepIfNeeded,
} from './memory-agent.js';
import {
  cleanupOldTaskRunLogs,
  ensureChatExists,
  getDueTasks,
  getSessionRecord,
  getTaskById,
  logTaskRun,
  storeMessageDirect,
  updateTaskAfterRun,
} from './db.js';
import { logger } from './logger.js';
import { hasScriptCapacity, runScript } from './script-runner.js';
import { NewMessage, RegisteredGroup, ScheduledTask } from './types.js';

export interface SchedulerDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  broadcastNewMessage: (
    chatJid: string,
    msg: NewMessage & { is_from_me?: boolean },
  ) => void;
  sendMessage: (
    jid: string,
    text: string,
  ) => Promise<string | undefined | void>;
  assistantName: string;
  dailySummaryDeps?: DailySummaryDeps;
  globalSleepDeps?: GlobalSleepDeps;
}

function computeNextRun(task: ScheduledTask): string | null {
  if (task.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(task.schedule_value, {
      tz: TIMEZONE,
    });
    return interval.next().toISOString();
  } else if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    const anchor = task.next_run
      ? new Date(task.next_run).getTime()
      : Date.now();
    let nextTime = anchor + ms;
    while (nextTime <= Date.now()) {
      nextTime += ms;
    }
    return new Date(nextTime).toISOString();
  }
  // 'once' tasks have no next run
  return null;
}

/**
 * Trigger an agent task by inserting a message into the chat.
 * The message will be picked up by the regular message polling loop
 * and processed by processGroupMessages() like any other message.
 */
function triggerAgentTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
  targetGroupJid: string,
): void {
  // 1. Immediately update next_run to prevent re-triggering in 60s
  const nextRun = computeNextRun(task);
  updateTaskAfterRun(task.id, nextRun, '已触发');

  // 2. Log the trigger
  logTaskRun({
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: 0,
    status: 'success',
    result: '已触发',
    error: null,
  });

  // 3. Insert message into chat
  const msgId = `task-${task.id}-${Date.now()}`;
  const timestamp = new Date().toISOString();
  ensureChatExists(targetGroupJid);
  storeMessageDirect(
    msgId,
    targetGroupJid,
    '__task__',
    '[定时任务]',
    `[task:${task.id}] ${task.prompt}`,
    timestamp,
    false,
  );

  // 4. Broadcast to WebSocket clients
  deps.broadcastNewMessage(targetGroupJid, {
    id: msgId,
    chat_jid: targetGroupJid,
    sender: '__task__',
    sender_name: '[定时任务]',
    content: `[task:${task.id}] ${task.prompt}`,
    timestamp,
    is_from_me: false,
  });

  logger.info(
    { taskId: task.id, groupJid: targetGroupJid, nextRun },
    'Scheduled task triggered as message',
  );
}

async function runScriptTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
  groupJid: string,
): Promise<void> {
  const startTime = Date.now();

  logger.info(
    { taskId: task.id, group: task.group_folder, executionType: 'script' },
    'Running script task',
  );

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
      result = scriptResult.stdout.trim() || '(无输出)';
    }

    // Send result to user
    const text = error
      ? `[脚本] 执行失败: ${error}${result ? `\n输出:\n${result.slice(0, 500)}` : ''}`
      : `[脚本] ${result!.slice(0, 1000)}`;

    await deps.sendMessage(groupJid, `${deps.assistantName}: ${text}`);

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

  const nextRun = computeNextRun(task);
  const resultSummary = error
    ? `Error: ${error}`
    : result
      ? result.slice(0, 200)
      : 'Completed';
  updateTaskAfterRun(task.id, nextRun, resultSummary);
}

let schedulerRunning = false;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
let lastCleanupTime = 0;

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;
  logger.info('Scheduler loop started');

  const loop = async () => {
    try {
      // Periodic cleanup of old task run logs (every 24h)
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

      // Memory Agent global_sleep
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
        // Re-check task status in case it was paused/cancelled
        const currentTask = getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') {
          continue;
        }

        const groups = deps.registeredGroups();
        let targetGroupJid = currentTask.chat_jid;
        const directTarget = groups[targetGroupJid];
        if (!directTarget || directTarget.folder !== currentTask.group_folder) {
          const sameFolder = Object.entries(groups).filter(
            ([, group]) => group.folder === currentTask.group_folder,
          );
          const preferred =
            sameFolder.find(([jid]) => jid.startsWith('web:')) || sameFolder[0];
          targetGroupJid = preferred?.[0] || '';
        }

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
          // Script tasks run directly, not through message injection
          runScriptTask(currentTask, deps, targetGroupJid).catch((err) => {
            logger.error(
              { taskId: currentTask.id, err },
              'Unhandled error in runScriptTask',
            );
          });
        } else {
          // Agent tasks: inject a message into the chat
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
