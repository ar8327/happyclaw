/**
 * IM Commentary — sends human-readable tool-call explanations to IM channels
 * during long-running agent tasks.
 *
 * Model priority:
 *   1. Claude Haiku (Anthropic API key)
 *   2. Heuristic formatting (no model, always available)
 *
 * Fire-and-forget: all public functions are async but callers should NOT await.
 * Rate-limited to prevent IM spam.
 */

import { logger } from './logger.js';

/** Minimum seconds between commentary messages per workspace folder. */
const RATE_LIMIT_SECONDS = 8;

/** Tools that are too trivial to comment on. */
const SKIP_TOOLS = new Set([
  'mcp__happyclaw__memory_query',
  'mcp__happyclaw__memory_remember',
  'TodoWrite',
  'TodoRead',
]);

/** Track last commentary time per folder to enforce rate limit. */
const lastCommentaryTime = new Map<string, number>();

/**
 * Track the first tool-call time of the current turn per folder.
 * Commentary only fires after MIN_TASK_DURATION_MS has elapsed — this
 * suppresses noise for quick interactive responses (<30 s) while still
 * reporting long background tasks.
 */
const turnFirstToolTime = new Map<string, number>();

/** Minimum time (ms) a turn must be running before commentary starts. */
const MIN_TASK_DURATION_MS = 30_000;

/** Called when a turn completes so the next turn gets a fresh timer. */
export function resetTurnCommentaryTimer(folder: string): void {
  turnFirstToolTime.delete(folder);
}

/**
 * Generate and send a natural-language explanation of a tool call to IM.
 * Safe to call fire-and-forget — all errors are caught internally.
 */
export async function sendToolCommentary(opts: {
  folder: string;
  toolName: string;
  toolInputSummary?: string;
  isNested: boolean;
  /** Called with the generated commentary text. Update the progress card or send a message. */
  onCommentary: (text: string) => void;
}): Promise<void> {
  const { folder, toolName, toolInputSummary, isNested, onCommentary } = opts;

  // Only comment on top-level tool calls
  if (isNested) return;

  // Skip trivial tools
  if (SKIP_TOOLS.has(toolName)) return;

  const now = Date.now();

  // Record the first tool call time of this turn
  if (!turnFirstToolTime.has(folder)) {
    turnFirstToolTime.set(folder, now);
  }

  // Suppress commentary for the first MIN_TASK_DURATION_MS of a turn
  // (avoids flooding the chat during quick interactive responses)
  const turnStart = turnFirstToolTime.get(folder)!;
  if (now - turnStart < MIN_TASK_DURATION_MS) return;

  // Rate limit: at most once per RATE_LIMIT_SECONDS per folder
  const last = lastCommentaryTime.get(folder) ?? 0;
  if (now - last < RATE_LIMIT_SECONDS * 1000) return;
  lastCommentaryTime.set(folder, now);

  try {
    const explanation = await generateExplanation(toolName, toolInputSummary);
    if (explanation) {
      onCommentary(explanation);
    }
  } catch (err) {
    logger.debug({ err, folder, toolName }, 'im-commentary: failed to send');
  }
}

const PROMPT_TEMPLATE = (input: string) =>
  `用中文一句话（不超过20字）解释正在做什么：\n${input}\n\n只输出解释文字，不要任何多余内容。`;

/** Generate explanation: Haiku → heuristic fallback. */
async function generateExplanation(
  toolName: string,
  inputSummary?: string,
): Promise<string | null> {
  const input = inputSummary
    ? `工具: ${toolName}\n输入: ${inputSummary.slice(0, 300)}`
    : `工具: ${toolName}`;

  // 1. Try Haiku (Anthropic API key)
  const haikuResult = await tryHaiku(PROMPT_TEMPLATE(input));
  if (haikuResult) return haikuResult;

  // 2. Heuristic fallback
  return formatFallback(toolName, inputSummary);
}

/** Call Claude Haiku (Anthropic API key fallback). */
async function tryHaiku(prompt: string): Promise<string | null> {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return null;

    const body = {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 60,
      messages: [{ role: 'user', content: prompt }],
    };

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) return null;

    const data = (await response.json()) as {
      content: Array<{ type: string; text: string }>;
    };
    return data.content?.find((c) => c.type === 'text')?.text?.trim() || null;
  } catch {
    return null;
  }
}

/** Simple heuristic fallback when no model is available. */
function formatFallback(toolName: string, inputSummary?: string): string {
  const short = inputSummary ? inputSummary.slice(0, 60) : '';
  if (toolName === 'Bash') return short ? `执行命令: ${short}` : '执行 Shell 命令';
  if (toolName === 'Read') return short ? `读取文件: ${short}` : '读取文件';
  if (toolName === 'Write') return short ? `写入文件: ${short}` : '写入文件';
  if (toolName === 'Edit') return short ? `编辑文件: ${short}` : '编辑文件';
  if (toolName === 'Grep') return short ? `搜索: ${short}` : '搜索代码';
  if (toolName === 'Glob') return short ? `查找文件: ${short}` : '查找文件';
  if (toolName === 'Agent') return short ? `启动子代理: ${short}` : '启动子代理';
  if (toolName === 'WebFetch' || toolName === 'WebSearch') return short ? `网页: ${short}` : '访问网页';
  return short ? `${toolName}: ${short}` : toolName;
}
