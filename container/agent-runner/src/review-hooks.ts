/**
 * Code Review Hooks — Automatic GPT parallel review for code changes.
 *
 * Architecture:
 * 1. PostToolUse hook: Lightweight collector — appends mutations as NDJSON events
 *    - Tracks Edit, Write, AND Bash commands that write files
 *    - Triggers incremental review when accumulated changes hit major threshold
 * 2. Stop hook: Review Coordinator — final review for remaining unreviewd changes
 *
 * Design principles:
 * - Hook layer only collects, never reviews
 * - Coordinator does classification and GPT call
 * - Append-only NDJSON state file for concurrency safety
 * - Review results sent via IPC for the user to see
 * - GPT receives actual diff content, not just metadata
 * - Sensitive file content is never sent externally
 */

import fs from 'fs';
import path from 'path';
import type {
  HookCallback,
  PostToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';

import { callLlm, getLlmCredentials, hasLlmCredentials, type LlmCredentials } from './gpt-client.js';
import {
  isSensitivePath,
  isRiskPath,
  RISK_CONTENT_KEYWORDS,
  detectContentRiskSignals,
  bashCommandWritesFiles,
  extractBashAffectedPaths,
} from './risk-rules.js';
import { createProvider, assembleContext } from './review-context/index.js';
import type { ReviewContextConfig } from './review-context/index.js';

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
  forceReview: boolean;
}

// ─── Constants ─────────────────────────────────────────────

const REVIEW_TIMEOUT_MAJOR_MS = 30_000;
const REVIEW_TIMEOUT_MEDIUM_MS = 15_000;

/** Max diff content per mutation to avoid token explosion */
const MAX_DIFF_CHARS = 3000;

/** Max total diff chars sent to GPT */
const MAX_TOTAL_DIFF_CHARS = 15000;

// ─── State Management (Append-only NDJSON) ────────────────

function getStateFilePath(sessionDir: string): string {
  return path.join(sessionDir, '.review-mutations.ndjson');
}

function appendMutation(sessionDir: string, mutation: MutationRecord): void {
  const stateFile = getStateFilePath(sessionDir);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
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

  const sensitive = isSensitivePath(filePath);
  const diff = sensitive
    ? `--- ${filePath}\n[REDACTED: sensitive file, +${perOccurrence.added}/-${perOccurrence.removed} lines]`
    : `--- ${filePath}\n` +
      (replaceAll ? `(replace_all: true, stats are per-occurrence estimate)\n` : '') +
      `@@ Edit @@\n` +
      oldStr.split('\n').map((l: string) => `- ${l}`).join('\n') + '\n' +
      newStr.split('\n').map((l: string) => `+ ${l}`).join('\n');

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
      content.split('\n').map((l: string) => `+ ${l}`).join('\n');

  return {
    timestamp: new Date().toISOString(),
    tool: 'Write',
    filePath,
    linesAdded: lines,
    linesRemoved: 0,
    isNewFile,
    diff: truncate(diff, MAX_DIFF_CHARS),
  };
}

function extractMutationFromBash(toolInput: any, toolResponse: any): MutationRecord | null {
  const command = String(toolInput?.command || '');
  if (!command || !bashCommandWritesFiles(command)) return null;

  const affectedPaths = extractBashAffectedPaths(command);
  if (affectedPaths.length === 0) {
    // Still record with generic path if we know it writes files
    return {
      timestamp: new Date().toISOString(),
      tool: 'Bash',
      filePath: '[bash file modification]',
      linesAdded: 0,
      linesRemoved: 0,
      isNewFile: false,
      diff: `--- Bash command\n$ ${command.slice(0, 500)}`,
    };
  }

  // Create one mutation per affected path
  // Return the first; caller handles multiple via extractMutationsFromBash
  const firstPath = affectedPaths[0];
  const sensitive = isSensitivePath(firstPath);
  return {
    timestamp: new Date().toISOString(),
    tool: 'Bash',
    filePath: firstPath,
    linesAdded: 0,
    linesRemoved: 0,
    isNewFile: false,
    diff: sensitive
      ? `--- ${firstPath}\n[REDACTED: sensitive file modified via Bash]`
      : `--- ${firstPath}\n$ ${command.slice(0, 500)}`,
  };
}

/** Extract all mutations from a Bash command (may affect multiple files) */
function extractMutationsFromBash(toolInput: any, toolResponse: any): MutationRecord[] {
  const command = String(toolInput?.command || '');
  if (!command || !bashCommandWritesFiles(command)) return [];

  const affectedPaths = extractBashAffectedPaths(command);
  if (affectedPaths.length === 0) {
    const m = extractMutationFromBash(toolInput, toolResponse);
    return m ? [m] : [];
  }

  return affectedPaths.map((filePath) => {
    const sensitive = isSensitivePath(filePath);
    return {
      timestamp: new Date().toISOString(),
      tool: 'Bash',
      filePath,
      linesAdded: 0,
      linesRemoved: 0,
      isNewFile: false,
      diff: sensitive
        ? `--- ${filePath}\n[REDACTED: sensitive file modified via Bash]`
        : `--- ${filePath}\n$ ${command.slice(0, 500)}`,
    };
  });
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

      if (m.contentRiskSignals) {
        for (const sig of m.contentRiskSignals) {
          riskSignals.push(sig);
          forceReview = true;
        }
      }
    }

    // Check path-based risk signals (use shared rules)
    if (isRiskPath(filePath)) {
      riskSignals.push(`路径风险: ${filePath}`);
      forceReview = true;
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
  creds: LlmCredentials,
  classification: ChangeClassification,
  mutations: MutationRecord[],
  serviceContext?: string,
): Promise<string> {
  const riskInfo = classification.riskSignals.length > 0
    ? `\n风险信号：\n${classification.riskSignals.map(s => `  - ${s}`).join('\n')}`
    : '';

  const diffContent = buildDiffSection(mutations);

  // Inject service context before the review prompt if available
  const contextPrefix = serviceContext ? `${serviceContext}\n\n` : '';

  const prompt = `${contextPrefix}请评审以下代码变更：

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

  const isMajor = classification.level === 'major';

  return await callLlm(creds, {
    prompt,
    system: '你是代码评审者。只指出真实问题，不做风格评论。简洁回复。',
    model: isMajor ? 'gpt-5.4' : 'gpt-5.4-mini',
    reasoningEffort: isMajor ? 'high' : 'medium',
    timeoutMs: isMajor ? REVIEW_TIMEOUT_MAJOR_MS : REVIEW_TIMEOUT_MEDIUM_MS,
    retryOn429: isMajor, // Retry for major reviews
  });
}

// ─── Service Context Resolution ──────────────────────────

/**
 * Try to resolve service context for the changed files.
 * Returns assembled context block string, or empty string if unavailable.
 * Never throws — fails silently with logging.
 */
async function resolveServiceContext(
  mutations: MutationRecord[],
  contextConfig: ReviewContextConfig | undefined,
  log: (msg: string) => void,
): Promise<string> {
  if (!contextConfig || contextConfig.provider === 'null') return '';

  try {
    const provider = createProvider(contextConfig);
    const changedFiles = mutations.map(m => m.filePath).filter(Boolean);
    if (changedFiles.length === 0) return '';

    // Infer repoPath from common prefix of changed files
    const firstFile = changedFiles[0];
    const repoPath = findRepoRoot(firstFile);
    if (!repoPath) return '';

    // Make changedFiles relative to repoPath
    const relativeFiles = changedFiles
      .map(f => f.startsWith(repoPath) ? f.substring(repoPath.length + 1) : f)
      .map(f => f.replace(/\\/g, '/'));

    const timeout = contextConfig.options?.timeout ?? 5000;
    const output = await Promise.race([
      provider.provide({ repoPath, changedFiles: relativeFiles }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), timeout)
      ),
    ]);

    // Log diagnostics
    for (const d of output.provider_diagnostics) {
      if (d.level !== 'info') {
        log(`[review-context] ${d.level}: ${d.code} — ${d.message}`);
      }
    }

    if (output.status === 'matched') {
      log(`[review-context] status=matched service=${output.matched_service} injectable=${output.injectable} gen=${output.generation_id} freshness=${output.provenance?.freshness}`);
    } else if (output.status !== 'not_configured' && output.status !== 'not_applicable') {
      log(`[review-context] status=${output.status} reason=${output.reason_code ?? 'n/a'}`);
    }

    const maxTokens = contextConfig.options?.maxTokens ?? 600;
    return assembleContext(output, maxTokens);
  } catch (err) {
    log(`[review-context] error: ${err instanceof Error ? err.message : String(err)}`);
    return '';
  }
}

/** Walk up from a file path to find a directory containing go.mod or pom.xml. */
function findRepoRoot(filePath: string): string | null {
  let dir = path.dirname(filePath);
  for (let i = 0; i < 20; i++) {
    if (fs.existsSync(path.join(dir, 'go.mod')) || fs.existsSync(path.join(dir, 'pom.xml'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// ─── Incremental Review ───────────────────────────────────

/**
 * Run a review on current accumulated mutations if they've reached major threshold.
 * Returns true if review was triggered, false otherwise.
 */
async function tryIncrementalReview(
  creds: LlmCredentials,
  sessionDir: string,
  ipcOutputDir: string,
  chatJid: string,
  log: (msg: string) => void,
  contextConfig?: ReviewContextConfig,
): Promise<boolean> {
  const mutations = loadMutations(sessionDir);
  if (mutations.length === 0) return false;

  const classification = classifyChanges(mutations);

  // Only trigger incremental review for major changes
  if (classification.level !== 'major') return false;

  log(`[review-incremental] Triggered: ${classification.totalFiles} files, +${classification.totalLinesAdded}/-${classification.totalLinesRemoved}`);

  try {
    const serviceContext = await resolveServiceContext(mutations, contextConfig, log);
    const reviewText = await callGptReview(creds, classification, mutations, serviceContext || undefined);
    const text = `🔴 **GPT 增量评审** (重大变更: ${classification.totalFiles}文件, +${classification.totalLinesAdded}/-${classification.totalLinesRemoved})\n\n${reviewText}`;
    writeIpcMessage(ipcOutputDir, chatJid, text);
    log(`[review-incremental] Review completed`);
  } catch (err) {
    log(`[review-incremental] Failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Clear state after incremental review so Stop doesn't re-review
  clearState(sessionDir);
  return true;
}

// ─── Hook Factories ────────────────────────────────────────

/**
 * Create the PostToolUse hook that collects mutations.
 * Tracks Edit, Write, AND Bash commands that modify files.
 * Triggers incremental review when changes reach major threshold.
 */
export function createPostToolUseReviewHook(
  sessionDir: string,
  ipcOutputDir?: string,
  chatJid?: string,
  log?: (msg: string) => void,
  contextConfig?: ReviewContextConfig,
): HookCallback {
  const creds = getLlmCredentials();
  let incrementalReviewPending = false;

  return async (input, _toolUseId, _options) => {
    const hookInput = input as PostToolUseHookInput;
    const toolName = hookInput.tool_name;

    // Skip subagent mutations
    if (hookInput.agent_id) return {};

    // Track Edit, Write, and file-writing Bash commands
    let mutations: MutationRecord[] = [];

    if (toolName === 'Edit') {
      const m = extractMutationFromEdit(hookInput.tool_input);
      if (m) mutations.push(m);
    } else if (toolName === 'Write') {
      const m = extractMutationFromWrite(hookInput.tool_input, hookInput.tool_response);
      if (m) mutations.push(m);
    } else if (toolName === 'Bash') {
      mutations = extractMutationsFromBash(hookInput.tool_input, hookInput.tool_response);
    } else {
      return {};
    }

    for (const mutation of mutations) {
      // Check content risk signals
      const toolInput = hookInput.tool_input as any;
      const content = toolInput?.new_string || toolInput?.content || '';
      if (typeof content === 'string' && content) {
        const signals = detectContentRiskSignals(content, mutation.filePath);
        if (signals.length > 0) {
          mutation.contentRiskSignals = signals;
        }
      }

      appendMutation(sessionDir, mutation);
    }

    // Try incremental review if we have IPC info and haven't just done one
    if (mutations.length > 0 && ipcOutputDir && chatJid && log && !incrementalReviewPending) {
      incrementalReviewPending = true;
      // Check every 5 mutations if we should trigger incremental review
      const allMutations = loadMutations(sessionDir);
      if (allMutations.length >= 5 && hasLlmCredentials(creds)) {
        const triggered = await tryIncrementalReview(creds, sessionDir, ipcOutputDir, chatJid, log, contextConfig);
        if (triggered) {
          incrementalReviewPending = false;
          return {};
        }
      }
      incrementalReviewPending = false;
    }

    return {};
  };
}

/**
 * Create the Stop hook that runs the Review Coordinator.
 * Reviews any remaining unreviewd mutations accumulated since last incremental review.
 */
export function createStopReviewHook(
  sessionDir: string,
  ipcOutputDir: string,
  chatJid: string,
  log: (msg: string) => void,
  contextConfig?: ReviewContextConfig,
): HookCallback {
  const creds = getLlmCredentials();

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

    if (!hasLlmCredentials(creds)) {
      log('[review-coordinator] No OpenAI credentials, skipping GPT review');
      clearState(sessionDir);
      return {};
    }

    try {
      const serviceContext = await resolveServiceContext(mutations, contextConfig, log);
      const reviewText = await callGptReview(creds, classification, mutations, serviceContext || undefined);

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
