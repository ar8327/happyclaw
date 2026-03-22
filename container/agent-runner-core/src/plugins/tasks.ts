/**
 * TasksPlugin — schedule_task, list_tasks, pause_task, resume_task, cancel_task tools.
 *
 * All communicate with the host process via IPC files in the tasks/ directory.
 */

import fs from 'fs';
import path from 'path';
import type { ContextPlugin, PluginContext, ToolDefinition, ToolResult } from '../plugin.js';
import { writeIpcFile } from '../ipc.js';

export class TasksPlugin implements ContextPlugin {
  readonly name = 'tasks';

  isEnabled(_ctx: PluginContext): boolean {
    return true;
  }

  getTools(ctx: PluginContext): ToolDefinition[] {
    const TASKS_DIR = path.join(ctx.workspaceIpc, 'tasks');
    const hasCrossGroupAccess = ctx.isAdminHome;

    return [
      // --- schedule_task ---
      {
        name: 'schedule_task',
        description:
          `Schedule a recurring or one-time task.

EXECUTION TYPE:
• "agent" (default): When triggered, a [定时任务] message is sent in the current conversation.
• "script" (admin only): Task runs a shell command directly on the host. Zero API token cost.

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
• cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am)
• interval: Milliseconds between runs (e.g., "300000" for 5 minutes)
• once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00")`,
        parameters: {
          type: 'object' as const,
          properties: {
            prompt: {
              type: 'string',
              description: 'What the agent should do (agent mode) or task description (script mode, optional).',
            },
            schedule_type: {
              type: 'string',
              enum: ['cron', 'interval', 'once'],
              description: 'cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time',
            },
            schedule_value: {
              type: 'string',
              description: 'cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00"',
            },
            execution_type: {
              type: 'string',
              enum: ['agent', 'script'],
              description: 'agent=full Claude Agent (default), script=shell command (admin only)',
            },
            script_command: {
              type: 'string',
              description: 'Shell command to execute (required for script mode).',
            },
            context_mode: {
              type: 'string',
              enum: ['group', 'isolated'],
              description: 'Deprecated. Always uses group mode.',
            },
            target_group_jid: {
              type: 'string',
              description: '(Admin home only) JID of the group to schedule the task for.',
            },
            model: {
              type: 'string',
              description: 'Model override for this task (e.g., "opus", "sonnet", "haiku"). If omitted, uses the workspace default.',
            },
          },
          required: ['schedule_type', 'schedule_value'],
        },
        execute: async (args: Record<string, unknown>): Promise<ToolResult> => {
          const execType = (args.execution_type as string) || 'agent';
          const prompt = (args.prompt as string) || '';
          const scriptCommand = args.script_command as string | undefined;

          // Validation
          if (execType === 'agent' && !prompt.trim()) {
            return { content: 'Agent mode requires a prompt. Provide instructions for what the agent should do.', isError: true };
          }
          if (execType === 'script' && !scriptCommand?.trim()) {
            return { content: 'Script mode requires script_command. Provide the shell command to execute.', isError: true };
          }
          if (execType === 'script' && !ctx.isAdminHome) {
            return { content: 'Only admin home container can create script tasks.', isError: true };
          }

          // Validate schedule_value
          const scheduleType = args.schedule_type as string;
          const scheduleValue = args.schedule_value as string;

          if (scheduleType === 'cron') {
            try {
              // Dynamic import to avoid hard dependency
              const { CronExpressionParser } = await import('cron-parser');
              CronExpressionParser.parse(scheduleValue);
            } catch {
              return { content: `Invalid cron: "${scheduleValue}". Use format like "0 9 * * *" (daily 9am).`, isError: true };
            }
          } else if (scheduleType === 'interval') {
            const ms = parseInt(scheduleValue, 10);
            if (isNaN(ms) || ms <= 0) {
              return { content: `Invalid interval: "${scheduleValue}". Must be positive milliseconds.`, isError: true };
            }
          } else if (scheduleType === 'once') {
            const date = new Date(scheduleValue);
            if (isNaN(date.getTime())) {
              return { content: `Invalid timestamp: "${scheduleValue}". Use ISO 8601 format.`, isError: true };
            }
          }

          const targetJid = hasCrossGroupAccess && args.target_group_jid
            ? args.target_group_jid as string
            : ctx.chatJid;

          const data: Record<string, unknown> = {
            type: 'schedule_task',
            prompt,
            schedule_type: scheduleType,
            schedule_value: scheduleValue,
            context_mode: (args.context_mode as string) || 'group',
            execution_type: execType,
            targetJid,
            createdBy: ctx.groupFolder,
            timestamp: new Date().toISOString(),
          };
          if (execType === 'script') {
            data.script_command = scriptCommand;
          }
          if (args.model) {
            data.model = args.model;
          }
          const filename = writeIpcFile(TASKS_DIR, data);
          const modeLabel = execType === 'script' ? 'script' : 'agent';
          return { content: `Task scheduled [${modeLabel}] (${filename}): ${scheduleType} - ${scheduleValue}` };
        },
      },

      // --- list_tasks ---
      {
        name: 'list_tasks',
        description: "List all scheduled tasks. From admin home: shows all tasks. From other groups: shows only that group's tasks.",
        parameters: {
          type: 'object' as const,
          properties: {},
        },
        execute: async (): Promise<ToolResult> => {
          const tasksFile = path.join(ctx.workspaceIpc, 'current_tasks.json');
          try {
            if (!fs.existsSync(tasksFile)) {
              return { content: 'No scheduled tasks found.' };
            }
            const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));
            const tasks = hasCrossGroupAccess
              ? allTasks
              : allTasks.filter((t: { groupFolder: string }) => t.groupFolder === ctx.groupFolder);
            if (tasks.length === 0) {
              return { content: 'No scheduled tasks found.' };
            }
            const formatted = tasks
              .map((t: { id: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string }) =>
                `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
              )
              .join('\n');
            return { content: `Scheduled tasks:\n${formatted}` };
          } catch (err) {
            return { content: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}`, isError: true };
          }
        },
      },

      // --- pause_task ---
      {
        name: 'pause_task',
        description: 'Pause a scheduled task. It will not run until resumed.',
        parameters: {
          type: 'object' as const,
          properties: {
            task_id: { type: 'string', description: 'The task ID to pause' },
          },
          required: ['task_id'],
        },
        execute: async (args: Record<string, unknown>): Promise<ToolResult> => {
          writeIpcFile(TASKS_DIR, {
            type: 'pause_task',
            taskId: args.task_id,
            groupFolder: ctx.groupFolder,
            isAdminHome: hasCrossGroupAccess,
            timestamp: new Date().toISOString(),
          });
          return { content: `Task ${args.task_id} pause requested.` };
        },
      },

      // --- resume_task ---
      {
        name: 'resume_task',
        description: 'Resume a paused task.',
        parameters: {
          type: 'object' as const,
          properties: {
            task_id: { type: 'string', description: 'The task ID to resume' },
          },
          required: ['task_id'],
        },
        execute: async (args: Record<string, unknown>): Promise<ToolResult> => {
          writeIpcFile(TASKS_DIR, {
            type: 'resume_task',
            taskId: args.task_id,
            groupFolder: ctx.groupFolder,
            isAdminHome: hasCrossGroupAccess,
            timestamp: new Date().toISOString(),
          });
          return { content: `Task ${args.task_id} resume requested.` };
        },
      },

      // --- cancel_task ---
      {
        name: 'cancel_task',
        description: 'Cancel and delete a scheduled task.',
        parameters: {
          type: 'object' as const,
          properties: {
            task_id: { type: 'string', description: 'The task ID to cancel' },
          },
          required: ['task_id'],
        },
        execute: async (args: Record<string, unknown>): Promise<ToolResult> => {
          writeIpcFile(TASKS_DIR, {
            type: 'cancel_task',
            taskId: args.task_id,
            groupFolder: ctx.groupFolder,
            isAdminHome: hasCrossGroupAccess,
            timestamp: new Date().toISOString(),
          });
          return { content: `Task ${args.task_id} cancellation requested.` };
        },
      },
    ];
  }

  getSystemPromptSection(_ctx: PluginContext): string {
    return '';
  }
}
