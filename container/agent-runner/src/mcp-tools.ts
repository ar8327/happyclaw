/**
 * MCP Tool Definitions for HappyClaw Agent Runner.
 *
 * Uses SDK's `tool()` helper to define in-process MCP tools.
 * These tools communicate with the host process via IPC files.
 *
 * Context (chatJid, groupFolder, etc.) is passed via McpContext
 * rather than read from environment variables, enabling in-process usage.
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

/** Context required by MCP tools. Passed at construction time. */
export interface McpContext {
  chatJid: string;
  groupFolder: string;
  isHome: boolean;
  isAdminHome: boolean;
  workspaceIpc: string;
  workspaceGroup: string;
  workspaceGlobal: string;
  workspaceMemory: string;
  userId?: string;
}

export function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

/**
 * Create all HappyClaw MCP tool definitions for in-process SDK MCP server.
 */
export function createMcpTools(ctx: McpContext): SdkMcpToolDefinition<any>[] {
  const MESSAGES_DIR = path.join(ctx.workspaceIpc, 'messages');
  const TASKS_DIR = path.join(ctx.workspaceIpc, 'tasks');
  const hasCrossGroupAccess = ctx.isAdminHome;

  const tools: SdkMcpToolDefinition<any>[] = [
    // --- send_message ---
    tool(
      'send_message',
      "Send a message to an IM channel (Feishu/Telegram/QQ) or Web UI. " +
      "Your stdout only appears in Web UI and is never sent to IM. To reach IM users, you MUST call this tool with the channel parameter (from the message's source attribute, e.g. 'feishu:oc_xxx', 'telegram:123'). " +
      "IMPORTANT: IM users cannot see your streaming output, tool calls, or thinking process — from their perspective, you are silent until you explicitly send_message. " +
      "When handling a request that takes time (research, coding, file operations, etc.), send a brief acknowledgment FIRST (e.g. '我看看哦', 'let me check'), then do your work, then send the result. Do not make the user wait in silence.",
      {
        text: z.string().describe('The message text to send'),
        channel: z
          .string()
          .optional()
          .describe(
            "Target IM channel, taken from the message's source attribute (e.g. 'feishu:oc_xxx', 'telegram:123'). Omit to only display in Web UI.",
          ),
      },
      async (args) => {
        const data = {
          type: 'message',
          chatJid: ctx.chatJid,
          text: args.text,
          targetChannel: args.channel,
          groupFolder: ctx.groupFolder,
          timestamp: new Date().toISOString(),
        };
        writeIpcFile(MESSAGES_DIR, data);
        return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
      },
    ),

    // --- send_image ---
    tool(
      'send_image',
      "Send an image file from the workspace to an IM channel (Feishu/Telegram/QQ). The channel parameter is required — images can only be sent to IM channels. The file must be an image (PNG, JPEG, GIF, WebP, etc.) and must exist in the workspace.",
      {
        file_path: z
          .string()
          .describe(
            'Path to the image file in the workspace (relative to workspace root or absolute)',
          ),
        channel: z
          .string()
          .describe(
            "Target IM channel (required). Taken from the message's source attribute (e.g. 'feishu:oc_xxx', 'telegram:123').",
          ),
        caption: z
          .string()
          .optional()
          .describe('Optional caption text to send with the image'),
      },
      async (args) => {
        // Resolve path relative to workspace (try group first, then global)
        const absPath = path.isAbsolute(args.file_path)
          ? args.file_path
          : path.join(ctx.workspaceGroup, args.file_path);

        // Security: ensure path is within workspace group or global directory
        const resolved = path.resolve(absPath);
        const groupRoot = ctx.workspaceGroup.endsWith(path.sep)
          ? ctx.workspaceGroup
          : ctx.workspaceGroup + path.sep;
        const globalRoot = ctx.workspaceGlobal
          ? (ctx.workspaceGlobal.endsWith(path.sep)
              ? ctx.workspaceGlobal
              : ctx.workspaceGlobal + path.sep)
          : null;
        const inGroup = resolved === ctx.workspaceGroup || resolved.startsWith(groupRoot);
        const inGlobal = globalRoot && (resolved === ctx.workspaceGlobal || resolved.startsWith(globalRoot));
        if (!inGroup && !inGlobal) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Error: file path must be within workspace directory.`,
              },
            ],
            isError: true,
          };
        }

        // Check file exists
        if (!fs.existsSync(resolved)) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Error: file not found: ${args.file_path}`,
              },
            ],
            isError: true,
          };
        }

        // Read file and check size (10MB limit for both Feishu and Telegram)
        const stat = fs.statSync(resolved);
        if (stat.size > 10 * 1024 * 1024) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Error: image file too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). Maximum is 10MB.`,
              },
            ],
            isError: true,
          };
        }
        if (stat.size === 0) {
          return {
            content: [
              { type: 'text' as const, text: `Error: image file is empty.` },
            ],
            isError: true,
          };
        }

        const buffer = fs.readFileSync(resolved);
        const base64 = buffer.toString('base64');

        // Detect MIME type from magic bytes
        const { detectImageMimeTypeFromBase64Strict } =
          await import('./image-detector.js');
        const mimeType = detectImageMimeTypeFromBase64Strict(base64);
        if (!mimeType) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Error: file does not appear to be a supported image format (PNG, JPEG, GIF, WebP, TIFF, BMP).`,
              },
            ],
            isError: true,
          };
        }

        const data = {
          type: 'image',
          chatJid: ctx.chatJid,
          targetChannel: args.channel,
          imageBase64: base64,
          mimeType,
          caption: args.caption || undefined,
          fileName: path.basename(resolved),
          groupFolder: ctx.groupFolder,
          timestamp: new Date().toISOString(),
        };
        writeIpcFile(MESSAGES_DIR, data);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Image sent: ${path.basename(resolved)} (${mimeType}, ${(stat.size / 1024).toFixed(1)}KB)`,
            },
          ],
        };
      },
    ),

    // --- send_file ---
    tool(
      'send_file',
      `Send a file to an IM channel (Feishu/Telegram/QQ). The channel parameter is required — files can only be sent to IM channels.
Supports: PDF, DOC, XLS, PPT, MP4, etc. Max file size: 30MB.`,
      {
        filePath: z
          .string()
          .describe(
            'File path relative to workspace/group (e.g., "output/report.pdf")',
          ),
        fileName: z
          .string()
          .describe('File name to display (e.g., "report.pdf")'),
        channel: z
          .string()
          .describe(
            "Target IM channel (required). Taken from the message's source attribute (e.g. 'feishu:oc_xxx', 'telegram:123').",
          ),
      },
      async (args) => {
        // Handle both absolute and relative paths
        let resolvedPath: string;
        let relativePath: string;

        if (path.isAbsolute(args.filePath)) {
          // Absolute path provided - validate within workspace group or global
          resolvedPath = path.resolve(args.filePath);
          const groupRoot = ctx.workspaceGroup.endsWith(path.sep)
            ? ctx.workspaceGroup
            : ctx.workspaceGroup + path.sep;
          const globalRoot = ctx.workspaceGlobal
            ? (ctx.workspaceGlobal.endsWith(path.sep)
                ? ctx.workspaceGlobal
                : ctx.workspaceGlobal + path.sep)
            : null;
          const inGroup = resolvedPath === ctx.workspaceGroup || resolvedPath.startsWith(groupRoot);
          const inGlobal = globalRoot && (resolvedPath === ctx.workspaceGlobal || resolvedPath.startsWith(globalRoot));
          if (!inGroup && !inGlobal) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: 'Error: file must be within the workspace directory.',
                },
              ],
              isError: true,
            };
          }
          // Convert to relative path
          relativePath = path.relative(ctx.workspaceGroup, resolvedPath);
        } else {
          // Relative path provided
          relativePath = args.filePath;
          resolvedPath = path.resolve(ctx.workspaceGroup, args.filePath);
          // Validate resolved path is still within workspace
          const safeRoot = ctx.workspaceGroup.endsWith(path.sep)
            ? ctx.workspaceGroup
            : ctx.workspaceGroup + path.sep;
          if (
            resolvedPath !== ctx.workspaceGroup &&
            !resolvedPath.startsWith(safeRoot)
          ) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: 'Error: file must be within the workspace/group directory.',
                },
              ],
              isError: true,
            };
          }
        }

        if (!fs.existsSync(resolvedPath)) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Error: file not found: ${args.filePath}`,
              },
            ],
            isError: true,
          };
        }

        const data = {
          type: 'send_file',
          chatJid: ctx.chatJid,
          targetChannel: args.channel,
          filePath: relativePath,
          fileName: args.fileName,
          timestamp: new Date().toISOString(),
        };
        writeIpcFile(TASKS_DIR, data);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Sending file "${args.fileName}"...`,
            },
          ],
        };
      },
    ),

    // --- schedule_task ---
    tool(
      'schedule_task',
      `Schedule a recurring or one-time task.

EXECUTION TYPE:
\u2022 "agent" (default): When triggered, a [定时任务] message is sent in the current conversation. You will process it in your normal conversation context with full chat history and all tools available.
\u2022 "script" (admin only): Task runs a shell command directly on the host. Zero API token cost. Use for deterministic tasks like health checks, data collection, cURL calls, or cron-like scripts.

MESSAGING BEHAVIOR:
\u2022 Agent mode: You receive the task as a message in the conversation. Use send_message with channel parameter to notify IM users. Your stdout output only appears in Web UI.
\u2022 Script mode: stdout is sent as the result. stderr is included on failure.

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
      {
        prompt: z
          .string()
          .optional()
          .default('')
          .describe(
            'What the agent should do (agent mode) or task description (script mode, optional).',
          ),
        schedule_type: z
          .enum(['cron', 'interval', 'once'])
          .describe(
            'cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time',
          ),
        schedule_value: z
          .string()
          .describe(
            'cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)',
          ),
        execution_type: z
          .enum(['agent', 'script'])
          .default('agent')
          .describe(
            'agent=full Claude Agent (default), script=shell command (admin only, zero token cost)',
          ),
        script_command: z
          .string()
          .max(4096)
          .optional()
          .describe(
            'Shell command to execute (required for script mode). Runs in the group workspace directory.',
          ),
        context_mode: z
          .enum(['group', 'isolated'])
          .default('group')
          .describe(
            'Deprecated. Always uses group mode (task runs in conversation context).',
          ),
        target_group_jid: z
          .string()
          .optional()
          .describe(
            '(Admin home only) JID of the group to schedule the task for. Defaults to the current group.',
          ),
      },
      async (args) => {
        const execType = args.execution_type || 'agent';

        // Validate execution_type constraints
        if (execType === 'agent' && !args.prompt?.trim()) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Agent mode requires a prompt. Provide instructions for what the agent should do.',
              },
            ],
            isError: true,
          };
        }
        if (execType === 'script' && !args.script_command?.trim()) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Script mode requires script_command. Provide the shell command to execute.',
              },
            ],
            isError: true,
          };
        }
        if (execType === 'script' && !ctx.isAdminHome) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Only admin home container can create script tasks.',
              },
            ],
            isError: true,
          };
        }

        // Validate schedule_value before writing IPC
        if (args.schedule_type === 'cron') {
          try {
            CronExpressionParser.parse(args.schedule_value);
          } catch {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).`,
                },
              ],
              isError: true,
            };
          }
        } else if (args.schedule_type === 'interval') {
          const ms = parseInt(args.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).`,
                },
              ],
              isError: true,
            };
          }
        } else if (args.schedule_type === 'once') {
          const date = new Date(args.schedule_value);
          if (isNaN(date.getTime())) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Invalid timestamp: "${args.schedule_value}". Use ISO 8601 format like "2026-02-01T15:30:00.000Z".`,
                },
              ],
              isError: true,
            };
          }
        }

        const targetJid =
          hasCrossGroupAccess && args.target_group_jid
            ? args.target_group_jid
            : ctx.chatJid;
        const data: Record<string, unknown> = {
          type: 'schedule_task',
          prompt: args.prompt || '',
          schedule_type: args.schedule_type,
          schedule_value: args.schedule_value,
          context_mode: args.context_mode || 'group',
          execution_type: execType,
          targetJid,
          createdBy: ctx.groupFolder,
          timestamp: new Date().toISOString(),
        };
        if (execType === 'script') {
          data.script_command = args.script_command;
        }
        const filename = writeIpcFile(TASKS_DIR, data);
        const modeLabel = execType === 'script' ? 'script' : 'agent';
        return {
          content: [
            {
              type: 'text' as const,
              text: `Task scheduled [${modeLabel}] (${filename}): ${args.schedule_type} - ${args.schedule_value}`,
            },
          ],
        };
      },
    ),

    // --- list_tasks ---
    tool(
      'list_tasks',
      "List all scheduled tasks. From admin home: shows all tasks. From other groups: shows only that group's tasks.",
      {},
      async () => {
        const tasksFile = path.join(ctx.workspaceIpc, 'current_tasks.json');
        try {
          if (!fs.existsSync(tasksFile)) {
            return {
              content: [
                { type: 'text' as const, text: 'No scheduled tasks found.' },
              ],
            };
          }
          const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));
          const tasks = hasCrossGroupAccess
            ? allTasks
            : allTasks.filter(
                (t: { groupFolder: string }) =>
                  t.groupFolder === ctx.groupFolder,
              );
          if (tasks.length === 0) {
            return {
              content: [
                { type: 'text' as const, text: 'No scheduled tasks found.' },
              ],
            };
          }
          const formatted = tasks
            .map(
              (t: {
                id: string;
                prompt: string;
                schedule_type: string;
                schedule_value: string;
                status: string;
                next_run: string;
              }) =>
                `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
            )
            .join('\n');
          return {
            content: [
              { type: 'text' as const, text: `Scheduled tasks:\n${formatted}` },
            ],
          };
        } catch (err) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
          };
        }
      },
    ),

    // --- pause_task ---
    tool(
      'pause_task',
      'Pause a scheduled task. It will not run until resumed.',
      { task_id: z.string().describe('The task ID to pause') },
      async (args) => {
        const data = {
          type: 'pause_task',
          taskId: args.task_id,
          groupFolder: ctx.groupFolder,
          isMain: hasCrossGroupAccess,
          timestamp: new Date().toISOString(),
        };
        writeIpcFile(TASKS_DIR, data);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Task ${args.task_id} pause requested.`,
            },
          ],
        };
      },
    ),

    // --- resume_task ---
    tool(
      'resume_task',
      'Resume a paused task.',
      { task_id: z.string().describe('The task ID to resume') },
      async (args) => {
        const data = {
          type: 'resume_task',
          taskId: args.task_id,
          groupFolder: ctx.groupFolder,
          isMain: hasCrossGroupAccess,
          timestamp: new Date().toISOString(),
        };
        writeIpcFile(TASKS_DIR, data);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Task ${args.task_id} resume requested.`,
            },
          ],
        };
      },
    ),

    // --- cancel_task ---
    tool(
      'cancel_task',
      'Cancel and delete a scheduled task.',
      { task_id: z.string().describe('The task ID to cancel') },
      async (args) => {
        const data = {
          type: 'cancel_task',
          taskId: args.task_id,
          groupFolder: ctx.groupFolder,
          isMain: hasCrossGroupAccess,
          timestamp: new Date().toISOString(),
        };
        writeIpcFile(TASKS_DIR, data);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Task ${args.task_id} cancellation requested.`,
            },
          ],
        };
      },
    ),

    // --- register_group ---
    tool(
      'register_group',
      `Register a new group so the agent can respond to messages there. Admin home only.

Use available_groups.json to find the JID for a group. The folder name should be lowercase with hyphens (e.g., "family-chat").`,
      {
        jid: z.string().describe('The chat JID (e.g., "feishu:oc_xxxx")'),
        name: z.string().describe('Display name for the group'),
        folder: z
          .string()
          .describe(
            'Folder name for group files (lowercase, hyphens, e.g., "family-chat")',
          ),
      },
      async (args) => {
        if (!hasCrossGroupAccess) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Only the admin home container can register new groups.',
              },
            ],
            isError: true,
          };
        }
        const data = {
          type: 'register_group',
          jid: args.jid,
          name: args.name,
          folder: args.folder,
          timestamp: new Date().toISOString(),
        };
        writeIpcFile(TASKS_DIR, data);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Group "${args.name}" registered. It will start receiving messages immediately.`,
            },
          ],
        };
      },
    ),
  ];

  // --- Memory Agent tools ---
  const API_URL = process.env.HAPPYCLAW_API_URL || 'http://localhost:3000';
  const API_TOKEN = process.env.HAPPYCLAW_INTERNAL_TOKEN || '';

  // --- Feishu document reading tool ---
  if (ctx.userId) {
    tools.push(
      tool(
        'read_feishu_document',
        '读取飞书文档或 Wiki 页面的内容。支持 feishu.cn 和 larkoffice.com 的 wiki/docx 链接。' +
          '需要用户已在设置中完成飞书 OAuth 授权。',
        {
          url: z
            .string()
            .describe(
              '飞书文档 URL（如 https://xxx.feishu.cn/wiki/xxx 或 https://xxx.larkoffice.com/wiki/xxx）',
            ),
        },
        async (args) => {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 30000);
          try {
            const res = await fetch(
              `${API_URL}/api/internal/feishu/read-document`,
              {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${API_TOKEN}`,
                },
                body: JSON.stringify({
                  userId: ctx.userId,
                  url: args.url,
                }),
                signal: controller.signal,
              },
            );
            clearTimeout(timeout);

            if (!res.ok) {
              const errBody = await res.json().catch(() => ({}));
              const errMsg =
                (errBody as { error?: string }).error || '读取文档失败';
              const code = (errBody as { code?: string }).code;
              if (code === 'OAUTH_REQUIRED') {
                return {
                  content: [
                    {
                      type: 'text' as const,
                      text: '需要先完成飞书 OAuth 授权才能读取文档。请让用户在 Web 设置页面中完成「飞书文档授权」。',
                    },
                  ],
                  isError: true,
                };
              }
              return {
                content: [{ type: 'text' as const, text: errMsg }],
                isError: true,
              };
            }

            const data = (await res.json()) as {
              title?: string;
              content?: string;
            };
            const title = data.title ? `# ${data.title}\n\n` : '';
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `${title}${data.content || '（文档内容为空）'}`,
                },
              ],
            };
          } catch (err) {
            clearTimeout(timeout);
            const errMsg =
              err instanceof Error && err.name === 'AbortError'
                ? '读取飞书文档超时'
                : '无法连接到飞书文档服务';
            return {
              content: [{ type: 'text' as const, text: errMsg }],
              isError: true,
            };
          }
        },
      ),
    );
  }

  // --- Feishu document search tool ---
  if (ctx.userId) {
    tools.push(
      tool(
        'search_feishu_docs',
        '搜索飞书文档。根据关键词搜索云文档和 Wiki 页面，返回匹配的文档列表（标题、链接、预览）。' +
          '需要用户已在设置中完成飞书 OAuth 授权（含搜索权限）。' +
          '搜索结果中的文档可以用 read_feishu_document 工具进一步读取内容。',
        {
          query: z
            .string()
            .min(1)
            .describe('搜索关键词（不能为空）'),
          count: z
            .number()
            .min(1)
            .max(50)
            .optional()
            .describe('返回结果数量（默认 20，最大 50）'),
          search_wiki: z
            .boolean()
            .optional()
            .describe('是否同时搜索 Wiki（默认 true）'),
          doc_types: z
            .array(z.enum(['doc', 'docx', 'sheet', 'bitable', 'mindnote', 'wiki', 'slide']))
            .optional()
            .describe('筛选文档类型'),
        },
        async (args) => {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 30000);
          try {
            const res = await fetch(
              `${API_URL}/api/internal/feishu/search`,
              {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${API_TOKEN}`,
                },
                body: JSON.stringify({
                  userId: ctx.userId,
                  query: args.query,
                  count: args.count || 20,
                  searchWiki: args.search_wiki !== false,
                  docTypes: args.doc_types,
                }),
                signal: controller.signal,
              },
            );
            clearTimeout(timeout);

            if (!res.ok) {
              const errBody = await res.json().catch(() => ({}));
              const errMsg =
                (errBody as { error?: string }).error || '搜索飞书文档失败';
              const code = (errBody as { code?: string }).code;
              if (code === 'OAUTH_REQUIRED') {
                return {
                  content: [
                    {
                      type: 'text' as const,
                      text: '需要先完成飞书 OAuth 授权才能搜索文档。请让用户在 Web 设置页面中完成「飞书文档授权」（需包含搜索权限）。',
                    },
                  ],
                  isError: true,
                };
              }
              return {
                content: [{ type: 'text' as const, text: errMsg }],
                isError: true,
              };
            }

            const data = (await res.json()) as {
              results?: Array<{
                title?: string;
                url?: string;
                docType?: string;
                preview?: string;
                updateTime?: string;
              }>;
              hasMore?: boolean;
              total?: number;
            };

            const results = data.results || [];
            if (results.length === 0) {
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `没有找到与「${args.query}」相关的飞书文档。`,
                  },
                ],
              };
            }

            const formatted = results
              .map((r, i) => {
                const parts = [`${i + 1}. **${r.title || '无标题'}**`];
                if (r.docType) parts.push(`   类型: ${r.docType}`);
                if (r.url) parts.push(`   链接: ${r.url}`);
                if (r.preview) parts.push(`   预览: ${r.preview}`);
                if (r.updateTime) parts.push(`   更新: ${r.updateTime}`);
                return parts.join('\n');
              })
              .join('\n\n');

            const summary = `找到 ${data.total || results.length} 个结果${data.hasMore ? '（还有更多）' : ''}：\n\n${formatted}`;
            return {
              content: [{ type: 'text' as const, text: summary }],
            };
          } catch (err) {
            clearTimeout(timeout);
            const errMsg =
              err instanceof Error && err.name === 'AbortError'
                ? '搜索飞书文档超时'
                : '无法连接到飞书搜索服务';
            return {
              content: [{ type: 'text' as const, text: errMsg }],
              isError: true,
            };
          }
        },
      ),
    );
  }

  if (ctx.userId) {
    /** Shared HTTP helper for Memory Agent endpoints */
    async function callMemoryAgent(
      endpoint: string,
      body: object,
    ): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; status: number; errorMsg: string }> {
      const controller = new AbortController();
      // Read from env var, with a small buffer (add 5s) above the configured server-side timeout
      const queryTimeoutMs = parseInt(process.env.HAPPYCLAW_MEMORY_QUERY_TIMEOUT || '60000', 10);
      const httpTimeout = (Number.isFinite(queryTimeoutMs) && queryTimeoutMs > 0 ? queryTimeoutMs : 60000) + 5000;
      const timeout = setTimeout(() => controller.abort(), httpTimeout);
      try {
        const res = await fetch(`${API_URL}/api/internal/memory${endpoint}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${API_TOKEN}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (!res.ok) {
          const status = res.status;
          let errorMsg = '记忆系统暂时不可用';
          if (status === 408) errorMsg = '记忆系统处理超时，你可以直接告诉我相关信息';
          else if (status === 502) errorMsg = '记忆系统出了点问题，不过不影响我们继续聊';
          else if (status === 503) errorMsg = '上一个记忆查询还在处理中，稍等一下';
          return { ok: false, status, errorMsg };
        }

        const data = await res.json();
        return { ok: true, data };
      } catch (err) {
        clearTimeout(timeout);
        const errorMsg =
          err instanceof Error && err.name === 'AbortError'
            ? '记忆查询超时'
            : '无法连接记忆系统';
        return { ok: false, status: 0, errorMsg };
      }
    }

    tools.push(
      // --- memory_query ---
      tool(
        'memory_query',
        '向记忆系统查询。可以问关于过去对话、用户信息、项目知识的任何问题。查询可能需要几秒钟。',
        {
          query: z.string().describe('查询内容'),
          context: z
            .string()
            .optional()
            .describe('当前对话的简要上下文，帮助记忆系统更准确地搜索'),
          channel: z
            .string()
            .optional()
            .describe('消息来源渠道（取自 source 属性），用于定位对话上下文'),
        },
        async (args) => {
          const result = await callMemoryAgent('/query', {
            userId: ctx.userId,
            query: args.query,
            context: args.context,
            chatJid: args.channel || ctx.chatJid,
            groupFolder: ctx.groupFolder,
          });

          if (!result.ok) {
            return {
              content: [{ type: 'text' as const, text: result.errorMsg }],
              isError: true,
            };
          }

          return {
            content: [
              {
                type: 'text' as const,
                text: (result.data.response as string) || '没有找到相关记忆。',
              },
            ],
          };
        },
      ),

      // --- memory_remember ---
      tool(
        'memory_remember',
        '告诉记忆系统记住某条信息。用户说「记住」或发现重要信息时使用。',
        {
          content: z.string().describe('需要记住的内容'),
          importance: z
            .enum(['high', 'normal'])
            .optional()
            .describe('重要性级别，默认 normal'),
          channel: z
            .string()
            .optional()
            .describe('消息来源渠道（取自 source 属性），用于定位对话上下文'),
        },
        async (args) => {
          const result = await callMemoryAgent('/remember', {
            userId: ctx.userId,
            content: args.content,
            importance: args.importance || 'normal',
            chatJid: args.channel || ctx.chatJid,
            groupFolder: ctx.groupFolder,
          });

          if (!result.ok) {
            return {
              content: [{ type: 'text' as const, text: result.errorMsg }],
              isError: true,
            };
          }

          return {
            content: [
              { type: 'text' as const, text: '已通知记忆系统。' },
            ],
          };
        },
      ),
    );
  }

  return tools;
}
