/**
 * MemoryPlugin — memory_query, memory_remember tools.
 *
 * Communicates with the Memory Agent via HTTP endpoints on the main process.
 */

import fs from 'fs';
import path from 'path';
import type { ContextPlugin, PluginContext, ToolDefinition, ToolResult } from '../plugin.js';

export interface MemoryPluginOptions {
  apiUrl: string;
  apiToken: string;
  /** Timeout for memory_query in ms (env: HAPPYCLAW_MEMORY_QUERY_TIMEOUT, default 60000). */
  queryTimeoutMs: number;
  /** Timeout for memory_remember in ms (env: HAPPYCLAW_MEMORY_SEND_TIMEOUT, default 120000). */
  sendTimeoutMs: number;
  /** Path to the memory index file (e.g., data/memory/{userId}/index.md). */
  memoryIndexPath?: string;
}

export class MemoryPlugin implements ContextPlugin {
  readonly name = 'memory';
  private opts: MemoryPluginOptions;

  constructor(opts: MemoryPluginOptions) {
    this.opts = opts;
  }

  isEnabled(ctx: PluginContext): boolean {
    return !!ctx.userId;
  }

  getTools(ctx: PluginContext): ToolDefinition[] {
    return [
      // --- memory_query ---
      {
        name: 'memory_query',
        description: '向记忆系统查询。可以问关于过去对话、用户信息、项目知识的任何问题。查询可能需要几秒钟。',
        parameters: {
          type: 'object' as const,
          properties: {
            query: { type: 'string', description: '查询内容' },
            context: { type: 'string', description: '当前对话的简要上下文，帮助记忆系统更准确地搜索' },
            channel: { type: 'string', description: '消息来源渠道（取自 source 属性），用于定位对话上下文' },
          },
          required: ['query'],
        },
        execute: async (args: Record<string, unknown>): Promise<ToolResult> => {
          const result = await this.callMemoryAgent('/query', {
            userId: ctx.userId,
            query: args.query,
            context: args.context || '',
            chatJid: (args.channel as string) || ctx.chatJid,
            workspaceFolder: ctx.groupFolder,
            groupFolder: ctx.groupFolder,
          }, this.opts.queryTimeoutMs);

          if (!result.ok) {
            return { content: result.errorMsg, isError: true };
          }
          return { content: (result.data.response as string) || '没有找到相关记忆。' };
        },
      },

      // --- memory_remember ---
      {
        name: 'memory_remember',
        description: '告诉记忆系统记住某条信息。用户说「记住」或发现重要信息时使用。',
        parameters: {
          type: 'object' as const,
          properties: {
            content: { type: 'string', description: '需要记住的内容' },
            importance: {
              type: 'string',
              enum: ['high', 'normal'],
              description: '重要性级别，默认 normal',
            },
            channel: { type: 'string', description: '消息来源渠道（取自 source 属性），用于定位对话上下文' },
          },
          required: ['content'],
        },
        execute: async (args: Record<string, unknown>): Promise<ToolResult> => {
          const result = await this.callMemoryAgent('/remember', {
            userId: ctx.userId,
            content: args.content,
            importance: (args.importance as string) || 'normal',
            chatJid: (args.channel as string) || ctx.chatJid,
            workspaceFolder: ctx.groupFolder,
            groupFolder: ctx.groupFolder,
          }, this.opts.sendTimeoutMs);

          if (!result.ok) {
            return { content: result.errorMsg, isError: true };
          }
          return { content: '已通知记忆系统。' };
        },
      },
    ];
  }

  getSystemPromptSection(ctx: PluginContext): string {
    if (ctx.isHome || ctx.isAdminHome) {
      return this.buildHomeMemoryPrompt(ctx);
    }
    return this.buildGroupMemoryPrompt();
  }

  /**
   * Full memory prompt for home containers (~70 lines).
   * Includes index.md, personality.md, memory_query usage examples,
   * memory_remember guidance, and compaction notes.
   */
  private buildHomeMemoryPrompt(ctx: PluginContext): string {
    // Memory Agent mode: read index.md from the memory-index mount
    const WORKSPACE_MEMORY_INDEX = process.env.HAPPYCLAW_WORKSPACE_MEMORY_INDEX || '/workspace/memory-index';
    const parts: string[] = ['', '## 记忆系统', ''];

    // Load memory index
    const indexContent = tryReadFileContent(path.join(WORKSPACE_MEMORY_INDEX, 'index.md'));
    if (indexContent) {
      parts.push(
        '你的随身索引已加载（这是经过压缩的快速参考，条目可能不完整。涉及具体事实时，建议通过 memory_query 确认）：',
        '',
        '<memory-index>',
        indexContent,
        '</memory-index>',
        '',
      );
    }

    // Load personality
    const personalityContent = tryReadFileContent(path.join(WORKSPACE_MEMORY_INDEX, 'personality.md'));
    if (personalityContent) {
      parts.push(
        '你对这位用户交互风格的观察记录：',
        '',
        '<personality-notes>',
        personalityContent,
        '</personality-notes>',
        '',
      );
    }

    parts.push(
      '### memory_query 和 memory_remember',
      '',
      '这两个 MCP 工具的底层是一个独立的记忆 Agent，它可以搜索、整理和存储你的长期记忆。',
      '',
      '**memory_query — 深度回忆**',
      '',
      '你可以像问一个知道一切过往的助手那样，直接问它问题。不需要把问题过度拆解，但要给足背景。例如：',
      '- 「今天是 2026-03-16 周一，根据记忆用户今天可能有什么安排？」',
      '- 「用户提到过一个关于 XXX 的项目，具体细节是什么？」',
      '- 「上周用户和我聊过一个技术方案，涉及向量数据库，帮我回忆一下。」',
      '',
      '**什么时候应该使用 memory_query：**',
      '- 当你不确定自己知不知道某件事时——先查再答，不要猜',
      '- 用户问起过去的事（"之前聊的"、"上次说的"、"还记得吗"）',
      '- 涉及用户个人信息、日程、偏好等需要确认准确性的问题',
      '- 用户在考你/测试你的记忆时',
      '- compact summary 或随身索引中的信息不够详细，需要深入了解时',
      '',
      '随身索引是快速参考，但**不是权威事实来源**。索引条目经过压缩，可能丢失限定条件或上下文。',
      '如果索引中已有一些信息，你可以先给出快速印象，',
      '然后询问用户要不要让你深入想想（调用 memory_query 获取完整细节）。',
      '涉及具体事实（日期、数字、决策结论）时，优先通过 memory_query 确认后再回答。',
      '',
      '**重要：查询通常需要 1-2 分钟。** 发起查询前，先给用户发一条消息（如「让我好好想想……」「我去翻翻记忆～」），',
      '避免用户以为你卡死了。如果是 IM 渠道，用 send_message 发送提示后再调用 memory_query。',
      '',
      '**memory_remember — 主动记忆**',
      '',
      '每次对话结束后，系统会自动整理对话内容存入记忆，所以不需要频繁手动记录。',
      '只在以下情况使用：',
      '- 用户明确说「记住」「别忘了」',
      '- 特别重要、怕被自动整理遗漏的信息（如用户纠正了个人信息、重要决策）',
      '',
      '不要在 CLAUDE.md 里手动维护用户信息——用户身份、偏好、知识由记忆系统统一管理，已通过上方随身索引加载。',
    );
    return parts.join('\n');
  }

  /**
   * Read-only memory prompt for non-home group containers (~15 lines).
   */
  private buildGroupMemoryPrompt(): string {
    return [
      '',
      '## 记忆',
      '',
      '### 查询记忆',
      '可使用 `memory_query` 工具查询用户的记忆（过去的对话、偏好、项目知识等）。',
      '查询可能需要几秒钟。',
      '',
      '### 本地记忆',
      '重要信息直接记录在当前工作区的 CLAUDE.md 或其他文件中。',
      'Claude 会自动维护你的会话记忆，无需额外操作。',
    ].join('\n');
  }

  // ─── Private helpers ────────────────────────────────────────

  private async callMemoryAgent(
    endpoint: string,
    body: object,
    timeoutMs: number,
  ): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; status: number; errorMsg: string }> {
    const controller = new AbortController();
    const httpTimeout = (Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 60000) + 5000;
    const timer = setTimeout(() => controller.abort(), httpTimeout);

    try {
      const res = await fetch(`${this.opts.apiUrl}/api/internal/memory${endpoint}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.opts.apiToken}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);

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
      clearTimeout(timer);
      const errorMsg = err instanceof Error && err.name === 'AbortError'
        ? '记忆查询超时'
        : '无法连接记忆系统';
      return { ok: false, status: 0, errorMsg };
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tryReadFileContent(filePath: string): string {
  try {
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf-8').trim();
    }
  } catch { /* ignore read errors */ }
  return '';
}
