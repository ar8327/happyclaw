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
  type ContextSummary,
} from './db.js';
import { getClaudeProviderConfig } from './runtime-config.js';
import type { NewMessage } from './types.js';

const COMPRESSION_MODEL = 'claude-sonnet-4-20250514';
const MAX_MESSAGES_TO_SUMMARIZE = 200;
const MAX_CONTENT_PER_MESSAGE = 500; // chars, truncate long messages

interface CompressResult {
  success: boolean;
  summary?: string;
  messageCount?: number;
  error?: string;
}

/**
 * Get the Anthropic API key from the provider config.
 * Falls back to ANTHROPIC_API_KEY env var.
 */
function getApiKey(): string | null {
  const config = getClaudeProviderConfig();
  if (config.anthropicApiKey) return config.anthropicApiKey;
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  return null;
}

/**
 * Get the Anthropic base URL from the provider config.
 */
function getBaseUrl(): string {
  const config = getClaudeProviderConfig();
  return config.anthropicBaseUrl || 'https://api.anthropic.com';
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
 * Call the Anthropic Messages API to generate a summary.
 */
async function callSonnetForSummary(transcript: string): Promise<string> {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error(
      'No Anthropic API key configured. Set it in Claude Provider settings or ANTHROPIC_API_KEY env var.',
    );
  }

  const baseUrl = getBaseUrl();
  const url = `${baseUrl}/v1/messages`;

  const systemPrompt = `You are a conversation summarizer. Your task is to create a concise but comprehensive summary of the conversation below. The summary should:

1. Capture all key decisions, conclusions, and action items
2. Note important technical details, file paths, code changes, and configurations discussed
3. Preserve the context needed for continuing the conversation
4. Be structured with clear sections if the conversation covers multiple topics
5. Be written in the same language as the conversation (usually Chinese or English)

Keep the summary under 2000 tokens. Focus on WHAT was decided and done, not the back-and-forth discussion process.`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: COMPRESSION_MODEL,
      max_tokens: 2048,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: `Please summarize this conversation:\n\n${transcript}`,
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `Anthropic API error ${response.status}: ${errorBody.slice(0, 500)}`,
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
 * 1. Fetches recent messages from DB
 * 2. Calls Sonnet to generate a summary
 * 3. Stores the summary in context_summaries table
 * 4. Resets the SDK session so next invocation starts fresh
 */
export async function compressContext(
  groupFolder: string,
  chatJid: string,
): Promise<CompressResult> {
  try {
    // 1. Fetch messages
    const messages = getMessagesPage(chatJid, undefined, MAX_MESSAGES_TO_SUMMARIZE);
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
      { groupFolder, chatJid, messageCount: messages.length },
      'Compressing context',
    );

    // 3. Call Sonnet for summary
    const summary = await callSonnetForSummary(transcript);

    // 4. Store summary
    const contextSummary: ContextSummary = {
      group_folder: groupFolder,
      chat_jid: chatJid,
      summary,
      message_count: messages.length,
      created_at: new Date().toISOString(),
      model_used: COMPRESSION_MODEL,
    };
    setContextSummary(contextSummary);

    // 5. Reset SDK session — next invocation will start fresh with summary
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
      { groupFolder, chatJid, err },
      'Failed to compress context',
    );
    return {
      success: false,
      error: errorMsg,
    };
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
