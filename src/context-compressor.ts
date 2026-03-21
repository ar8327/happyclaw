/**
 * Context Compressor — generates conversation summaries using the Anthropic Messages API.
 *
 * Uses Sonnet to summarize conversation history, then resets the SDK session
 * so the next agent invocation starts fresh with the summary injected.
 *
 * Optionally extracts factual knowledge (decisions, conventions, preferences)
 * and writes them to the Memory Agent for persistent cross-session recall.
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
import { getClaudeProviderConfig } from './runtime-config.js';
import type { NewMessage } from './types.js';

const COMPRESSION_MODEL = 'claude-sonnet-4-20250514';
const MAX_MESSAGES_TO_SUMMARIZE = 200;
const MAX_CONTENT_PER_MESSAGE = 500; // chars, truncate long messages
const AUTO_COMPRESS_THRESHOLD = 80; // messages since last compression to trigger auto

/** Per-folder compression lock — prevents concurrent compression for the same folder */
const compressingFolders = new Set<string>();

export interface CompressResult {
  success: boolean;
  summary?: string;
  messageCount?: number;
  extractedKnowledge?: number; // number of knowledge entries extracted
  error?: string;
}

export interface CompressOptions {
  /** Whether to extract knowledge and write to Memory Agent */
  extractKnowledge?: boolean;
  /** Callback to send knowledge entries to Memory Agent (type: 'remember') */
  onKnowledgeEntry?: (content: string, importance: string) => Promise<void>;
  /**
   * Only compress messages with timestamp <= this value.
   * Prevents race condition where new messages arriving during compression
   * get included in the summary AND remain in the active session.
   */
  beforeTimestamp?: string;
}

interface KnowledgeEntry {
  type: 'decision' | 'convention' | 'preference' | 'fact';
  topic: string;
  content: string;
  confidence: 'high' | 'medium';
}

/** Check if a folder is currently being compressed */
export function isCompressing(groupFolder: string): boolean {
  return compressingFolders.has(groupFolder);
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
 * Call Sonnet to generate a text response.
 */
async function callSonnet(
  systemPrompt: string,
  userMessage: string,
): Promise<string> {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error(
      'No Anthropic API key configured. Set it in Claude Provider settings or ANTHROPIC_API_KEY env var.',
    );
  }

  const baseUrl = getBaseUrl();
  const url = `${baseUrl}/v1/messages`;

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
          content: userMessage,
        },
      ],
    }),
  });

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
 * Extract factual knowledge from a conversation transcript.
 * Returns structured knowledge entries that can be saved to the Memory Agent.
 */
async function extractKnowledgeEntries(
  transcript: string,
): Promise<KnowledgeEntry[]> {
  const systemPrompt = `You are a knowledge extractor. Extract important factual knowledge from the conversation below.

Output a JSON array of knowledge entries. Each entry:
{
  "type": "decision" | "convention" | "preference" | "fact",
  "topic": "short topic tag",
  "content": "specific content",
  "confidence": "high" | "medium"
}

Only extract:
- Decisions the user explicitly made (e.g., "use Sonnet for compression")
- Agreed-upon conventions (e.g., "commit messages in Chinese")
- User-expressed preferences (e.g., "don't use Haiku")
- Important technical facts (e.g., "sessions are stored in the sessions table")

Do NOT extract: discussion process, temporary analysis, suggestions not adopted by the user.
Output ONLY the JSON array, no other text.`;

  const text = await callSonnet(
    systemPrompt,
    `Extract knowledge from this conversation:\n\n${transcript}`,
  );

  // Extract JSON array — handle markdown code blocks and leading/trailing prose.
  // Use a stricter approach: try fenced code block first, then outermost [...].
  let jsonStr: string;
  const fencedMatch = text.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/);
  if (fencedMatch) {
    jsonStr = fencedMatch[1];
  } else {
    // Find the first '[' and last ']' for the outermost array
    const firstBracket = text.indexOf('[');
    const lastBracket = text.lastIndexOf(']');
    if (firstBracket !== -1 && lastBracket > firstBracket) {
      jsonStr = text.slice(firstBracket, lastBracket + 1);
    } else {
      jsonStr = text.trim();
    }
  }

  try {
    const entries = JSON.parse(jsonStr) as KnowledgeEntry[];
    if (!Array.isArray(entries)) return [];
    // Validate and filter
    return entries.filter(
      (e) =>
        e &&
        typeof e.type === 'string' &&
        typeof e.content === 'string' &&
        e.content.length > 0,
    );
  } catch {
    logger.warn(
      { responseLength: text.length },
      'Failed to parse knowledge extraction response as JSON',
    );
    return [];
  }
}

/**
 * Compress the conversation for a group/chat.
 *
 * 1. Acquires per-folder lock (prevents concurrent compression)
 * 2. Fetches recent messages from DB
 * 3. Calls Sonnet to generate a summary
 * 4. Optionally extracts knowledge and writes to Memory Agent
 * 5. Stores the summary in context_summaries table
 * 6. Resets the SDK session so next invocation starts fresh
 *
 * Note: The caller is responsible for clearing the in-memory sessions map
 * (since it lives in index.ts, not here).
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
        extractKnowledge: !!options?.extractKnowledge,
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

    const summary = await callSonnet(
      summaryPrompt,
      `Please summarize this conversation:\n\n${transcript}`,
    );

    // 4. Optionally extract knowledge
    let extractedKnowledge = 0;
    if (options?.extractKnowledge && options.onKnowledgeEntry) {
      try {
        const entries = await extractKnowledgeEntries(transcript);
        for (const entry of entries) {
          const content = `[${entry.type}] ${entry.topic}: ${entry.content}`;
          const importance = entry.confidence === 'high' ? 'high' : 'normal';
          try {
            await options.onKnowledgeEntry(content, importance);
            extractedKnowledge++;
          } catch (err) {
            logger.warn(
              { topic: entry.topic, error: err instanceof Error ? err.message : String(err) },
              'Failed to save knowledge entry to Memory Agent',
            );
          }
        }
        logger.info(
          { groupFolder, chatJid, extracted: extractedKnowledge, total: entries.length },
          'Knowledge extraction completed',
        );
      } catch (err) {
        logger.error(
          { groupFolder, chatJid, error: err instanceof Error ? err.message : String(err) },
          'Knowledge extraction failed (compression will continue)',
        );
      }
    }

    // 5. Store summary
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
        extractedKnowledge,
      },
      'Context compressed successfully',
    );

    return {
      success: true,
      summary,
      messageCount: messages.length,
      extractedKnowledge,
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
