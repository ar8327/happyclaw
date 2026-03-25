# HappyClaw Multi-Provider Agent Runner 设计方案

> 状态：草案 v3（基于 v2 + 深度代码审计 + 边界精化）
> 日期：2026-03-25
> 前提：基于 Codex SDK v0.116.0 实际验证 + agent-runner 全量代码审计

## 0. 实际验证结论（保留 v1）

以下能力已在本机 `@openai/codex-sdk@0.116.0` + `@openai/codex@0.115.0` 上用代码验证通过：

| 能力 | 验证状态 | 关键细节 |
|------|---------|---------|
| 多轮对话 | ✅ | 同一 Thread 多次 `runStreamed()` 保持上下文 |
| 会话 resume | ✅ | `resumeThread(id)` + `runStreamed()` 恢复对话 |
| MCP 工具注入 | ✅ | `config.mcp_servers.<name>` 逐实例注入，不修改全局配置 |
| MCP 工具调用 | ✅ | 完整 `item.started → item.completed` 流程，返回 result |
| 系统 prompt | ✅ | `config.model_instructions_file` 指向临时文件 |
| 中断 (AbortSignal) | ✅ | `TurnOptions.signal` → AbortError |
| 环境变量隔离 | ✅ | `CodexOptions.env` 覆盖 process.env，agent 可见 |
| 图片输入 | ✅ | `local_image` type + 本地文件路径（非 base64）|
| Web 搜索 | ✅ | `webSearchMode: 'live'` + `web_search` item 事件 |

**关键限制（已验证）：**

| 限制 | 影响 |
|------|------|
| **无 token 级流式** | agent_message 只有 `item.completed`（完整文本），无增量 delta。前端打字机效果缺失。|
| **无 `item.updated` 事件** | 即使 5s 长命令也只有 started→completed，无中间更新 |
| **每 turn 启动新进程** | `runStreamed()` 每次 spawn `codex exec`。无法中途推送消息。|
| **无 Hook 系统** | 无 PreCompact/PreToolUse。对话归档和安全检查需替代方案。|
| **图片须本地文件** | 需将 base64 存为临时文件再传路径 |
| **MCP 是外部进程** | 不支持 in-process MCP server，需 stdio transport |

---

## 1. v1 方案的问题

v1 采用"平行复制"策略——不修改 Claude runner，在旁边新增一套 `codex-*.ts`。
深度调研后发现以下架构问题使得平行复制的维护代价过高：

### 1.1 九个文件直接耦合 Claude SDK

`agent-runner/src/` 共 16 个文件，其中 **9 个**直接 `import` `@anthropic-ai/claude-agent-sdk`：

| 文件 | 耦合内容 | 严重度 |
|------|---------|--------|
| `claude-session.ts` | `query()`, `Query`, `McpServerConfig` | 高（预期） |
| `mcp-adapter.ts` | `tool()`, `SdkMcpToolDefinition` | 高（预期） |
| `query-runner.ts` | `PermissionMode`, `McpServerConfig` | 中 |
| `stream-processor.ts` | 处理 Claude SDK 消息格式（`content_block_start/delta`） | 高 |
| `index.ts` | `createSdkMcpServer`, `PermissionMode` | 中 |
| `transcript-archive.ts` | `HookCallback`, `PreCompactHookInput` | 中 |
| `safety-lite.ts` | Claude SDK hook types | 低 |
| `agent-definitions.ts` | `AgentDefinition` | 低 |
| `session-state.ts` | `PermissionMode`（仅类型） | 低 |

### 1.2 两套 prompt 组装路径互不相干

深度审计发现比最初预估的更严重：

| 维度 | `agent-runner-core` | `agent-runner/context-builder` |
|------|-------|-------|
| 入口函数 | `ContextManager.buildSystemPrompt()` | `buildSystemPromptAppend()` |
| 是否被调用 | ❌ 从未 | ✅ 唯一入口 |
| 记忆段 | MemoryPlugin (~30 行，只读 index.md/personality.md) | context-builder (~80 行，含使用指导/home 区分/compaction 注意事项) |
| 全局 CLAUDE.md | 所有容器都加载 | 仅 `isHome` 容器 |
| 工作区 CLAUDE.md | 加载 `workspaceGroup/CLAUDE.md` | 不加载（由 claude_code preset 处理） |
| contextSummary | PluginContext 中无此字段 | ✅ XML 包裹的上下文摘要 |
| 交互原则 | 部分（在 buildBaseSystemPrompt） | ✅ 完整（独立常量段） |
| IM 路由 | 部分（静态通信规则） | ✅ 动态（含活跃渠道列表） |
| 输出格式 | ✅ 相对路径 + Mermaid | ✅ 相同内容（重复实现） |
| WebFetch 策略 | ✅ 简版 | ✅ 详版 |
| 后台任务指导 | ❌ 无 | ✅ Task 生命周期说明 |
| Post-compaction reminder | ❌ 无 | ✅ buildChannelRoutingReminder() |

**结论**：core 的 prompt 系统只覆盖了 context-builder 的 ~30% 功能。两者在全局 CLAUDE.md 的加载条件上甚至有行为冲突。

### 1.3 query loop 逻辑高度通用但无法复用

`index.ts` 的 while(true) 循环（~160 行）包含：溢出重试、中断恢复、drain/close 检测、session ID 管理、IPC 等待。这些对**任何 provider** 都一样，但 v1 方案需要在 `codexMain()` 中全部重写。

### 1.4 stream-processor.ts 的隐藏复杂度

深度审计发现此文件 (914 行) 比设计文档描述的更复杂：

| 职责 | 行数(估) | 说明 |
|------|---------|------|
| 流式文本/思考缓冲 | ~150 | 双模式：>200 char 立即刷新 / 100ms 定时器 |
| 工具使用生命周期 | ~200 | 顶层、嵌套、Skill、Task、AskUserQuestion、TodoWrite |
| 后台任务追踪 | ~100 | backgroundTaskToolUseIds / sdkTaskIdToToolUseId 映射 |
| 子 Agent 消息转发 | ~80 | Task parent_tool_use_id → StreamEvent 转换 |
| Skill 嵌套检测 | ~50 | activeSkillToolUseId 补偿 SDK 缺失的 parent_tool_use_id |
| JSON 增量解析 | ~80 | Skill name / Task description / TodoWrite JSON 解析 |
| cleanup 安全网 | ~40 | 循环结束时补发挂起的 tool_use_end / task_notification |
| 模式切换检测 | ~20 | EnterPlanMode/ExitPlanMode → mode_change 事件 |

这 914 行**全部是 Claude SDK 特有逻辑**。它们必须整体移入 Claude provider，而非分散。

### 1.5 v1 平行复制 vs v2 解耦对比

| | v1 平行复制 | v2 解耦后加 Codex |
|---|---|---|
| 首次新 provider 成本 | ~1240 行 | ~2200 行（含重构，较 v2 修正） |
| 第 N 个新 provider 成本 | ~1000 行 | ~400 行 |
| query loop 修改 | 改 N 份 | 改 1 份 |
| prompt 逻辑修改 | 改 N 份 | 改 1 份 |
| IPC/session 变更 | 改 N 份 | 改 1 份 |

---

## 2. 目标架构

### 2.1 分层结构

```
container/
├── agent-runner-core/              ← 增强：统一 prompt 组装
│   └── src/
│       ├── context.ts              (ContextManager — 插件 + prompt 编排)
│       ├── prompt-builder.ts       (基础 prompt + 所有 guideline 段)
│       ├── plugin.ts               (ContextPlugin 接口)
│       ├── plugins/                (5 个内置插件)
│       ├── ipc.ts                  (IPC 原语)
│       ├── protocol.ts            (stdin/stdout 协议)
│       ├── types.ts               (ContainerInput/Output/StreamEvent)
│       └── utils.ts               (通用工具)
│
├── agent-runner/                   ← 重构：provider-agnostic 框架 + provider 实现
│   └── src/
│       ├── index.ts                (薄入口：解析 stdin → 选择 provider → 启动)
│       ├── types.ts                (HappyClaw 协议类型，零 SDK 引用)
│       │
│       ├── # ─── Provider-agnostic 框架 ───
│       ├── runner-interface.ts     (AgentRunner 接口 + NormalizedMessage)
│       ├── query-loop.ts           (通用查询循环 + 重试 + IPC 等待 + 活性看门狗)
│       ├── session-state.ts        (IM channels + 中断追踪，零 SDK 引用)
│       ├── ipc-handler.ts          (sentinel/消息处理，零 SDK 引用)
│       ├── image-utils.ts          (图片处理)
│       ├── image-detector.ts       (MIME 检测)
│       ├── utils.ts                (通用工具)
│       │
│       ├── # ─── Claude Provider ───
│       ├── providers/
│       │   ├── claude/
│       │   │   ├── claude-runner.ts         (实现 AgentRunner 接口)
│       │   │   ├── claude-session.ts        (SDK query 生命周期)
│       │   │   ├── claude-stream-processor.ts (SDK 流式事件 → StreamEvent)
│       │   │   ├── claude-mcp-adapter.ts    (core tools → SDK tool 格式)
│       │   │   ├── claude-hooks.ts          (PreCompact + SafetyLite)
│       │   │   ├── claude-config.ts         (DEFAULT_ALLOWED_TOOLS 等)
│       │   │   └── claude-agent-defs.ts     (预定义子 agent 注册表)
│       │   │
│       │   └── codex/
│       │       ├── codex-runner.ts          (实现 AgentRunner 接口)
│       │       ├── codex-session.ts         (SDK Thread 生命周期)
│       │       ├── codex-event-adapter.ts   (ThreadEvent → StreamEvent)
│       │       ├── codex-mcp-server.ts      (stdio MCP bridge，独立入口)
│       │       ├── codex-archive.ts         (token 阈值归档)
│       │       └── codex-image-utils.ts     (base64 → 临时文件)
│       │
│       └── stream-event.types.ts   (StreamEvent 类型定义)
```

### 2.2 系统架构图

```
宿主机进程（不变）
  │
  │  stdin: ContainerInput JSON
  │  stdout: OUTPUT_MARKER 包裹的 ContainerOutput
  ▼
┌──────────────────────────────────────────────────────────────┐
│                     agent-runner                              │
│                                                               │
│  ┌── index.ts (薄入口) ───────────────────────────────────┐ │
│  │  readStdin → parseInput → selectProvider → startLoop    │ │
│  └─────────────────────────────────────────────────────────┘ │
│                         │                                     │
│                         ▼                                     │
│  ┌── query-loop.ts (通用循环) ────────────────────────────┐ │
│  │  while(true):                                           │ │
│  │    gen = runner.runQuery(prompt, config)                 │ │
│  │    for await (msg of gen):                              │ │
│  │      dispatch(msg) → emit StreamEvent / track state     │ │
│  │    result = gen return value                            │ │
│  │    handleOverflow / handleInterrupt / handleDrain        │ │
│  │    + 活性看门狗（5min 无事件 / 20min 工具硬超时）         │ │
│  │    waitForIpcMessage → next iteration                   │ │
│  │                                                          │ │
│  │  runner: AgentRunner  ← 接口，不知道具体 provider       │ │
│  └──────────────────────────────────────────────────────────┘ │
│                         │                                     │
│            ┌────────────┴────────────┐                        │
│            ▼                         ▼                        │
│  ┌── ClaudeRunner ──┐    ┌── CodexRunner ───┐                │
│  │  claude-session   │    │  codex-session    │                │
│  │  stream-processor │    │  event-adapter    │                │
│  │  mcp-adapter      │    │  mcp-server       │                │
│  │  hooks            │    │  archive          │                │
│  │  agent-defs       │    │                    │                │
│  └───────────────────┘    └──────────────────┘                │
│                                                               │
│  ┌── 共享基础设施（零 SDK 引用）──────────────────────────┐  │
│  │ session-state │ ipc-handler │ types │ utils │ images    │  │
│  └─────────────────────────────────────────────────────────┘  │
│                                                               │
│  ┌── agent-runner-core（增强）────────────────────────────┐  │
│  │ ContextManager (统一 prompt + tools)                    │  │
│  │ Plugins × 5  │  IPC primitives  │  Protocol types       │  │
│  └──────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

---

## 3. AgentRunner 接口

这是整个解耦的核心——query-loop 通过此接口与任何 provider 交互。

### 3.1 runner-interface.ts

```typescript
// runner-interface.ts

import type { ContainerOutput, StreamEvent } from './types.js';
import type { SessionState } from './session-state.js';
import type { IpcPaths } from './ipc-handler.js';

// ─── 归一化消息类型 ─────────────────────────────────────

/**
 * Provider SDK 消息归一化后的统一表示。
 * query-loop 只看这个类型，不看 Claude/Codex 原始消息。
 */
export type NormalizedMessage =
  | { kind: 'stream_event'; event: StreamEvent }
  | { kind: 'session_init'; sessionId: string }
  | { kind: 'result'; text: string | null; usage?: UsageInfo }
  | { kind: 'error'; message: string; recoverable: boolean;
      errorType?: 'context_overflow' | 'unrecoverable_transcript' | 'session_resume_failed' }
  | { kind: 'resume_anchor'; anchor: string };

export interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD: number;
  durationMs: number;
  numTurns: number;
  modelUsage?: Record<string, { inputTokens: number; outputTokens: number; costUSD: number }>;
}

// ─── Query 配置 ─────────────────────────────────────────

export interface QueryConfig {
  prompt: string;
  sessionId?: string;
  resumeAt?: string;
  images?: Array<{ data: string; mimeType?: string }>;
  permissionMode?: string;
}

// ─── Query 结果 ─────────────────────────────────────────

export interface QueryResult {
  newSessionId?: string;
  /** Provider-specific 的 resume 锚点（Claude: uuid，Codex: threadId） */
  resumeAnchor?: string;
  closedDuringQuery: boolean;
  interruptedDuringQuery: boolean;
  drainDetectedDuringQuery: boolean;
  contextOverflow?: boolean;
  unrecoverableTranscriptError?: boolean;
  sessionResumeFailed?: boolean;
}

// ─── 活性报告（用于 query-loop 的看门狗）───────────────

/**
 * Provider 向 query-loop 报告当前活动状态。
 * query-loop 据此决定是否重置/跳过活性超时。
 */
export interface ActivityReport {
  /** 是否有活跃的工具调用正在执行 */
  hasActiveToolCall: boolean;
  /** 当前工具调用已持续时间 (ms)，无活跃调用时为 0 */
  activeToolDurationMs: number;
  /** 是否有后台任务仍在运行 */
  hasPendingBackgroundTasks: boolean;
}

// ─── IPC 交互能力 ───────────────────────────────────────

export interface IpcCapabilities {
  /** 能否向活跃 query 中推送消息？Claude: true, Codex: false */
  supportsMidQueryPush: boolean;
  /** 能否运行时切换权限模式？Claude: true, Codex: false */
  supportsRuntimeModeSwitch: boolean;
}

// ─── Runner 接口 ────────────────────────────────────────

export interface AgentRunner {
  /** 返回此 provider 的 IPC 能力声明 */
  readonly ipcCapabilities: IpcCapabilities;

  /**
   * 初始化 runner（创建 SDK 实例、MCP 配置等）。
   * 在 query loop 开始前调用一次。
   */
  initialize(): Promise<void>;

  /**
   * 执行一次查询。
   *
   * 实现须：
   * 1. 将 prompt 发给 LLM
   * 2. 将 SDK 事件转为 NormalizedMessage yield 出去
   * 3. 在内部处理 provider-specific 逻辑（如 Claude 的 compact_boundary routing reminder）
   * 4. yield { kind: 'resume_anchor', anchor } 每当 resume 点更新
   * 5. 最终通过 generator return 返回 QueryResult
   *
   * query-loop 负责：重试、overflow 恢复、drain/close 退出、活性看门狗。
   */
  runQuery(config: QueryConfig): AsyncGenerator<NormalizedMessage, QueryResult>;

  /**
   * 向活跃查询推送后续消息（仅 supportsMidQueryPush=true 时有效）。
   * Codex 实现应将消息累积到 pendingMessages。
   * @returns 被拒绝的图片原因列表（空 = 全部通过）
   */
  pushMessage(text: string, images?: Array<{ data: string; mimeType?: string }>): string[];

  /** 中断当前查询 */
  interrupt(): Promise<void>;

  /** 设置权限模式（仅 supportsRuntimeModeSwitch=true 时有效） */
  setPermissionMode?(mode: string): Promise<void>;

  /**
   * 报告当前活动状态，供 query-loop 的活性看门狗决策。
   * 每次看门狗超时检查时调用。
   *
   * 默认实现（不覆盖时）：返回 { hasActiveToolCall: false, activeToolDurationMs: 0, hasPendingBackgroundTasks: false }
   */
  getActivityReport?(): ActivityReport;

  /**
   * 两次查询之间的清理 / 重建（如 Claude 的 MCP server rebuild）。
   * 每轮 query 结束后、下一轮开始前调用。
   */
  betweenQueries?(): Promise<void>;

  /** runner 退出前的资源清理（如 Codex 的 forceArchive）。 */
  cleanup?(): Promise<void>;
}
```

### 3.2 关键设计决策

**为什么用 `AsyncGenerator<NormalizedMessage, QueryResult>` 而不是回调？**

- query-loop 可以用手动迭代消费，代码自然
- Generator 的 return value 就是 QueryResult，不需要额外状态传递
- Provider 内部的错误分类（overflow / unrecoverable / resume_failed）由 provider 自己处理，通过 `kind: 'error'` 和 `errorType` 告知 query-loop

**Generator return value 的正确获取方式**：

```typescript
// ✅ 正确：手动迭代获取 return value
const gen = runner.runQuery(config);
let iterResult: IteratorResult<NormalizedMessage, QueryResult>;
while (!(iterResult = await gen.next()).done) {
  dispatch(iterResult.value); // NormalizedMessage
}
const queryResult: QueryResult = iterResult.value;

// ❌ 错误：for-await 丢弃 return value
for await (const msg of gen) { ... }
// 到这里 gen 已 done，无法获取 return value
```

**为什么 `IpcCapabilities` 是声明式的？**

query-loop 根据 `supportsMidQueryPush` 决定 IPC poller 的行为：
- `true`：poller 检测到消息 → 调 `runner.pushMessage()` 注入
- `false`：poller 检测到消息 → 累积到 `pendingMessages[]`，query 结束后合并到下一轮 prompt

这样 poller 逻辑写一次，provider 只需声明能力。

**为什么新增 `resume_anchor` 而移除 `compact_boundary`？**

v2 有 `compact_boundary` kind，但审计后发现它是 Claude 特有的：
- compact_boundary 触发后需要注入 routing reminder（`buildChannelRoutingReminder()`）
- 注入方式是 `session.pushMessage()`——纯 Claude API
- Codex 没有 compaction 概念

resume_anchor 则是通用的——每个 provider 都需要告诉 query-loop"我的 resume 点更新了"：
- Claude: assistant(text) uuid / user(tool_result) uuid
- Codex: thread ID（每 turn 不变，但首次需要报告）

**为什么新增 `ActivityReport`？**

活性看门狗（5 分钟无事件超时 / 20 分钟工具硬超时）是通用需求，但决策依赖 provider 内部状态：
- `hasActiveToolCall`：来自 stream-processor 的状态追踪
- `hasPendingBackgroundTasks`：来自 stream-processor 的后台任务计数

query-loop 不直接访问 provider 内部状态，而是通过 `getActivityReport()` 请求。这样：
- Claude provider 从 stream-processor 读取状态
- Codex provider 返回默认值（Codex turn 很短，通常不需要复杂超时管理）

---

## 4. 统一 Prompt 组装（修复双路径问题）

### 4.1 问题回顾（v3 更新：基于全量代码审计）

深度审计揭示了比 v2 描述更严重的问题：

**core 的 prompt 系统只覆盖了 context-builder 的 ~30% 功能**。详见 §1.2 对比表。

**关键行为冲突**：
- core 的 `buildBaseSystemPrompt()` 对所有容器加载 `workspaceGlobal/CLAUDE.md`
- context-builder 只对 `isHome` 容器加载
- 如果统一时不处理这个差异，非 home 容器会突然看到全局指令

**MemoryPlugin 差距**：
- core: ~30 行，只读取 index.md + personality.md 原文
- context-builder: ~80 行，含 home/non-home 区分、memory_query 使用范例、compaction 注意事项、"随身索引不权威"的警告

### 4.2 分层 Prompt 方案

**核心原则**：`ContextManager` 提供两级 API，适配不同 provider 的 prompt 注入方式。

```
┌─────────────────────────────────────────────────┐
│              buildFullPrompt()                    │
│  ┌────────────────────┐ ┌─────────────────────┐ │
│  │  buildBasePrompt()  │ │ buildAppendPrompt() │ │
│  │                    │ │                     │ │
│  │  • 环境 / 工作目录  │ │ • 全局 CLAUDE.md    │ │
│  │  • provider info   │ │ • contextSummary    │ │
│  │  • workspace       │ │ • 交互原则          │ │
│  │    CLAUDE.md       │ │ • IM 路由 (动态)    │ │
│  │                    │ │ • 记忆 (完整版)     │ │
│  │                    │ │ • 输出格式          │ │
│  │                    │ │ • WebFetch 策略     │ │
│  │                    │ │ • 后台任务指导       │ │
│  │                    │ │ • 插件 prompt 段     │ │
│  └────────────────────┘ └─────────────────────┘ │
└─────────────────────────────────────────────────┘

Claude → systemPrompt: { preset: 'claude_code', append: buildAppendPrompt() }
         （preset 已含基础环境信息，不需要 buildBasePrompt）

Codex  → model_instructions_file ← writeFullPromptToFile()
         （无 preset，需要完整 prompt）
```

**为什么 Claude 不需要 buildBasePrompt()**：
`claude_code` preset 已包含环境信息、工作目录、基础工具说明。传入 `buildBasePrompt()` 的内容会与 preset 重复。workspace CLAUDE.md 由 Claude SDK 的 `settingSources: ['project', 'user']` 自动处理。

### 4.3 变更清单

#### Step 1: 增强 PluginContext

```typescript
// agent-runner-core/src/plugin.ts — 扩展

export interface PluginContext {
  // 已有
  chatJid: string;
  groupFolder: string;
  isHome: boolean;
  isAdminHome: boolean;
  workspaceIpc: string;
  workspaceGroup: string;
  workspaceGlobal: string;
  workspaceMemory: string;
  userId?: string;

  // 新增：动态上下文（每轮 query 前可更新）
  recentImChannels?: Set<string>;
  contextSummary?: string;
  providerInfo?: string;  // 如 "Claude Opus 4.6" / "Codex o3-pro"
}
```

#### Step 2: 重写 prompt-builder.ts

将 `context-builder.ts` 的 8 个段落和所有静态常量迁入 core：

```typescript
// agent-runner-core/src/prompt-builder.ts

/**
 * 基础 prompt——环境信息 + workspace CLAUDE.md。
 * Codex 等无 preset 的 provider 使用。
 * Claude 不需要（preset 已含基础信息）。
 */
export function buildBasePrompt(ctx: PluginContext): string;

/**
 * 追加 prompt——所有 guideline 段 + 插件 prompt + 动态内容。
 * 所有 provider 都使用此函数。
 *
 * 段落顺序（与现有 context-builder.ts 一致）：
 * 1. 全局 CLAUDE.md（仅 isHome）
 * 2. contextSummary（如有）
 * 3. 交互原则（静态）
 * 4. IM 路由（静态 + 动态 recentImChannels）
 * 5. 记忆（完整版，含 home/non-home 区分）
 * 6. 插件 prompt 段（MemoryPlugin 以外的插件）
 * 7. 输出格式（静态）
 * 8. WebFetch 策略（静态）
 * 9. 后台任务指导（静态）
 */
export function buildAppendPrompt(
  ctx: PluginContext,
  plugins: ContextPlugin[],
): string;

/**
 * 完整 prompt = base + append。
 * Codex 用。
 */
export function buildFullPrompt(
  ctx: PluginContext,
  plugins: ContextPlugin[],
): string;

/**
 * Post-compaction routing reminder。
 * Claude 特有（其他 provider 无 compaction 概念），但定义在 core
 * 因为它只依赖 activeChannels 列表，不依赖 SDK 类型。
 */
export function buildChannelRoutingReminder(activeChannels: string[]): string;

// 静态常量直接从 context-builder.ts 搬入（内容不变）
export const INTERACTION_GUIDELINES: string;
export const OUTPUT_GUIDELINES: string;
export const WEB_FETCH_GUIDELINES: string;
export const BACKGROUND_TASK_GUIDELINES: string;
```

#### Step 3: 增强 MemoryPlugin

把 `context-builder.ts` 的详版记忆段合并到 `MemoryPlugin.getSystemPromptSection()`：

```typescript
// 改动后的 MemoryPlugin.getSystemPromptSection():
getSystemPromptSection(ctx: PluginContext): string {
  if (ctx.isHome || ctx.isAdminHome) {
    // ~70 行：完整记忆指导
    // - 加载 index.md（标注"随身索引，非权威"）
    // - 加载 personality.md（XML 包裹）
    // - memory_query 使用范例（4 个场景）
    // - memory_remember 指导（何时记、何时不记）
    // - compaction 后的行为建议
    return buildHomeMemoryPrompt(ctx.workspaceMemory);
  } else {
    // ~15 行：只读模式指导
    return buildGroupMemoryPrompt();
  }
}
```

删除 core 旧版 ~30 行的简版实现，以 context-builder 的 ~80 行版本为准。

#### Step 4: ContextManager 新增方法

```typescript
// agent-runner-core/src/context.ts

class ContextManager {
  // 已有
  buildSystemPrompt(input: ContainerInput, providerInfo?: string): string;
  // ↑ 保留向后兼容，内部改为调 buildFullPrompt()

  // 新增
  buildAppendPrompt(): string;           // Claude 用
  buildFullPrompt(): string;             // Codex 用
  writeFullPromptToFile(filePath: string): void;  // Codex 便捷方法

  // 新增：更新动态上下文（每轮 query 前调用）
  updateDynamicContext(updates: {
    recentImChannels?: Set<string>;
    contextSummary?: string;
  }): void;
}
```

#### Step 5: 删除 agent-runner 的 context-builder.ts

所有逻辑已迁入 core。`buildChannelRoutingReminder()` 也在 core 中（它不依赖 SDK 类型）。

### 4.4 各 Provider 如何使用统一 prompt

| Provider | 调用方式 | 交付方式 |
|----------|---------|---------|
| Claude | `ctxMgr.buildAppendPrompt()` → 字符串 | `systemPrompt: { preset: 'claude_code', append }` |
| Codex | `ctxMgr.writeFullPromptToFile(tmpPath)` | `model_instructions_file` 指向 tmpPath |
| 未来 X | `ctxMgr.buildFullPrompt()` → 字符串 | 按 SDK 要求传递 |

### 4.5 验证 prompt 输出一致性

Phase 0 中的关键验证步骤：迁移完成后，同样输入下 `buildAppendPrompt()` 的输出必须与原 `buildSystemPromptAppend()` 逐段比对一致。可写一个临时脚本做 diff。

---

## 5. 通用 Query Loop

### 5.1 query-loop.ts

从 index.ts 的 while(true) 循环提取，集成活性看门狗：

```typescript
// query-loop.ts

import type { AgentRunner, QueryConfig, QueryResult, NormalizedMessage, ActivityReport } from './runner-interface.js';
import type { SessionState } from './session-state.js';
import type { IpcPaths } from './ipc-handler.js';
import type { ContainerOutput } from './types.js';

export interface QueryLoopConfig {
  runner: AgentRunner;
  initialPrompt: string;
  initialImages?: Array<{ data: string; mimeType?: string }>;
  sessionId?: string;
  state: SessionState;
  ipcPaths: IpcPaths;
  imChannelsFile: string;
  log: (msg: string) => void;
  writeOutput: (output: ContainerOutput) => void;
  maxOverflowRetries?: number;  // 默认 3
}

/**
 * 通用查询循环。Provider-agnostic。
 *
 * 职责：
 * 1. 消费 runner.runQuery() 的 NormalizedMessage 流
 * 2. 根据 IpcCapabilities 配置 IPC poller 行为
 * 3. 处理通用控制流：overflow 重试、中断恢复、drain/close 退出
 * 4. 活性看门狗：5 分钟无事件 / 20 分钟工具硬超时
 * 5. 在 query 间等待 IPC 消息、调用 runner.betweenQueries()
 */
export async function runQueryLoop(config: QueryLoopConfig): Promise<void> {
  const { runner, state, ipcPaths, log, writeOutput } = config;
  const MAX_RETRIES = config.maxOverflowRetries ?? 3;

  let prompt = config.initialPrompt;
  let images = config.initialImages;
  let sessionId = config.sessionId;
  let resumeAnchor: string | undefined;
  let overflowRetryCount = 0;

  // 累积 IPC 消息（Codex 等 turn 模型使用）
  let pendingMessages: IpcMessage[] = [];

  while (true) {
    clearInterruptSentinel(ipcPaths);
    state.clearInterruptRequested();
    log(`Starting query (session: ${sessionId || 'new'})...`);

    // ── 启动 IPC poller ──
    const poller = createUnifiedIpcPoller({
      runner,
      state,
      ipcPaths,
      log,
      writeOutput,
      imChannelsFile: config.imChannelsFile,
      onMessage: runner.ipcCapabilities.supportsMidQueryPush
        ? (msg) => runner.pushMessage(msg.text, msg.images)
        : (msg) => pendingMessages.push(msg),
      onModeChange: runner.ipcCapabilities.supportsRuntimeModeSwitch
        ? (mode) => runner.setPermissionMode?.(mode)
        : undefined,
    });

    // ── 执行查询 + 消费流 ──
    const queryConfig: QueryConfig = {
      prompt, sessionId, resumeAt: resumeAnchor, images,
      permissionMode: state.currentPermissionMode,
    };

    let result: QueryResult;
    try {
      result = await consumeQueryStream(
        runner, queryConfig, poller, state, log, writeOutput, config.imChannelsFile,
      );
    } catch (err) {
      poller.stop();
      throw err;
    }
    poller.stop();

    // ── 更新 session 状态 ──
    if (result.newSessionId) sessionId = result.newSessionId;
    if (result.resumeAnchor) resumeAnchor = result.resumeAnchor;
    await runner.betweenQueries?.();

    // ── 通用错误恢复 ──
    if (result.sessionResumeFailed) {
      log('Session resume failed, retrying with fresh session');
      sessionId = undefined;
      resumeAnchor = undefined;
      continue;
    }
    if (result.unrecoverableTranscriptError) {
      writeOutput({ status: 'error', result: null,
        error: 'unrecoverable_transcript: 会话历史包含无法处理的数据，需要重置',
        newSessionId: sessionId });
      process.exit(1);
    }
    if (result.contextOverflow) {
      if (++overflowRetryCount >= MAX_RETRIES) {
        writeOutput({ status: 'error', result: null,
          error: `context_overflow: 已重试 ${MAX_RETRIES} 次仍失败` });
        process.exit(1);
      }
      log(`Context overflow, retry ${overflowRetryCount}/${MAX_RETRIES}`);
      await sleep(3000);
      continue;
    }
    overflowRetryCount = 0;

    // ── 控制信号 ──
    if (result.closedDuringQuery) {
      writeOutput({ status: 'closed', result: null });
      break;
    }
    if (result.interruptedDuringQuery) {
      writeOutput({ status: 'stream', result: null,
        streamEvent: { eventType: 'status', statusText: 'interrupted' } });
      clearInterruptSentinel(ipcPaths);
      const next = await waitForIpcMessage(ipcPaths, log, writeOutput, state, config.imChannelsFile);
      if (!next) break;
      state.clearInterruptRequested();
      prompt = next.text;
      images = next.images;
      pendingMessages = [];
      continue;
    }
    if (result.drainDetectedDuringQuery || shouldDrain(ipcPaths)) {
      await runner.cleanup?.();
      writeOutput({ status: 'drained', result: null, newSessionId: sessionId });
      process.exit(0);
    }

    // ── 等待下一条消息 ──
    writeOutput({ status: 'success', result: null, newSessionId: sessionId });
    log('Query ended, waiting for next IPC message...');

    const nextMsg = await waitForIpcMessage(ipcPaths, log, writeOutput, state, config.imChannelsFile);
    if (!nextMsg) {
      await runner.cleanup?.();
      break;
    }

    // 合并 pending messages（Codex turn 间累积的）
    if (pendingMessages.length > 0) {
      prompt = mergeMessages([...pendingMessages, nextMsg]);
      images = mergeImages([...pendingMessages, nextMsg]);
      pendingMessages = [];
    } else {
      prompt = nextMsg.text;
      images = nextMsg.images;
    }
  }
}
```

### 5.2 consumeQueryStream（含活性看门狗）

```typescript
/**
 * 消费 runner.runQuery() 的 NormalizedMessage 流。
 *
 * 职责：
 * 1. 手动迭代 generator（不用 for-await，以获取 return value）
 * 2. 转发 stream_event → writeOutput
 * 3. 处理 session_init / resume_anchor / result / error
 * 4. 活性看门狗：5 分钟无事件超时 + 20 分钟工具硬超时
 */
async function consumeQueryStream(
  runner: AgentRunner,
  config: QueryConfig,
  poller: IpcPoller,
  state: SessionState,
  log: LogFn,
  writeOutput: WriteOutputFn,
  imChannelsFile: string,
): Promise<QueryResult> {
  const ACTIVITY_TIMEOUT_MS = 300_000;       // 5 分钟
  const TOOL_HARD_TIMEOUT_MS = parseInt(
    process.env.TOOL_CALL_HARD_TIMEOUT_MS || '1200000', 10,
  );                                          // 20 分钟

  const gen = runner.runQuery(config);
  let lastEventAt = Date.now();
  let activityTimer: ReturnType<typeof setTimeout> | null = null;

  const resetActivityTimer = () => {
    lastEventAt = Date.now();
    if (activityTimer) clearTimeout(activityTimer);
    activityTimer = setTimeout(async () => {
      if (!poller.isActive) return;  // query 已结束

      // 向 provider 询问活动状态
      const report = runner.getActivityReport?.() ?? {
        hasActiveToolCall: false,
        activeToolDurationMs: 0,
        hasPendingBackgroundTasks: false,
      };

      // 后台任务仍在运行 → 延长超时
      if (report.hasPendingBackgroundTasks) {
        log(`Activity timeout skipped: background tasks pending, extending`);
        resetActivityTimer();
        return;
      }

      // 工具调用中 → 检查硬超时
      if (report.hasActiveToolCall) {
        if (report.activeToolDurationMs < TOOL_HARD_TIMEOUT_MS) {
          log(`Activity timeout skipped: tool call in progress (${Math.round(report.activeToolDurationMs / 1000)}s)`);
          resetActivityTimer();
          return;
        }
        log(`Tool call hard timeout: ${Math.round(report.activeToolDurationMs / 1000)}s exceeds ${TOOL_HARD_TIMEOUT_MS / 1000}s`);
      } else {
        log(`Activity timeout: no events for ${ACTIVITY_TIMEOUT_MS}ms`);
      }

      // 超时 → 中断
      await runner.interrupt();
      poller.stop();
    }, ACTIVITY_TIMEOUT_MS);
  };
  resetActivityTimer();

  // 手动迭代以获取 generator return value
  let newSessionId: string | undefined;
  let resumeAnchor: string | undefined;

  let iterResult: IteratorResult<NormalizedMessage, QueryResult>;
  while (!(iterResult = await gen.next()).done) {
    resetActivityTimer();
    const msg = iterResult.value;

    switch (msg.kind) {
      case 'stream_event':
        writeOutput({ status: 'stream', result: null, streamEvent: msg.event });
        break;

      case 'session_init':
        newSessionId = msg.sessionId;
        log(`Session initialized: ${newSessionId}`);
        break;

      case 'resume_anchor':
        resumeAnchor = msg.anchor;
        break;

      case 'result':
        writeOutput({ status: 'success', result: msg.text, newSessionId });
        if (msg.usage) {
          writeOutput({
            status: 'stream', result: null,
            streamEvent: { eventType: 'usage', usage: msg.usage },
          });
        }
        break;

      case 'error':
        log(`Query error: ${msg.message} (${msg.errorType || 'generic'})`);
        // 不在此处理——错误信息通过 QueryResult 返回
        break;
    }
  }

  if (activityTimer) clearTimeout(activityTimer);

  // iterResult.done === true, iterResult.value 是 QueryResult
  const queryResult = iterResult.value;
  // 合并消费期间追踪的状态
  if (newSessionId && !queryResult.newSessionId) {
    queryResult.newSessionId = newSessionId;
  }
  if (resumeAnchor && !queryResult.resumeAnchor) {
    queryResult.resumeAnchor = resumeAnchor;
  }
  return queryResult;
}
```

### 5.3 Unified IPC Poller

```typescript
/**
 * 统一 IPC poller。行为由 runner.ipcCapabilities 驱动。
 *
 * 始终检测 close/drain/interrupt 哨兵。
 * 消息处理行为通过 onMessage 回调参数化：
 * - Claude: 直接推送到活跃 query
 * - Codex: 累积到 pending 列表
 */
interface IpcPollerOptions {
  runner: AgentRunner;
  state: SessionState;
  ipcPaths: IpcPaths;
  log: LogFn;
  writeOutput: WriteOutputFn;
  imChannelsFile: string;
  onMessage: (msg: IpcMessage) => void;
  onModeChange?: (mode: string) => void;
}

interface IpcPoller {
  isActive: boolean;
  closedDuringQuery: boolean;
  interruptedDuringQuery: boolean;
  drainDetectedDuringQuery: boolean;
  stop(): void;
}

function createUnifiedIpcPoller(opts: IpcPollerOptions): IpcPoller {
  const pollerState: IpcPoller = {
    isActive: true,
    closedDuringQuery: false,
    interruptedDuringQuery: false,
    drainDetectedDuringQuery: false,
    stop() { this.isActive = false; },
  };

  const poll = () => {
    if (!pollerState.isActive) return;

    // 1. Close sentinel
    if (shouldClose(opts.ipcPaths)) {
      opts.log('Close sentinel detected during query');
      pollerState.closedDuringQuery = true;
      opts.runner.interrupt().catch(() => {});
      pollerState.stop();
      return;
    }

    // 2. Drain sentinel（检测但不停止 query）
    if (!pollerState.drainDetectedDuringQuery && shouldDrain(opts.ipcPaths)) {
      opts.log('Drain sentinel detected during query');
      pollerState.drainDetectedDuringQuery = true;
    }

    // 3. Interrupt sentinel
    if (shouldInterrupt(opts.ipcPaths)) {
      opts.log('Interrupt sentinel detected');
      pollerState.interruptedDuringQuery = true;
      opts.state.markInterruptRequested();
      opts.runner.interrupt().catch(() => {});
      pollerState.stop();
      return;
    }

    // 4. 消息和模式切换
    const { messages, modeChange } = drainIpcInput(opts.ipcPaths, opts.log);
    if (modeChange && opts.onModeChange) {
      opts.state.currentPermissionMode = modeChange;
      opts.log(`Mode change via IPC: ${modeChange}`);
      opts.onModeChange(modeChange);
    }
    for (const msg of messages) {
      opts.log(`IPC message (${msg.text.length} chars, ${msg.images?.length || 0} images)`);
      opts.state.extractSourceChannels(msg.text, opts.imChannelsFile);
      opts.writeOutput({ status: 'stream', result: null,
        streamEvent: { eventType: 'status', statusText: 'ipc_message_received' } });
      opts.onMessage(msg);
    }

    setTimeout(poll, IPC_POLL_MS);
  };
  setTimeout(poll, IPC_POLL_MS);

  return pollerState;
}
```

---

## 6. Provider 实现

### 6.1 ClaudeRunner

```typescript
// providers/claude/claude-runner.ts

import type {
  AgentRunner, IpcCapabilities, QueryConfig, QueryResult,
  NormalizedMessage, ActivityReport,
} from '../../runner-interface.js';

export class ClaudeRunner implements AgentRunner {
  readonly ipcCapabilities: IpcCapabilities = {
    supportsMidQueryPush: true,
    supportsRuntimeModeSwitch: true,
  };

  private session: ClaudeSession;
  private processor: ClaudeStreamProcessor;
  private ctxMgr: ContextManager;
  private mcpServerConfigBuilder: () => McpServerConfig;
  private mcpServerConfig: McpServerConfig;

  constructor(private opts: ClaudeRunnerOptions) {}

  async initialize(): Promise<void> {
    // 1. 创建 ContextManager + 注册所有 Plugin
    this.ctxMgr = createContextManager(this.opts.pluginCtx);
    // 2. 构建初始 MCP server config
    this.mcpServerConfigBuilder = () => createSdkMcpServer({ ... });
    this.mcpServerConfig = this.mcpServerConfigBuilder();
    // 3. 初始化 ClaudeSession
    this.session = new ClaudeSession(this.opts.log);
  }

  /**
   * 执行一次 Claude 查询。
   *
   * 内部结构：
   * 1. 更新动态上下文 → 构建 systemPromptAppend
   * 2. session.run() 创建 SDK query + MessageStream
   * 3. pushMessage() 注入初始 prompt
   * 4. for-await SDK 消息 → ClaudeStreamProcessor → yield NormalizedMessage
   * 5. 内部处理：compact_boundary routing reminder、子 agent 消息、背景任务
   * 6. return QueryResult
   *
   * ~120 行主循环 + ClaudeStreamProcessor 914 行不变。
   * 总复杂度与现有 processMessages() 持平，但逻辑边界更清晰。
   */
  async *runQuery(config: QueryConfig): AsyncGenerator<NormalizedMessage, QueryResult> {
    // 1. 更新 ContextManager 动态上下文
    this.ctxMgr.updateDynamicContext({
      recentImChannels: this.opts.state.recentImChannels,
      contextSummary: this.opts.containerInput.contextSummary,
    });
    const systemPromptAppend = this.ctxMgr.buildAppendPrompt();

    // 2. 组装 session config
    const sessionConfig: ClaudeSessionConfig = {
      sessionId: config.sessionId,
      resumeAt: config.resumeAt,
      cwd: this.opts.groupDir,
      model: this.opts.model,
      permissionMode: config.permissionMode ?? 'bypassPermissions',
      systemPromptAppend,
      // ... 其他字段
    };
    const mcpServers = {
      ...this.opts.loadUserMcpServers(),
      happyclaw: this.mcpServerConfig,
    };

    // 3. 启动 session（eagerly creates MessageStream）
    const messageGen = this.session.run(sessionConfig, mcpServers);

    // 4. 推送初始 prompt
    const rejected = this.session.pushMessage(config.prompt, config.images);
    for (const reason of rejected) {
      yield { kind: 'stream_event', event: { eventType: 'status', statusText: `⚠️ ${reason}` } };
    }

    // 5. 创建 StreamProcessor
    this.processor = new ClaudeStreamProcessor(this.opts.emit, this.opts.log, (newMode) => {
      this.opts.state.currentPermissionMode = newMode;
      this.session.setPermissionMode(newMode).catch(() => {});
    });

    // 6. 消费 SDK 消息流
    let newSessionId: string | undefined;
    let lastResumeUuid: string | undefined;
    let messageCount = 0;

    for await (const message of messageGen) {
      // stream_event（最高频）
      if (message.type === 'stream_event') {
        this.processor.processStreamEvent(message);
        continue;
      }
      if (message.type === 'tool_progress') {
        this.processor.processToolProgress(message);
        continue;
      }
      if (message.type === 'tool_use_summary') {
        this.processor.processToolUseSummary(message);
        continue;
      }

      // 系统消息
      if (message.type === 'system') {
        if (this.processor.processSystemMessage(message)) continue;
        if (message.subtype === 'init') {
          newSessionId = message.session_id;
          yield { kind: 'session_init', sessionId: newSessionId };
        }
        if (message.subtype === 'compact_boundary') {
          // Claude 特有：注入 routing reminder
          const channels = [...this.opts.state.recentImChannels];
          this.session.pushMessage(buildChannelRoutingReminder(channels));
        }
        if (message.subtype === 'task_notification') {
          this.processor.processTaskNotification(message);
        }
      }

      // 子 Agent 消息
      this.processor.processSubAgentMessage(message);

      // assistant 消息 → resume 锚点
      if (message.type === 'assistant' && message.uuid) {
        const hasText = this.extractHasText(message);
        if (hasText) {
          lastResumeUuid = message.uuid;
          yield { kind: 'resume_anchor', anchor: lastResumeUuid };
        }
        this.processor.processAssistantMessage(message);
      }

      // user(tool_result) → resume 锚点
      if (message.type === 'user' && message.uuid) {
        const hasToolResult = this.extractHasToolResult(message);
        if (hasToolResult) {
          lastResumeUuid = message.uuid;
          yield { kind: 'resume_anchor', anchor: lastResumeUuid };
        }
        // 提取后台任务 SDK ID
        this.extractBackgroundTaskIds(message);
      }

      // result
      if (message.type === 'result') {
        const errorResult = this.handleResultErrors(message, newSessionId);
        if (errorResult) {
          yield errorResult;  // kind: 'error'
          this.processor.cleanup();
          return this.buildQueryResult(newSessionId, lastResumeUuid, errorResult);
        }

        // 成功结果
        const { effectiveResult } = this.processor.processResult(message.result);
        const usage = this.extractUsage(message);
        yield { kind: 'result', text: effectiveResult, usage };

        // 检查后台任务是否仍在运行
        if (this.processor.pendingBackgroundTaskCount > 0) {
          // 不结束 generator——继续等待后台任务完成
          continue;
        }
        // 后台任务全部完成，结束
        break;
      }
    }

    // 清理
    this.processor.cleanup();

    return {
      newSessionId,
      resumeAnchor: lastResumeUuid,
      closedDuringQuery: false,   // 由 IPC poller 设置
      interruptedDuringQuery: false,
      drainDetectedDuringQuery: false,
    } satisfies QueryResult;
  }

  pushMessage(text: string, images?: Array<{ data: string; mimeType?: string }>): string[] {
    return this.session.pushMessage(text, images);
  }

  async interrupt(): Promise<void> {
    await this.session.interrupt();
    this.session.end();
  }

  async setPermissionMode(mode: string): Promise<void> {
    await this.session.setPermissionMode(mode as PermissionMode);
  }

  getActivityReport(): ActivityReport {
    return {
      hasActiveToolCall: this.processor?.hasActiveToolCall ?? false,
      activeToolDurationMs: this.processor?.activeToolDurationMs ?? 0,
      hasPendingBackgroundTasks: (this.processor?.pendingBackgroundTaskCount ?? 0) > 0,
    };
  }

  async betweenQueries(): Promise<void> {
    // Rebuild MCP server config 防止 transport 失效
    this.mcpServerConfig = this.mcpServerConfigBuilder();
  }
}
```

**复杂度分析**：

| 组件 | 行数 | 说明 |
|------|------|------|
| `ClaudeRunner` 主体 | ~200 行 | 接口实现 + runQuery 循环 |
| `ClaudeStreamProcessor` | ~914 行 | 从 stream-processor.ts 移入，**内容不变** |
| `ClaudeSession` | ~228 行 | 从 claude-session.ts 移入，**内容不变** |
| `claude-mcp-adapter.ts` | ~112 行 | 从 mcp-adapter.ts 移入，**内容不变** |
| `claude-hooks.ts` | ~212 行 | 从 transcript-archive.ts + safety-lite.ts 合并 |
| `claude-config.ts` | ~30 行 | DEFAULT_ALLOWED_TOOLS + 模型别名 |
| `claude-agent-defs.ts` | ~28 行 | 从 agent-definitions.ts 移入 |

ClaudeRunner.runQuery() ~120 行 vs 原 processMessages() ~300 行。差值来自：
- activity watchdog 逻辑上移到 query-loop（~40 行）
- IPC poller 状态管理上移到 query-loop（~30 行）
- 诊断日志简化（原版有大量 debug log）
- 错误分类辅助函数保留在 ClaudeRunner 中但为私有方法

### 6.2 CodexRunner（保留 v1 验证成果，适配新接口）

```typescript
// providers/codex/codex-runner.ts

export class CodexRunner implements AgentRunner {
  readonly ipcCapabilities: IpcCapabilities = {
    supportsMidQueryPush: false,     // Codex 每 turn 独立进程
    supportsRuntimeModeSwitch: false, // 无运行时模式切换
  };

  private session: CodexSession;
  private ctxMgr: ContextManager;
  private archive: CodexArchiveManager;
  private instructionsFile: string;

  async initialize(): Promise<void> {
    // 创建 ContextManager
    // 写 system prompt 到临时文件
    // 初始化 CodexSession（含 MCP stdio server 配置）
    // 初始化 CodexArchiveManager
  }

  async *runQuery(config: QueryConfig): AsyncGenerator<NormalizedMessage, QueryResult> {
    // 1. 每轮 turn 前重新写 instructions file（动态内容可能变化）
    this.ctxMgr.writeFullPromptToFile(this.instructionsFile);

    // 2. 准备图片（base64 → 临时文件）
    const imagePaths = config.images
      ? saveImagesToTempFiles(config.images, tmpDir)
      : undefined;

    // 3. 调用 session.runTurn(prompt, imagePaths)
    // 4. for await 消费 ThreadEvent：
    //    - 通过 codex-event-adapter 转为 StreamEvent
    //    - yield { kind: 'stream_event', event }
    // 5. turn.completed → 提取 usage → yield { kind: 'result', text, usage }
    // 6. 检查是否需要归档
    this.archive.recordTurn(usage, turnItems);
    if (this.archive.shouldArchive()) {
      await this.archive.archive(this.opts.groupFolder, this.opts.userId);
    }
    // 7. yield resume anchor (thread ID)
    yield { kind: 'resume_anchor', anchor: this.session.getThreadId() };

    // 8. return QueryResult
    return { ... } satisfies QueryResult;
  }

  pushMessage(text: string, images?: ...): string[] {
    // Codex 不支持 mid-query push。
    // query-loop 已根据 ipcCapabilities 把消息累积到 pending。
    return [];
  }

  async interrupt(): Promise<void> {
    this.session.interrupt();
  }

  // Codex turns 很短（通常 <2min），不需要自定义 ActivityReport
  // query-loop 使用默认值即可

  async cleanup(): Promise<void> {
    await this.archive.forceArchive(this.opts.groupFolder, this.opts.userId);
  }
}
```

### 6.3 关键设计差异表

| 维度 | Claude 路径 | Codex 路径 |
|------|------------|------------|
| 多轮模型 | push 模型（MessageStream.push） | turn 模型（thread.runStreamed 循环）|
| IPC 消息注入 | 查询内实时推送 | 查询间批量合并（由 query-loop 处理）|
| 流式粒度 | 逐 token delta | item 级别完整块 |
| MCP 集成 | in-process createSdkMcpServer | 外部 stdio MCP server 进程 |
| 安全机制 | PreToolUse hook (safety-lite) | sandboxMode + approvalPolicy |
| 对话归档 | PreCompact hook 自动触发 | turn.completed 后按 token 阈值触发 |
| System prompt | ContextManager.buildAppendPrompt() → append 字符串 | ContextManager.writeFullPromptToFile() |
| 权限模式 | 运行时 setPermissionMode | 启动时固定 sandboxMode |
| 活性看门狗 | getActivityReport() 报告工具/后台任务状态 | 默认值（turns 短，无需复杂超时管理）|

---

## 7. 解耦共享基础设施

### 7.1 消除 PermissionMode 泄漏

**现状**：`session-state.ts` 和 `ipc-handler.ts` 直接 import `PermissionMode` from Claude SDK。

**修复**：

```typescript
// session-state.ts — 改动 1 行
- import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';
+ // PermissionMode 是字符串枚举，由各 provider 映射到自身概念
+ type PermissionMode = string;
```

```typescript
// ipc-handler.ts — 改动 1 行
- import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';
+ type PermissionMode = string;
```

**影响**：2 个文件各改 1 行。Claude provider 内部继续使用 SDK 的 `PermissionMode` 类型做类型安全，只是不泄漏到共享层。

### 7.2 移动 SDKUserMessage

**现状**：`types.ts` 包含 Claude SDK 特有的 `SDKUserMessage` 接口（message.content + parent_tool_use_id）。

**修复**：将 `SDKUserMessage` 移入 `providers/claude/claude-session.ts`（它的唯一使用者）。

### 7.3 最终的 SDK 引用分布

| 文件 | 引用 Claude SDK？ | 引用 Codex SDK？ |
|------|-------------------|-----------------|
| index.ts | ❌ | ❌ |
| runner-interface.ts | ❌ | ❌ |
| query-loop.ts | ❌ | ❌ |
| session-state.ts | ❌ | ❌ |
| ipc-handler.ts | ❌ | ❌ |
| types.ts | ❌ | ❌ |
| utils.ts | ❌ | ❌ |
| providers/claude/*.ts | ✅ | ❌ |
| providers/codex/*.ts | ❌ | ✅ |

**零交叉**：没有任何共享文件引用任何 provider SDK。

---

## 8. Codex 子模块设计（保留 v1 验证成果）

### 8.1 codex-session.ts（~150 行，与 v1 相同）

```typescript
export class CodexSession {
  private codex: Codex;
  private thread: Thread | null = null;
  private abortController: AbortController | null = null;

  constructor(config: CodexSessionConfig);
  startOrResume(threadId?: string): void;
  async *runTurn(prompt: string, images?: string[]): AsyncGenerator<ThreadEvent>;
  getThreadId(): string | null;
  interrupt(): void;
}
```

### 8.2 codex-event-adapter.ts（~200 行，与 v1 相同）

将 Codex ThreadEvent 转为 HappyClaw StreamEvent：

| Codex ThreadEvent | → StreamEvent(s) |
|-------------------|-------------------|
| `thread.started` | `init` |
| `item.started` (command_execution) | `tool_use_start` { toolName: 'Bash' } |
| `item.completed` (command_execution) | `tool_use_end` |
| `item.started` (mcp_tool_call) | `tool_use_start` { toolName: `mcp__${server}__${tool}` } |
| `item.completed` (mcp_tool_call) | `tool_use_end` |
| `item.completed` (agent_message) | `text_delta` { text: 完整文本 } |
| `item.completed` (file_change) | `tool_use_start` + `tool_use_end` { toolName: 'Edit'/'Write' } |
| `item.completed` (web_search) | `tool_use_start` + `tool_use_end` { toolName: 'WebSearch' } |
| `item.completed` (reasoning) | `thinking_delta` |
| `item.completed` (todo_list) | `todo_update` |
| `turn.completed` | `usage` |
| `turn.failed` / `error` | `status` |

### 8.3 codex-mcp-server.ts（~120 行，与 v1 相同）

独立入口点（`node codex-mcp-server.js`），stdio transport，复用 `createContextManager()`。

### 8.4 codex-archive.ts（~100 行，与 v1 相同）

基于 token 累积量在 turn 间归档。

### 8.5 codex-image-utils.ts（~40 行，与 v1 相同）

base64 → 临时文件。

---

## 9. IPC 多轮语义（保留 v1，适配新架构）

v1 的 IPC 分析完全正确，差异由 query-loop 的 `IpcCapabilities` 自动处理：

```
Claude (supportsMidQueryPush: true):
  query 期间 IPC poller 检测到消息 → onMessage → runner.pushMessage()
  → agent 在同一 query 内看到新消息

Codex (supportsMidQueryPush: false):
  query 期间 IPC poller 检测到消息 → onMessage → pendingMessages.push()
  query 结束后 → query-loop 合并 pending + waitForIpcMessage
  → 下一轮 runQuery(mergedPrompt)
```

**query-loop 自动处理**，provider 不需要关心。

---

## 10. 宿主机侧变更（与 v1 相同）

### 10.1 container-runner.ts

宿主机已有三级配置体系（global → container → group.model），注入点清晰：

```diff
+ const llmProvider = group.llm_provider || 'claude';
+ if (llmProvider === 'codex') {
+   envLines.push('HAPPYCLAW_LLM_PROVIDER=codex');
+   const openaiKey = getOpenAIApiKey();
+   if (openaiKey) envLines.push(`OPENAI_API_KEY=${openaiKey}`);
+ }
```

### 10.2 前端

- `ContainerEnvPanel.tsx`：LLM provider 选择
- Settings：Codex API key 配置
- **无需修改**：WebSocket、Chat UI、GroupQueue（StreamEvent/ContainerOutput 协议不变）

### 10.3 Codex API Key 管理

`runtime-config.ts` + `routes/config.ts`，约 50 行后端 + 80 行前端。

---

## 11. 实施计划

### Phase 0: 解耦基础设施（不加 Codex，纯重构）

**目标**：现有 Claude 功能不变，但架构就绪。

**策略**：每个 step 独立可验证、可回退。前 3 步为"安全变更"（改类型/加文件），后 5 步为"结构变更"（移动/重写）。

| Step | 变更 | 风险 | 验证 |
|------|------|------|------|
| 0.1 | `session-state.ts` / `ipc-handler.ts`：`PermissionMode` → `string` | 极低 | `make typecheck` |
| 0.2 | `types.ts`：移 `SDKUserMessage` → `claude-session.ts` | 极低 | `make typecheck` |
| 0.3 | 创建 `runner-interface.ts`（AgentRunner + NormalizedMessage + ActivityReport 类型） | 零（纯类型） | `make typecheck` |
| 0.4 | 增强 core prompt 系统：扩展 PluginContext + 重写 prompt-builder.ts + 增强 MemoryPlugin + ContextManager 新方法 | **高** | prompt diff 脚本对比输出 |
| 0.5 | agent-runner 切换到 core prompt：`runQuery()` 改用 `ctxMgr.buildAppendPrompt()`，删除 `context-builder.ts`（`buildChannelRoutingReminder` 移入 core） | **高** | 手动测试 prompt 不变 |
| 0.6 | 创建 `providers/claude/` 目录，移入 Claude 相关文件：`stream-processor.ts` → `claude-stream-processor.ts`、`claude-session.ts`（已在正确位置只需移目录）、`mcp-adapter.ts` → `claude-mcp-adapter.ts`、`transcript-archive.ts` + `safety-lite.ts` → `claude-hooks.ts`、`agent-definitions.ts` → `claude-agent-defs.ts`、新建 `claude-config.ts` | 中 | `make typecheck` + `make build` |
| 0.7 | 实现 `ClaudeRunner`（封装现有逻辑，实现 AgentRunner 接口）。关键：runQuery() 替代 processMessages()，getActivityReport() 封装 stream-processor 状态查询 | **高** | 端到端手动测试 |
| 0.8 | 提取 `query-loop.ts`（含活性看门狗 + unified IPC poller），重写 `index.ts` 为薄入口 | **高** | 全量验证矩阵 |

**Step 0.4 详细拆分**（最复杂的步骤）：

| Sub-step | 变更 | 验证 |
|----------|------|------|
| 0.4a | 扩展 PluginContext：加 `recentImChannels`、`contextSummary`、`providerInfo` | `make typecheck` |
| 0.4b | 搬静态常量到 core/prompt-builder.ts：INTERACTION_GUIDELINES、OUTPUT_GUIDELINES、WEB_FETCH_GUIDELINES、BACKGROUND_TASK_GUIDELINES | 内容 diff 一致 |
| 0.4c | 重写 core 的 `buildAppendPrompt()`：组装 8 段，与 context-builder 逻辑一致 | prompt diff 脚本 |
| 0.4d | 增强 MemoryPlugin.getSystemPromptSection()：合并 context-builder 的详版记忆段 | prompt diff 脚本 |
| 0.4e | ContextManager 新增 `buildAppendPrompt()` / `updateDynamicContext()` / `writeFullPromptToFile()` | `make typecheck` |
| 0.4f | **写 prompt diff 脚本**：给定相同 PluginContext + ContainerInput，对比 `buildSystemPromptAppend()` vs `ctxMgr.buildAppendPrompt()` | 输出 100% 一致 |

**Step 0.7 详细拆分**：

| Sub-step | 变更 | 验证 |
|----------|------|------|
| 0.7a | ClaudeRunner 骨架：implement AgentRunner 所有方法，runQuery() 暂时直接调用旧 runQuery() | `make typecheck` |
| 0.7b | ClaudeRunner.runQuery() 内联 processMessages() 逻辑（从 query-runner.ts 迁移） | 手动测试：流式输出 |
| 0.7c | 删除旧 query-runner.ts，所有调用改为 ClaudeRunner | `make build` + 手动测试 |

**验证矩阵（Phase 0 完成后）**：
- [ ] `make typecheck` 通过
- [ ] `make build` 通过
- [ ] 手动测试：Web 对话 → 流式推送正常（text_delta 逐字出现）
- [ ] 手动测试：IM 消息路由 → send_message 正常
- [ ] 手动测试：多轮对话 → IPC 推送（查询中追加消息）正常
- [ ] 手动测试：_interrupt → 中断 + 等待下条消息正常
- [ ] 手动测试：_drain → 完成当前查询后退出正常
- [ ] 手动测试：_close → 立即退出正常
- [ ] 手动测试：context overflow → 自动重试（最多 3 次）正常
- [ ] 手动测试：MCP 工具调用（send_message / memory_query）正常
- [ ] 手动测试：后台任务（Task with run_in_background）→ 子 agent 消息流正常
- [ ] 手动测试：长时间无活动 → 5 分钟后自动中断正常
- [ ] 手动测试：会话归档（PreCompact hook）→ conversations/ 文件生成正常

### Phase 1: Codex Provider 核心能力

| Step | 变更 |
|------|------|
| 1.1 | 安装 `@openai/codex-sdk` + `@modelcontextprotocol/sdk` |
| 1.2 | 实现 `codex-mcp-server.ts`（复用 createContextManager） |
| 1.3 | 实现 `codex-session.ts` |
| 1.4 | 实现 `codex-event-adapter.ts` |
| 1.5 | 实现 `codex-image-utils.ts` |
| 1.6 | 实现 `CodexRunner`（实现 AgentRunner 接口） |
| 1.7 | `index.ts` 加 provider 选择分支（读 `HAPPYCLAW_LLM_PROVIDER` 环境变量） |

**验证**：
- 手动 stdin 注入 → Codex runner 启动 → StreamEvent 输出
- MCP 工具调用正常
- 多轮对话保持上下文
- _interrupt / _drain / _close 正常
- IPC 消息在 turn 间正确合并

### Phase 2: 归档 + 宿主机集成

| Step | 变更 |
|------|------|
| 2.1 | 实现 `codex-archive.ts` |
| 2.2 | 修改 `container-runner.ts`（环境变量注入） |
| 2.3 | 实现 Codex API key 管理（runtime-config + 加密存储） |

### Phase 3: 前端 + 打磨

| Step | 变更 |
|------|------|
| 3.1 | 前端 LLM provider 选择 + API key 配置 |
| 3.2 | 前端处理批量 text_delta（可选：模拟打字效果） |
| 3.3 | 更新文档 |

---

## 12. 新增/修改文件清单

### Phase 0 新增

```
container/agent-runner/src/
  runner-interface.ts           (~100 行) AgentRunner 接口 + NormalizedMessage + ActivityReport
  query-loop.ts                 (~300 行) 通用查询循环 + 活性看门狗 + unified IPC poller

container/agent-runner/src/providers/claude/
  claude-runner.ts              (~200 行) AgentRunner 实现
  claude-stream-processor.ts    (≈914 行) 从 stream-processor.ts 移入（内容不变）
  claude-session.ts             (≈228 行) 从 claude-session.ts 移入（内容不变）
  claude-mcp-adapter.ts         (≈112 行) 从 mcp-adapter.ts 移入（内容不变）
  claude-hooks.ts               (~212 行) 从 transcript-archive.ts + safety-lite.ts 合并
  claude-config.ts              (~30 行)  DEFAULT_ALLOWED_TOOLS + 模型别名
  claude-agent-defs.ts          (~28 行)  从 agent-definitions.ts 移入

container/agent-runner-core/src/
  prompt-builder.ts             (扩展 → ~350 行) 迁入全部 guideline 段 + buildAppendPrompt + buildFullPrompt
  plugins/memory.ts             (扩展 → ~220 行) 合并详版记忆 prompt（home/non-home 区分）
  context.ts                    (扩展 → ~110 行) updateDynamicContext + buildAppendPrompt + writeFullPromptToFile
  plugin.ts                     (扩展)   PluginContext 增加 3 个动态字段
```

### Phase 0 删除

```
container/agent-runner/src/
  context-builder.ts            删除（逻辑迁入 core）
  query-runner.ts               删除（逻辑迁入 ClaudeRunner.runQuery）
  (以下文件移入 providers/claude/，原位置删除)
  stream-processor.ts
  mcp-adapter.ts
  transcript-archive.ts
  safety-lite.ts
  agent-definitions.ts
```

### Phase 0 修改

```
container/agent-runner/src/
  index.ts                      (重写为薄入口，~100 行)
  session-state.ts              (PermissionMode → string，改 1 行)
  ipc-handler.ts                (PermissionMode → string，改 1 行)
  types.ts                      (移除 SDKUserMessage)
  claude-session.ts             (移入 providers/claude/ + 加入 SDKUserMessage 类型)
```

### Phase 1 新增

```
container/agent-runner/src/providers/codex/
  codex-runner.ts               (~250 行) AgentRunner 实现
  codex-session.ts              (~150 行) SDK 封装
  codex-event-adapter.ts        (~200 行) ThreadEvent → StreamEvent
  codex-mcp-server.ts           (~120 行) stdio MCP bridge
  codex-image-utils.ts          (~40 行)  base64 → 临时文件

container/agent-runner/
  package.json                  (+2 deps) @openai/codex-sdk, @modelcontextprotocol/sdk
```

### Phase 2-3（与 v1 相同）

```
container/agent-runner/src/providers/codex/
  codex-archive.ts              (~100 行)

src/
  container-runner.ts           (+20 行)
  runtime-config.ts             (+50 行)
  routes/config.ts              (+30 行)

web/src/
  components/                   (+100 行)
```

---

## 13. 安全模型（与 v1 相同）

| Claude 机制 | Codex 替代 |
|------------|-----------|
| `permissionMode: bypassPermissions` | `sandboxMode: 'danger-full-access'` + `approvalPolicy: 'never'` |
| `permissionMode: plan` | `approvalPolicy: 'on-request'` |
| safety-lite PreToolUse hook | 接受降级——Codex 自带 sandbox |

---

## 14. 风险

| 风险 | 影响 | 缓解 |
|------|------|------|
| **Phase 0 重构回归** | Claude 现有功能可能受影响 | Step 0.4/0.7/0.8 细分 sub-step；每步独立验证；prompt diff 脚本保证 prompt 一致 |
| **ClaudeRunner.runQuery() 体积** | 可能超预期（>200 行） | 保持 stream-processor 为独立类；runQuery 只做消息分发 + 错误分类 |
| **活性看门狗边界** | 看门狗超时与 IPC poller 中断可能竞态 | runner.interrupt() 幂等（多次调用不 crash）；poller.stop() 与 watchdog clearTimeout 协调 |
| **prompt 统一后行为微变** | 统一 prompt 可能与 claude_code preset 有微妙交互 | Step 0.4f prompt diff 脚本逐段对比 |
| **后台任务追踪跨 provider 差异** | Codex 无子 agent 概念 | ActivityReport 默认值安全（hasPendingBackgroundTasks: false） |
| 每 turn 新进程开销 | 延迟增加 ~1-2s | 接受——Codex CLI 启动有缓存 |
| IPC 消息延迟处理 | 用户消息需等 turn 结束 | query-loop 自动处理 pending 合并 |
| 无 token 级流式 | 前端文本一次性出现 | 接受降级或后续加模拟打字 |
| MCP server 进程管理 | 子进程残留 | Codex CLI 自行管理；添加 cleanup() 保底 |
| 无 PreCompact hook | 归档时机不精确 | token 阈值 + 退出时 forceArchive |
| `model_instructions_file` 需每轮更新 | 动态内容（IM channels）可能过期 | CodexRunner.runQuery 每轮重写 |

---

## 15. 与 v1/v2 的核心差异总结

| 维度 | v1 | v2 | v3 |
|------|----|----|-----|
| 架构策略 | 平行复制 | 解耦重构 | 解耦重构（同 v2） |
| NormalizedMessage | — | 5 种 kind | 5 种 kind（移除 compact_boundary，新增 resume_anchor） |
| 活性看门狗 | 未定义 | 未定义 | ActivityReport 接口 + query-loop 统一管理 |
| prompt 分层 | 两套并行 | 统一到 core（buildFullSystemPrompt） | 双 API（buildAppendPrompt + buildFullPrompt） |
| Phase 0 粒度 | — | 8 步 | 8 步 + 高风险步骤 sub-step 拆分 |
| prompt 验证 | — | 手动对比 | diff 脚本自动化 |
| Generator return | — | ❌ gen.return() 错误 | ✅ 手动迭代 iterResult.value |
| compact_boundary | — | query-loop 感知 | provider 内部处理（query-loop 不感知） |
| stream-processor 归属 | 不动 | 移入 claude provider | 移入 claude provider（**强调 914 行不变**） |
| Phase 0 预估复杂度 | — | ~800 行（低估） | ~2200 行总变更（含移动的 ~1500 行 + 新写 ~700 行） |
