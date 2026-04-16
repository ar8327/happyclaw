/**
 * Context Compressor — generates conversation summaries using the Anthropic Messages API.
 *
 * Uses Sonnet to summarize conversation history, then resets the SDK session
 * so the next agent invocation starts fresh with the summary injected.
 */

import { logger } from './logger.js';
import {
  getMessagesPage,
  setContextSummary,
  getContextSummary,
  deleteSession,
  countMessagesSince,
  type ContextSummary,
} from './db.js';
import { importLocalClaudeCredentials } from './runtime-config.js';
import type { NewMessage } from './types.js';

// OAuth tokens (from Claude Code subscription) only allow Haiku for direct Messages API.
// Haiku is fast and sufficient for summarization tasks.
const COMPRESSION_MODEL = 'claude-haiku-4-5-20251001';
const MAX_MESSAGES_TO_SUMMARIZE = 200;
const MAX_CONTENT_PER_MESSAGE = 500; // chars, truncate long messages
const AUTO_COMPRESS_THRESHOLD = 80; // messages since last compression to trigger auto

/** Per-folder compression lock — prevents concurrent compression for the same folder */
const compressingFolders = new Set<string>();

export interface CompressResult {
  success: boolean;
  summary?: string;
  messageCount?: number;
  error?: string;
}

export interface CompressOptions {
  /**
   * Only compress messages with timestamp <= this value.
   * Prevents race condition where new messages arriving during compression
   * get included in the summary AND remain in the active session.
   */
  beforeTimestamp?: string;
}

/** Check if a folder is currently being compressed */
export function isCompressing(groupFolder: string): boolean {
  return compressingFolders.has(groupFolder);
}

/**
 * Get authentication credentials for the Anthropic API.
 * Tries local machine environment first, then local Claude Code OAuth credentials.
 * Returns { type, token } where type determines the HTTP header to use.
 */
function getAuthCredentials(): { type: 'api-key' | 'bearer'; token: string } | null {
  if (process.env.ANTHROPIC_API_KEY) {
    return { type: 'api-key', token: process.env.ANTHROPIC_API_KEY };
  }

  const oauth = importLocalClaudeCredentials();
  if (oauth?.accessToken) {
    return { type: 'bearer', token: oauth.accessToken };
  }

  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    return { type: 'bearer', token: process.env.CLAUDE_CODE_OAUTH_TOKEN };
  }

  return null;
}

/**
 * Get the Anthropic base URL from the local environment.
 */
function getBaseUrl(): string {
  return process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
}

/**
 * Build a conversation transcript from DB messages for summarization.
 */
function buildTranscript(
  messages: Array<NewMessage & { is_from_me: boolean }>,
): string {
  const lines: string[] = [];
  for (const msg of messages) {
    const role = msg.is_from_me ? 'Assistant' : msg.sender_name || 'User';
    let content = msg.content || '';
    if (content.length > MAX_CONTENT_PER_MESSAGE) {
      content = content.slice(0, MAX_CONTENT_PER_MESSAGE) + '...';
    }
    // Skip empty messages
    if (!content.trim()) continue;
    lines.push(`[${role}]: ${content}`);
  }
  return lines.join('\n\n');
}

/**
 * Call Sonnet to generate a text response.
 */
async function callSonnet(
  systemPrompt: string,
  userMessage: string,
): Promise<string> {
  const auth = getAuthCredentials();
  if (!auth) {
    throw new Error(
      'No local Anthropic credentials found. Configure Claude Code locally or export ANTHROPIC_API_KEY.',
    );
  }

  const baseUrl = getBaseUrl();
  const url = `${baseUrl}/v1/messages`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
  };
  if (auth.type === 'api-key') {
    headers['x-api-key'] = auth.token;
  } else {
    headers['Authorization'] = `Bearer ${auth.token}`;
    // OAuth Bearer requires this beta header for Messages API access
    headers['anthropic-beta'] = 'oauth-2025-04-20';
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000); // 60s timeout

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: COMPRESSION_MODEL,
        max_tokens: 2048,
        system: systemPrompt,
        messages: [
          {
            role: 'user',
            content: userMessage,
          },
        ],
      }),
    });
  } catch (err: unknown) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('Anthropic API 请求超时 (60s)');
    }
    throw err;
  }
  clearTimeout(timer);

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `Anthropic API error ${response.status}: ${errorBody.slice(0, 200)}`,
    );
  }

  const result = (await response.json()) as {
    content: Array<{ type: string; text?: string }>;
  };
  const textBlock = result.content.find((b) => b.type === 'text');
  if (!textBlock?.text) {
    throw new Error('Anthropic API returned no text content');
  }

  return textBlock.text;
}

/**
 * Compress the conversation for a group/chat.
 *
 * 1. Acquires per-folder lock
 * 2. Fetches recent messages from DB
 * 3. Calls Sonnet to generate a summary
 * 4. Stores the summary in context_summaries table
 * 5. Resets the SDK session so next invocation starts fresh
 *
 * Note: The caller is responsible for clearing the in-memory sessions map
 * because it lives in index.ts, not here.
 */
export async function compressContext(
  groupFolder: string,
  chatJid: string,
  options?: CompressOptions,
): Promise<CompressResult> {
  // Acquire per-folder lock
  if (compressingFolders.has(groupFolder)) {
    return {
      success: false,
      error: 'Compression already in progress for this workspace',
    };
  }
  compressingFolders.add(groupFolder);

  try {
    // 1. Fetch messages (bounded by beforeTimestamp to prevent race with new messages)
    const messages = getMessagesPage(
      chatJid,
      options?.beforeTimestamp,
      MAX_MESSAGES_TO_SUMMARIZE,
    );
    if (messages.length < 5) {
      return {
        success: false,
        error: 'Not enough messages to compress (minimum 5)',
      };
    }

    // Messages come in DESC order from getMessagesPage, reverse to chronological
    messages.reverse();

    // 2. Build transcript
    const transcript = buildTranscript(messages);
    if (transcript.length < 100) {
      return {
        success: false,
        error: 'Conversation too short to compress',
      };
    }

    logger.info(
      {
        groupFolder,
        chatJid,
        messageCount: messages.length,
        transcriptLength: transcript.length,
      },
      'Compressing context',
    );

    // 3. Call Sonnet for summary
    const summaryPrompt = `You are a conversation summarizer. Your task is to create a concise but comprehensive summary of the conversation below. The summary should:

1. Capture all key decisions, conclusions, and action items
2. Note important technical details, file paths, code changes, and configurations discussed
3. Preserve the context needed for continuing the conversation
4. Be structured with clear sections if the conversation covers multiple topics
5. Be written in the same language as the conversation (usually Chinese or English)

Keep the summary under 2000 tokens. Focus on WHAT was decided and done, not the back-and-forth discussion process.`;

    logger.info({ groupFolder }, 'Calling Haiku for summary...');
    const t0 = Date.now();
    const summary = await callSonnet(
      summaryPrompt,
      `Please summarize this conversation:\n\n${transcript}`,
    );
    logger.info({ groupFolder, durationMs: Date.now() - t0, summaryLength: summary.length }, 'Summary generated');

    // 4. Store summary before resetting the session.
    const contextSummary: ContextSummary = {
      group_folder: groupFolder,
      chat_jid: chatJid,
      summary,
      message_count: messages.length,
      created_at: new Date().toISOString(),
      model_used: COMPRESSION_MODEL,
    };
    setContextSummary(contextSummary);

    // 6. Reset SDK session — next invocation will start fresh with summary
    deleteSession(groupFolder);

    logger.info(
      {
        groupFolder,
        chatJid,
        messageCount: messages.length,
        summaryLength: summary.length,
      },
      'Context compressed successfully',
    );

    return {
      success: true,
      summary,
      messageCount: messages.length,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error(
      { groupFolder, chatJid, error: errorMsg },
      'Failed to compress context',
    );
    return {
      success: false,
      error: errorMsg,
    };
  } finally {
    compressingFolders.delete(groupFolder);
  }
}

/**
 * Get the existing context summary for a group/chat, if any.
 */
export function getExistingContextSummary(
  groupFolder: string,
  chatJid: string,
): ContextSummary | undefined {
  return getContextSummary(groupFolder, chatJid);
}

/**
 * Check if auto-compression should be triggered.
 * Returns true if enough new messages have accumulated since the last compression
 * (or since the beginning if no compression has been done yet).
 */
export function shouldAutoCompress(
  groupFolder: string,
  chatJid: string,
): boolean {
  // Skip if already compressing
  if (compressingFolders.has(groupFolder)) return false;

  const existing = getContextSummary(groupFolder, chatJid);
  if (existing) {
    // Count messages since last compression
    const newCount = countMessagesSince(chatJid, existing.created_at);
    return newCount >= AUTO_COMPRESS_THRESHOLD;
  }
  // No previous compression — use COUNT for efficiency
  const totalCount = countMessagesSince(chatJid, '1970-01-01T00:00:00.000Z');
  return totalCount >= AUTO_COMPRESS_THRESHOLD;
}
