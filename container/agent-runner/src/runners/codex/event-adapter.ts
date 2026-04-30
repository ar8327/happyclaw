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
      return [];

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
