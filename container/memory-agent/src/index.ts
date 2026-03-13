/**
 * HappyClaw Memory Agent
 *
 * A lightweight per-user memory management agent that runs as a child process
 * of the main HappyClaw server. Communicates via stdin/stdout JSON lines.
 *
 * Architecture:
 *   Uses a PERSISTENT query() with AsyncIterable<SDKUserMessage> prompt,
 *   keeping a single long-lived CLI process. This avoids spawning a new CLI
 *   per request, which would fail OAuth token refresh (refresh tokens are
 *   single-use, and the main agent's CLI may have already consumed it).
 *
 * Protocol:
 *   stdin:  One JSON object per line (newline-delimited)
 *   stdout: One JSON response per line (matched by requestId)
 *   stderr: Diagnostic logs (not parsed by parent)
 *
 * Request types:
 *   - query:          Search memories and return relevant information
 *   - remember:       Store new information into memory
 *   - session_wrapup: Process a conversation transcript (async, no response expected)
 *   - global_sleep:   Nightly maintenance (async, no response expected)
 */

import { query, type Query } from '@anthropic-ai/claude-agent-sdk';
import readline from 'readline';
import fs from 'fs';
import path from 'path';

const MEMORY_DIR = process.env.HAPPYCLAW_MEMORY_DIR || process.cwd();
const MODEL = process.env.HAPPYCLAW_MODEL === 'opus' ? 'claude-opus-4-6' : 'claude-sonnet-4-6';

// Safety net for total turns in the persistent session.
// Individual request limits are enforced by natural completion behavior.
const MAX_TURNS = 500;

// Restart the query after this many requests to prevent context overflow.
const MAX_REQUESTS_PER_SESSION = 20;

interface MemoryRequest {
  requestId: string;
  type: 'query' | 'remember' | 'session_wrapup' | 'global_sleep';
  // query
  query?: string;
  context?: string;
  // remember
  content?: string;
  importance?: 'high' | 'normal';
  // session_wrapup
  transcriptFile?: string;
  groupFolder?: string;
  chatJids?: string[];
  // channel context (query/remember)
  chatJid?: string;
  channelLabel?: string;
}

interface MemoryResponse {
  requestId: string;
  success: boolean;
  response?: string;
  error?: string;
}

interface RequestResult {
  text: string;
  isError: boolean;
}

function log(msg: string): void {
  process.stderr.write(`[memory-agent] ${msg}\n`);
}

// ─── MessageStream ─────────────────────────────────────────────────
// Push-based async iterable for streaming user messages to the SDK.
// Keeps the iterable alive until end() is called.

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: string | null;
  session_id: string;
}

class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>(r => { this.waiting = r; });
      this.waiting = null;
    }
  }
}

// ─── System Prompt ─────────────────────────────────────────────────

const SYSTEM_PROMPT = `你是一个记忆管理系统。你的职责是管理和维护用户的长期记忆。

## 你的工作目录

你的工作目录是用户的记忆存储区。目录结构：

- index.md — 随身索引（主 Agent 每次对话自动加载的摘要，~200 条上限）
- knowledge/ — 按领域组织的详细知识
- impressions/ — 按会话组织的语义索引文件（话题、关键词、涉及的人/事/概念）
- transcripts/ — 原始对话记录（source of truth）
- personality.md — 用户交互风格记录
- state.json — 系统元数据（lastGlobalSleep、pendingWrapups 等）

## 请求类型

### query — 回忆查询

处理流程：
1. Grep index.md 快速查找
2. 没命中 → Grep impressions/ 语义索引文件
3. 命中 → Read knowledge/ 或 transcripts/ 获取细节
4. 组织自然语言回复，包含来源、时间和渠道信息（如果已知）
5. **索引自我修复**（在组织回复之后、同一次处理中执行）：
   - 如果第 1 层（index.md）没命中但第 2/3 层命中了 → 回去检查对应的 impressions/ 索引文件，补充缺失的关键词/关联词，让下次同类查询更容易命中
   - 如果第 2 层命中但展开后发现实际不相关（误命中）→ 修正该索引文件中导致误命中的关键词，减少噪音
   - 如果最终从 transcripts/ 找到了有价值的内容但 knowledge/ 里没有 → 顺手提炼写入 knowledge/，更新 index.md 索引
   - 每次 query 最多修复 1-2 个索引文件，微调而非重建
   - 如果修复量较大（比如发现某个索引文件质量很差），记录到 state.json 的 pendingMaintenance，留给 global_sleep 处理

### remember — 记住信息

1. 判断信息类型（用户身份/偏好/项目知识/临时提醒）
2. 写入对应的 knowledge/ 文件（检查冲突，自述优先）
3. 更新 index.md（加一行索引，不放具体内容）

### session_wrapup — 会话收尾

1. 读取 transcripts/ 中的新对话记录
2. 生成语义索引文件 → impressions/（包含：话题摘要、关键词列表、涉及的人/事/概念、来源渠道、时间范围）
3. 提炼知识 → knowledge/（检查冲突，合并而非覆盖）
4. 更新 index.md 近期上下文区
5. **交叉修复**：如果本次对话中引用了旧记忆（比如用户说"上次聊的那个"），检查对应的旧 impressions 索引文件，补充本次对话暴露出的缺失关联

**⚠️ 禁止事项**：session_wrapup 过程中 **绝对不要修改 state.json 中的 pendingWrapups 字段**。pendingWrapups 由主服务进程管理，仅在 global_sleep 完成后才清空。你可以更新 state.json 中的其他计数字段（如 totalImpressions、totalKnowledgeFiles），但必须保持 pendingWrapups 原样不动。

### global_sleep — 全局维护

这是凌晨自动触发的深度维护任务。请**逐步执行**以下流程：

#### 步骤 1：备份 index.md
- 读取当前 index.md
- 如果存在 index.md.bak.2 → 删除
- 如果存在 index.md.bak.1 → 重命名为 index.md.bak.2
- 将当前 index.md 复制为 index.md.bak.1（保留最近 3 版备份）

#### 步骤 2：Compact index.md
- 读取 index.md，统计每个分区的条目数
- 如果总条目数 > 200：
  - 合并近义/重复条目
  - 降级低热度条目（近期上下文区中超过 7 天未涉及的 → 移到备用区或删除）
  - 精简过长的索引行（索引只放指引，不放内容）
- 确保各分区不超出建议上限：关于用户(~30) / 活跃话题(~50) / 重要提醒(~20) / 近期上下文(~50) / 备用(~50)
- 写回 index.md

#### 步骤 3：过期清理
- 扫描"重要提醒"区中带有日期的条目
- 如果提醒日期已过 → 移除（如"下周三出差"在出差日之后删除）
- 扫描 impressions/ 中超过 6 个月的文件，如果对应 knowledge/ 已有提炼 → 可以归档（移到 transcripts/archived/ 或直接删除）

#### 步骤 4：自审
- 检查分区比例是否合理
- 检查是否有重复条目（同一件事出现在多个分区）
- 检查是否有内容错放（详细内容出现在 index.md 里，应该只放索引）
- 修复发现的问题

#### 步骤 5：更新 personality.md
- 浏览最近的 impressions/ 和 knowledge/ 文件
- 分析用户的交互模式（话题偏好、沟通风格、活跃时间段等）
- 更新 personality.md（如果不存在则创建）
- 注意：personality.md 只记录观察到的模式，不做价值判断

#### 步骤 6：更新 state.json
- 读取 state.json
- 设置 lastGlobalSleep 为当前时间
- 清空 pendingWrapups 数组
- 更新 indexVersion（+1）
- 更新 totalImpressions 和 totalKnowledgeFiles 的计数
- 写回 state.json

## 索引自我修复

类似人类的记忆强化——回忆一次后关联路径变多，下次更容易想起来。

修复发生在 query 处理的尾声（不阻塞回复），三种情况：

| 信号 | 动作 | 示例 |
|------|------|------|
| 命中了但索引层没覆盖 | 补充索引文件的关键词/关联词 | 搜"Qdrant"在 impressions 命中，但该索引文件的关键词里没有"Qdrant" → 补上 |
| 搜到了但实际不相关 | 修正索引文件，移除/弱化误导词 | 搜"借贷"命中了一个聊天记录，但那次只是顺嘴提了一句 → 从关键词里移除"借贷" |
| 深层有料但浅层没索引 | 提炼写入 knowledge/ + 更新 index.md | transcripts 里找到了用户详述的技术方案，但 knowledge/ 没有 → 提炼写入 |

## 硬规则

- 时间绝对化：所有写入的时间转为绝对时间，保留记录时间和事件时间
- 随身索引只放索引不放内容，超限触发 compact 不触发丢弃
- 可信度：自述优先原则——自己说自己的最可信，第三方转述标注来源、不覆盖自述
- index.md 分区：关于用户(~30) / 活跃话题(~50) / 重要提醒(~20) / 近期上下文(~50) / 备用(~50)
- compact 前必须备份 index.md（保留最近 3 版）
- global_sleep 完成后必须更新 state.json（lastGlobalSleep + 清空 pendingWrapups）
- 渠道维度：impression 文件应记录对话发生的渠道/群组名，查询时可作为上下文参考
`;

// ─── Prompt Builder ────────────────────────────────────────────────

function buildPrompt(request: MemoryRequest): string {
  switch (request.type) {
    case 'query':
      return [
        `【记忆查询请求】`,
        ``,
        `查询内容：${request.query}`,
        request.context ? `当前对话上下文：${request.context}` : '',
        request.channelLabel ? `当前对话渠道：${request.channelLabel}` : '',
        ``,
        `请按照 query 处理流程搜索记忆并回复。如果没有找到相关记忆，直接说明即可。`,
        `回复时使用自然语言，包含来源和时间信息。`,
        ``,
        `回复完成后，执行索引自我修复（如有需要）：检查本次查询路径，补充缺失关键词或修正误导词。每次最多修复 1-2 个文件。`,
      ]
        .filter(Boolean)
        .join('\n');

    case 'remember':
      return [
        `【记忆存储请求】`,
        ``,
        `需要记住的内容：${request.content}`,
        `重要性：${request.importance || 'normal'}`,
        request.channelLabel ? `来源渠道：${request.channelLabel}` : '',
        `当前时间：${new Date().toISOString()}`,
        ``,
        `请按照 remember 处理流程存储这条信息。`,
      ]
        .filter(Boolean)
        .join('\n');

    case 'session_wrapup':
      return [
        `【会话收尾请求】`,
        ``,
        `对话记录文件：${request.transcriptFile}`,
        `群组文件夹：${request.groupFolder}`,
        request.chatJids ? `涉及渠道：${request.chatJids.join(', ')}` : '',
        `当前时间：${new Date().toISOString()}`,
        ``,
        `请按照 session_wrapup 处理流程整理这次对话。`,
      ]
        .filter(Boolean)
        .join('\n');

    case 'global_sleep':
      return [
        `【全局维护请求】`,
        ``,
        `当前时间：${new Date().toISOString()}`,
        ``,
        `请严格按照 global_sleep 处理流程的 6 个步骤逐步执行全局维护：`,
        `1. 备份 index.md（管理 .bak.1 / .bak.2 轮转）`,
        `2. Compact index.md（合并重复、降级低热度、精简过长条目）`,
        `3. 过期清理（已过时的提醒和过旧的 impressions）`,
        `4. 自审（分区比例、去重、内容错放）`,
        `5. 更新 personality.md（分析交互模式）`,
        `6. 更新 state.json（设置 lastGlobalSleep、清空 pendingWrapups、更新计数）`,
        ``,
        `每完成一个步骤后，继续执行下一步。全部完成后输出维护报告摘要。`,
      ].join('\n');

    default:
      return `未知请求类型：${(request as MemoryRequest).type}`;
  }
}

// ─── Persistent Query Session ──────────────────────────────────────

/** Active query session state */
interface Session {
  query: Query;
  stream: MessageStream;
  requestCount: number;
  /** Resolves when the query's for-await loop finishes (CLI died or stream ended) */
  done: Promise<void>;
}

/** Pending result slot — only one request in flight at a time */
let pendingResolve: ((result: RequestResult) => void) | null = null;

/** Consume SDK messages from the query generator, routing results to the pending promise. */
async function consumeQuery(q: Query): Promise<void> {
  try {
    for await (const message of q) {
      if (message.type === 'result') {
        const r = message as Record<string, unknown>;
        const text = typeof r.result === 'string' ? r.result : '';
        const isError = !!r.is_error;
        if (pendingResolve) {
          pendingResolve({ text, isError });
          pendingResolve = null;
        }
      }
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log(`Query consumer error: ${errMsg}`);
    if (pendingResolve) {
      pendingResolve({ text: errMsg, isError: true });
      pendingResolve = null;
    }
  }
}

function waitForResult(): Promise<RequestResult> {
  return new Promise(resolve => { pendingResolve = resolve; });
}

function startSession(): Session {
  const stream = new MessageStream();
  const q = query({
    prompt: stream,
    options: {
      model: MODEL,
      cwd: MEMORY_DIR,
      systemPrompt: SYSTEM_PROMPT,
      maxTurns: MAX_TURNS,
      permissionMode: 'bypassPermissions',
      allowedTools: [
        'Read',
        'Write',
        'Edit',
        'Grep',
        'Glob',
      ],
    },
  });
  const done = consumeQuery(q);
  return { query: q, stream, requestCount: 0, done };
}

function stopSession(session: Session): void {
  session.stream.end();
}

// ─── Main ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  log(`Starting Memory Agent (model: ${MODEL}, dir: ${MEMORY_DIR})`);

  // Ensure memory directory structure exists
  for (const subdir of ['knowledge', 'impressions', 'transcripts']) {
    fs.mkdirSync(path.join(MEMORY_DIR, subdir), { recursive: true });
  }

  const rl = readline.createInterface({
    input: process.stdin,
    terminal: false,
  });

  let session: Session | null = null;
  let sessionDied = false;

  for await (const line of rl) {
    if (!line.trim()) continue;

    let request: MemoryRequest;
    try {
      request = JSON.parse(line);
    } catch (err) {
      log(`Invalid JSON input: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    if (!request.requestId || !request.type) {
      log(`Missing requestId or type in request: ${line.slice(0, 200)}`);
      continue;
    }

    log(`Handling ${request.type} request (id: ${request.requestId})`);

    // Start or restart session if needed
    if (!session || sessionDied || session.requestCount >= MAX_REQUESTS_PER_SESSION) {
      if (session) {
        log(`Recycling session (requests: ${session.requestCount}, died: ${sessionDied})`);
        stopSession(session);
        await session.done;
      }
      log('Starting new query session');
      session = startSession();
      sessionDied = false;

      // Monitor session death in background
      session.done.then(() => {
        sessionDied = true;
      });
    }

    // Push prompt and wait for result
    const prompt = buildPrompt(request);
    const resultPromise = waitForResult();
    session.stream.push(prompt);
    session.requestCount++;

    const result = await resultPromise;

    let response: MemoryResponse;
    if (result.isError) {
      log(`Error handling ${request.type} request: ${result.text.slice(0, 200)}`);
      response = {
        requestId: request.requestId,
        success: false,
        error: result.text,
      };
    } else {
      response = {
        requestId: request.requestId,
        success: true,
        response: result.text || '记忆系统处理完成，但未返回文本结果。',
      };
    }

    process.stdout.write(JSON.stringify(response) + '\n');
    log(`Completed ${request.type} request (id: ${request.requestId}, success: ${response.success})`);
  }

  // stdin closed — clean up
  if (session) {
    stopSession(session);
    await session.done;
  }
  log('stdin closed, exiting');
}

main().catch((err) => {
  log(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
