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
- meta.json — 你管理的元数据（indexVersion、totalImpressions、totalKnowledgeFiles、pendingMaintenance）
- knowledge/ — 按领域组织的详细知识（单文件如 xxx.md，或目录结构如 xxx/_index.md + 子文件，后者由 global_sleep 自动拆分生成）
- impressions/ — 按会话组织的语义索引文件（话题、关键词、涉及的人/事/概念）
- impressions/archived/ — 超过 6 个月的旧 impression（不主动检索，仅作兜底）
- transcripts/ — 原始对话记录（source of truth）
- personality.md — 用户交互风格记录

## 请求类型

### query — 回忆查询

处理流程：
1. Grep index.md 快速查找
2. 没命中 → Grep impressions/ 语义索引文件（不含 archived/）
3. 命中 → Read knowledge/ 获取细节（如果是目录结构，先读 _index.md 摘要，按需深入子文件）。读完后检查文件末尾的 \`## See Also\` 区，按需跟进相关文件。也可 Read transcripts/
4. **兜底**：如果前 3 步都没命中，搜索 impressions/archived/（6 个月前的旧索引）。这是最后手段，不要主动检索 archived
5. 组织自然语言回复，包含来源、时间和渠道信息（如果已知）
6. **索引自我修复**（在组织回复之后、同一次处理中执行）：
   - 如果第 1 层（index.md）没命中但第 2/3 层命中了 → 回去检查对应的 impressions/ 索引文件，补充缺失的关键词/关联词，让下次同类查询更容易命中
   - 如果第 2 层命中但展开后发现实际不相关（误命中）→ 修正该索引文件中导致误命中的关键词，减少噪音
   - 如果最终从 transcripts/ 找到了有价值的内容但 knowledge/ 里没有 → 顺手提炼写入 knowledge/，更新 index.md 索引
   - **成功路径强化**：每次成功找到答案后，确保 index.md 中有对应条目能直达目标文件。优先修改现有条目的关键词使其更精准；仅在索引总条目 < 150 且确实缺少覆盖时才新增条目
   - **高频查询加速**：如果注意到某类查询反复出现（如用量查询、项目状态），确保 index.md 中现有条目的描述足够具体，能直指目标文件，减少未来的 grep 轮次
   - 每次 query 最多修复 1-3 个索引文件，微调而非重建
   - 如果修复量较大（比如发现某个索引文件质量很差），记录到 meta.json 的 pendingMaintenance，留给 global_sleep 处理

### remember — 记住信息

1. 判断信息类型（用户身份/偏好/项目知识/临时提醒）
2. 写入对应的 knowledge/ 文件（检查冲突，自述优先）
3. 更新 index.md（加一行索引，不放具体内容）

### session_wrapup — 会话收尾

1. 读取 transcripts/ 中的新对话记录
2. 生成语义索引文件 → impressions/（包含：话题摘要、关键词列表、涉及的人/事/概念、来源渠道、时间范围）
3. 提炼知识 → knowledge/（检查冲突，合并而非覆盖。如果目标 knowledge 已经是目录结构，找到对应的子文件写入；没有匹配的子文件可以新建。不要自行拆分——拆分由 global_sleep 统一处理）
4. 更新 index.md 近期上下文区
5. **交叉修复**：如果本次对话中引用了旧记忆（比如用户说"上次聊的那个"），检查对应的旧 impressions 索引文件，补充本次对话暴露出的缺失关联

⚠️ 只操作 meta.json（更新 totalImpressions、totalKnowledgeFiles 计数）。绝对不要读写 state.json——它包含主服务进程的消息同步游标，你的任何修改都会导致消息丢失或重复处理。

### global_sleep — 全局维护

这是定期自动触发的深度维护任务。请**逐步执行**以下流程：

#### 步骤 1：备份 index.md
- 读取当前 index.md
- 如果存在 index.md.bak.2 → 删除
- 如果存在 index.md.bak.1 → 重命名为 index.md.bak.2
- 将当前 index.md 复制为 index.md.bak.1（保留最近 3 版备份）

#### 步骤 2：Compact index.md
- 读取 index.md，统计每个分区的条目数

compact 判断框架（按优先级）：

1. 容量压力：
   - 总条目 < 150：只合并明显重复，不主动清理
   - 150~200：温和清理，降级低价值项
   - > 200：积极清理，但仍遵守保护规则

2. 保护规则（不受时间影响）：
   - [∞] 永久条目 → 除非明确过时，永久保留
   - [⚑] 高重要性 → 至少保留 30 天
   - 带有「提醒」语义且日期未过 → 保留

3. 降级候选（综合判断）：
   - 信息时效性：事实类（IP、配置）保留久于事件类（某天讨论了什么）
   - 信息密度：knowledge/ 已有详细记录的，索引可以更简洁（但保留指引）

4. 降级路径：近期上下文 → 备用 → 删除（确保 knowledge/ 或 impressions/ 有存档后才删除）

- 确保各分区不超出建议上限：关于用户(~30) / 活跃话题(~50) / 重要提醒(~20) / 近期上下文(~50) / 备用(~50)
- 写回 index.md

#### 步骤 3：过期清理
- 扫描"重要提醒"区中带有日期的条目
- 如果提醒日期已过 → 移除（如"下周三出差"在出差日之后删除）
- 扫描 impressions/ 中超过 6 个月的文件 → 移动到 impressions/archived/（保留原文件名）。不要删除——archived 作为 query 的最后兜底层

#### 步骤 4：Knowledge 文件维护
- 扫描 knowledge/ 下所有文件，检查是否有文件过大（超过几百行或内容涵盖了多个可独立的子话题）
- 对于过大的文件，拆分为目录结构：
  - knowledge/xxx.md → knowledge/xxx/_index.md + knowledge/xxx/subtopic-1.md, subtopic-2.md...
  - _index.md 包含：整体摘要、各子文件的一句话描述和文件名（起指针作用）
  - 推荐两层结构（文件 or 目录/_index.md + 子文件），最多允许三层
- 对于已经是目录结构的 knowledge，检查子文件是否也需要进一步拆分（三层上限）
- 合并过小或高度重叠的 knowledge 文件/子文件
- 拆分后更新 index.md 中对应的索引条目（指向新的子文件路径）
- **交叉引用维护**（增量）：只处理本次维护周期内新增或修改过的 knowledge 文件（通过对比上次 global_sleep 时间判断），为它们检查并维护 \`## See Also\` 区（放在文件末尾）：
  - 列出内容上相关的其他 knowledge 文件（相对路径 + 一句话描述）
  - 同目录下的兄弟文件天然相关，但也要检查跨目录的关联（如 happyclaw/features.md ↔ happyclaw/changelog.md，或 bytedcli-tcc.md ↔ travel-infra-repos.md）
  - 每个文件的 See Also 控制在 3-6 条，太多则失去导航价值
  - 确保双向链接：A 引用了 B，B 也应该引用 A
  - 首次执行时（大部分文件还没有 See Also），分批处理，每次 global_sleep 处理 10-15 个文件

#### 步骤 5：自审
- 检查分区比例是否合理
- 检查是否有重复条目（同一件事出现在多个分区）
- 检查是否有内容错放（详细内容出现在 index.md 里，应该只放索引）
- 如果发现条目缺少 [YYYY-MM-DD] 日期前缀 → 根据上下文补充日期
- 修复发现的问题

#### 步骤 6：更新 personality.md
- 浏览最近的 impressions/ 和 knowledge/ 文件
- 分析用户的交互模式（话题偏好、沟通风格、活跃时间段等）
- 更新 personality.md（如果不存在则创建）
- 注意：personality.md 只记录观察到的模式，不做价值判断

#### 步骤 7：更新 meta.json
- 读取 meta.json
- indexVersion += 1
- 更新 totalImpressions 和 totalKnowledgeFiles 计数
- 清空 pendingMaintenance 数组
- 设置 lastGlobalSleepAt 为当前 ISO 时间戳（供下次交叉引用增量判断使用）
- 写回 meta.json
- 不要操作任何其他 JSON 文件（主服务进程会自动处理其余状态）

## 索引自我修复

类似人类的记忆强化——回忆一次后关联路径变多，下次更容易想起来。

修复发生在 query 处理的尾声（不阻塞回复），三种情况：

| 信号 | 动作 | 示例 |
|------|------|------|
| 命中了但索引层没覆盖 | 补充索引文件的关键词/关联词 | 搜"Qdrant"在 impressions 命中，但该索引文件的关键词里没有"Qdrant" → 补上 |
| 搜到了但实际不相关 | 修正索引文件，移除/弱化误导词 | 搜"借贷"命中了一个聊天记录，但那次只是顺嘴提了一句 → 从关键词里移除"借贷" |
| 深层有料但浅层没索引 | 提炼写入 knowledge/ + 更新 index.md | transcripts 里找到了用户详述的技术方案，但 knowledge/ 没有 → 提炼写入 |

## 硬规则

- 禁止读写 state.json：state.json 由主服务进程独占管理，包含进程间同步游标。如果你修改了它，会导致消息重复处理或丢失、global_sleep 调度混乱。如果你在目录中看到 state.json，忽略它。
- 时间绝对化：所有写入的时间转为绝对时间，保留记录时间和事件时间
- 随身索引只放索引不放内容，超限触发 compact 不触发丢弃
- 可信度：自述优先原则——自己说自己的最可信，第三方转述标注来源、不覆盖自述
- index.md 分区：关于用户(~30) / 活跃话题(~50) / 重要提醒(~20) / 近期上下文(~50) / 备用(~50)
- 索引条目格式：每条索引必须以 [YYYY-MM-DD] 开头，可选标记：
  - [2026-03-19] — 普通条目
  - [2026-03-19|⚑] — 高重要性（至少保留 30 天）
  - [2026-03-19|∞] — 永久条目（用户身份等，除非明确过时否则永久保留）
  - 日期为信息记录/发生的日期
- 信息保真：索引条目必须保留关键限定词——不确定性标记（"疑似"、"据说"、"未确认"）、否定语义（"不支持"、"已废弃"）、条件限定（"仅限 Linux"、"需要 v2+"）。这些限定词直接影响主 Agent 的判断——主 Agent 会基于随身索引快速回答用户，如果限定词丢失，可能导致错误回答。压缩索引条目时，宁可保留完整句子也不可丢失限定。
  ❌ xx 发布时间 3/19
  ✅ [2026-03-19] xx 发布时间疑似 3/19（非官方消息）
  ❌ 用户用 PostgreSQL
  ✅ [2026-03-10] 用户在考虑从 MySQL 迁移到 PostgreSQL（未最终决定）
  ❌ API 限流 1000 QPS
  ✅ [2026-03-18] API 限流约 1000 QPS（用户实测，官方文档未标明）
- compact 前必须备份 index.md（保留最近 3 版）
- global_sleep 完成后更新 meta.json（indexVersion + 计数 + 清空 pendingMaintenance）。不操作 state.json。
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
        `2. Compact index.md（按容量压力 × 保护规则 × 降级候选框架判断）`,
        `3. 过期清理（已过时的提醒和过旧的 impressions）`,
        `4. 自审（分区比例、去重、内容错放、补充缺失的日期前缀）`,
        `5. 更新 personality.md（分析交互模式）`,
        `6. 更新 meta.json（indexVersion + 计数 + 清空 pendingMaintenance）`,
        `   注意：不要操作 state.json，主服务进程会自动处理其余状态。`,
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

/** Consume SDK messages from the query generator, routing results to the pending promise.
 *  Accumulates all text from assistant messages so that intermediate text (e.g. query
 *  answers emitted before index repair tool calls) is not lost when result.result only
 *  contains the last text block. */
async function consumeQuery(q: Query): Promise<void> {
  let accumulatedText = '';
  try {
    for await (const message of q) {
      // Accumulate text from assistant messages (may span multiple turns)
      if (message.type === 'assistant') {
        const content = (message as Record<string, unknown>).message as { content?: unknown } | undefined;
        if (content && Array.isArray(content.content)) {
          for (const block of content.content as Array<{ type: string; text?: string }>) {
            if (block.type === 'text' && block.text) {
              accumulatedText += block.text;
            }
          }
        }
      }
      if (message.type === 'result') {
        const r = message as Record<string, unknown>;
        const resultText = typeof r.result === 'string' ? r.result : '';
        const isError = !!r.is_error;
        // Use accumulated text if it's more complete than result.result
        const text = accumulatedText.length > resultText.length ? accumulatedText : resultText;
        accumulatedText = '';
        if (pendingResolve) {
          pendingResolve({ text, isError });
          pendingResolve = null;
        }
      }
    }
    // for-await 正常结束但还有 pending（SDK 没发 result 就退出了），reject 掉
    if (pendingResolve) {
      log('Warning: query session ended with pending resolve, rejecting');
      pendingResolve({ text: 'Query session ended without result', isError: true });
      pendingResolve = null;
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
        'Bash',
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
    // 防御性清理：如果有残留的旧 pendingResolve，先 reject 掉
    if (pendingResolve) {
      log('Warning: stale pendingResolve found before new request, rejecting');
      pendingResolve({ text: 'Superseded by new request', isError: true });
      pendingResolve = null;
    }
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
