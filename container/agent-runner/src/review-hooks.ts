/**
 * Code Review Hooks — Automatic GPT parallel review for code changes.
 *
 * Architecture (Plan C):
 * 1. PostToolUse hook: Lightweight collector — appends mutations as NDJSON events
 * 2. Stop hook: Review Coordinator — aggregates mutations, classifies severity,
 *    calls GPT via CrossModel API, injects review as IPC output message
 *
 * Design principles:
 * - Hook layer only collects, never reviews
 * - Coordinator does classification and GPT call
 * - Append-only NDJSON state file for concurrency safety
 * - Review results sent via IPC for the user to see
 * - GPT receives actual diff content, not just metadata
 */

import fs from 'fs';
import path from 'path';
import type {
  HookCallback,
  PostToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';

// ─── Types ─────────────────────────────────────────────────

interface MutationRecord {
  timestamp: string;
  tool: string;
  filePath: string;
  linesAdded: number;
  linesRemoved: number;
  isNewFile: boolean;
  /** Actual diff content for GPT review */
  diff?: string;
  /** Content-based risk signals detected */
  contentRiskSignals?: string[];
}

type ChangeLevel = 'trivial' | 'medium' | 'major';

interface ChangeClassification {
  level: ChangeLevel;
  totalLinesAdded: number;
  totalLinesRemoved: number;
  totalFiles: number;
  newFiles: number;
  hasRiskSignal: boolean;
  riskSignals: string[];
  /** Force review regardless of line counts */
  forceReview: boolean;
}

// ─── Constants ─────────────────────────────────────────────

/** Hard timeout for the entire GPT review call (ms). Prevents blocking agent stop. */
const REVIEW_TIMEOUT_MS = 15_000;

/** Max diff content per mutation to avoid token explosion */
const MAX_DIFF_CHARS = 3000;

/** Max total diff chars sent to GPT */
const MAX_TOTAL_DIFF_CHARS = 15000;

const CODEX_API_URL = 'https://chatgpt.com/backend-api/codex/responses';
const CHAT_COMPLETIONS_API_URL = 'https://api.openai.com/v1/chat/completions';

const RISK_PATH_PATTERNS = [
  /auth/i,
  /payment/i,
  /security/i,
  /crypto/i,
  /migration/i,
  /schema/i,
  /permission/i,
  /secret/i,
  /credential/i,
  /\.env/,
  /config\/production/i,
];

/** Paths whose diff content should NOT be sent to external APIs or persisted in plain text */
const SENSITIVE_PATH_PATTERNS = [
  /\.env/i,
  /secret/i,
  /credential/i,
  /\.pem$/i,
  /\.key$/i,
  /password/i,
  /token/i,
  /\.netrc/i,
  /authorized_keys/i,
  /config\/production/i,
];

function isSensitivePath(filePath: string): boolean {
  return SENSITIVE_PATH_PATTERNS.some((p) => p.test(filePath));
}

const RISK_CONTENT_KEYWORDS = [
  'DELETE FROM',
  'DROP TABLE',
  'rm -rf',
  'exec(',
  'eval(',
  'dangerouslySetInnerHTML',
  'innerHTML',
  'process.exit',
  '--force',
  'sudo ',
];

// ─── State Management (Append-only NDJSON) ────────────────

function getStateFilePath(sessionDir: string): string {
  return path.join(sessionDir, '.review-mutations.ndjson');
}

function appendMutation(sessionDir: string, mutation: MutationRecord): void {
  const stateFile = getStateFilePath(sessionDir);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  // appendFile is atomic enough for single-process sequential writes
  fs.appendFileSync(stateFile, JSON.stringify(mutation) + '\n');
}

function loadMutations(sessionDir: string): MutationRecord[] {
  const stateFile = getStateFilePath(sessionDir);
  try {
    if (!fs.existsSync(stateFile)) return [];
    const content = fs.readFileSync(stateFile, 'utf-8').trim();
    if (!content) return [];
    return content.split('\n').map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    }).filter((m): m is MutationRecord => m !== null);
  } catch {
    return [];
  }
}

function clearState(sessionDir: string): void {
  const stateFile = getStateFilePath(sessionDir);
  try {
    if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
  } catch {
    // Ignore cleanup errors
  }
}

// ─── Mutation Collection ───────────────────────────────────

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + `\n... (truncated, ${s.length - maxLen} chars omitted)`;
}

function extractMutationFromEdit(toolInput: any): MutationRecord | null {
  const filePath = toolInput?.file_path || toolInput?.path || '';
  if (!filePath) return null;

  const oldStr = String(toolInput?.old_string || '');
  const newStr = String(toolInput?.new_string || '');
  const replaceAll = Boolean(toolInput?.replace_all);

  const oldLines = oldStr ? oldStr.split('\n').length : 0;
  const newLines = newStr ? newStr.split('\n').length : 0;
  const perOccurrence = {
    added: Math.max(0, newLines - oldLines),
    removed: Math.max(0, oldLines - newLines),
  };

  // For replace_all, we don't know occurrence count — mark as estimated
  // Use conservative multiplier of 1 (stats may undercount, but won't fabricate)
  const sensitive = isSensitivePath(filePath);
  const diff = sensitive
    ? `--- ${filePath}\n[REDACTED: sensitive file, +${perOccurrence.added}/-${perOccurrence.removed} lines]`
    : `--- ${filePath}\n` +
      (replaceAll ? `(replace_all: true, stats are per-occurrence estimate)\n` : '') +
      `@@ Edit @@\n` +
      oldStr.split('\n').map((l) => `- ${l}`).join('\n') + '\n' +
      newStr.split('\n').map((l) => `+ ${l}`).join('\n');

  return {
    timestamp: new Date().toISOString(),
    tool: 'Edit',
    filePath,
    linesAdded: perOccurrence.added,
    linesRemoved: perOccurrence.removed,
    isNewFile: false,
    diff: truncate(diff, MAX_DIFF_CHARS),
  };
}

function extractMutationFromWrite(toolInput: any, toolResponse: any): MutationRecord | null {
  const filePath = toolInput?.file_path || toolInput?.path || '';
  if (!filePath) return null;

  const content = String(toolInput?.content || '');
  const lines = content.split('\n').length;

  const responseStr = typeof toolResponse === 'string' ? toolResponse : JSON.stringify(toolResponse || '');
  const isNewFile = responseStr.includes('created') || responseStr.includes('Created');

  const sensitive = isSensitivePath(filePath);
  const diff = sensitive
    ? `--- ${filePath}\n[REDACTED: sensitive file, ${lines} lines written]`
    : `--- ${filePath}\n` +
      `@@ Write (${isNewFile ? 'new file' : 'overwrite'}) @@\n` +
      content.split('\n').map((l) => `+ ${l}`).join('\n');

  return {
    timestamp: new Date().toISOString(),
    tool: 'Write',
    filePath,
    linesAdded: lines,
    // For overwrites we can't know the old line count from hook data alone
    linesRemoved: 0,
    isNewFile,
    diff: truncate(diff, MAX_DIFF_CHARS),
  };
}

// ─── Classification ────────────────────────────────────────

function classifyChanges(mutations: MutationRecord[]): ChangeClassification {
  if (mutations.length === 0) {
    return {
      level: 'trivial',
      totalLinesAdded: 0,
      totalLinesRemoved: 0,
      totalFiles: 0,
      newFiles: 0,
      hasRiskSignal: false,
      riskSignals: [],
      forceReview: false,
    };
  }

  const fileMap = new Map<string, MutationRecord[]>();
  for (const m of mutations) {
    const existing = fileMap.get(m.filePath) || [];
    existing.push(m);
    fileMap.set(m.filePath, existing);
  }

  let totalAdded = 0;
  let totalRemoved = 0;
  let newFiles = 0;
  const riskSignals: string[] = [];
  let forceReview = false;

  for (const [filePath, muts] of fileMap) {
    for (const m of muts) {
      totalAdded += m.linesAdded;
      totalRemoved += m.linesRemoved;
      if (m.isNewFile) newFiles++;

      // Collect content-based risk signals (already detected in PostToolUse)
      if (m.contentRiskSignals) {
        for (const sig of m.contentRiskSignals) {
          riskSignals.push(sig);
          forceReview = true;
        }
      }
    }

    // Check path-based risk signals
    for (const pattern of RISK_PATH_PATTERNS) {
      if (pattern.test(filePath)) {
        riskSignals.push(`路径风险: ${filePath} 匹配 ${pattern}`);
        forceReview = true;
        break;
      }
    }
  }

  const totalFiles = fileMap.size;
  const totalDelta = totalAdded + totalRemoved;
  const hasRiskSignal = riskSignals.length > 0;

  let level: ChangeLevel;
  if (forceReview || newFiles >= 3 || totalDelta >= 100) {
    level = 'major';
  } else if (totalDelta >= 10) {
    level = 'medium';
  } else {
    level = 'trivial';
  }

  return {
    level,
    totalLinesAdded: totalAdded,
    totalLinesRemoved: totalRemoved,
    totalFiles,
    newFiles,
    hasRiskSignal,
    riskSignals,
    forceReview,
  };
}

// ─── GPT Review ────────────────────────────────────────────

function buildDiffSection(mutations: MutationRecord[]): string {
  let totalChars = 0;
  const sections: string[] = [];

  for (const m of mutations) {
    if (!m.diff) continue;
    if (totalChars + m.diff.length > MAX_TOTAL_DIFF_CHARS) {
      sections.push(`\n... (remaining diffs truncated, total budget ${MAX_TOTAL_DIFF_CHARS} chars)`);
      break;
    }
    sections.push(m.diff);
    totalChars += m.diff.length;
  }

  return sections.join('\n\n');
}

async function callGptReview(
  classification: ChangeClassification,
  mutations: MutationRecord[],
  accessToken?: string,
  apiKey?: string,
): Promise<string> {
  const riskInfo = classification.riskSignals.length > 0
    ? `\n风险信号：\n${classification.riskSignals.map(s => `  - ${s}`).join('\n')}`
    : '';

  const diffContent = buildDiffSection(mutations);

  const prompt = `请评审以下代码变更：

变更统计：
- 文件数：${classification.totalFiles}
- 新文件：${classification.newFiles}
- 新增行：${classification.totalLinesAdded}
- 删除行：${classification.totalLinesRemoved}
- 变更级别：${classification.level}
${riskInfo}

实际变更内容：
\`\`\`diff
${diffContent}
\`\`\`

重点检查：
1. 边界条件和异常路径是否完整
2. 安全风险（注入、泄露、权限绕过）
3. 逻辑遗漏或隐含假设
4. 并发/竞态条件

按格式回复（简洁）：
## 风险等级
[高/中/低]
## 发现
（无问题则写"变更看起来合理"）
## 建议
（无建议则写"无"）`;

  const reasoningEffort = classification.level === 'major' ? 'high' : 'medium';

  // Try Codex API first (subscription, free)
  if (accessToken) {
    try {
      return await callCodexApi(prompt, accessToken, reasoningEffort);
    } catch {
      // Fall through to Chat Completions
    }
  }

  // Fallback to Chat Completions API
  if (apiKey) {
    return await callChatCompletionsApi(prompt, apiKey, reasoningEffort);
  }

  throw new Error('No OpenAI credentials available for review');
}

async function callCodexApi(prompt: string, accessToken: string, effort: string): Promise<string> {
  const response = await fetch(CODEX_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      model: 'gpt-5.4-mini',
      instructions: '你是代码评审者。只指出真实问题，不做风格评论。简洁回复。',
      input: [{ role: 'user', content: prompt }],
      reasoning: { effort },
      stream: false,
    }),
    signal: AbortSignal.timeout(REVIEW_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Codex API ${response.status}`);
  }

  const data = await response.json() as any;
  if (data.output) {
    for (const item of data.output) {
      if (item.type === 'message' && item.content) {
        for (const block of item.content) {
          if (block.type === 'output_text') return block.text;
        }
      }
    }
  }
  throw new Error('No text in Codex response');
}

async function callChatCompletionsApi(prompt: string, apiKey: string, effort: string): Promise<string> {
  const response = await fetch(CHAT_COMPLETIONS_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-5.4-mini',
      messages: [
        { role: 'system', content: '你是代码评审者。只指出真实问题，不做风格评论。简洁回复。' },
        { role: 'user', content: prompt },
      ],
      reasoning_effort: effort,
    }),
    signal: AbortSignal.timeout(REVIEW_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Chat Completions API ${response.status}`);
  }

  const data = await response.json() as any;
  return data.choices?.[0]?.message?.content || '';
}

// ─── Hook Factories ────────────────────────────────────────

/**
 * Create the PostToolUse hook that collects mutations.
 * Lightweight — only appends to NDJSON state file, no API calls.
 */
export function createPostToolUseReviewHook(sessionDir: string): HookCallback {
  return async (input, _toolUseId, _options) => {
    const hookInput = input as PostToolUseHookInput;
    const toolName = hookInput.tool_name;

    // Only track Edit and Write — NotebookEdit excluded (no structured diff available)
    if (toolName !== 'Edit' && toolName !== 'Write') {
      return {};
    }

    // Skip subagent mutations (delegate_task has its own isolation)
    if (hookInput.agent_id) {
      return {};
    }

    let mutation: MutationRecord | null = null;

    if (toolName === 'Edit') {
      mutation = extractMutationFromEdit(hookInput.tool_input);
    } else if (toolName === 'Write') {
      mutation = extractMutationFromWrite(hookInput.tool_input, hookInput.tool_response);
    }

    if (mutation) {
      // Check for content-based risk signals — stored as metadata, not line inflation
      const toolInput = hookInput.tool_input as any;
      const content = toolInput?.new_string || toolInput?.content || '';
      if (typeof content === 'string') {
        const signals: string[] = [];
        for (const keyword of RISK_CONTENT_KEYWORDS) {
          if (content.includes(keyword)) {
            signals.push(`内容风险: "${keyword}" in ${mutation.filePath}`);
          }
        }
        if (signals.length > 0) {
          mutation.contentRiskSignals = signals;
        }
      }

      appendMutation(sessionDir, mutation);
    }

    return {};
  };
}

/**
 * Create the Stop hook that runs the Review Coordinator.
 * Reads accumulated mutations, classifies, optionally calls GPT, writes result.
 */
export function createStopReviewHook(
  sessionDir: string,
  ipcOutputDir: string,
  chatJid: string,
  log: (msg: string) => void,
): HookCallback {
  return async (_input, _toolUseId, _options) => {
    const mutations = loadMutations(sessionDir);
    if (mutations.length === 0) {
      return {};
    }

    const classification = classifyChanges(mutations);
    log(`[review-coordinator] ${classification.totalFiles} files, +${classification.totalLinesAdded}/-${classification.totalLinesRemoved}, level=${classification.level}${classification.forceReview ? ' (forced)' : ''}`);

    // Trivial changes: skip review
    if (classification.level === 'trivial') {
      clearState(sessionDir);
      return {};
    }

    // Get OpenAI credentials
    const accessToken = process.env.CROSSMODEL_OPENAI_ACCESS_TOKEN;
    const apiKey = process.env.CROSSMODEL_OPENAI_API_KEY;

    if (!accessToken && !apiKey) {
      log('[review-coordinator] No OpenAI credentials, skipping GPT review');
      clearState(sessionDir);
      return {};
    }

    try {
      const reviewText = await callGptReview(
        classification,
        mutations,
        accessToken,
        apiKey,
      );

      // Write review result as IPC message for user visibility
      const levelEmoji = classification.level === 'major' ? '🔴' : '🟡';
      const levelLabel = classification.level === 'major' ? '重大' : '中等';
      const text = `${levelEmoji} **GPT 代码评审** (${levelLabel}变更: ${classification.totalFiles}文件, +${classification.totalLinesAdded}/-${classification.totalLinesRemoved})\n\n${reviewText}`;

      writeIpcMessage(ipcOutputDir, chatJid, text);
      log(`[review-coordinator] GPT review completed for ${classification.level} change`);
    } catch (err) {
      log(`[review-coordinator] GPT review failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    clearState(sessionDir);
    return {};
  };
}

// ─── IPC Helpers ───────────────────────────────────────────

function writeIpcMessage(outputDir: string, chatJid: string, text: string): void {
  fs.mkdirSync(outputDir, { recursive: true });
  const filename = `review-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
  // Use standard IPC message format so main process picks it up
  const message = {
    type: 'message',
    chatJid,
    text,
  };
  // Atomic write: write to tmp then rename
  const tmpPath = path.join(outputDir, `.${filename}.tmp`);
  const finalPath = path.join(outputDir, filename);
  fs.writeFileSync(tmpPath, JSON.stringify(message));
  fs.renameSync(tmpPath, finalPath);
}
