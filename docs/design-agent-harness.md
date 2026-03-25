# HappyClaw Agent Harness 设计稿

> 状态：草案 v9（Claude-only，无预留接口，状态治理优先）
> 日期：2026-03-25
> 前版：v8 → 补全删除清单遗漏（memory-agent.ts、SettingsPage.tsx、usage store 等 ~10 个文件）；修复 §5 Resume UUID 归属与 §3.2 的矛盾（保持为 main() 局部变量）；ClaudeSession MCP 配置统一由调用者组装（loadUserMcpServers 留在 protocol-bridge）；safety-lite fork bomb 正则转义修复；context-builder 去除死代码段落 heartbeatContent；Phase 2a 承认需要函数签名变更；core 层 prompt-builder.ts 标记 @deprecated 前置到 Phase 3

## 1. 目标

四件事：

1. **GPT 大清洗**：删除所有 OpenAI/GPT 代码（~6000 行）——agent-runner-openai、cross-model、delegate、safety/review hooks、GPT client、OpenAI 凭据管理、前端配置、usage store、settings 导航
2. **提取 Claude Session 模块**：从 index.ts 提取 `MessageStream` + `query()` 封装为**具体类**（不加接口），清理 agent-runner-core 的死代码
3. **治理共享状态 + 拆分巨石 index.ts**：先把 5 个模块级变量收敛为显式 `SessionState`，再拆分为 protocol-bridge + context-builder + query-runner + ipc-handler + transcript-archive + image-utils
4. **IM Commentary 换 Claude**：移除 GPT 调用路径，保留 Claude Haiku + 启发式 fallback

### 不变的

- ContainerInput/Output 协议（宿主机 ↔ harness 的 stdin/stdout 约定）
- IPC 文件通信机制（input/、messages/、tasks/、哨兵文件）
- StreamEvent 类型体系（shared/stream-event.ts）
- 宿主机侧的 GroupQueue、TurnManager、WebSocket 广播——全部不动
- Memory Agent（完全不动——入口、JSONL 协议、data/memory/ 目录结构）
- PreCompact hook（归档对话 + session_wrapup IPC，非 GPT 依赖）
- stream-processor.ts（913 行，直接消费 Claude SDK 消息类型，不改）

### 明确不做的

- ~~SDK Adapter 接口~~（不预定义 PushModelAdapter / TurnModelAdapter / AdapterEvent——只有一个实现时，接口是负债不是资产。等真有第二个 SDK 再从两个具体实现中抽象）
- ~~EventNormalizer~~（pass-through 类没有存在意义）
- Context Engine 两层分离（维持现状）
- Credential Manager 独立提取（维持现状，只删除 OpenAI 部分）
- FeishuDocs skill 迁移（独立 PR）
- Memory Agent 改造
- 重命名 agent-runner → agent-harness（收益不值代价，可选独立 PR）

---

## 2. 架构总览

### 2.1 系统架构图

```
宿主机进程（不变）
  │
  │  stdin: ContainerInput JSON
  │  stdout: OUTPUT_MARKER 包裹的 ContainerOutput
  ▼
┌──────────────────────────────────────────────────────┐
│                   agent-runner                        │
│                                                       │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────┐ │
│  │ Protocol      │  │ Context      │  │ Stream     │ │
│  │ Bridge        │  │ Builder      │  │ Processor  │ │
│  │               │  │              │  │            │ │
│  │ main loop     │  │ 动态生成     │  │ SDK msgs → │ │
│  │ stdin/stdout  │  │ system       │  │ StreamEvent│ │
│  │ signal/error  │  │ prompt       │  │ (不动)     │ │
│  └──────────────┘  └──────────────┘  └────────────┘ │
│                                                       │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────┐ │
│  │ Claude        │  │ Session      │  │ Query      │ │
│  │ Session       │  │ State        │  │ Runner     │ │
│  │               │  │              │  │            │ │
│  │ MessageStream │  │ 5 个模块级   │  │ runQuery   │ │
│  │ + query()     │  │ 变量 → 1 个  │  │ process-   │ │
│  │ + hooks/MCP   │  │ 显式对象     │  │ Messages   │ │
│  │ + interrupt() │  │              │  │ ipcPoller  │ │
│  └──────────────┘  └──────────────┘  └────────────┘ │
│                                                       │
│  ┌────────────────────────────────────┐               │
│  │ IPC Handler                        │               │
│  │ sentinel + drain + wait（调用 core）│               │
│  └────────────────────────────────────┘               │
│                                                       │
│  ┌─────────────────────────────────────────────────┐ │
│  │   MCP Server（查询间重建，防 transport 断连）     │ │
│  │                                                   │ │
│  │  send_message  │ memory_query   │ schedule_task  │ │
│  │  send_image    │ memory_remember│ list_tasks     │ │
│  │  send_file     │                │ pause/resume/  │ │
│  │                │                │ cancel_task    │ │
│  │  feishu_docs_* │                │ register_group │ │
│  └─────────────────────────────────────────────────┘ │
│                                                       │
│  ┌─────────────────────────────────────────────────┐ │
│  │   Hooks                                          │ │
│  │                                                   │
│  │  PreCompact: 归档对话 + session_wrapup IPC       │ │
│  │  PreToolUse: safety-lite（仅 host 模式）          │ │
│  └─────────────────────────────────────────────────┘ │
│                                                       │
│  ┌─────────────────────────────────────────────────┐ │
│  │   agent-runner-core（共享库）                     │ │
│  │                                                   │ │
│  │  ContextManager + ContextPlugin（插件注册/路由）  │ │
│  │  ToolDefinition（工具定义，mcp-adapter 转 SDK）   │ │
│  │  IPC 原语（readFile/writeFile/createConfig）     │ │
│  │  ContainerInput/Output 协议类型                   │ │
│  └─────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────┘
```

### 2.2 agent-runner-core 定位

**定位**：SDK 无关的共享库——插件系统 + IPC 原语 + 协议类型。

**保留**：
- `plugin.ts` / `context.ts`：ContextManager + ContextPlugin 接口（组织 MCP 工具）
- `ipc.ts`：文件 IPC 通道基础操作
- `protocol.ts`：OUTPUT_MARKER 标记符 + 日志工厂
- `types.ts`：ContainerInput/Output + StreamEvent 类型
- `prompt-builder.ts`：基础系统提示构建（**注意**：GPT 大清洗后此模块无消费者——Claude runner 使用 SDK 的 `preset + append` 机制，不调用 `buildBaseSystemPrompt()`。同理 `ContextManager.buildSystemPrompt()` 也成为死代码。Phase 3 标记 `@deprecated`）
- `utils.ts`：文本处理、敏感数据脱敏
- `plugins/`：messaging.ts、tasks.ts、groups.ts、memory.ts、feishu-docs.ts

**本次删除**：
- `tool-adapters.ts`：`toOpenAITools()` / `toCodexTools()` 已无消费者
- `plugins/cross-model.ts`：跨模型调用（GPT 依赖）
- `plugins/delegate.ts`：任务委托（GPT 依赖）

**关系**：agent-runner 的 `mcp-adapter.ts` 调用 `core.ContextManager.getActiveTools()` → 转为 Claude SDK MCP tool 格式。这条路径不变。

---

## 3. 核心模块设计

### 3.1 Protocol Bridge（index.ts 瘦身后的入口）

**职责**：main loop、stdin/stdout 协议、信号处理、查询循环编排。

#### 完整职责清单

| 职责集群 | 具体内容 |
|---------|---------|
| **I/O 协议** | stdin 解析 ContainerInput、OUTPUT_MARKER 包裹写回 stdout |
| **查询循环** | 首次查询 → 等待 IPC → 下一轮查询 → 直到 _close/_drain |
| **错误恢复** | 上下文溢出重试（3 次）、不可恢复 transcript 检测、session resume 失败重建 |
| **MCP 生命周期** | 查询间重建 MCP server（防止 transport 断开） |
| **信号处理** | SIGTERM/SIGINT 优雅关闭、EPIPE 降级、uncaughtException/unhandledRejection 兜底 |

**不再包含**：runQuery 函数体（→ query-runner.ts）、系统 prompt 拼接（→ context-builder.ts）、IPC 操作（→ ipc-handler.ts）。

### 3.2 SessionState（新增）

**职责**：收敛 index.ts 散落的 5 个模块级变量为一个显式传递的对象。

**解决的问题**：当前 `recentImChannels`、`imChannelLastSeen`、`currentPermissionMode`、`lastInterruptRequestedAt`、`imPersistTimer` 是模块级变量，被 `runQuery()`、IPC 轮询回调、信号处理器、context builder 通过闭包交叉访问。这导致拆文件时依赖关系不可见——六个模块互相 import 共享状态，比一个大文件更难理解。

```typescript
// session-state.ts

export class SessionState {
  // --- IM 渠道追踪 ---
  recentImChannels = new Set<string>();
  imChannelLastSeen = new Map<string, number>();
  private imPersistTimer: ReturnType<typeof setTimeout> | null = null;

  /** 从 .recent-im-channels.json 恢复 */
  loadImChannels(groupDir: string): void { /* ... */ }

  /** 防抖持久化到磁盘 */
  schedulePersistImChannels(groupDir: string): void { /* ... */ }

  /** 从 source="..." 提取渠道并更新 lastSeen */
  extractSourceChannels(text: string): void { /* ... */ }

  /** 返回活跃渠道列表（24h TTL 过滤） */
  getActiveImChannels(): string[] { /* ... */ }

  // --- 权限 ---
  currentPermissionMode: PermissionMode = 'bypassPermissions';

  // --- 中断追踪 ---
  lastInterruptRequestedAt = 0;

}
```

**不放在 SessionState 里的**：`sessionId`、`lastAssistantUuid`、`lastResumeUuid`。这三个值由 `runQuery()` 作为返回值输出，main() 在查询**成功完成后**才采纳。如果放进 SessionState 作为可变字段，runQuery 中途失败时这些值可能已被部分更新——等于把"事务提交"变成了"实时写入"，丢失了原来的原子性保证。

**使用方式**：main() 创建一个 `SessionState` 实例，显式传给 `runQuery()`、`buildContextPrompt()`、`pollIpcDuringQuery()` 等函数。不再有模块级状态。

### 3.3 Claude Session（具体类，无接口）

**职责**：封装 Claude Agent SDK 的完整查询生命周期——`MessageStream` 管理、SDK `query()` 调用（包括所有选项组装）、运行时控制（中断、权限切换）。

**v6 的问题**：v6 的 ClaudeSession 只是 MessageStream + query() 的薄透传（~60 行实际逻辑），调用者仍需理解 SDK 全部参数体系，间接层没有提供封装价值。

**v7 改进**：ClaudeSession 吸收 SDK 配置组装逻辑（hooks 注册、MCP server 配置、model 选择、目录权限），调用者只传业务级参数。

**为什么不用接口**：只有一个实现。接口是给多态用的——没有第二个 SDK 消费者时，接口只增加间接层不提供价值。等未来真有第二个 SDK，从两个具体实现中抽象出的接口才是准确的。

```typescript
// claude-session.ts

import { query, MessageStream, type PermissionMode } from '@anthropic-ai/claude-agent-sdk';

/** 业务级参数——调用者不需要知道 SDK 选项结构 */
export interface ClaudeSessionConfig {
  // 会话
  sessionId?: string;
  resumeAt?: string;
  // 环境
  cwd: string;
  additionalDirectories?: string[];
  model?: string;
  // 权限
  permissionMode?: PermissionMode;
  allowedTools?: string[];
  disallowedTools?: string[];
  // 业务上下文（由 context-builder 组装好的字符串）
  systemPromptAppend: string;
  // 运行模式（决定 hooks 策略）
  isHostMode: boolean;
  isHome: boolean;
  isAdminHome: boolean;
  groupFolder: string;
  userId?: string;
}

export class ClaudeSession {
  private stream: MessageStream | null = null;
  private queryRef: QueryRef | null = null;

  /**
   * 启动 query，返回 SDK 原始消息的 async iterable。
   * 内部负责：hooks 组装、MCP server 加载、SDK options 拼装。
   * 调用者只需遍历返回的消息流。
   *
   * 每次调用都重建 MessageStream——上一轮 end() 后 stream 已关闭，无法复用。
   * ClaudeSession 实例本身可跨查询复用（只是 stream 和 queryRef 每轮重置）。
   */
  async *run(
    config: ClaudeSessionConfig,
    mcpServers: Record<string, unknown>,  // 调用者负责组装完整配置（happyclaw + 用户自定义）
  ): AsyncIterable<SDKMessage> {
    // 每次 run() 重建 stream，确保干净状态
    this.stream = new MessageStream();
    this.queryRef = null;

    // hooks 组装：PreCompact 始终启用，safety-lite 仅 host 模式
    const hooks = {
      PreCompact: [{ hooks: [
        createPreCompactHook(config.isHome, config.isAdminHome, config.groupFolder, config.userId),
      ] }],
      PreToolUse: config.isHostMode ? [{ hooks: [createSafetyLiteHook()] }] : [],
    };

    const q = query({
      prompt: this.stream,
      options: {
        model: config.model || 'opus',
        cwd: config.cwd,
        additionalDirectories: config.additionalDirectories,
        resume: config.sessionId,
        resumeSessionAt: config.resumeAt,
        systemPrompt: { type: 'preset', preset: 'claude_code', append: config.systemPromptAppend },
        permissionMode: config.permissionMode ?? 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        allowedTools: config.allowedTools,
        disallowedTools: config.disallowedTools,
        maxThinkingTokens: 16384,
        settingSources: ['project', 'user'],
        includePartialMessages: true,
        mcpServers,
        hooks,
        agents: PREDEFINED_AGENTS,
      },
    });
    this.queryRef = q;

    for await (const message of q) {
      yield message;  // 直接 yield SDK 原始消息，不做转换
    }
  }

  /** 向正在运行的 query 推送用户消息 */
  pushMessage(text: string, images?: ImageData[]): string[] {
    if (!this.stream) throw new Error('ClaudeSession.run() not called');
    return this.stream.push({ role: 'user', content: text }, images);
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    await this.queryRef?.setPermissionMode(mode);
  }

  async interrupt(): Promise<void> {
    await this.queryRef?.interrupt();
  }

  end(): void {
    this.stream?.end();
  }
}
```

**关键决策**：
- `run()` 直接 yield Claude SDK 的原始消息类型，不包装为中间 `AdapterEvent`。stream-processor.ts 本来就消费这些对象（注意：stream-processor 没有 SDK import，它消费的是运行时传入的普通对象，比设计稿此前描述的更解耦）。
- hooks/MCP 组装内化到 ClaudeSession，query-runner 不再接触 SDK 配置细节。
- **MessageStream 每次 run() 重建**——当前代码每次 runQuery() 都 new MessageStream()（index.ts:813），保持这个语义。ClaudeSession 实例可跨查询复用，stream 和 queryRef 每轮重置。
- **MCP 配置由调用者组装**——`loadUserMcpServers()`（当前 index.ts:780）保留在 protocol-bridge（瘦身后的 index.ts），由 main() 在查询循环中调用并与 happyclaw MCP server 合并后传入 `ClaudeSession.run()`。理由：该函数读宿主机文件系统 `~/.claude/settings.json`，是环境配置行为而非会话生命周期，放 ClaudeSession 内会混淆职责。

### 3.4 Context Builder

**职责**：组装 `systemPrompt.append` 字符串——收集所有动态上下文片段，拼接为最终注入 SDK 的系统提示追加内容。

**必须在 harness 内**——需要实时读取本地文件（memory index、global CLAUDE.md）。

**函数签名**：

```typescript
// context-builder.ts

export interface ContextBuilderInput {
  state: SessionState;           // 读取 getActiveImChannels()
  containerInput: ContainerInput; // 读取 contextSummary、isHome、isAdminHome、userId
  groupDir: string;              // WORKSPACE_GROUP，用于读取本地文件
  globalDir: string;             // WORKSPACE_GLOBAL
  memoryDir: string;             // WORKSPACE_MEMORY
}

/**
 * 返回拼接好的 systemPrompt.append 字符串。
 * 内部拼接顺序（对应 index.ts lines 963-1076，去除始终为空的 heartbeatContent 后为 8 个段落）：
 *
 * 1. globalClaudeMd           — 读 {globalDir}/CLAUDE.md（仅 isHome）
 * 2. contextSummary           — 从 containerInput.contextSummary（compact 后注入）
 * 3. interactionGuidelines    — 静态字符串（禁止主动向用户介绍工具）
 * 4. channelRoutingGuidelines — 静态 + state.getActiveImChannels() 动态注入
 * 5. memoryRecall             — 读 {memoryDir}/{userId}/index.md + 格式化
 * 6. outputGuidelines         — 静态（Markdown 图片、Mermaid）
 * 7. webFetchGuidelines       — 静态（WebFetch 失败时 fallback）
 * 8. backgroundTaskGuidelines — 静态（run_in_background 用法）
 */
export function buildSystemPromptAppend(input: ContextBuilderInput): string;

/** 单独导出，供 compact_boundary 后重新注入路由提醒 */
export function buildChannelRoutingReminder(activeChannels: string[]): string;
```

**设计决策**：
- 静态指引字符串作为模块级常量定义在 context-builder.ts 内（不外泄）
- `readMemoryIndex`、`readPersonality`、`buildMemoryRecallPrompt` 作为内部函数一并移入（只有 context-builder 使用，来源：index.ts:673–778）
- `buildChannelRoutingReminder` 单独导出——query-runner 在收到 `compact_boundary` 系统消息后需要重新推送路由提醒

### 3.5 Stream Processor

**不改**。913 行。

注意：stream-processor **没有 Claude SDK import**——它消费的是 index.ts 传入的运行时对象，不在编译时耦合 SDK 类型。这比此前版本描述的"直接消费 SDK 类型"更解耦，意味着未来接新 SDK 时，只需让新事件匹配 stream-processor 期望的对象形状即可。

如果未来接入新 SDK，在新 SDK 侧写转换层（将其事件转为 stream-processor 能消费的形状），而不是在 stream-processor 前面加 normalizer 层。这个决策推迟到有第二个 SDK 时再做——届时有两个具体实现可以对比，设计出的转换层才是准确的。

### 3.6 MCP Server

**职责**：把核心 tool 以 MCP 协议暴露给 SDK agent。

**生命周期**：每次 query 循环前**重建**（`createSdkMcpServer()`），因为上一轮 query 结束后 transport 会断开。这不是"随 harness 启动"的静态组件。

现有的 `mcp-adapter.ts` 的 `coreToolsToSdkTools()` 已经很好地完成了 `ToolDefinition → SDK MCP tool` 的转换（JSON Schema → Zod，~80 行精简代码）。保持不变，只删除 CrossModelPlugin 和 DelegatePlugin 的注册。

**清理后工具列表**：

| Plugin | 工具 |
|--------|------|
| MessagingPlugin | send_message, send_image, send_file |
| TasksPlugin | schedule_task, list_tasks, pause_task, resume_task, cancel_task |
| GroupsPlugin | register_group |
| MemoryPlugin | memory_query, memory_remember |
| FeishuDocsPlugin | feishu_docs_read, feishu_docs_search |

### 3.7 Hooks

#### PreCompact（保留，不变）

**职责**：SDK 上下文压缩前，归档对话 + 触发 memory wrapup。

```typescript
hooks: {
  PreCompact: [{ hooks: [createPreCompactHook(isHome, isAdminHome, groupFolder, userId)] }],
  PreToolUse: isHostMode ? [{ hooks: [createSafetyLiteHook()] }] : [],
}
```

**PreCompact 做两件事**：
1. 归档完整对话到 `conversations/{date}-{title}.md`（解析 transcript JSON → Markdown）
2. 写 `session_wrapup` IPC 信号（触发 Memory Agent 整理本次会话的记忆）

从 index.ts 提取到 `transcript-archive.ts`。

#### Safety Lite（新增，仅 host 模式）

**问题**：v5 方案直接删除所有 safety hooks，理由是"Docker 容器隔离兜底"。但 **host 模式（admin 主容器）没有 Docker 隔离**，且 `permissionMode` 默认是 `bypassPermissions`，`allowedTools` 不校验工具参数内容。

**方案**：保留一个精简版 PreToolUse hook，仅在 host 模式启用，用正则匹配高危模式：

```typescript
// safety-lite.ts (~40 行)

const DANGEROUS_PATTERNS = [
  /rm\s+-rf\s+\/(?!tmp|workspace)/,    // rm -rf /（排除安全路径）
  /DROP\s+(DATABASE|TABLE)\s/i,          // DROP DATABASE/TABLE
  />\s*\/dev\/sd/,                       // 写入裸设备
  /mkfs\./,                              // 格式化文件系统
  /:\(\)\{ :\|:& \};:/,                   // fork bomb（需转义 (){}|）
];

export function createSafetyLiteHook(): HookCallback {
  return async ({ tool_name, tool_input }) => {
    if (tool_name !== 'Bash') return { decision: 'approve' };
    const cmd = typeof tool_input?.command === 'string' ? tool_input.command : '';
    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(cmd)) {
        return { decision: 'deny', reason: `Safety-lite blocked: ${pattern}` };
      }
    }
    return { decision: 'approve' };
  };
}
```

**Container 模式**：不启用此 hook（Docker 隔离足够）。
**Host 模式**：启用。不调用任何外部模型，零延迟，纯正则。

**已知不防**：变量展开（`rm -rf $HOME`）、命令替换（`rm -rf $(echo /)`）、`eval`/`source` 间接执行、别名/函数包装。正则只匹配字面量模式，**不是安全边界**——真正的安全边界是 Docker 容器或 OS 权限。这个 hook 的定位是"最后一道减速带"，不是"防火墙"。

### 3.8 GPT 大清洗

#### 删除清单

**整个删除的文件/目录：**

| 目标 | 行数 |
|------|------|
| `container/agent-runner-openai/` | ~1130 |
| `container/agent-runner-core/src/plugins/cross-model.ts` | ~360 |
| `container/agent-runner-core/src/plugins/delegate.ts` | ~665 |
| `container/agent-runner-core/src/tool-adapters.ts` | ~51 |
| `container/agent-runner/src/safety-hooks.ts` | ~328 |
| `container/agent-runner/src/review-hooks.ts` | ~649 |
| `container/agent-runner/src/gpt-client.ts` | ~219 |
| `container/agent-runner/src/risk-rules.ts` | ~259 |
| `container/agent-runner/src/review-context/` | ~910 |
| `web/src/components/settings/OpenAIProviderSection.tsx` | ~473 |

**需要清理的文件：**

| 文件 | 删什么 |
|------|--------|
| `agent-runner/src/index.ts` | hooks 导入（lines 21-23）、reviewContextConfig（lines 1084-1087）、hook 注册简化为 PreCompact + safety-lite（lines 1110-1121） |
| `agent-runner/src/mcp-adapter.ts` | CrossModelPlugin、DelegatePlugin 的 import 行 + `createContextManager()` 中两个 `.register()` 调用（注意：当前是无条件注册，没有 env var 守卫，直接删两行即可） |
| `agent-runner-core/src/index.ts` | CrossModel、Delegate、toOpenAITools、toCodexTools exports |
| `agent-runner-core/src/tool-adapters.ts` | 整个删除（toOpenAITools/toCodexTools 无消费者） |
| `src/index.ts` | ① 限流自动切换 OpenAI 逻辑（lines ~2567-2599）：删除 `isRateLimit` 检测 + `getOpenAIProviderConfig()` 调用 + `setRegisteredGroup(…, llm_provider: 'openai')` 整块 ② IM Commentary 调用处 `useGpt: feishuConfig?.imCommentaryUseGpt ?? false` 参数（line ~2023）→ 删除该参数 ③ `getOpenAIProviderConfig` import |
| `src/container-runner.ts` | OpenAI runner 选择逻辑（lines ~995-1006）+ 凭据注入（lines ~1055-1100） |
| `src/runtime-config.ts` | ① OpenAI provider config ~577 行（lines 3330-3906） ② `SystemSettings.autoSwitchToOpenAIOnRateLimit` 字段 + getSystemSettings/saveSystemSettings 中对应逻辑 ③ `UserFeishuConfig.imCommentaryUseGpt` 字段 + readUserFeishuConfig/saveUserFeishuConfig 中对应逻辑 |
| `src/routes/config.ts` | 10 个 /api/config/openai* 路由（lines 2678-2979） |
| `src/routes/usage.ts` | ChatGPT usage 端点（lines 258-436） |
| `web/src/components/settings/OpenAIProviderSection.tsx` | 整个删除（已在上表） |
| `web/src/components/chat/ContainerEnvPanel.tsx` | OpenAI model presets / provider toggle |
| `web/src/components/settings/FeishuChannelCard.tsx` | `imCommentaryUseGpt` toggle UI（lines ~436-466）+ `hasGptProvider` 字段 + 接口定义中两个 GPT 相关字段 |
| `src/im-commentary.ts` | `useGpt` 参数（sendToolCommentary + generateExplanation 签名）、tryGpt() 函数、getOpenAIProviderConfig import、GPT 常量 |
| `src/schemas.ts` | `imCommentaryUseGpt: z.boolean().optional()` Zod 校验字段（line ~393） |
| `src/routes/memory-agent.ts` | `GET /api/internal/memory/openai-credentials` 端点 + `getOpenAIProviderConfig` import（**删除 runtime-config 的 OpenAI 函数后此处编译报错**） |
| `web/src/pages/SettingsPage.tsx` | `import OpenAIProviderSection` + `'openai'` tab 路由 + VALID_TABS/SYSTEM_TABS 中的 `'openai'` 条目（**删除 OpenAIProviderSection.tsx 后此处编译报错**） |
| `web/src/stores/usage.ts` | `OpenAIRateWindow`/`OpenAICredits`/`OpenAIAccountData`/`OpenAIAccountResponse` 类型 + `openaiAccount*` 状态 + `loadOpenAIAccount()` 方法 + `/api/usage/openai-subscription` 调用（**删除 usage.ts 端点后前端 404**） |
| `web/src/components/settings/SettingsNav.tsx` | `{ key: 'openai', label: 'OpenAI 提供商' }` 导航项（**删了页面不删导航入口 → 空白页**） |
| `web/src/components/settings/SystemSettingsSection.tsx` | `autoSwitchToOpenAIOnRateLimit` 相关 state、控件、文案 |
| `web/src/components/settings/types.ts` | `autoSwitchToOpenAIOnRateLimit: boolean` 字段定义 |

#### IM Commentary 改造

`src/im-commentary.ts` 当前调用优先级：GPT → Claude Haiku → 启发式。

改为：Claude Haiku → 启发式。

变更范围（详见上方清理表）：
- `src/im-commentary.ts`：删 `useGpt` 参数、`tryGpt()`、GPT import/常量；`generateExplanation()` 签名简化为 `(toolName, inputSummary?)`
- `src/index.ts`：IM Commentary 调用处删 `useGpt` 参数
- `src/runtime-config.ts`：删 `UserFeishuConfig.imCommentaryUseGpt` 字段 + 读写逻辑
- `web/…/FeishuChannelCard.tsx`：删"使用 GPT 生成解说"toggle + `hasGptProvider` 字段

清理后的 `generateExplanation`：

```typescript
async function generateExplanation(toolName: string, inputSummary?: string): Promise<string | null> {
  const input = inputSummary
    ? `工具: ${toolName}\n输入: ${inputSummary.slice(0, 300)}`
    : `工具: ${toolName}`;

  // 1. Try Haiku (Anthropic API key)
  const haikuResult = await tryHaiku(PROMPT_TEMPLATE(input));
  if (haikuResult) return haikuResult;

  // 2. Heuristic fallback
  return formatFallback(toolName, inputSummary);
}
```

#### 安全降级评估

| 删除的能力 | 影响 | 缓解 |
|-----------|------|------|
| GPT gatekeeper（PreToolUse） | 高风险操作不再有 GPT 二次判断 | **Host 模式**：safety-lite 正则匹配高危模式。**Container 模式**：Docker 隔离兜底 |
| Loop recovery coaching | agent 循环时不再有 GPT 建议 | Claude 自身的 thinking 能力通常足够跳出循环 |
| Code review（PostToolUse + Stop） | 变更不再有自动审查 | 接受降级；未来可独立 PR 插入新的审查机制 |
| OpenAI fallback | Claude 限流时无退路 | 接受风险；未来独立 PR 加新 SDK |

---

## 4. 目录结构变更

### 新增 / 重构

```
container/agent-runner/src/              ← 目录名不变（重命名可选，独立 PR）
  index.ts                               ← 瘦身为入口 + protocol bridge (~200 行)
                                           来源：main() + 查询循环编排 + 信号处理
  session-state.ts                       ← 新增：5 个模块级变量 → 显式状态对象 (~80 行)
  claude-session.ts                      ← 新增：SDK 查询生命周期封装 (~120 行)
                                           来源：MessageStream + query() + hooks 组装（MCP 配置由调用者传入）
  query-runner.ts                        ← 查询执行（3 个函数）(~460 行)
                                           runQuery()：编排 (~80 行)
                                           processMessages()：消息循环 + activity watchdog (~300 行)
                                           createIpcPoller()：IPC 轮询闭包 (~80 行)
  context-builder.ts                     ← buildSystemPromptAppend + buildChannelRoutingReminder
                                           来源：系统 prompt 8 个段落拼接 + memory recall（去除空的 heartbeatContent）
  ipc-handler.ts                         ← 哨兵检测 + drainIpc + waitForIpcMessage
                                           来源：IPC 相关工具函数（上层封装，调用 core/ipc）
  transcript-archive.ts                  ← PreCompact hook + 对话解析/格式化
                                           来源：createPreCompactHook + parseTranscript
  image-utils.ts                         ← MIME/尺寸/过滤
                                           来源：图片处理工具函数
  safety-lite.ts                         ← 新增：host 模式精简安全 hook (~40 行)

  stream-processor.ts                    ← 不动（913 行）
  mcp-adapter.ts                         ← 清理：删除 CrossModel/Delegate 注册
  agent-definitions.ts                   ← 不动（27 行）
  types.ts                               ← 不动
  utils.ts                               ← 不动
  image-detector.ts                      ← 不动
```

注意：**不创建 `adapter/` 子目录**。`claude-session.ts` 平放在 src/ 下，因为它是唯一的 SDK 交互模块，不需要子目录组织。

**ipc-handler.ts 与 core/ipc.ts 的关系**：

现状：core/ipc.ts 导出了 `shouldClose`、`shouldDrain`、`shouldInterrupt`、`drainIpcInput`、`waitForIpcMessage` 等完整业务函数，但 index.ts 从未 import 它们——index.ts 在本地重新实现了同名函数（lines 518–668），增加了 agent-runner 特有的增强逻辑：中断宽限期追踪、`set_mode` 权限切换、心跳日志、`_drain` 自动 exit。两套实现并存但互不调用。

本次处理：**ipc-handler.ts 提取自 index.ts 的本地实现**（增强版），不使用 core 的版本。core/ipc.ts 的同名导出标记为 `@deprecated`（agent-runner-openai 删除后已无消费者，Phase 3 清理）。命名用 `ipc-handler` 而非 `ipc-manager` 以避免混淆。

**query-runner.ts 内部结构**：v6 把 runQuery（~620 行）整体搬到新文件，v7 进一步拆为 3 个函数——`runQuery`（编排）、`processMessages`（消息循环）、`createIpcPoller`（轮询闭包），每个函数有清晰的输入/输出边界，可独立理解和测试。

### 删除

```
container/agent-runner-openai/           ← 整个删除（~1130 行）
container/agent-runner/src/
  safety-hooks.ts                        ← 删除（328 行，被 safety-lite.ts 替代）
  review-hooks.ts                        ← 删除（649 行）
  gpt-client.ts                          ← 删除（219 行）
  risk-rules.ts                          ← 删除（259 行）
  review-context/                        ← 整个删除（~910 行）

container/agent-runner-core/src/
  tool-adapters.ts                       ← 删除（51 行，无消费者）
  plugins/cross-model.ts                 ← 删除（~360 行）
  plugins/delegate.ts                    ← 删除（~665 行）
```

---

## 5. 会话管理

### Session 生命周期

```
harness 启动
  │
  ├── 从 ContainerInput.sessionId 获取上次的会话 ID
  │
  ├── ClaudeSession.run({ sessionId, resumeAt })
  │   → 内部调用 query({ options: { resume: sessionId } })
  │   → SDK 自行管理 .claude/ 下的会话文件
  │
  ├── Claude SDK compact 后可能产生新 session ID
  │   harness 从 result message 中捕获，写回 ContainerOutput.newSessionId
  │
  └── 宿主机侧更新 DB（已有逻辑，不变）
```

### 会话持久化

不变：`data/sessions/{folder}/.claude/`

### Resume 点追踪

**保持为 main() 局部变量**（见 §3.2 不放在 SessionState 的理由——事务性），从 `runQuery()` 返回值中更新：
- `lastAssistantUuid`：最近一个有 text 内容的 assistant 消息
- `lastResumeUuid`：最近的 assistant(text) 或 user(tool_result) 消息

当 agent 的最后动作是 tool_use 而不是 text 时，如果只用 lastAssistantUuid 恢复会产生并行分支。lastResumeUuid 确保从最新节点恢复。main() 在 runQuery 成功返回后才采纳新值——中途失败时保留上一轮的安全点。

---

## 6. 宿主机侧变更

### container-runner.ts

```diff
- const llmProvider = group.llm_provider || 'claude';
- const isOpenAI = llmProvider === 'openai';
- const runnerSubdir = isOpenAI ? 'agent-runner-openai' : 'agent-runner';
+ // OpenAI runner 已移除，原 openai 群组自动回退到 Claude
+ if (group.llm_provider === 'openai') {
+   logger.warn({ group: group.name }, 'llm_provider=openai but OpenAI runner removed; falling back to Claude');
+ }
+ const runnerSubdir = 'agent-runner';
```

删除：
- `llmProvider` / `isOpenAI` 分支逻辑
- OpenAI 凭据注入（OPENAI_*、CROSSMODEL_* 环境变量）
- OpenAI runner 的依赖检查

新增环境变量：
- `HAPPYCLAW_HOST_MODE=1`（当执行模式为 host 时设置，用于 safety-lite 判断是否启用）

**旧 OpenAI 群组运行时处理**：`llm_provider === 'openai'` 的群组不阻塞启动，正常走 Claude runner 并打 warn 日志。不做自动 DB migration——保留旧值，让用户在前端看到提示后手动确认。

其余逻辑（进程 spawn、超时管理、IPC 目录创建、Claude 环境变量注入）不变。harness 从 stdin 读 ContainerInput、往 stdout 写 ContainerOutput，协议层完全兼容。

### index.ts（后端主入口）

删除：
- 限流自动切换 OpenAI 逻辑（lines ~2567-2599）：`isRateLimit` 检测 → `getOpenAIProviderConfig()` → `setRegisteredGroup(…, llm_provider: 'openai')` 整块
- IM Commentary 调用处 `useGpt: feishuConfig?.imCommentaryUseGpt ?? false` 参数（line ~2023）
- `getOpenAIProviderConfig` import

### runtime-config.ts

删除 ~577 行 OpenAI provider 代码：
- `getOpenAIProviderConfig()` / `saveOpenAIProviderConfig()`
- OAuth 流程（Device Code + PKCE）
- Token 刷新
- 加密存储

额外清理：
- `SystemSettings.autoSwitchToOpenAIOnRateLimit` 字段 + getSystemSettings/saveSystemSettings/buildEnvFallbackSettings 中对应逻辑
- `UserFeishuConfig.imCommentaryUseGpt` 字段 + readUserFeishuConfig/saveUserFeishuConfig 中对应逻辑（lines ~2340, 2402, 2422, 2437）

Claude provider config 不变。

### routes/config.ts

删除 10 个 `/api/config/openai*` 路由（~300 行）。

### routes/usage.ts

删除 ChatGPT usage 端点（~180 行）。

### routes/memory-agent.ts

删除：
- `GET /api/internal/memory/openai-credentials` 端点（返回 OpenAI 凭据给 Memory Agent）
- `getOpenAIProviderConfig` import

注意：Memory Agent 当前可能依赖此端点获取 OpenAI 凭据。删除后需确认 Memory Agent 不会调用该路径（当前 Memory Agent 使用 Claude，不依赖 OpenAI）。

### 前端

- 删除 `OpenAIProviderSection.tsx`（~473 行）
- 清理 `SettingsPage.tsx`：删除 `import OpenAIProviderSection` + `'openai'` tab 路由 + VALID_TABS/SYSTEM_TABS 中的 `'openai'` 条目
- 清理 `SettingsNav.tsx`：删除 `{ key: 'openai', label: 'OpenAI 提供商' }` 导航项
- 清理 `SystemSettingsSection.tsx`：删除 `autoSwitchToOpenAIOnRateLimit` 相关 state、控件、文案
- 清理 `settings/types.ts`：删除 `autoSwitchToOpenAIOnRateLimit: boolean` 字段
- 清理 `stores/usage.ts`：删除 `OpenAIRateWindow`/`OpenAICredits`/`OpenAIAccountData`/`OpenAIAccountResponse` 类型 + `openaiAccount*` 状态 + `loadOpenAIAccount()` + `/api/usage/openai-subscription` 调用
- 清理 `ContainerEnvPanel.tsx`：删除 OpenAI provider toggle（`['claude', 'openai']` 按钮组）、OpenAI model presets、Reasoning Effort/Summary 控件、`OPENAI_MODEL_ENV_KEY` 等常量。**新增**：当 `group.llm_provider === 'openai'` 时，在面板顶部显示一条迁移提示横幅（黄色 warning 风格），告知用户"OpenAI 提供商已移除，此工作区已自动切换为 Claude"，并附带一个"确认切换"按钮调用 `PATCH /api/groups/:jid { llm_provider: 'claude' }` 写回 DB、消除提示
- 清理 `FeishuChannelCard.tsx`：删除"使用 GPT 生成解说"toggle UI（lines ~436-466）、`imCommentaryUseGpt` + `hasGptProvider` 字段（接口定义 + 运行时引用）

**旧数据兼容——`llm_provider: 'openai'` 群组迁移策略**：

`src/types.ts`、`src/db.ts`、`web/src/types.ts`、`src/routes/groups.ts` 中暂保留 `llm_provider?: 'claude' | 'openai'` 类型定义，避免运行时异常。

运行时行为：
- **后端**：`container-runner.ts` 忽略 `'openai'` 值，统一走 Claude runner，打 warn 日志（见上方 diff）
- **前端**：`ContainerEnvPanel.tsx` 检测到 `llm_provider === 'openai'` 时显示黄色迁移提示横幅，用户点击"确认切换"后 PATCH 写回 `'claude'`，消除提示
- **不做自动 migration**：保留旧值让用户感知到变化并手动确认，避免静默切换引发困惑

后续（Phase 3 或独立 PR）可在所有 `'openai'` 记录清零后，通过 DB migration 移除该字段。

### entrypoint.sh

无需修改（目录名不变）。如果未来做可选重命名 PR，需同步更新 entrypoint.sh 中的编译输出路径。

---

## 7. 实施计划

**原则**：每个 Phase 独立可交付、独立可验证。Phase 1 纯删除；Phase 2 拆为 2a（状态治理 + 低风险提取）和 2b（ClaudeSession + runQuery 拆解 + 入口瘦身），2a 是 2b 的前置——先把依赖项提取稳定，再做需要跨模块协调的 runQuery 拆分。

### Phase 1: GPT 大清洗 + Core 瘦身（纯删除，~6000 行）

**目标**：删除所有 OpenAI/GPT 代码，项目编译通过。

**Container 侧：**

1. 删除 `container/agent-runner-openai/` 整个目录（~1130 行）
2. 删除 agent-runner/src/ 中：safety-hooks.ts、review-hooks.ts、gpt-client.ts、risk-rules.ts、review-context/（~2365 行）
3. 删除 agent-runner-core/src/plugins/ 中：cross-model.ts、delegate.ts（~1025 行）
4. 删除 agent-runner-core/src/tool-adapters.ts（51 行）
5. 清理 agent-runner/src/mcp-adapter.ts：删除 CrossModelPlugin、DelegatePlugin 的 import + `createContextManager()` 中两个 `.register()` 调用
6. 清理 agent-runner/src/index.ts：
   - 删除 imports（review-hooks, review-context, safety-hooks）
   - 删除 reviewContextConfig
   - 简化 hooks 注册 → 只保留 PreCompact
7. 清理 agent-runner-core/src/index.ts：删除 CrossModel、Delegate、toOpenAITools、toCodexTools exports + 相关类型

**宿主机侧：**

8. 清理 src/index.ts：
   - 删除限流自动切换 OpenAI 逻辑（lines ~2567-2599）
   - 删除 IM Commentary 调用处 `useGpt` 参数（line ~2023）
   - 删除 `getOpenAIProviderConfig` import
9. 清理 src/container-runner.ts：删除 OpenAI runner 选择逻辑 + 凭据注入
10. 清理 src/runtime-config.ts：
    - 删除 OpenAI provider config（~577 行：getOpenAIProviderConfig/saveOpenAIProviderConfig、OAuth 流程、Token 刷新、加密存储）
    - 删除 `SystemSettings.autoSwitchToOpenAIOnRateLimit` 字段 + get/save 中对应逻辑
    - 删除 `UserFeishuConfig.imCommentaryUseGpt` 字段 + read/save 中对应逻辑
11. 清理 src/routes/config.ts：删除 /api/config/openai* 路由（~300 行）
12. 清理 src/routes/usage.ts：删除 ChatGPT usage 端点（~180 行）
13. 清理 src/im-commentary.ts：删除 `useGpt` 参数（sendToolCommentary + generateExplanation 签名）、tryGpt()、getOpenAIProviderConfig import、GPT 常量
14. 清理 src/schemas.ts：删除 `imCommentaryUseGpt: z.boolean().optional()` Zod 校验字段

15. 清理 src/routes/memory-agent.ts：删除 `GET /api/internal/memory/openai-credentials` 端点 + `getOpenAIProviderConfig` import

**前端：**

16. 删除 web/src/components/settings/OpenAIProviderSection.tsx（~473 行）
17. 清理 web/src/pages/SettingsPage.tsx：删除 `import OpenAIProviderSection` + `'openai'` tab 路由 + VALID_TABS/SYSTEM_TABS 中 `'openai'` 条目
18. 清理 web/src/components/settings/SettingsNav.tsx：删除 `'openai'` 导航项
19. 清理 web/src/components/settings/SystemSettingsSection.tsx：删除 `autoSwitchToOpenAIOnRateLimit` 相关 state/控件/文案
20. 清理 web/src/components/settings/types.ts：删除 `autoSwitchToOpenAIOnRateLimit` 字段
21. 清理 web/src/stores/usage.ts：删除 OpenAI 相关类型、状态、方法、API 调用
22. 清理 web/src/components/chat/ContainerEnvPanel.tsx：删除 OpenAI presets / provider toggle
23. 清理 web/src/components/settings/FeishuChannelCard.tsx：删除 `imCommentaryUseGpt` toggle UI + `hasGptProvider` 字段 + 接口中 GPT 相关字段

**构建产物**：Dockerfile 只 COPY agent-runner/，不涉及 agent-runner-openai，删目录后 `container/build.sh` 无需修改。

**验证**：`make typecheck && make build` 通过

### Phase 2a: 状态治理 + 低风险模块提取

**目标**：收敛共享状态为 SessionState，提取与 runQuery 无依赖关系的独立模块。

**原则**：大部分模块从 index.ts 中剪切-粘贴即可，每个独立可 typecheck。**注意**：步骤 1 创建 SessionState 后，步骤 4-6 提取的函数需要将闭包访问的模块级变量改为接收 `SessionState` 参数——这**是**函数签名变更，不是纯粹的物理搬移。建议步骤 1 完成后立即在 index.ts 原地将相关函数改为接收 SessionState（编译通过），再搬移到新文件。

1. 创建 `session-state.ts`：将 5 个模块级变量 + 相关操作函数收敛为 SessionState 类（见 §3.2）
2. 创建 `safety-lite.ts`：精简版 PreToolUse hook（仅 host 模式）
3. 提取 `image-utils.ts`：resolveImageMimeType、getImageDimensions、filterOversizedImages
4. 提取 `ipc-handler.ts`：shouldClose、shouldDrain、shouldInterrupt、drainIpcInput、waitForIpcMessage（从 index.ts 本地实现提取，不使用 core 版本——见 §4 说明）
5. 提取 `transcript-archive.ts`：createPreCompactHook、parseTranscript、formatTranscriptMarkdown
6. 提取 `context-builder.ts`：buildSystemPromptAppend + buildChannelRoutingReminder（见 §3.4 函数签名）；`readMemoryIndex`、`readPersonality`、`buildMemoryRecallPrompt` 作为内部函数一并移入

**验证**：`make typecheck && make build` 通过。index.ts 变小但 main() 和 runQuery() 仍在原位。

### Phase 2b: 拆解 runQuery + 瘦身入口

**目标**：提取 ClaudeSession + query-runner → 瘦身 index.ts 为纯入口。

**依赖 Phase 2a**：query-runner 会 import SessionState、ipc-handler、context-builder、transcript-archive（均已在 2a 提取）。

**步骤 1：提取 ClaudeSession**

7. 创建 `claude-session.ts`：封装 MessageStream + query() + hooks 组装（见 §3.3）
   - `loadUserMcpServers()` 保留在 index.ts（protocol-bridge），由 main() 组装完整 mcpServers 后传入 ClaudeSession.run()

**步骤 2：拆解 runQuery**

> v6 的问题：runQuery（~620 行）整体搬到新文件只是物理移动，认知复杂度不降。
> v8 改进：拆为 3 个函数，每个有清晰的输入输出边界。

8. 提取 `query-runner.ts`，内部拆为：

```typescript
// query-runner.ts

/**
 * 编排一次完整查询。
 * 接收外部创建的 ClaudeSession 实例（由 protocol-bridge 传入），
 * 负责：调用 context-builder → 配置 session → 启动轮询 → 遍历消息 → 错误恢复 → 返回结果。
 */
export async function runQuery(
  config: QueryRunnerConfig,  // 业务参数（prompt, images, containerInput, memoryRecall, ...）
  state: SessionState,
  session: ClaudeSession,
  mcpServerConfig: ...,
): Promise<QueryResult>;
// QueryResult = { newSessionId?, lastAssistantUuid?, lastResumeUuid?,
//                 closedDuringQuery, contextOverflow?, unrecoverableTranscriptError?,
//                 interruptedDuringQuery, sessionResumeFailed?, drainDetectedDuringQuery? }

/**
 * 消息循环：遍历 SDK 事件流，分发给 processor，追踪 UUID，处理系统消息。
 * 内含 activity watchdog（5 min 无事件 → 强制中断；20 min 工具超时 → 强制中断）。
 */
async function processMessages(
  messageStream: AsyncIterable<SDKMessage>,
  processor: StreamEventProcessor,
  state: SessionState,
  session: ClaudeSession,
  emitOutput: boolean,
): Promise<MessageLoopResult>;
// MessageLoopResult = { newSessionId?, lastAssistantUuid?, lastResumeUuid?,
//                       contextOverflow?, unrecoverableTranscriptError? }

/** IPC 轮询回调：每 500ms 检查哨兵 + 排空输入 + 推送到 session */
function createIpcPoller(
  state: SessionState,
  session: ClaudeSession,
  processor: StreamEventProcessor,
): { start(): void; stop(): void };
```

- `runQuery`：顶层编排（~80 行）——接收外部传入的 ClaudeSession、调用 context-builder、启动 poller、调用 processMessages、错误恢复、返回结果
- `processMessages`：for-await 循环体 + activity watchdog（~300 行）——消息类型分发、UUID 追踪、compact_boundary 路由提醒注入、后台任务协调、**activity watchdog 逻辑**（QUERY_ACTIVITY_TIMEOUT_MS 5 min 无事件超时 + TOOL_CALL_HARD_TIMEOUT_MS 20 min 工具硬超时，当前 index.ts:838–883）
- `createIpcPoller`：轮询闭包（~80 行）——哨兵检测、权限模式切换、消息推送

**步骤 3：瘦身入口**

9. 瘦身 index.ts：只保留 main() + 查询循环编排 + 信号处理（~200 行）
   - `main()` 创建 SessionState 实例 + ClaudeSession 实例，显式传给所有函数
   - sessionId / lastAssistantUuid / lastResumeUuid 保持为 main() 的局部变量，从 runQuery 返回值中更新
   - 删除所有模块级 `let` 变量（编译器报错驱动，确保无遗漏）

**验证**：
- `make typecheck && make build` 通过
- 端到端测试场景：
  1. Web 发消息 → 正常流式回复
  2. IM（飞书/Telegram）转发 → send_message 送达
  3. 长对话触发 compact → 归档到 conversations/ + session_wrapup IPC
  4. 发送 `_interrupt` 哨兵 → 优雅中断
  5. Session resume → 从上次 UUID 恢复，无 fan-out 分支
  6. Host 模式 → safety-lite 拦截 `rm -rf /`
  7. 5 分钟无活动 → activity watchdog 强制中断（回归验证）

### Phase 3: 清理（独立 PR，可并行）

- FeishuDocs plugin → CLI skill（可选）
- 更新 CLAUDE.md、CLAUDE-full.md
- agent-runner-core 清理：
  - 标记 core/ipc.ts 中与 ipc-handler.ts 重叠的导出为 `@deprecated`（Phase 1 删 agent-runner-openai 后已无消费者——尽早标记避免 Phase 1-2 期间误用）
  - 标记 `prompt-builder.ts` 的 `buildBaseSystemPrompt()` 和 `context.ts` 的 `ContextManager.buildSystemPrompt()` 为 `@deprecated`（Claude runner 不调用，GPT runner 已删）
  - 清理过时注释：`context.ts` 中"Both Claude and OpenAI runners"、`types.ts` 中"Provider-agnostic — used by Claude, OpenAI, and future runners"
- 可选：重命名 agent-runner → agent-harness（独立 PR，需同步更新 Dockerfile、entrypoint.sh、build.sh、package.json、container-runner.ts spawn 路径）

---

## 8. 风险

| 风险 | 影响 | 缓解 |
|------|------|------|
| SessionState 遗漏隐式依赖 | 某些闭包读取模块级变量时没改为读 state | 删除模块级 `let` 后 TypeScript 编译器报错驱动 |
| 模块拆分遗漏边界情况 | 函数搬移后 import 遗漏 | SessionState 显式化后依赖可见；每步 typecheck |
| 删除 safety hooks 后 host 模式安全性 | 高风险 Bash 命令无二次确认 | safety-lite 正则匹配兜底（仅 host 模式），零延迟无外部依赖 |
| safety-lite 正则覆盖不全 | 未匹配的危险命令仍会执行 | 接受——正则是尽力而为，不是安全边界。真正的安全边界是 Docker 容器或 OS 权限 |
| 删除 OpenAI fallback | Claude 限流时无退路 | 接受风险；未来独立 PR 加新 SDK |
| 删除 code review | 变更不再有自动审查 | 接受降级；未来独立 PR 插入审查机制 |
| 可选重命名影响面大 | Dockerfile、entrypoint.sh、build.sh、package.json、container-runner.ts 均需更新 | 推迟到 Phase 3 独立 PR，diff 大但无逻辑变更 |
| ipc-handler 与 core/ipc 双重实现 | 维护两套同名函数容易混淆 | Phase 2a 明确提取 index.ts 本地版本；Phase 3 标记 core 版本 deprecated |
| activity watchdog 遗漏 | 搬移 runQuery 时遗忘看门狗逻辑 → 容器卡死 | 明确归属 processMessages()，端到端验证项 #7 覆盖 |
| GPT 引用残留导致编译失败 | 删除清单遗漏文件 → `make typecheck` 报错 | v9 已补全；Phase 1 完成后全局搜索 `openai`/`gpt`（不区分大小写）做最终确认 |

---

## 附录 A: Codex SDK 能力参考（Future Reference）

> 以下信息基于 Codex SDK v0.116.0 的实际调研，留作未来参考。不以此设计接口——等真有需求时从具体实现出发。

| 能力 | API | 备注 |
|------|-----|------|
| 创建会话 | `codex.startThread(opts)` | workingDirectory, model, sandboxMode, approvalPolicy |
| 恢复会话 | `codex.resumeThread(id)` | 从 ~/.codex/sessions/ 恢复 |
| 阻塞执行 | `thread.run(prompt)` | 返回 `{ items, finalResponse, usage }` |
| 流式执行 | `thread.runStreamed(prompt)` | 返回 `{ events: AsyncGenerator<ThreadEvent> }` |
| 事件类型 | `ThreadEvent.type` | thread.started, turn.started/completed/failed, item.started/updated/completed, error |
| 结果项类型 | `ThreadItem.type` | agent_message, command_execution, file_change, mcp_tool_call, web_search, todo_list |
| 沙箱模式 | `sandboxMode` | read-only, workspace-write, danger-full-access |
| 审批策略 | `approvalPolicy` | never, on-request, on-failure, untrusted |
| 认证 | `apiKey` 或 `codex login` OAuth | API Key 直传；OAuth 存 ~/.codex/ |
| MCP 支持 | config.toml `[mcp_servers]` | stdio 和 streamable-http transport |
| 图片输入 | `local_image` item | 支持本地文件路径 |
| 结构化输出 | `outputSchema` | JSON Schema 约束输出 |

## 附录 B: Codex SDK 事件映射（Future Reference）

> 未来接入 Codex SDK 时的事件映射参考。

| Codex ThreadEvent | → stream-processor 需要的形状 | → StreamEvent |
|-------------------|-------------------------------|---------------|
| `item.updated` (agent_message, text content) | 合成 text content block delta | `text_delta` |
| `item.started` (command_execution / file_change) | 合成 tool_use content block start | `tool_use_start` |
| `item.completed` (command_execution / file_change) | 合成 tool_use_summary message | `tool_use_end` |
| `turn.completed` (含 usage) | 合成 result message | `usage` |

**注意**：Codex SDK 的事件粒度是 item 级别（非逐 token），前端打字机效果会比 Claude 侧粗糙。

## 附录 C: SDK 能力对比（Future Reference）

| 能力 | Claude Agent SDK | Codex SDK (@openai/codex-sdk) |
|------|-----------------|-------------------------------|
| **底层实现** | spawn Claude CLI 子进程 | spawn Codex CLI (Rust) 子进程 |
| **Tool calling 循环** | SDK 内置 | Codex CLI 内置 |
| **内置开发工具** | Read/Write/Edit/Glob/Grep/Bash | Shell execution + File patch + Web search |
| **沙箱安全** | `permissionMode` + `allowedTools` | OS 级沙箱（Seatbelt/Landlock）+ `sandboxMode` |
| **MCP 支持** | `createSdkMcpServer` (in-process) | config.toml MCP 配置 |
| **流式输出** | `includePartialMessages: true`（逐 token） | `runStreamed()`（item 级别） |
| **多轮对话** | `MessageStream.push()` (push 模型) | 同一 thread 多次 `.run()` (turn 模型) |
| **会话 resume** | `resume: sessionId` (本地 SQLite) | `resumeThread(threadId)` (本地 sessions/) |
| **Hook 系统** | PreToolUse/PostToolUse/PreCompact/Stop（完整） | 无 |
| **上下文压缩** | SDK auto-compact + PreCompact hook | Codex CLI 内部管理 |
| **Sub-agent** | `agents` 选项 (predefined agents) | Codex 内置 subagents |
| **System prompt** | `systemPrompt.append` / preset | `.codex/instructions.md` 文件 |
| **图片输入** | 支持 base64 | 支持 local_image |
| **结构化输出** | 无直接支持 | `outputSchema` JSON Schema |
