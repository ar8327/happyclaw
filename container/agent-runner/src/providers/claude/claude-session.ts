/**
 * ClaudeSession — encapsulates the Claude Agent SDK query lifecycle.
 *
 * Owns the MessageStream and Query reference, exposing a clean interface
 * for running queries, pushing follow-up messages, interrupting, and
 * changing permission modes.  Keeps index.ts focused on orchestration
 * (IPC polling, retry logic, output routing) rather than SDK wiring.
 */

import { query, type PermissionMode, type Query, type McpServerConfig, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { createPreCompactHook, createSafetyLiteHook } from './claude-hooks.js';
import { PREDEFINED_AGENTS } from './claude-agent-defs.js';
import { resolveImageMimeType, filterOversizedImages, type ClaudeImageMimeType } from '../../image-utils.js';

/**
 * Push-based async iterable for streaming user messages to the SDK.
 * Keeps the iterable alive until end() is called, preventing isSingleUserTurn.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(
    text: string,
    images?: Array<{ data: string; mimeType?: string }>,
    log?: (msg: string) => void,
  ): string[] {
    const rejectedReasons: string[] = [];
    let filteredImages = images;

    // 过滤超限图片，在发送给 SDK 之前拦截
    if (filteredImages && filteredImages.length > 0) {
      const logFn = log ?? (() => {});
      const { valid, rejected } = filterOversizedImages(filteredImages, logFn);
      rejectedReasons.push(...rejected);
      filteredImages = valid.length > 0 ? valid : undefined;
    }

    let content: SDKUserMessage['message']['content'];

    if (filteredImages && filteredImages.length > 0) {
      const logFn = log ?? (() => {});
      // 多模态消息：text + images
      content = [
        { type: 'text', text },
        ...filteredImages.map((img) => ({
          type: 'image' as const,
          source: {
            type: 'base64' as const,
            media_type: resolveImageMimeType(img, logFn) as ClaudeImageMimeType,
            data: img.data,
          },
        })),
      ];
    } else {
      // 纯文本消息
      content = text;
    }

    this.queue.push({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
    return rejectedReasons;
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>((r) => {
        this.waiting = r;
      });
      this.waiting = null;
    }
  }
}

export interface ClaudeSessionConfig {
  sessionId?: string;
  resumeAt?: string;
  cwd: string;
  additionalDirectories?: string[];
  model?: string;
  thinkingEffort?: string;
  permissionMode?: PermissionMode;
  allowedTools?: string[];
  disallowedTools?: string[];
  systemPromptAppend: string;
  isHostMode: boolean;
  isHome: boolean;
  isAdminHome: boolean;
  groupFolder: string;
  userId?: string;
}

export class ClaudeSession {
  private stream: MessageStream | null = null;
  private queryRef: Query | null = null;
  private log: (msg: string) => void;

  constructor(log: (msg: string) => void) {
    this.log = log;
  }

  /**
   * Start a query against the Claude Agent SDK.
   *
   * Yields every SDKMessage from the underlying Query async generator.
   * The caller is responsible for processing messages, managing IPC, and
   * calling pushMessage / interrupt / end as needed.
   *
   * @param config  Session-level configuration (model, cwd, permissions, etc.)
   * @param mcpServers  Fully assembled MCP server configs (user + built-in)
   */
  /**
   * Start a query against the Claude Agent SDK.
   *
   * IMPORTANT: Stream creation is eager (runs before the returned generator
   * is iterated), so callers can safely call pushMessage() between run()
   * and the first iteration of the returned generator.
   */
  run(
    config: ClaudeSessionConfig,
    mcpServers: Record<string, McpServerConfig>,
  ): AsyncGenerator<any> {
    // Fresh stream for each query — created eagerly (not inside the async
    // generator body) so that pushMessage() works before iteration starts.
    this.stream = new MessageStream();
    this.queryRef = null;

    // Assemble hooks
    const hooks: Record<string, any> = {
      PreCompact: [
        {
          hooks: [
            createPreCompactHook(
              config.isHome,
              config.isAdminHome,
              config.groupFolder,
              config.userId,
            ),
          ],
        },
      ],
    };
    if (config.isHostMode) {
      hooks.PreToolUse = [{ hooks: [createSafetyLiteHook()] }];
    }

    const stream = this.stream;
    const self = this;

    async function* iterate() {
      const q = query({
        prompt: stream,
        options: {
          model: config.model || 'opus',
          cwd: config.cwd,
          additionalDirectories: config.additionalDirectories,
          resume: config.sessionId,
          resumeSessionAt: config.resumeAt,
          systemPrompt: {
            type: 'preset' as const,
            preset: 'claude_code' as const,
            append: config.systemPromptAppend,
          },
          allowedTools: config.allowedTools,
          ...(config.disallowedTools && { disallowedTools: config.disallowedTools }),
          ...(config.thinkingEffort
            ? { effort: config.thinkingEffort as 'low' | 'medium' | 'high' | 'max' }
            : {}),
          permissionMode: config.permissionMode ?? 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          settingSources: ['project', 'user'],
          includePartialMessages: true,
          mcpServers,
          hooks,
          agents: PREDEFINED_AGENTS,
        },
      });
      self.queryRef = q;

      for await (const message of q) {
        yield message;
      }
    }

    return iterate();
  }

  /**
   * Push a follow-up user message into the active query stream.
   *
   * @returns Array of rejection reasons for oversized images (empty if none)
   */
  pushMessage(text: string, images?: Array<{ data: string; mimeType?: string }>): string[] {
    if (!this.stream) throw new Error('ClaudeSession.run() not called');
    return this.stream.push(text, images, this.log);
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    await this.queryRef?.setPermissionMode(mode);
  }

  async interrupt(): Promise<void> {
    await this.queryRef?.interrupt();
  }

  end(): void {
    this.stream?.end();
  }
}
