/**
 * HappyClaw Agent Runner — OpenAI Backend
 *
 * Same ContainerInput/ContainerOutput protocol as the Claude agent-runner,
 * but powered by OpenAI's APIs.
 *
 * Two modes:
 * - api_key:       Standard Chat Completions API (api.openai.com)
 * - chatgpt_oauth: Codex Responses API (chatgpt.com) via OAuth Bearer token
 *
 * Uses agent-runner-core for:
 * - Protocol (stdin/stdout/stream events)
 * - IPC (message polling, close sentinel)
 * - ContextManager + plugins (tools, system prompt)
 * - Tool format adapters (toOpenAITools, toCodexTools)
 */

import path from 'path';
import OpenAI from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionChunk } from 'openai/resources/chat/completions.js';

import {
  // Protocol
  readStdin,
  writeOutput,
  emitStreamEvent,
  createLogger,
  // IPC
  createIpcConfig,
  waitForIpcMessage,
  // Context & Plugins
  ContextManager,
  MessagingPlugin,
  TasksPlugin,
  GroupsPlugin,
  MemoryPlugin,
  FeishuDocsPlugin,
  CrossModelPlugin,
  // Tool adapters
  toOpenAITools,
  toCodexTools,
  // Types
  type ContainerInput,
  type PluginContext,
  type CodexToolDef,
} from 'happyclaw-agent-runner-core';

import {
  codexStreamRequest,
  type CodexInputItem,
} from './codex-client.js';
import { LocalToolsPlugin } from './local-tools.js';

// ─── Environment ─────────────────────────────────────────────

const WORKSPACE_GROUP = process.env.HAPPYCLAW_WORKSPACE_GROUP || '/workspace/group';
const WORKSPACE_GLOBAL = process.env.HAPPYCLAW_WORKSPACE_GLOBAL || '/workspace/global';
const WORKSPACE_MEMORY = process.env.HAPPYCLAW_WORKSPACE_MEMORY || '/workspace/memory';
const WORKSPACE_IPC = process.env.HAPPYCLAW_WORKSPACE_IPC || '/workspace/ipc';

const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5.4';
const OPENAI_AUTH_MODE = process.env.OPENAI_AUTH_MODE || 'api_key';
const OPENAI_REASONING_EFFORT = (process.env.OPENAI_REASONING_EFFORT || '') as '' | 'low' | 'medium' | 'high';
const OPENAI_REASONING_SUMMARY = (process.env.OPENAI_REASONING_SUMMARY || '') as '' | 'auto' | 'concise' | 'detailed' | 'none';

/** Delegate mode: single-turn execution, no IPC, no messaging/tasks plugins. */
const IS_DELEGATE = process.env.HAPPYCLAW_DELEGATE_MODE === '1';

const API_URL = process.env.HAPPYCLAW_API_URL || 'http://localhost:3000';
const API_TOKEN = process.env.HAPPYCLAW_INTERNAL_TOKEN || '';

const log = createLogger('agent-runner-openai');

// Approximate max tokens for conversation history (keep well under model context window)
const MAX_HISTORY_CHARS = 800_000; // ~200k tokens at ~4 chars/token

/**
 * Estimate character count of a Chat Completions message array.
 * Keeps the first message (system prompt) and trims oldest user/assistant pairs.
 */
function trimChatHistory(messages: ChatCompletionMessageParam[]): void {
  let totalChars = 0;
  for (const m of messages) {
    totalChars += typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content || '').length;
  }
  // Keep system prompt (index 0) and trim from the front of conversation
  while (totalChars > MAX_HISTORY_CHARS && messages.length > 3) {
    const removed = messages.splice(1, 2); // Remove oldest user+assistant pair
    for (const m of removed) {
      totalChars -= typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content || '').length;
    }
  }
}

/**
 * Estimate character count of Codex conversation items and trim oldest.
 */
function trimCodexHistory(items: CodexInputItem[]): void {
  const itemSize = (item: CodexInputItem): number =>
    'content' in item ? (item.content?.length ?? 0) : JSON.stringify(item).length;
  let totalChars = 0;
  for (const item of items) {
    totalChars += itemSize(item);
  }
  while (totalChars > MAX_HISTORY_CHARS && items.length > 2) {
    const removed = items.shift()!;
    totalChars -= itemSize(removed);
  }
}

// ─── Context Manager Setup ───────────────────────────────────

function buildContextManager(ctx: PluginContext): ContextManager {
  const mgr = new ContextManager(ctx);

  if (IS_DELEGATE) {
    // Delegate mode: only local tools (file ops + commands), no messaging/tasks/memory/IM
    mgr.register(new LocalToolsPlugin());
    // No CrossModelPlugin — prevent recursive delegation or cross-model calls
    return mgr;
  }

  const MEMORY_INDEX_PATH = process.env.HAPPYCLAW_WORKSPACE_MEMORY_INDEX || '/workspace/memory-index';

  mgr
    .register(new MessagingPlugin())
    .register(new TasksPlugin())
    .register(new GroupsPlugin())
    .register(new MemoryPlugin({
      apiUrl: API_URL,
      apiToken: API_TOKEN,
      queryTimeoutMs: parseInt(process.env.HAPPYCLAW_MEMORY_QUERY_TIMEOUT || '60000', 10),
      sendTimeoutMs: parseInt(process.env.HAPPYCLAW_MEMORY_SEND_TIMEOUT || '120000', 10),
      memoryIndexPath: path.join(MEMORY_INDEX_PATH, 'index.md'),
    }))
    .register(new FeishuDocsPlugin({
      apiUrl: API_URL,
      apiToken: API_TOKEN,
    }))
    .register(new LocalToolsPlugin())  // OpenAI-specific: file ops & command execution
    .register(new CrossModelPlugin());
  return mgr;
}

// ═══════════════════════════════════════════════════════════════
// MODE 1: Chat Completions API (api_key mode)
// ═══════════════════════════════════════════════════════════════

async function runChatCompletionsTurn(
  client: OpenAI,
  messages: ChatCompletionMessageParam[],
  ctxMgr: ContextManager,
): Promise<string> {
  const tools = toOpenAITools(ctxMgr.getActiveTools());
  let resultText = '';
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let numTurns = 0;
  const startTime = Date.now();

  while (true) {
    numTurns++;
    emitStreamEvent({ eventType: 'status', statusText: 'thinking' });

    const createParams: OpenAI.ChatCompletionCreateParamsStreaming = {
      model: OPENAI_MODEL,
      messages,
      tools: tools as OpenAI.ChatCompletionTool[],
      stream: true,
      stream_options: { include_usage: true },
    };
    if (OPENAI_REASONING_EFFORT) {
      createParams.reasoning_effort = OPENAI_REASONING_EFFORT;
    }
    const stream = await client.chat.completions.create(createParams);

    let currentToolCallId: string | null = null;
    let currentToolName = '';
    let currentToolArgs = '';
    const pendingToolCalls: Array<{ id: string; name: string; args: string }> = [];
    let textBuffer = '';

    for await (const chunk of stream as AsyncIterable<ChatCompletionChunk>) {
      // Capture usage from final chunk (stream_options.include_usage)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chunkUsage = (chunk as any).usage;
      if (chunkUsage) {
        totalInputTokens += chunkUsage.prompt_tokens || 0;
        totalOutputTokens += chunkUsage.completion_tokens || 0;
      }

      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        textBuffer += delta.content;
        emitStreamEvent({ eventType: 'text_delta', textDelta: delta.content });
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          if (tc.id) {
            if (currentToolCallId) {
              pendingToolCalls.push({ id: currentToolCallId, name: currentToolName, args: currentToolArgs });
            }
            currentToolCallId = tc.id;
            currentToolName = tc.function?.name || '';
            currentToolArgs = tc.function?.arguments || '';
            emitStreamEvent({
              eventType: 'tool_use_start',
              toolUseId: tc.id,
              toolName: currentToolName,
              toolInputSummary: '',
            });
          } else {
            if (tc.function?.arguments) {
              currentToolArgs += tc.function.arguments;
            }
          }
        }
      }
    }

    if (currentToolCallId) {
      pendingToolCalls.push({ id: currentToolCallId, name: currentToolName, args: currentToolArgs });
    }

    if (pendingToolCalls.length === 0) {
      resultText = textBuffer;
      // Always emit usage event, even if token counts are 0
      emitStreamEvent({
        eventType: 'usage',
        usage: {
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUSD: 0,
          durationMs: Date.now() - startTime,
          numTurns,
          modelUsage: {
            [OPENAI_MODEL]: {
              inputTokens: totalInputTokens,
              outputTokens: totalOutputTokens,
              costUSD: 0,
            },
          },
        },
      });
      break;
    }

    messages.push({
      role: 'assistant',
      content: textBuffer || null,
      tool_calls: pendingToolCalls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: tc.args },
      })),
    });

    for (const tc of pendingToolCalls) {
      let parsedArgs: Record<string, unknown> = {};
      try { parsedArgs = JSON.parse(tc.args); } catch { parsedArgs = { raw: tc.args }; }

      emitStreamEvent({
        eventType: 'tool_use_start',
        toolUseId: tc.id,
        toolName: tc.name,
        toolInputSummary: tc.args.slice(0, 200),
      });

      log(`Tool call: ${tc.name}(${tc.args.slice(0, 200)})`);
      const result = await ctxMgr.executeTool(tc.name, parsedArgs);

      emitStreamEvent({
        eventType: 'tool_use_end',
        toolUseId: tc.id,
        toolName: tc.name,
        toolOutputSummary: result.content.slice(0, 500),
      });

      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: result.content,
      });
    }
  }

  return resultText;
}

// ═══════════════════════════════════════════════════════════════
// MODE 2: Codex Responses API (chatgpt_oauth mode)
// ═══════════════════════════════════════════════════════════════

async function runCodexTurn(
  accessToken: string,
  instructions: string,
  conversationItems: CodexInputItem[],
  codexTools: CodexToolDef[],
  ctxMgr: ContextManager,
): Promise<{ text: string; newItems: CodexInputItem[] }> {
  const allNewItems: CodexInputItem[] = [];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let numTurns = 0;
  const startTime = Date.now();

  while (true) {
    numTurns++;
    emitStreamEvent({ eventType: 'status', statusText: 'thinking' });

    const result = await codexStreamRequest(
      accessToken,
      OPENAI_MODEL,
      instructions,
      [...conversationItems, ...allNewItems],
      codexTools,
      emitStreamEvent,
      log,
      {
        reasoningEffort: OPENAI_REASONING_EFFORT || undefined,
        reasoningSummary: OPENAI_REASONING_SUMMARY || undefined,
      },
    );

    // Accumulate usage across tool call loops
    if (result.usage) {
      totalInputTokens += result.usage.input_tokens;
      totalOutputTokens += result.usage.output_tokens;
    }

    allNewItems.push(...result.outputItems);

    if (result.functionCalls.length === 0) {
      // Always emit usage event at the end of the turn, even if token counts are 0
      // (Codex chatgpt_oauth API doesn't return usage data in response.completed)
      emitStreamEvent({
        eventType: 'usage',
        usage: {
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUSD: 0, // OpenAI Codex (ChatGPT subscription) doesn't have per-token cost
          durationMs: Date.now() - startTime,
          numTurns,
          modelUsage: {
            [OPENAI_MODEL]: {
              inputTokens: totalInputTokens,
              outputTokens: totalOutputTokens,
              costUSD: 0,
            },
          },
        },
      });
      return { text: result.text, newItems: allNewItems };
    }

    for (const fc of result.functionCalls) {
      let parsedArgs: Record<string, unknown> = {};
      try { parsedArgs = JSON.parse(fc.arguments); } catch { parsedArgs = { raw: fc.arguments }; }

      emitStreamEvent({
        eventType: 'tool_use_start',
        toolUseId: fc.callId,
        toolName: fc.name,
        toolInputSummary: fc.arguments.slice(0, 200),
      });

      log(`Codex tool call: ${fc.name}(${fc.arguments.slice(0, 200)})`);
      const toolResult = await ctxMgr.executeTool(fc.name, parsedArgs);

      emitStreamEvent({
        eventType: 'tool_use_end',
        toolUseId: fc.callId,
        toolName: fc.name,
        toolOutputSummary: toolResult.content.slice(0, 500),
      });

      allNewItems.push({
        type: 'function_call_output',
        call_id: fc.callId,
        output: toolResult.content,
      });
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  const rawInput = await readStdin();
  let input: ContainerInput;
  try {
    input = JSON.parse(rawInput);
  } catch (err) {
    writeOutput({ status: 'error', result: null, error: `Invalid input JSON: ${err}` });
    process.exit(1);
  }

  log(`Starting | mode=${OPENAI_AUTH_MODE} | model=${OPENAI_MODEL} | folder=${input.groupFolder}${IS_DELEGATE ? ' | DELEGATE' : ''}`);

  emitStreamEvent({ eventType: 'init', model: OPENAI_MODEL });

  // Build plugin context & context manager
  const pluginCtx: PluginContext = {
    chatJid: input.chatJid,
    groupFolder: input.groupFolder,
    isHome: !!input.isHome,
    isAdminHome: !!input.isAdminHome,
    workspaceIpc: WORKSPACE_IPC,
    workspaceGroup: WORKSPACE_GROUP,
    workspaceGlobal: WORKSPACE_GLOBAL,
    workspaceMemory: WORKSPACE_MEMORY,
    userId: input.userId,
  };
  const ctxMgr = buildContextManager(pluginCtx);
  const systemPrompt = ctxMgr.buildSystemPrompt(input, `OpenAI (${OPENAI_MODEL})`);

  // IPC config
  const ipcConfig = createIpcConfig(WORKSPACE_IPC);

  if (OPENAI_AUTH_MODE === 'chatgpt_oauth') {
    await runCodexMode(input, systemPrompt, ctxMgr, ipcConfig);
  } else {
    await runChatCompletionsMode(input, systemPrompt, ctxMgr, ipcConfig);
  }
}

// ─── Chat Completions Mode ──────────────────────────────────

async function runChatCompletionsMode(
  input: ContainerInput,
  systemPrompt: string,
  ctxMgr: ContextManager,
  ipcConfig: Parameters<typeof waitForIpcMessage>[0],
): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    writeOutput({ status: 'error', result: null, error: 'OPENAI_API_KEY not set' });
    process.exit(1);
  }

  const clientOptions: ConstructorParameters<typeof OpenAI>[0] = {
    apiKey,
    timeout: 5 * 60_000,  // 5 min request timeout (prevents indefinite hangs)
  };
  if (process.env.OPENAI_BASE_URL) {
    clientOptions.baseURL = process.env.OPENAI_BASE_URL;
  }
  const client = new OpenAI(clientOptions);

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: input.prompt },
  ];

  try {
    const result = await runChatCompletionsTurn(client, messages, ctxMgr);
    if (result) messages.push({ role: 'assistant', content: result });
    writeOutput({ status: 'success', result });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log(`Error in initial turn: ${errMsg}`);
    writeOutput({ status: 'error', result: null, error: errMsg });
  }

  // Delegate mode: single-turn only, exit immediately
  if (IS_DELEGATE) {
    log('Delegate mode: single-turn complete, exiting');
    return;
  }

  while (true) {
    const nextMessage = await waitForIpcMessage(ipcConfig);
    if (nextMessage === null) {
      log('Close sentinel received, exiting');
      writeOutput({ status: 'closed', result: null });
      break;
    }

    messages.push({ role: 'user', content: nextMessage.text });
    trimChatHistory(messages);

    try {
      const result = await runChatCompletionsTurn(client, messages, ctxMgr);
      if (result) messages.push({ role: 'assistant', content: result });
      writeOutput({ status: 'success', result });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log(`Error in IPC turn: ${errMsg}`);
      writeOutput({ status: 'error', result: null, error: errMsg });
    }
  }
}

// ─── Codex Responses Mode ───────────────────────────────────

async function runCodexMode(
  input: ContainerInput,
  systemPrompt: string,
  ctxMgr: ContextManager,
  ipcConfig: Parameters<typeof waitForIpcMessage>[0],
): Promise<void> {
  const accessToken = process.env.OPENAI_ACCESS_TOKEN;
  if (!accessToken) {
    writeOutput({ status: 'error', result: null, error: 'OPENAI_ACCESS_TOKEN not set (required for chatgpt_oauth mode)' });
    process.exit(1);
  }

  const codexTools = toCodexTools(ctxMgr.getActiveTools());
  const conversationItems: CodexInputItem[] = [
    { type: 'message', role: 'user', content: input.prompt },
  ];

  try {
    const { text, newItems } = await runCodexTurn(
      accessToken, systemPrompt, conversationItems, codexTools, ctxMgr,
    );
    conversationItems.push(...newItems);
    writeOutput({ status: 'success', result: text });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log(`Error in initial Codex turn: ${errMsg}`);
    writeOutput({ status: 'error', result: null, error: errMsg });
  }

  // Delegate mode: single-turn only, exit immediately
  if (IS_DELEGATE) {
    log('Delegate mode: single-turn complete, exiting');
    return;
  }

  while (true) {
    const nextMessage = await waitForIpcMessage(ipcConfig);
    if (nextMessage === null) {
      log('Close sentinel received, exiting');
      writeOutput({ status: 'closed', result: null });
      break;
    }

    conversationItems.push({ type: 'message', role: 'user', content: nextMessage.text });
    trimCodexHistory(conversationItems);

    try {
      const { text, newItems } = await runCodexTurn(
        accessToken, systemPrompt, conversationItems, codexTools, ctxMgr,
      );
      conversationItems.push(...newItems);
      writeOutput({ status: 'success', result: text });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log(`Error in Codex IPC turn: ${errMsg}`);
      writeOutput({ status: 'error', result: null, error: errMsg });
    }
  }
}

// ─── Entry ──────────────────────────────────────────────────

main().catch((err) => {
  log(`Fatal error: ${err}`);
  writeOutput({ status: 'error', result: null, error: String(err) });
  process.exit(1);
});
