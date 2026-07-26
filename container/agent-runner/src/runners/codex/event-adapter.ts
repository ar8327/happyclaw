/**
 * Codex Event Adapter — converts ThreadEvent → HappyClaw StreamEvent.
 *
 * Maps Codex SDK events to the unified StreamEvent format used by the
 * query-loop and frontend.
 */

import {
  formatCodexAppServerError,
  type CodexThreadEvent,
  type CodexThreadItem,
} from './session.js';
import type { StreamEvent } from '../../types.js';

/**
 * Convert a Codex ThreadEvent to zero or more HappyClaw StreamEvents.
 */
export function convertThreadEvent(event: CodexThreadEvent): StreamEvent[] {
  switch (event.type) {
    case 'thread.started':
      return [{ eventType: 'init' }];

    case 'turn.started':
      return []; // No equivalent needed

    case 'item.started':
      return handleItemStarted(event);

    case 'item.updated':
      if (event.item.type === 'todo_list') {
        return [buildTodoEvent(event.item)];
      }
      // Codex item.updated carries the latest full snapshot instead of a true
      // delta. Downstream consumers append text_delta payloads, so emitting the
      // snapshot here would duplicate content in streaming views.
      return [];

    case 'item.completed':
      return handleItemCompleted(event);

    case 'turn.completed':
      // Codex SDK's turn.completed usage is cumulative for the whole thread in
      // recent CLI builds. CodexRunner emits normalized per-request usage after
      // inspecting token_count events, so do not emit usage from the adapter.
      return [];

    case 'token_count':
    case 'compact.completed':
      return [];

    case 'turn.failed':
      return handleTurnFailed(event);

    case 'error':
      return handleError(event);

    default:
      return [];
  }
}

function handleItemStarted(
  event: Extract<CodexThreadEvent, { type: 'item.started' }>,
): StreamEvent[] {
  const item = event.item;
  switch (item.type) {
    case 'command_execution':
      return [
        {
          eventType: 'tool_use_start',
          toolUseId: item.id,
          toolName: 'Bash',
          toolInputSummary: item.command.slice(0, 500),
          toolInput: { command: item.command },
        },
      ];

    case 'mcp_tool_call':
      return [
        {
          eventType: 'tool_use_start',
          toolUseId: item.id,
          toolName: `mcp__${item.server}__${item.tool}`,
          toolInputSummary: summarizeToolInput(item.arguments),
          toolInput:
            item.arguments &&
            typeof item.arguments === 'object' &&
            !Array.isArray(item.arguments)
              ? (item.arguments as Record<string, unknown>)
              : { input: item.arguments },
        },
      ];

    case 'file_change':
      return [
        {
          eventType: 'tool_use_start',
          toolUseId: item.id,
          toolName: 'Edit',
          toolInputSummary: item.changes
            .map((change) => `${change.kind}: ${change.path}`)
            .join(', ')
            .slice(0, 500),
          toolInput: { changes: item.changes },
        },
      ];

    case 'web_search':
      return [
        {
          eventType: 'tool_use_start',
          toolUseId: item.id,
          toolName: 'WebSearch',
          toolInputSummary: item.query.slice(0, 500),
          toolInput: { query: item.query },
        },
      ];

    case 'context_compaction':
      return [];

    case 'reasoning':
      return [];

    case 'todo_list':
      return [buildTodoEvent(item)];

    default:
      return [];
  }
}

function handleItemCompleted(
  event: Extract<CodexThreadEvent, { type: 'item.completed' }>,
): StreamEvent[] {
  const item = event.item;
  const events: StreamEvent[] = [];

  switch (item.type) {
    case 'command_execution':
      events.push({
        eventType: 'tool_use_end',
        toolUseId: item.id,
      });
      break;

    case 'mcp_tool_call':
      events.push({
        eventType: 'tool_use_end',
        toolUseId: item.id,
      });
      break;

    case 'agent_message':
      // Emit the complete text as a text_delta (Codex has no incremental deltas)
      events.push({
        eventType: 'text_delta',
        text: item.text,
      });
      break;

    case 'file_change':
      events.push({
        eventType: 'tool_use_end',
        toolUseId: item.id,
      });
      break;

    case 'web_search':
      events.push({
        eventType: 'tool_use_end',
        toolUseId: item.id,
      });
      break;

    case 'reasoning':
      events.push({
        eventType: 'thinking_delta',
        text: item.text,
      });
      break;

    case 'todo_list':
      events.push(buildTodoEvent(item));
      break;

    case 'error':
      events.push({
        eventType: 'status',
        statusText: `Error: ${item.message}`,
      });
      break;

    case 'context_compaction':
      break;
  }

  return events;
}

function summarizeToolInput(input: unknown): string {
  if (typeof input === 'string') return input.slice(0, 500);
  try {
    return JSON.stringify(input).slice(0, 500);
  } catch {
    return String(input).slice(0, 500);
  }
}

function buildTodoEvent(
  item: Extract<CodexThreadItem, { type: 'todo_list' }>,
): StreamEvent {
  return {
    eventType: 'todo_update',
    todos: item.items.map((todo, index) => ({
      id: `${item.id}:${index}`,
      content: todo.text,
      status: todo.completed ? 'completed' : 'pending',
    })),
  };
}

function handleTurnFailed(
  event: Extract<CodexThreadEvent, { type: 'turn.failed' }>,
): StreamEvent[] {
  return [
    {
      eventType: 'status',
      statusText: `Runner 当前 turn 无法继续：${event.error.message}`,
      runnerError: {
        message: event.error.message,
        detail: event.error.message,
        willRetry: false,
      },
    },
  ];
}

function handleError(
  event: Extract<CodexThreadEvent, { type: 'error' }>,
): StreamEvent[] {
  const detail = formatCodexAppServerError(event);
  return [
    {
      eventType: 'status',
      statusText: event.willRetry
        ? `Runner 暂时异常，正在自动重试：${event.message}`
        : `Runner 当前 turn 无法继续：${event.message}`,
      runnerError: {
        message: event.message,
        detail,
        willRetry: event.willRetry,
      },
    },
  ];
}

export type { CodexThreadEvent, CodexThreadItem };
