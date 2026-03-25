/**
 * Codex Event Adapter — converts ThreadEvent → HappyClaw StreamEvent.
 *
 * Maps Codex SDK events to the unified StreamEvent format used by the
 * query-loop and frontend.
 */

import type {
  ThreadEvent,
  ItemStartedEvent,
  ItemCompletedEvent,
  TurnCompletedEvent,
  TurnFailedEvent,
  ThreadErrorEvent,
} from '@openai/codex-sdk';
import type { StreamEvent } from '../../types.js';

/**
 * Convert a Codex ThreadEvent to zero or more HappyClaw StreamEvents.
 */
export function convertThreadEvent(event: ThreadEvent): StreamEvent[] {
  switch (event.type) {
    case 'thread.started':
      return [{ eventType: 'init' }];

    case 'turn.started':
      return []; // No equivalent needed

    case 'item.started':
      return handleItemStarted(event);

    case 'item.updated':
      // Codex item.updated carries the latest snapshot; extract text delta if agent_message
      if (event.item.type === 'agent_message') {
        return [{ eventType: 'text_delta', text: event.item.text }];
      }
      return [];

    case 'item.completed':
      return handleItemCompleted(event);

    case 'turn.completed':
      return handleTurnCompleted(event);

    case 'turn.failed':
      return handleTurnFailed(event);

    case 'error':
      return handleError(event);

    default:
      return [];
  }
}

function handleItemStarted(event: ItemStartedEvent): StreamEvent[] {
  const item = event.item;
  switch (item.type) {
    case 'command_execution':
      return [{
        eventType: 'tool_use_start',
        toolUseId: item.id,
        toolName: 'Bash',
      }];

    case 'mcp_tool_call':
      return [{
        eventType: 'tool_use_start',
        toolUseId: item.id,
        toolName: `mcp__${item.server}__${item.tool}`,
      }];

    case 'file_change':
      return [{
        eventType: 'tool_use_start',
        toolUseId: item.id,
        toolName: 'Edit',
      }];

    case 'web_search':
      return [{
        eventType: 'tool_use_start',
        toolUseId: item.id,
        toolName: 'WebSearch',
      }];

    case 'reasoning':
      return [{ eventType: 'thinking_delta', text: item.text }];

    case 'todo_list':
      // Emit as a status update
      return [{
        eventType: 'status',
        statusText: `Todo: ${item.items.length} items`,
      }];

    default:
      return [];
  }
}

function handleItemCompleted(event: ItemCompletedEvent): StreamEvent[] {
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
      // Nothing to emit on completion
      break;

    case 'error':
      events.push({
        eventType: 'status',
        statusText: `Error: ${item.message}`,
      });
      break;
  }

  return events;
}

function handleTurnCompleted(event: TurnCompletedEvent): StreamEvent[] {
  return [{
    eventType: 'usage',
    usage: {
      inputTokens: event.usage.input_tokens,
      outputTokens: event.usage.output_tokens,
      cacheReadInputTokens: event.usage.cached_input_tokens,
      cacheCreationInputTokens: 0,
      costUSD: 0, // Codex SDK doesn't report cost
      durationMs: 0,
      numTurns: 1,
    },
  }];
}

function handleTurnFailed(event: TurnFailedEvent): StreamEvent[] {
  return [{
    eventType: 'status',
    statusText: `Turn failed: ${event.error.message}`,
  }];
}

function handleError(event: ThreadErrorEvent): StreamEvent[] {
  return [{
    eventType: 'status',
    statusText: `Error: ${event.message}`,
  }];
}
