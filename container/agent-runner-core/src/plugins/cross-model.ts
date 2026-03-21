/**
 * CrossModelPlugin — ask_model tool for cross-model collaboration.
 *
 * Enables any runner (Claude or OpenAI) to delegate tasks to another LLM provider.
 * Currently supports OpenAI Chat Completions API as a secondary model.
 *
 * Environment variables:
 * - CROSSMODEL_OPENAI_API_KEY: OpenAI API key for cross-model calls
 * - CROSSMODEL_OPENAI_BASE_URL: Optional custom base URL
 * - CROSSMODEL_OPENAI_MODEL: Model to use (default: gpt-4.1)
 */

import type { ContextPlugin, PluginContext, ToolDefinition, ToolResult } from '../plugin.js';

export interface CrossModelPluginOptions {
  /** OpenAI API key (from env or config). */
  openaiApiKey?: string;
  /** Optional base URL override. */
  openaiBaseUrl?: string;
  /** Model to use for cross-model calls. Default: gpt-4.1 */
  openaiModel?: string;
  /** Max tokens for response. Default: 4096 */
  maxTokens?: number;
}

export class CrossModelPlugin implements ContextPlugin {
  readonly name = 'cross-model';
  private opts: CrossModelPluginOptions;

  constructor(opts: CrossModelPluginOptions = {}) {
    this.opts = opts;
  }

  isEnabled(): boolean {
    const apiKey = this.opts.openaiApiKey || process.env.CROSSMODEL_OPENAI_API_KEY;
    return !!apiKey;
  }

  getTools(_ctx: PluginContext): ToolDefinition[] {
    return [
      {
        name: 'ask_model',
        description:
          '向另一个 LLM 模型发送请求并获取回复。' +
          '用于：方案评审（让另一个模型审查你的方案）、获取第二意见、翻译、总结等。' +
          '当前支持 OpenAI 模型。返回模型的文本回复。',
        parameters: {
          type: 'object' as const,
          properties: {
            prompt: {
              type: 'string',
              description: '发送给模型的完整 prompt（包含你需要评审/处理的内容）',
            },
            system: {
              type: 'string',
              description: '可选的 system prompt，用于设定模型的角色和行为',
            },
            provider: {
              type: 'string',
              enum: ['openai'],
              description: '目标模型提供商（当前支持 openai）',
            },
            model: {
              type: 'string',
              description: '可选：指定具体模型（如 gpt-4.1, o3-mini）。不指定则使用默认模型。',
            },
          },
          required: ['prompt'],
        },
        execute: async (args: Record<string, unknown>): Promise<ToolResult> => {
          return this.executeAskModel(args);
        },
      },
    ];
  }

  getSystemPromptSection(): string {
    return (
      '## 跨模型协同\n\n' +
      '你可以使用 `ask_model` 工具向其他 LLM 模型发送请求。典型用途：\n' +
      '- **方案评审**：完成方案后，让另一个模型审查，获取不同视角的反馈\n' +
      '- **第二意见**：对不确定的问题，咨询另一个模型\n' +
      '- **专长委托**：将特定类型的任务委托给更擅长的模型\n\n' +
      '使用时，将完整上下文包含在 prompt 中，因为目标模型没有当前对话的历史。'
    );
  }

  // ─── Internal ─────────────────────────────────────────────

  private async executeAskModel(args: Record<string, unknown>): Promise<ToolResult> {
    const prompt = String(args.prompt || '');
    const system = args.system ? String(args.system) : undefined;
    const model = args.model ? String(args.model) : (this.opts.openaiModel || process.env.CROSSMODEL_OPENAI_MODEL || 'gpt-4.1');

    if (!prompt.trim()) {
      return { content: 'Error: prompt is required', isError: true };
    }

    const apiKey = this.opts.openaiApiKey || process.env.CROSSMODEL_OPENAI_API_KEY;
    if (!apiKey) {
      return { content: 'Error: OpenAI API key not configured for cross-model calls', isError: true };
    }

    const baseUrl = this.opts.openaiBaseUrl || process.env.CROSSMODEL_OPENAI_BASE_URL || 'https://api.openai.com/v1';
    const maxTokens = this.opts.maxTokens || 4096;

    try {
      const messages: Array<{ role: string; content: string }> = [];
      if (system) {
        messages.push({ role: 'system', content: system });
      }
      messages.push({ role: 'user', content: prompt });

      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          max_completion_tokens: maxTokens,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        return {
          content: `Error from OpenAI API (${response.status}): ${errorText.slice(0, 500)}`,
          isError: true,
        };
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      };

      const reply = data.choices?.[0]?.message?.content || '(empty response)';
      const usage = data.usage;

      let result = `**[${model}]** 的回复：\n\n${reply}`;
      if (usage) {
        result += `\n\n---\n_Token usage: ${usage.prompt_tokens} input + ${usage.completion_tokens} output = ${usage.total_tokens} total_`;
      }

      return { content: result };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `Error calling OpenAI API: ${msg}`, isError: true };
    }
  }
}
