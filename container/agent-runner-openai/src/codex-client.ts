/**
 * Codex Responses API client for ChatGPT OAuth mode.
 *
 * Uses the Responses API at chatgpt.com/backend-api/codex/responses
 * with Bearer token authentication from Codex OAuth flow.
 *
 * This is a completely different protocol from Chat Completions:
 * - Request uses `input` (items array) instead of `messages`
 * - Response is SSE with structured events instead of chunked deltas
 * - Tool calls use `function_call` output items
 * - Tool results use `function_call_output` input items
 */

import type { StreamEvent } from 'happyclaw-agent-runner-core';

// ─── Types ──────────────────────────────────────────────────

export interface CodexToolDefinition {
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type CodexInputItem =
  | { type: 'message'; role: 'user' | 'assistant'; content: string }
  | { type: 'function_call'; id: string; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string };

interface CodexReasoning {
  effort: 'low' | 'medium' | 'high';
  summary?: 'auto' | 'concise' | 'detailed' | 'none';
}

interface CodexRequest {
  model: string;
  instructions: string;
  input: string | CodexInputItem[];
  tools: CodexToolDefinition[];
  stream: true;
  store: false;
  reasoning?: CodexReasoning;
}

interface CodexFunctionCall {
  id: string;
  callId: string;
  name: string;
  arguments: string;
}

export interface CodexUsageData {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

export interface CodexTurnResult {
  text: string;
  functionCalls: CodexFunctionCall[];
  /** Raw output items to feed back as conversation history */
  outputItems: CodexInputItem[];
  /** Token usage from the API response */
  usage?: CodexUsageData;
}

// ─── SSE Parser ─────────────────────────────────────────────

interface SSEEvent {
  event: string;
  data: string;
}

async function* parseSSE(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<SSEEvent> {
  const decoder = new TextDecoder();
  let buffer = '';
  // Persist across chunks so split event/data lines aren't lost
  let currentEvent = '';
  let currentData = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() || ''; // Keep incomplete line in buffer

    for (const line of lines) {
      if (line.startsWith('event: ')) {
        currentEvent = line.slice(7).trim();
      } else if (line.startsWith('data: ')) {
        currentData = line.slice(6);
      } else if (line === '' && currentEvent) {
        yield { event: currentEvent, data: currentData };
        currentEvent = '';
        currentData = '';
      }
    }
  }

  // Flush any remaining event when the stream ends (e.g. response.completed)
  if (currentEvent && currentData) {
    yield { event: currentEvent, data: currentData };
  }
}

// ─── Client ─────────────────────────────────────────────────

const CODEX_API_URL = 'https://chatgpt.com/backend-api/codex/responses';

export function convertToolsToCodex(
  chatTools: Array<{ type: 'function'; function: { name: string; description?: string; parameters?: Record<string, unknown> } }>,
): CodexToolDefinition[] {
  return chatTools.map((t) => ({
    type: 'function',
    name: t.function.name,
    description: t.function.description || '',
    parameters: t.function.parameters || {},
  }));
}

/**
 * Execute a single Codex Responses API call (streaming).
 * Returns the assistant's text output and any function calls.
 */
export async function codexStreamRequest(
  accessToken: string,
  model: string,
  instructions: string,
  input: string | CodexInputItem[],
  tools: CodexToolDefinition[],
  onStreamEvent: (event: StreamEvent) => void,
  log: (msg: string) => void,
  options?: { reasoningEffort?: 'low' | 'medium' | 'high'; reasoningSummary?: 'auto' | 'concise' | 'detailed' | 'none' },
): Promise<CodexTurnResult> {
  const body: CodexRequest = {
    model,
    instructions,
    input,
    tools,
    stream: true,
    store: false,
  };

  if (options?.reasoningEffort) {
    body.reasoning = { effort: options.reasoningEffort };
    if (options.reasoningSummary) {
      body.reasoning.summary = options.reasoningSummary;
    }
  }

  const response = await fetch(CODEX_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`Codex API error ${response.status}: ${errorText.slice(0, 500)}`);
  }

  if (!response.body) {
    throw new Error('Codex API returned no body');
  }

  const reader = response.body.getReader();
  let textBuffer = '';
  const functionCalls: CodexFunctionCall[] = [];
  const outputItems: CodexInputItem[] = [];
  let usageData: CodexUsageData | undefined;

  // Track in-progress function calls by index/id
  const pendingCalls = new Map<string, { id: string; callId: string; name: string; args: string }>();

  for await (const sse of parseSSE(reader)) {
    try {
      const data = JSON.parse(sse.data);

      switch (sse.event) {
        case 'response.output_item.added': {
          const item = data.item;
          if (item?.type === 'function_call') {
            const key = item.id || item.call_id || `fc_${functionCalls.length}`;
            pendingCalls.set(key, {
              id: item.id || key,
              callId: item.call_id || key,
              name: item.name || '',
              args: item.arguments || '',
            });
            onStreamEvent({
              eventType: 'tool_use_start',
              toolUseId: item.call_id || key,
              toolName: item.name || '',
              toolInputSummary: '',
            });
          }
          break;
        }

        case 'response.content_part.delta': {
          const delta = data.delta;
          if (typeof delta === 'string') {
            textBuffer += delta;
            onStreamEvent({ eventType: 'text_delta', textDelta: delta });
          } else if (delta?.text) {
            textBuffer += delta.text;
            onStreamEvent({ eventType: 'text_delta', textDelta: delta.text });
          }
          break;
        }

        case 'response.function_call_arguments.delta': {
          const itemId = data.item_id || data.output_index?.toString();
          const pending = itemId ? pendingCalls.get(itemId) : undefined;
          if (pending && data.delta) {
            pending.args += data.delta;
          }
          break;
        }

        case 'response.function_call_arguments.done': {
          const itemId = data.item_id || data.output_index?.toString();
          const pending = itemId ? pendingCalls.get(itemId) : undefined;
          if (pending) {
            // Use the final arguments from the done event if provided
            if (data.arguments) {
              pending.args = data.arguments;
            }
          }
          break;
        }

        case 'response.output_item.done': {
          const item = data.item;
          if (item?.type === 'function_call') {
            const fc: CodexFunctionCall = {
              id: item.id || '',
              callId: item.call_id || '',
              name: item.name || '',
              arguments: item.arguments || '',
            };
            functionCalls.push(fc);
            outputItems.push({
              type: 'function_call',
              id: fc.id,
              call_id: fc.callId,
              name: fc.name,
              arguments: fc.arguments,
            });
            log(`Codex function call: ${fc.name}(${fc.arguments.slice(0, 200)})`);
          } else if (item?.type === 'message') {
            // Extract text from message content parts
            const content = item.content;
            if (Array.isArray(content)) {
              for (const part of content) {
                if (part.type === 'output_text' && part.text) {
                  // Text already accumulated via deltas, but capture any missed
                  if (!textBuffer.includes(part.text)) {
                    textBuffer = part.text;
                  }
                }
              }
            }
            outputItems.push({
              type: 'message',
              role: 'assistant',
              content: textBuffer,
            });
          }
          break;
        }

        case 'response.completed': {
          // Final event — capture usage data from the response (if available)
          // Note: chatgpt_oauth mode typically does NOT include usage data
          const resp = data.response || data;
          if (resp.usage) {
            usageData = {
              input_tokens: resp.usage.input_tokens || 0,
              output_tokens: resp.usage.output_tokens || 0,
              total_tokens: resp.usage.total_tokens || 0,
            };
            log(`Codex usage: input=${usageData.input_tokens} output=${usageData.output_tokens} total=${usageData.total_tokens}`);
          }
          break;
        }

        // Ignore other events (response.created, response.in_progress, etc.)
      }
    } catch {
      // Skip unparseable SSE data lines
    }
  }

  return { text: textBuffer, functionCalls, outputItems, usage: usageData };
}
