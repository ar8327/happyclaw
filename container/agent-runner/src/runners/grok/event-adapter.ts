/**
 * grok 事件归一化。
 *
 * `--output-format streaming-messages-json` 的行结构与 Claude Code 的
 * stream-json 完全同构（`system`/`assistant`/`user`/`result`/`stream_event`，
 * assistant.message 就是 Anthropic Message），差异只在工具命名：
 *
 *   run_terminal_command → Bash、todo_write → TodoWrite、…
 *   MCP 工具不展开成顶层工具，统一走 `use_tool`，
 *   真实工具名在 input.tool_name 里，形如 `agentdock__send_message`。
 *
 * 所以这里只做名字归一，随后整行交给 claude 的 StreamEventProcessor 渲染 ——
 * 913 行的流式聚合、嵌套工具追踪、Skill/Task 解析全部原样复用。
 *
 * 归一化是有状态的：`use_tool` 的 content_block_start 到达时 input 还是空的，
 * 真名要等 input_json_delta 拼出 `tool_name` 才知道。直接放行会让 UI 把每一次
 * MCP 调用都显示成 `use_tool`（send_message 和 memory_search 长得一模一样），
 * 所以 start 事件先扣住，解出真名后再补发。见 GrokEventNormalizer。
 */

import { toClaudeToolName } from './tool-names.js';

/** grok 的 MCP 工具全名 `server__tool` → claude 习惯的 `mcp__server__tool`。 */
export function toClaudeMcpToolName(grokToolName: string): string {
  return `mcp__${grokToolName}`;
}

/** 从（可能不完整的）use_tool 入参 JSON 里提取 tool_name。 */
export function extractUseToolName(partialJson: string): string | null {
  const match = partialJson.match(/"tool_name"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  return match ? match[1] : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 改写单个 tool_use 块。
 *
 * `use_tool` 是 MCP 的统一入口，把它摊平成真实工具名，UI 才会显示
 * `mcp__agentdock__send_message` 而不是一律 `use_tool`；参数也换成内层
 * tool_input，否则展示出来的是一层无意义的包装。
 */
function normalizeToolUseBlock(
  block: Record<string, unknown>,
): Record<string, unknown> {
  const name = typeof block.name === 'string' ? block.name : '';
  if (name === 'use_tool' && isRecord(block.input)) {
    const inner = block.input;
    const toolName =
      typeof inner.tool_name === 'string' ? inner.tool_name : null;
    if (toolName) {
      return {
        ...block,
        name: toClaudeMcpToolName(toolName),
        input: isRecord(inner.tool_input) ? inner.tool_input : {},
      };
    }
    return block;
  }
  return { ...block, name: toClaudeToolName(name) };
}

function normalizeContentBlocks(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  return content.map((block) =>
    isRecord(block) && block.type === 'tool_use'
      ? normalizeToolUseBlock(block)
      : block,
  );
}

interface PendingUseTool {
  /** 扣下的 content_block_start，解出真名后改写再发。 */
  startEvent: Record<string, unknown>;
  /** 扣下期间到达的 delta，补发 start 之后按序放行。 */
  buffered: Record<string, unknown>[];
  /** 已累积的 partial_json，用来找 tool_name。 */
  inputJson: string;
}

/**
 * 有状态的 grok → Claude Code 事件归一化器。
 *
 * 每次 `normalize()` 返回 0..n 个事件：`use_tool` 的 start 会被扣住，等到
 * `tool_name` 拼出来才带着真名补发（连同期间缓冲的 delta）；块结束时仍未解出
 * 就原样放行，保证任何情况下都不丢事件。
 *
 * 每轮 query 用一个新实例（content block index 是轮内编号）。
 */
export class GrokEventNormalizer {
  private readonly pending = new Map<number, PendingUseTool>();

  private flushPending(
    index: number,
    resolvedName: string | null,
  ): Record<string, unknown>[] {
    const entry = this.pending.get(index);
    if (!entry) return [];
    this.pending.delete(index);

    const inner = entry.startEvent.event as Record<string, unknown>;
    const block = inner.content_block as Record<string, unknown>;
    const startEvent = {
      ...entry.startEvent,
      event: {
        ...inner,
        content_block: resolvedName
          ? { ...block, name: toClaudeMcpToolName(resolvedName) }
          : block,
      },
    };
    return [startEvent, ...entry.buffered];
  }

  normalize(event: Record<string, unknown>): Record<string, unknown>[] {
    const type = event.type;

    if (type === 'assistant' || type === 'user') {
      const message = event.message;
      if (!isRecord(message)) return [event];
      return [
        {
          ...event,
          message: {
            ...message,
            content: normalizeContentBlocks(message.content),
          },
        },
      ];
    }

    if (type === 'system' && event.subtype === 'init') {
      const tools = event.tools;
      if (!Array.isArray(tools)) return [event];
      return [
        {
          ...event,
          tools: tools.map((tool) =>
            typeof tool === 'string' ? toClaudeToolName(tool) : tool,
          ),
        },
      ];
    }

    if (type !== 'stream_event') return [event];

    const inner = event.event;
    if (!isRecord(inner)) return [event];
    const index = typeof inner.index === 'number' ? inner.index : null;

    if (inner.type === 'content_block_start' && isRecord(inner.content_block)) {
      const block = inner.content_block;
      if (block.type !== 'tool_use') return [event];
      if (block.name === 'use_tool' && index !== null) {
        // 扣住，等 tool_name 拼出来
        this.pending.set(index, {
          startEvent: event,
          buffered: [],
          inputJson: '',
        });
        return [];
      }
      return [
        {
          ...event,
          event: { ...inner, content_block: normalizeToolUseBlock(block) },
        },
      ];
    }

    if (index === null || !this.pending.has(index)) return [event];
    const entry = this.pending.get(index)!;

    if (inner.type === 'content_block_delta') {
      const delta = inner.delta;
      if (isRecord(delta) && typeof delta.partial_json === 'string') {
        entry.inputJson += delta.partial_json;
        const resolved = extractUseToolName(entry.inputJson);
        if (resolved) {
          entry.buffered.push(event);
          return this.flushPending(index, resolved);
        }
      }
      entry.buffered.push(event);
      return [];
    }

    if (inner.type === 'content_block_stop') {
      // 到块结束还没解出真名（异常入参），原样放行，宁可名字不准也不丢事件
      const flushed = this.flushPending(
        index,
        extractUseToolName(entry.inputJson),
      );
      return [...flushed, event];
    }

    entry.buffered.push(event);
    return [];
  }
}
