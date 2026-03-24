# HappyClaw Agent Harness 设计稿

> 状态：草案 v2（SDK 方案）
> 日期：2026-03-24

## 1. 目标

六件事：

1. **Tool 梳理**：飞书文档等平台 tool → 可插拔 skill；ask_model/delegate_task → 合并为可指定 agent 的通用 skill；核心 tool → MCP server
2. **Agent Harness**：agent-runner + agent-runner-openai 统一为 agent-harness，底层通过 SDK Adapter 调用 Claude Agent SDK / OpenAI Agents SDK
3. **凭据管理**：OAuth 校验/刷新/存储从各模块抽出，统一为独立的 Credential Manager
4. **Context Engine**：上下文注入、compact 策略、token 消耗优化——从 agent runner 独立出来，解决现有 token 消耗过大问题
5. **Hook 管理**：统一为 SDK 原生 hook 回调，执行记录 → StreamEvent（可视化）
6. **Memory Agent**：底层改为依赖 agent harness，底层 SDK 可配置

### 不变的

- ContainerInput/Output 协议（宿主机 ↔ harness 的 stdin/stdout 约定）
- IPC 文件通信机制（input/、messages/、tasks/、哨兵文件）
- StreamEvent 类型体系（shared/stream-event.ts）
- 宿主机侧的 GroupQueue、TurnManager、WebSocket 广播——全部不动
- Memory Agent 的 JSONL 通信协议（宿主机 ↔ memory-agent 的 stdin/stdout）
- data/memory/{userId}/ 目录结构

### 要变的

- agent-runner（Claude SDK 直调）、agent-runner-openai（OpenAI API 直调）→ agent-harness（统一入口，SDK Adapter 抽象）
- memory-agent（Claude SDK 直调）→ agent-harness `--mode memory` 复用
- FeishuDocsPlugin、CrossModelPlugin、DelegatePlugin → skill
- HappyClaw tools（messaging/tasks/memory/groups）→ MCP server
- Hooks → SDK 原生回调（Claude: HookCallback / OpenAI: guardrails + needsApproval）
- OAuth/API Key 管理 → Credential Manager（独立模块）
- 上下文管理 → Context Engine（独立模块）

---

## 2. 架构总览

```
宿主机进程（不变）
  │
  │  stdin: ContainerInput JSON
  │  stdout: OUTPUT_MARKER 包裹的 ContainerOutput
  ▼
┌──────────────────────────────────────────────────────┐
│                   agent-harness                       │
│                                                       │
│  ┌─────────────┐  ┌─────────────┐  ┌──────────────┐ │
│  │  Protocol    │  │  Context    │  │  Stream      │ │
│  │  Bridge      │  │  Builder    │  │  Converter   │ │
│  │              │  │             │  │              │ │
│  │ stdin→SDK    │  │ 动态生成    │  │ SDK events → │ │
│  │ SDK→stdout   │  │ system      │  │ StreamEvent  │ │
│  │ IPC 多轮     │  │ prompt      │  │              │ │
│  └─────────────┘  └─────────────┘  └──────────────┘ │
│                                                       │
│  ┌─────────────────────────────────────────────────┐ │
│  │              SDK Adapter                         │ │
│  │                                                   │ │
│  │  ┌──────────────┐  ┌───────────────────────┐    │ │
│  │  │ claude        │  │ openai                 │    │ │
│  │  │               │  │                        │    │ │
│  │  │ query({       │  │ run(agent, input, {    │    │ │
│  │  │   prompt,     │  │   stream: true,        │    │ │
│  │  │   options     │  │   context,             │    │ │
│  │  │ })            │  │ })                     │    │ │
│  │  │               │  │                        │    │ │
│  │  │ Claude Agent  │  │ OpenAI Agents          │    │ │
│  │  │ SDK           │  │ SDK                    │    │ │
│  │  └──────────────┘  └───────────────────────┘    │ │
│  └─────────────────────────────────────────────────┘ │
│                                                       │
│  ┌─────────────────────────────────────────────────┐ │
│  │          MCP Server（内置，随 harness 启动）      │ │
│  │                                                   │ │
│  │  send_message  │ memory_query   │ schedule_task  │ │
│  │  send_image    │ memory_remember│ list_tasks     │ │
│  │  send_file     │                │ pause/resume/  │ │
│  │                │                │ cancel_task    │ │
│  │                │                │ register_group │ │
│  └─────────────────────────────────────────────────┘ │
│                                                       │
│  ┌─────────────────────────────────────────────────┐ │
│  │          Hook Manager                            │ │
│  │                                                   │
│  │  - Claude: SDK HookCallback 回调（in-process）   │ │
│  │  - OpenAI: guardrails + needsApproval           │ │
│  │  - 统一写 StreamEvent 到 IPC（可视化）           │ │
│  └─────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────┘
         │                              │
         │ SDK in-process               │ SDK hooks (callbacks)
         ▼                              ▼
┌─────────────────┐           ┌──────────────────┐
│  SDK Runtime     │           │  Hook Callbacks   │
│  (claude-agent-  │           │  (safety gate,    │
│   sdk / @openai/ │◄─────────│   loop detect,    │
│   agents)        │  callback │   code review)    │
│                  │           └──────────────────┘
│  Skills:         │
│  - cross-model   │
│  - feishu-docs   │
│  - agent-browser │
│  - ...           │
└─────────────────┘
```

---

## 3. 核心模块设计

### 3.1 Protocol Bridge

**职责**：宿主机 ContainerInput/Output 协议 ↔ SDK Adapter 的输入/输出。

```
宿主机 stdin → harness 解析 ContainerInput
  → 首条消息: 调用 SDK（prompt + context）
  → 后续消息: IPC 轮询 → 通过 MessageStream 追加给 SDK

SDK 输出事件 → harness 转换 → OUTPUT_MARKER 包裹写回 stdout
SDK 完成 → harness 写 ContainerOutput{ status: 'success'|'error' }
```

**IPC 多轮流程**：

```
1. harness 读取 ContainerInput，调用 SDK Adapter
2. SDK 执行首轮，harness 捕获流式事件，逐条写 ContainerOutput
3. harness 开始轮询 IPC input/
4. 收到新消息 → 通过 MessageStream.push() 喂给 SDK（无需重启进程）
5. 收到 _close → 终止 SDK 执行（AbortController）
6. 收到 _drain → 等 SDK 当前轮完成后终止
7. 收到 _interrupt → 发送 abort signal 给 SDK
```

**Claude Agent SDK 适配**：
```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';

const stream = new MessageStream(); // push-based AsyncIterable
stream.push({ role: 'user', content: prompt });

const q = query({
  prompt: stream,
  options: {
    model,
    cwd: workspaceDir,
    resume: sessionId,
    systemPrompt: { type: 'preset', preset: 'claude_code', append: systemPromptAppend },
    permissionMode: 'bypassPermissions',
    allowedTools: [...],
    mcpServers: { happyclaw: sdkMcpServer },
    hooks: hooksConfig,
    includePartialMessages: true,
  }
});

for await (const message of q) {
  // 直接处理 SDK 事件
}
```

**OpenAI Agents SDK 适配**：
```typescript
import { Agent, run, tool, MCPServerStdio } from '@openai/agents';

const agent = new Agent({
  name: 'happyclaw',
  model: modelName,
  instructions: systemPrompt,
  tools: [...harnessTools],
  mcpServers: [mcpServer],
});

const result = await run(agent, prompt, {
  stream: true,
  context: runtimeContext,
  maxTurns,
});

for await (const event of result.toStream()) {
  // 转换为 StreamEvent
}
```

### 3.2 Context Builder

**职责**：将 HappyClaw 特有的上下文注入到 SDK agent。

不同 SDK 有不同的注入方式：

| 上下文内容 | Claude Agent SDK | OpenAI Agents SDK |
|-----------|-----------------|-------------------|
| 通信规则（IM routing） | `systemPrompt.append` | `agent.instructions` |
| 工作区 CLAUDE.md | SDK 自动读取 cwd 下的 CLAUDE.md | 拼接到 `instructions` |
| Memory recall | `systemPrompt.append` | 拼接到 `instructions` |
| Channel routing | `systemPrompt.append` | 拼接到 `instructions` |
| 可用 skill 列表 | SDK 自动发现 skills/ | 写入 `instructions` 或注册为 tool |

**动态内容**（每轮可能变化）：
- IM channel 列表（从 IPC 消息的 source 字段提取）
- Memory index（从 data/memory/{userId}/index.md 读取）
- 上一轮的 context summary（compact 后）

### 3.3 Stream Converter

**职责**：SDK 的事件流 → HappyClaw StreamEvent。

**Claude Agent SDK 事件映射**：

| SDK message.type | StreamEvent |
|-----------------|-------------|
| `stream_event` (content_block_delta, text_delta) | `text_delta` |
| `stream_event` (content_block_delta, thinking_delta) | `thinking_delta` |
| `tool_use_summary` | `tool_use_start` + `tool_use_end` |
| `tool_progress` | `tool_progress` |
| `result` | `usage`（提取 token 信息）|

现有 `agent-runner/src/stream-processor.ts` 已经实现了这些映射，可以直接复用。

**OpenAI Agents SDK 事件映射**：

| SDK event | StreamEvent |
|-----------|-------------|
| `raw_model_stream_event` (output_text_delta) | `text_delta` |
| `raw_model_stream_event` (reasoning_delta) | `thinking_delta` |
| `run_item_stream_event` (tool_called) | `tool_use_start` |
| `run_item_stream_event` (tool_output) | `tool_use_end` |
| run 完成后 `result.usage` | `usage` |

### 3.4 MCP Server（内置）

**职责**：把核心 tool 以 MCP 协议暴露给 SDK agent。

当前的 ContextPlugin 接口已经定义好了 ToolDefinition，只需要包一层 MCP server：

```typescript
// 伪代码
const mcpServer = new McpServer('happyclaw');

for (const tool of contextManager.getActiveTools()) {
  mcpServer.tool(
    tool.name,
    tool.description,
    tool.parameters,
    async (args) => {
      const result = await tool.execute(args);
      return { content: [{ type: 'text', text: result.content }] };
    }
  );
}
```

**SDK 侧配置**：

Claude Agent SDK（直接传 MCP server 对象）：
```typescript
import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';

// 方式 A：用 SDK 内置的 MCP 适配（现有 agent-runner 的做法）
const sdkMcpServer = createSdkMcpServer(mcpServer);

query({
  prompt: stream,
  options: {
    mcpServers: { happyclaw: sdkMcpServer }
  }
});
```

OpenAI Agents SDK（通过 MCPServerStdio 连接）：
```typescript
import { MCPServerStdio } from '@openai/agents';

// OpenAI SDK 需要 stdio transport，harness 启动 MCP server 进程
const mcpServer = new MCPServerStdio({
  name: 'happyclaw',
  command: 'node',
  args: ['mcp-server.js'],
  env: { HAPPYCLAW_WORKSPACE_IPC: '...' },
});
await mcpServer.connect();

const agent = new Agent({
  mcpServers: [mcpServer],
  // ...
});
```

**注意**：Claude Agent SDK 支持 in-process MCP server（`createSdkMcpServer`），OpenAI Agents SDK 需要通过 stdio/HTTP transport。两者的 MCP server 逻辑共享，只是传递方式不同。

### 3.5 Hook Manager

**职责**：管理 hook 的注册、执行和可视化。

#### SDK 原生 Hook 能力对比

| 现有 hook | 功能 | Claude Agent SDK | OpenAI Agents SDK |
|-----------|------|-----------------|-------------------|
| PreToolUse (gatekeeper) | 高风险操作拦截 | `hooks.PreToolUse` HookCallback | `tool.needsApproval` + `inputGuardrails` |
| PostToolUse (loop detect) | 循环卡住检测 | `hooks.PostToolUse` HookCallback | `outputGuardrails` + 自定义 middleware |
| PostToolUse (code review) | 变更收集 + GPT review | `hooks.PostToolUse` HookCallback | `outputGuardrails` |
| Stop (final review) | 最终代码评审 | `hooks.Stop` HookCallback | run 完成后处理 |
| PreCompact (archive) | 对话归档 + memory wrapup | `hooks.PreCompact` HookCallback | 手动 token 管理触发 |

#### Claude Agent SDK Hook 实现

```typescript
import { HookCallback } from '@anthropic-ai/claude-agent-sdk';

const gatekeeper: HookCallback = async (input, toolUseID, { signal }) => {
  // input 包含 tool_name, tool_input 等
  const preInput = input as PreToolUseHookInput;

  // 写 StreamEvent 到 IPC（可视化）
  writeStreamEvent({
    eventType: 'hook_started',
    hookName: 'gatekeeper',
    hookEvent: 'PreToolUse',
    toolName: preInput.tool_name,
  });

  // 安全检查逻辑（复用现有 safety-hooks.ts 核心代码）
  const decision = await checkSafety(preInput);

  writeStreamEvent({
    eventType: 'hook_response',
    hookName: 'gatekeeper',
    hookOutcome: decision.allowed ? 'allowed' : 'blocked',
  });

  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision.allowed ? 'allow' : 'deny',
      permissionDecisionReason: decision.reason,
    }
  };
};

// 注册
query({
  prompt: stream,
  options: {
    hooks: {
      PreToolUse: [
        { matcher: 'Bash|Edit|Write', hooks: [gatekeeper] },
      ],
      PostToolUse: [
        { matcher: 'Bash|Edit|Write', hooks: [loopDetect, codeReview] },
      ],
      Stop: [
        { hooks: [finalReview] },
      ],
      PreCompact: [
        { hooks: [archiveTranscript] },
      ],
    }
  }
});
```

**优势**：hook 回调是 in-process 的，没有 shell spawn 开销，可以直接访问 harness 内部状态。

#### OpenAI Agents SDK Hook 实现

OpenAI SDK 没有完全对等的 hook 系统，但可以通过以下机制覆盖：

```typescript
import { Agent, tool } from '@openai/agents';

// 方式 1：tool.needsApproval —— 等价 PreToolUse gatekeeper
const bashTool = tool({
  name: 'bash',
  // ...
  needsApproval: async (runContext, toolCall) => {
    // 返回 true 时 run() 暂停，产生 interruption
    return isDangerous(toolCall);
  },
});

// 方式 2：inputGuardrails / outputGuardrails
const agent = new Agent({
  inputGuardrails: [{
    name: 'safety_check',
    run: async ({ input }) => ({
      behavior: isSafe(input) ? { type: 'allow' } : { type: 'block', message: '...' },
    }),
  }],
  outputGuardrails: [{
    name: 'review_check',
    run: async ({ output }) => ({
      behavior: { type: 'allow' },  // 或 block
    }),
  }],
});

// 方式 3：stream 事件中间件 —— PostToolUse 等价
for await (const event of result.toStream()) {
  if (event.type === 'run_item_stream_event') {
    if (event.name === 'tool_output') {
      // 在此检测循环、收集变更
      await loopDetect(event.item);
      await codeReview(event.item);
    }
  }
  // 转换并输出
}
```

#### Hook 可视化

不变——每次 hook 执行时，写一条 StreamEvent 到 IPC：

```typescript
{
  eventType: 'hook_started',
  hookName: 'gatekeeper',
  hookEvent: 'PreToolUse',
  toolName: 'Bash',
  toolInputSummary: 'rm -rf /tmp/...',
}

// 执行完成后
{
  eventType: 'hook_response',
  hookName: 'gatekeeper',
  hookEvent: 'PreToolUse',
  hookOutcome: 'blocked',  // 或 'allowed', 'advisory'
  text: '安全检查结果...',
}
```

### 3.6 Credential Manager

**职责**：统一管理所有 OAuth token 和 API key 的获取、刷新、存储。

#### 现状问题

凭据逻辑分散在至少 6 个地方：
- `runtime-config.ts` → `getClaudeProviderConfig()`、`getOpenAIProviderConfig()`（Claude/OpenAI 凭据读取 + 加密存储）
- `feishu-oauth.ts` → 飞书 OAuth 授权流程 + token 刷新
- `context-compressor.ts` → `getAuthCredentials()`（Claude API 认证，4 层 fallback）
- `cross-model.ts` → `getCredentials()`（OpenAI 动态刷新）
- `container-runner.ts` → 环境变量注入（ANTHROPIC_*、OPENAI_*、CROSSMODEL_*）
- `routes/memory-agent.ts` → OpenAI 凭据端点（`/api/internal/memory/openai-credentials`）

#### 统一接口

```typescript
interface CredentialManager {
  /** 获取指定 provider 的有效凭据（自动刷新） */
  getCredentials(provider: 'claude' | 'openai' | 'feishu', userId?: string): Promise<Credentials>;

  /** 保存新的凭据（如 OAuth callback） */
  saveCredentials(provider: string, userId: string | null, credentials: Credentials): Promise<void>;

  /** 撤销凭据 */
  revokeCredentials(provider: string, userId: string | null): Promise<void>;

  /** 导出为环境变量（给容器/子进程注入） */
  toEnvVars(provider: string, userId?: string): Record<string, string>;

  /** 检查凭据是否有效（不触发刷新） */
  isValid(provider: string, userId?: string): boolean;
}

type Credentials =
  | { type: 'api_key'; apiKey: string; baseUrl?: string }
  | { type: 'oauth'; accessToken: string; refreshToken?: string; expiresAt?: number }
  | { type: 'oauth_profile'; profilePath: string };  // Claude Code 的 OAuth profile
```

#### Provider 清单

| Provider | 凭据类型 | 作用域 | 刷新机制 |
|----------|---------|--------|---------|
| `claude` | API key / OAuth profile | 系统级 | SDK 自管 OAuth profile |
| `openai` | API key / OAuth token | 系统级 | 定时刷新 + 动态端点 |
| `feishu` | OAuth token | per-user | refresh_token 自动刷新 |

#### 存储

延续现有的加密存储（AES-256-GCM in `data/config/`），但统一入口：
- `data/config/credentials/claude.json`
- `data/config/credentials/openai.json`
- `data/config/credentials/feishu-{userId}.json`

#### 消费方

```
Credential Manager
  ├── container-runner.ts → toEnvVars() 注入到容器环境
  ├── context-compressor.ts → getCredentials('claude') 调 Messages API
  ├── cross-model skill → getCredentials('openai') 调 OpenAI API
  ├── feishu-docs skill → getCredentials('feishu', userId)
  └── memory-agent → 通过 harness 环境变量间接获取
```

### 3.7 Context Engine

**职责**：从 agent runner 独立出来的上下文管理模块——控制注入什么上下文、何时 compact、怎么压缩。解决当前 token 消耗过大的问题。

#### 现状问题

1. **SDK 自带 compact 不可控**：Claude SDK 自己决定什么时候 compact，我们只能通过 PreCompact hook 做善后
2. **context-compressor.ts 是独立的压缩器**：用 Haiku 总结对话历史，重置 session——但它跟 SDK 的 compact 是两套并行机制
3. **上下文膨胀**：memory index、channel routing、system prompt append 等每轮都注入，吃上下文
4. **没有 token 预算管理**：不知道当前 session 用了多少 token，也不知道离 compact 还有多远

#### 架构

Context Engine 是 harness 和宿主机之间的独立层：

```
┌──────────────────────────────────────────┐
│             Context Engine                │
│                                           │
│  ┌───────────┐  ┌──────────────────────┐ │
│  │ Budget     │  │ Injection Pipeline   │ │
│  │ Tracker    │  │                      │ │
│  │            │  │ system prompt        │ │
│  │ 估算当前   │  │ → memory index       │ │
│  │ token 消耗 │  │ → channel routing    │ │
│  │ 判断是否   │  │ → context summary    │ │
│  │ 需要压缩   │  │ → CLAUDE.md          │ │
│  └───────────┘  └──────────────────────┘ │
│                                           │
│  ┌───────────┐  ┌──────────────────────┐ │
│  │ Compact    │  │ Summary Generator    │ │
│  │ Strategy   │  │                      │ │
│  │            │  │ 用 Haiku 压缩对话   │ │
│  │ 决定何时   │  │ 提取知识写 memory    │ │
│  │ 怎么压缩   │  │ 归档到 conversations │ │
│  └───────────┘  └──────────────────────┘ │
└──────────────────────────────────────────┘
```

#### 接口

```typescript
interface ContextEngine {
  /** 构建本轮注入的上下文（根据预算裁剪） */
  buildContext(opts: ContextBuildOptions): Promise<ContextOutput>;

  /** compact 发生前的回调（Claude SDK PreCompact hook） */
  onBeforeCompact(context: CompactContext): Promise<CompactAction>;

  /** compact 发生后的回调 */
  onAfterCompact(newSessionId: string): Promise<void>;

  /** 主动触发压缩（宿主机侧调用，如消息数超阈值） */
  triggerCompression(groupFolder: string): Promise<CompressResult>;

  /** 获取当前 token 预算状态 */
  getBudgetStatus(groupFolder: string): BudgetStatus;
}

interface ContextBuildOptions {
  groupFolder: string;
  userId?: string;
  chatJid: string;
  isHome: boolean;
  /** 可用 token 预算（估算） */
  tokenBudget?: number;
}

interface ContextOutput {
  /** 注入到 system prompt 的内容 */
  systemPromptAppend: string;
  /** 预估消耗的 token 数 */
  estimatedTokens: number;
  /** 哪些内容被裁剪了（用于诊断） */
  truncated: string[];
}

interface BudgetStatus {
  estimatedUsed: number;      // 当前 session 估算已用 token
  estimatedLimit: number;     // 模型上下文窗口
  utilizationPct: number;     // 使用率
  shouldCompress: boolean;    // 是否建议压缩
  messageCount: number;       // 消息数
  lastCompressedAt?: string;  // 上次压缩时间
}

interface CompactContext {
  transcriptPath: string;
  sessionId: string;
  turnCount: number;
  groupFolder: string;
  userId?: string;
}

type CompactAction = {
  archive?: boolean;           // 归档到 conversations/
  triggerWrapup?: boolean;     // 触发 memory session_wrapup
  contextSummary?: string;     // 注入下一轮的 context summary
  knowledgeEntries?: Array<{   // 提取的知识条目
    content: string;
    importance: string;
  }>;
};
```

#### Token 预算管理策略

```
上下文窗口（如 200k）
├── 固定开销（~10k）
│   ├── system prompt 基础部分
│   ├── tool 定义（MCP tools + SDK 内置 tools）
│   └── skill 元数据
├── 动态注入（Context Engine 管理，按预算裁剪）
│   ├── memory index（按重要性排序，超预算截断）
│   ├── channel routing（固定，很短）
│   ├── context summary（上次 compact 的摘要）
│   └── CLAUDE.md 内容
└── 对话历史（SDK 自行管理）
    ├── Claude: SDK 自动 compact，通过 PreCompact hook 参与
    └── OpenAI: 手动管理，通过 Context Engine 触发压缩
```

**裁剪策略**：当 token 预算紧张时，Context Engine 按优先级裁剪注入内容：
1. 最先裁剪：context summary 的细节部分
2. 其次裁剪：memory index 的低优先级条目
3. 最后裁剪：CLAUDE.md 的非关键部分
4. 不裁剪：channel routing、tool 定义

**OpenAI 侧的 compact 策略**：

OpenAI Agents SDK 没有内置 compact，需要 harness 主动管理：

```typescript
// 方式 1：previousResponseId（Responses API 服务端记忆）
// 让 OpenAI 服务端处理上下文管理，自动截断
const result = await run(agent, newMessage, {
  previousResponseId: lastResponseId,
});

// 方式 2：手动 history 传递 + Context Engine 裁剪
// 当 token 接近上限时，用 Haiku 压缩历史再传入
const compressedHistory = await contextEngine.compressHistory(history);
const result = await run(agent, [
  ...compressedHistory,
  { role: 'user', content: newMessage },
]);
```

#### 与现有 context-compressor.ts 的关系

现有的 `context-compressor.ts` 的核心逻辑（Haiku 总结、知识提取）迁移到 Context Engine 的 Summary Generator 中。宿主机侧的主动压缩触发（AUTO_COMPRESS_THRESHOLD = 80 条消息）保留，通过 Context Engine 接口调用。

---

## 4. Memory Agent Harness 化

### 4.1 现状

Memory agent 是 per-user 长驻子进程，直接调 Claude SDK `query()`：
- 模型：Sonnet 4.6（默认）
- 协议：stdin/stdout JSONL（requestId 匹配请求响应）
- 工具：Read/Write/Edit/Grep/Glob/Bash（SDK 内置工具）
- 生命周期：MemoryAgentManager 管理（最多 3 并发，20 请求后重启，10 分钟闲置清理）
- 上下文：一个 280 行的 system prompt（行为规范）

### 4.2 Harness 化方案

Memory agent 比主 agent 简单——不需要 MCP server、hooks、skills。只需要：

```
MemoryAgentManager（宿主机，不变）
  │ stdin/stdout JSONL（不变）
  ▼
agent-harness --mode memory
  │
  ├── 读取 JSONL 请求
  ├── 构建 prompt（请求类型 → 指令文本）
  ├── 调用 SDK Adapter
  │     Claude: query({ prompt, options: { systemPrompt, cwd, allowedTools } })
  │     OpenAI: run(memoryAgent, prompt, { context })
  ├── 消费 SDK 输出
  └── 写 JSONL 响应
```

**关键差异**：

| | 主 agent harness | Memory agent harness |
|---|---|---|
| 通信协议 | ContainerInput/Output + IPC 多轮 | JSONL 单次请求响应 |
| MCP server | 需要（messaging/tasks/memory/groups）| 不需要（只用内置 file tools）|
| Hooks | 需要（safety/review）| 不需要 |
| Skills | 需要（feishu-docs/cross-model）| 不需要 |
| 会话模式 | 长会话 + resume | 长会话 + resume（20 请求后重启）|
| System prompt | 动态（每轮可变）| 固定（280 行行为规范）|
| Stream events | 需要转换 | 不需要（不产生 UI 事件）|

**实现方式**：harness 接受 `--mode main|memory` 参数，memory 模式跳过 MCP/hooks/skills/stream 相关逻辑，只做 JSONL ↔ SDK 的桥接。

### 4.3 System Prompt 注入

Memory agent 的 system prompt 是它的"宪法"——定义了四种操作（query/remember/session_wrapup/global_sleep）的完整算法。

注入方式：
- Claude Agent SDK：`systemPrompt` 选项（替换或 append）
- OpenAI Agents SDK：`agent.instructions`

System prompt 由 harness 在启动时从模板生成（可能需要填入 userId、目录路径等动态值）。

### 4.4 OpenAI Agents SDK 的 Memory Agent 实现

```typescript
import { Agent, run, tool } from '@openai/agents';
import { z } from 'zod';

// 为 OpenAI SDK 手动实现文件操作工具（Claude SDK 内置，OpenAI 没有）
const readFile = tool({
  name: 'read_file',
  description: 'Read a file',
  parameters: z.object({ path: z.string() }),
  execute: async ({ path }) => fs.readFile(path, 'utf-8'),
});

const writeFile = tool({
  name: 'write_file',
  description: 'Write a file',
  parameters: z.object({ path: z.string(), content: z.string() }),
  execute: async ({ path, content }) => { await fs.writeFile(path, content); return 'ok'; },
});

// ... glob, grep, edit, bash 同理

const memoryAgent = new Agent({
  name: 'memory-agent',
  model: 'gpt-4.1',
  instructions: memorySystemPrompt,  // 280 行规范
  tools: [readFile, writeFile, editFile, globFiles, grepFiles, bash],
});

// 处理 JSONL 请求
for await (const request of readJsonlStdin()) {
  const result = await run(memoryAgent, request.prompt, {
    previousResponseId: lastResponseId,  // 保持会话连续
  });
  lastResponseId = result.lastResponseId;

  writeJsonlStdout({
    requestId: request.requestId,
    success: true,
    response: result.finalOutput,
  });
}
```

### 4.5 宿主机侧变更

`src/memory-agent.ts` 的 `MemoryAgentManager` 基本不变——它负责进程生命周期和 JSONL 路由。只是 spawn 的目标变了：

```diff
- spawn('node', [memoryAgentDist], { ... })
+ spawn('node', [harnessDistPath, '--mode', 'memory'], { ... })
```

---

## 5. Skill 迁移

### 5.1 feishu-docs skill

```
container/
  agent-runner-core/src/
    services/
      feishu-docs.ts        ← 从现有 plugin 提取 HTTP 调用逻辑
    cli/
      feishu-docs.ts        ← CLI 入口

  skills/
    feishu-docs/
      SKILL.md              ← agent 使用指南
```

**CLI 接口**：
```bash
feishu-docs read <url>
feishu-docs search <query> [--count N] [--types docx,wiki]
```

**SKILL.md 要点**：
- 触发：用户分享飞书链接、提到飞书文档、需要查找文档
- 前置：用户需在 Web 设置页完成飞书 OAuth 授权
- 输出：Markdown 格式文档内容 / 搜索结果列表

**依赖**：`HAPPYCLAW_API_URL` + `HAPPYCLAW_INTERNAL_TOKEN`（环境变量，容器内已有）

### 5.2 cross-model skill（合并 ask_model + delegate_task，agent-agnostic）

```
container/
  agent-runner-core/src/
    services/
      cross-model.ts        ← 合并：agent 调用 + worktree + patch
    cli/
      cross-model.ts        ← CLI 入口

  skills/
    cross-model/
      SKILL.md              ← agent 使用指南
```

**CLI 接口**：
```bash
cross-model <prompt>                         # 纯文本，用默认 agent
cross-model <prompt> --workspace             # 创建 git worktree，跑完出 patch
cross-model <prompt> --agent openai          # 指定用 OpenAI Agents SDK
cross-model <prompt> --agent claude          # 指定用 Claude Agent SDK
cross-model <prompt> --model gpt-4.1        # 指定模型（SDK 内部路由）
```

**核心变化**：不再绑死 OpenAI。`--agent` 参数决定用哪个 SDK adapter 执行。底层复用 harness 的 SDK Adapter。

**service 内部结构**：
```
CrossModelService
├── resolveAdapter(opts)      ← 根据 --agent 参数选择 SDK Adapter
├── credentialManager.get()   ← 从 Credential Manager 获取凭据
├── callAgent(prompt, opts)   ← 调用 SDK adapter，收集文本输出
└── delegateInWorkspace(opts) ← worktree 生命周期 + SDK 调用 + patch
    ├── provision()           ← git worktree add --detach
    ├── runAgent()            ← 跑选定的 SDK adapter（Claude / OpenAI）
    ├── computePatch()        ← 安全 git diff（父进程计算，不信任子进程）
    └── cleanup()             ← worktree remove
```

**SKILL.md 要点**：
- 无 `--workspace`：方案评审、翻译、第二意见。快速，无文件操作
- 有 `--workspace`：编码子任务、重构、bug 修复。返回 patch，agent 审核后 apply
- 可用 agent 和模型列表（从 Credential Manager 动态获取）
- 选 agent 的指引：需要不同视角时选另一家的 agent

---

## 6. 会话管理

### 6.1 Session 生命周期

```
harness 启动
  │
  ├── 从 ContainerInput.sessionId 获取上次的会话 ID
  │
  ├── Claude Agent SDK: query({ options: { resume: sessionId } })
  │   SDK 自行管理 .claude/ 下的会话文件
  │
  ├── OpenAI Agents SDK: run(agent, input, { previousResponseId })
  │   使用 Responses API 的服务端会话延续
  │   或手动传递 history
  │
  ├── Claude SDK compact 后可能产生新 session ID
  │   harness 从 result message 中捕获，写回 ContainerOutput.newSessionId
  │
  └── 宿主机侧更新 DB（已有逻辑，不变）
```

### 6.2 会话持久化

**Claude Agent SDK**：

不变：`data/sessions/{folder}/.claude/`

harness 设置 `CLAUDE_CONFIG_DIR` 环境变量指向此目录（当前已有）。SDK 会自动使用它存储会话状态。

**OpenAI Agents SDK**：

两种策略：

1. **Responses API `previousResponseId`**（推荐）：会话状态存储在 OpenAI 服务端，harness 只需要保存最后的 `responseId`。
   - 持久化：`data/sessions/{folder}/openai-state.json` → `{ lastResponseId: string }`
   - 优势：无本地状态管理，OpenAI 服务端自动处理上下文窗口
   - 劣势：依赖 OpenAI 服务可用性

2. **手动 history**：harness 保存完整对话历史到本地。
   - 持久化：`data/sessions/{folder}/openai-history.json`
   - 配合 Context Engine 做压缩
   - 适用于需要离线访问历史的场景

---

## 7. 目录结构变更

### 现有（删除）

```
container/
  agent-runner/                 ← 删除（Claude SDK 直调，逻辑迁移到 harness）
  agent-runner-openai/          ← 删除（OpenAI API 直调，逻辑迁移到 harness）
  memory-agent/                 ← 删除（Claude SDK 直调，harness --mode memory 替代）
```

### 新增

```
container/
  agent-harness/                ← 新增
    src/
      index.ts                  ← 主入口：Protocol Bridge
      context-builder.ts        ← 动态上下文生成
      stream-converter.ts       ← SDK 事件 → StreamEvent
      hook-manager.ts           ← Hook 注册 + StreamEvent 可视化
      mcp-server.ts             ← 内置 MCP server
      adapters/
        types.ts                ← SDK Adapter 接口
        claude-sdk.ts           ← Claude Agent SDK 适配
        openai-sdk.ts           ← OpenAI Agents SDK 适配
      hooks/
        gatekeeper.ts           ← 安全网关逻辑（从 safety-hooks.ts 迁移）
        loop-detect.ts          ← 循环检测逻辑（从 safety-hooks.ts 迁移）
        code-review.ts          ← 代码评审逻辑（从 review-hooks.ts 迁移）
    package.json                ← 依赖：@anthropic-ai/claude-agent-sdk + @openai/agents

  agent-runner-core/            ← 保留，调整
    src/
      plugins/
        messaging.ts            ← 保留（MCP server 使用）
        tasks.ts                ← 保留
        groups.ts               ← 保留
        memory.ts               ← 保留
        feishu-docs.ts          ← 删除（→ services/）
        cross-model.ts          ← 删除（→ services/）
        delegate.ts             ← 删除（→ services/）
      services/                 ← 新增
        feishu-docs.ts          ← 从 plugin 提取
        cross-model.ts          ← 合并 cross-model + delegate，agent-agnostic
      cli/                      ← 新增
        feishu-docs.ts          ← CLI 入口
        cross-model.ts          ← CLI 入口

  skills/
    feishu-docs/SKILL.md        ← 新增
    cross-model/SKILL.md        ← 新增

src/                            ← 宿主机侧调整
  credential-manager.ts         ← 新增（统一凭据管理）
  context-engine.ts             ← 新增（上下文管理引擎）
  context-compressor.ts         ← 迁移核心逻辑到 context-engine.ts
```

---

## 8. SDK Adapter 接口

```typescript
interface SdkAdapter {
  /** 适配器名称 */
  readonly name: 'claude' | 'openai';

  /** 启动 agent 执行（流式） */
  run(opts: RunOptions): AsyncIterable<AdapterEvent>;

  /** 向运行中的 agent 发送后续消息（多轮） */
  sendMessage(message: string): void;

  /** 请求 agent 优雅停止 */
  requestStop(): void;

  /** 强制中止 */
  abort(): void;
}

interface RunOptions {
  prompt: string;
  sessionId?: string;
  cwd: string;
  systemPromptAppend: string;
  env: Record<string, string>;
  mcpServer: McpServerInstance;       // 内置 MCP server 实例
  hooks: HooksConfig;
  maxTurns?: number;
  model?: string;
}

/** 统一的适配器事件（屏蔽两个 SDK 的差异） */
type AdapterEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_use_start'; toolName: string; toolId: string; input?: unknown }
  | { type: 'tool_use_end'; toolId: string; output?: string; isError?: boolean }
  | { type: 'tool_progress'; toolName: string; text: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number; cacheRead?: number; cacheCreation?: number }
  | { type: 'session_id'; sessionId: string }
  | { type: 'error'; message: string }
  | { type: 'done'; status: 'success' | 'error' };

interface HooksConfig {
  /** Claude SDK: 直接作为 HookCallback 传递 */
  /** OpenAI SDK: 转换为 guardrails + needsApproval */
  gatekeeper?: GatekeeperFn;
  loopDetect?: LoopDetectFn;
  codeReview?: CodeReviewFn;
  finalReview?: FinalReviewFn;
  preCompact?: PreCompactFn;
}
```

### Claude SDK Adapter 实现要点

```typescript
class ClaudeSdkAdapter implements SdkAdapter {
  readonly name = 'claude';
  private stream = new MessageStream();
  private abortController = new AbortController();

  async *run(opts: RunOptions): AsyncIterable<AdapterEvent> {
    this.stream.push({ role: 'user', content: opts.prompt });

    const q = query({
      prompt: this.stream,
      options: {
        model: opts.model || 'sonnet',
        cwd: opts.cwd,
        resume: opts.sessionId,
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: opts.systemPromptAppend,
        },
        permissionMode: 'bypassPermissions',
        allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'],
        mcpServers: { happyclaw: opts.mcpServer },
        hooks: this.buildHooks(opts.hooks),
        includePartialMessages: true,
        maxThinkingTokens: 16384,
        signal: this.abortController.signal,
      },
    });

    for await (const message of q) {
      // 复用现有 stream-processor.ts 的映射逻辑
      yield* this.convertMessage(message);
    }
  }

  sendMessage(message: string) {
    this.stream.push({ role: 'user', content: message });
  }

  requestStop() {
    this.stream.end();
  }

  abort() {
    this.abortController.abort();
  }
}
```

### OpenAI SDK Adapter 实现要点

```typescript
class OpenAiSdkAdapter implements SdkAdapter {
  readonly name = 'openai';
  private agent: Agent;
  private abortController = new AbortController();
  private lastResponseId?: string;

  async *run(opts: RunOptions): AsyncIterable<AdapterEvent> {
    // 构建文件操作工具（OpenAI SDK 没有内置的 Read/Write/Edit 等）
    const fileTools = buildFileTools(opts.cwd);

    // 连接 MCP server
    const mcpServer = new MCPServerStdio({
      name: 'happyclaw',
      command: 'node',
      args: [opts.mcpServer.scriptPath],
      env: opts.env,
    });
    await mcpServer.connect();

    this.agent = new Agent({
      name: 'happyclaw',
      model: opts.model || 'gpt-4.1',
      instructions: opts.systemPromptAppend,
      tools: [
        ...fileTools,
        ...this.buildGuardrailTools(opts.hooks),
      ],
      mcpServers: [mcpServer],
      modelSettings: {
        maxTokens: 16384,
        reasoning: { effort: 'high', summary: 'concise' },
      },
    });

    const result = await run(this.agent, opts.prompt, {
      stream: true,
      previousResponseId: this.lastResponseId,
      maxTurns: opts.maxTurns,
      signal: this.abortController.signal,
    });

    for await (const event of result.toStream()) {
      yield* this.convertEvent(event);
    }

    this.lastResponseId = result.lastResponseId;
    await mcpServer.close();
  }

  // OpenAI SDK 的多轮需要重新 run()，不像 Claude 的 MessageStream push
  sendMessage(message: string) {
    // 触发新一轮 run()，带 previousResponseId 保持上下文
    // 由 Protocol Bridge 管理
  }

  requestStop() {
    // OpenAI run 是 promise-based，等当前 run 完成即可
  }

  abort() {
    this.abortController.abort();
  }
}
```

---

## 9. 宿主机侧变更

### container-runner.ts

```diff
- const isOpenAI = llmProvider === 'openai';
- const runnerSubdir = isOpenAI ? 'agent-runner-openai' : 'agent-runner';
+ const runnerSubdir = 'agent-harness';
+
+ // SDK provider 作为环境变量传入 harness
+ hostEnv['HAPPYCLAW_SDK_PROVIDER'] = llmProvider === 'openai' ? 'openai' : 'claude';
```

其余逻辑（进程 spawn、超时管理、IPC 目录创建、环境变量注入）基本不变。harness 从 stdin 读 ContainerInput、往 stdout 写 ContainerOutput，协议层完全兼容。

---

## 10. SDK 能力对比与差异处理

| 能力 | Claude Agent SDK | OpenAI Agents SDK | 差异处理 |
|------|-----------------|-------------------|---------|
| **Tool calling 循环** | SDK 内置 | SDK 内置 (`run()`) | 统一 ✓ |
| **内置文件工具** | Read/Write/Edit/Glob/Grep/Bash | 无 | OpenAI 侧需手动实现 |
| **MCP 支持** | `createSdkMcpServer` (in-process) | `MCPServerStdio` (subprocess) | 共享 MCP server 逻辑 |
| **流式输出** | `includePartialMessages: true` | `stream: true` + `toStream()` | AdapterEvent 统一 |
| **多轮对话** | `MessageStream.push()` (同进程) | 重新 `run()` + `previousResponseId` | Adapter 内部处理 |
| **会话 resume** | `resume: sessionId` | `previousResponseId` | 语义等价 |
| **Hooks (PreToolUse)** | `HookCallback` (in-process) | `needsApproval` + guardrails | Hook Manager 适配 |
| **Hooks (PostToolUse)** | `HookCallback` | stream 事件中间件 | Hook Manager 适配 |
| **Hooks (PreCompact)** | `HookCallback` | 无等价物 | Context Engine 手动管理 |
| **扩展思考** | `maxThinkingTokens` | `reasoning: { effort, summary }` | 分别配置 |
| **Sub-agent** | `agents` 选项 (predefined agents) | `handoffs` (agent 间委托) | 分别实现 |
| **权限模式** | `permissionMode` | `needsApproval` per-tool | Adapter 内部处理 |
| **System prompt** | `systemPrompt.append` / preset | `agent.instructions` | Context Builder 统一 |
| **Working directory** | `cwd` 选项 | 无直接支持 | tool 实现中限制路径 |
| **Token budget** | `maxBudgetUSD` | `maxTurns` | 分别配置 |

### OpenAI 侧需要手动实现的文件工具

Claude Agent SDK 内置了开发工具（Read/Write/Edit/Glob/Grep/Bash），OpenAI Agents SDK 没有。需要为 OpenAI adapter 实现等价工具：

```typescript
// container/agent-harness/src/adapters/openai-file-tools.ts

import { tool } from '@openai/agents';
import { z } from 'zod';
import fs from 'fs/promises';
import { glob } from 'glob';
import { execSync } from 'child_process';

export function buildFileTools(cwd: string) {
  const resolvePath = (p: string) => path.resolve(cwd, p);

  return [
    tool({
      name: 'read_file',
      description: 'Read a file. Returns content with line numbers.',
      parameters: z.object({
        file_path: z.string(),
        offset: z.number().optional(),
        limit: z.number().optional(),
      }),
      execute: async ({ file_path, offset, limit }) => {
        const content = await fs.readFile(resolvePath(file_path), 'utf-8');
        const lines = content.split('\n');
        const start = offset || 0;
        const end = limit ? start + limit : lines.length;
        return lines.slice(start, end)
          .map((line, i) => `${start + i + 1}\t${line}`)
          .join('\n');
      },
    }),

    tool({
      name: 'write_file',
      description: 'Write content to a file.',
      parameters: z.object({
        file_path: z.string(),
        content: z.string(),
      }),
      execute: async ({ file_path, content }) => {
        await fs.writeFile(resolvePath(file_path), content);
        return `Written to ${file_path}`;
      },
    }),

    tool({
      name: 'edit_file',
      description: 'Replace a string in a file.',
      parameters: z.object({
        file_path: z.string(),
        old_string: z.string(),
        new_string: z.string(),
      }),
      execute: async ({ file_path, old_string, new_string }) => {
        const fullPath = resolvePath(file_path);
        const content = await fs.readFile(fullPath, 'utf-8');
        if (!content.includes(old_string)) {
          return 'Error: old_string not found in file';
        }
        await fs.writeFile(fullPath, content.replace(old_string, new_string));
        return `Edited ${file_path}`;
      },
    }),

    tool({
      name: 'glob_files',
      description: 'Find files matching a glob pattern.',
      parameters: z.object({ pattern: z.string() }),
      execute: async ({ pattern }) => {
        const matches = await glob(pattern, { cwd });
        return matches.join('\n') || 'No matches found';
      },
    }),

    tool({
      name: 'grep',
      description: 'Search file contents with regex.',
      parameters: z.object({
        pattern: z.string(),
        path: z.string().optional(),
        glob: z.string().optional(),
      }),
      execute: async ({ pattern, path: searchPath, glob: globPattern }) => {
        const target = searchPath ? resolvePath(searchPath) : cwd;
        let cmd = `rg --no-heading -n "${pattern}" "${target}"`;
        if (globPattern) cmd += ` --glob "${globPattern}"`;
        try {
          return execSync(cmd, { encoding: 'utf-8', maxBuffer: 1024 * 1024 });
        } catch {
          return 'No matches found';
        }
      },
    }),

    tool({
      name: 'bash',
      description: 'Execute a bash command.',
      parameters: z.object({ command: z.string() }),
      execute: async ({ command }) => {
        try {
          return execSync(command, { cwd, encoding: 'utf-8', timeout: 120000 });
        } catch (e: any) {
          return `Error (exit ${e.status}): ${e.stderr || e.message}`;
        }
      },
    }),
  ];
}
```

---

## 11. 实施计划

### Phase 0: 基础设施抽取（其他工作的前置）

1. **Credential Manager**
   - 实现 `src/credential-manager.ts`
   - 整合现有的 `getClaudeProviderConfig()`、`getOpenAIProviderConfig()`、飞书 OAuth
   - 统一凭据读取/刷新/存储接口
   - 迁移 `container-runner.ts` 中的环境变量注入逻辑

2. **Context Engine 骨架**
   - 实现 `src/context-engine.ts`
   - 从 `agent-runner/src/index.ts` 提取上下文构建逻辑（systemPromptAppend）
   - 从 `context-compressor.ts` 迁移压缩/摘要逻辑
   - Token 预算跟踪（先用简单估算，后续可精确化）

### Phase 1: Agent Harness 骨架 + Claude SDK Adapter

1. 创建 `agent-harness/` 项目结构
2. 定义 `SdkAdapter` 接口（`adapters/types.ts`）
3. 实现 Claude SDK Adapter（从现有 `agent-runner/src/index.ts` 迁移）
   - 这一步本质上是把现有 agent-runner 的代码重构到新的 Adapter 接口下
   - stream-processor.ts 逻辑迁移到 stream-converter.ts
4. 实现 Protocol Bridge（stdin/stdout + IPC 多轮）
5. 验证 Claude SDK Adapter 端到端可用（替代现有 agent-runner）

### Phase 2: MCP Server + Skill 迁移

1. 把 messaging/tasks/memory/groups plugin 包装成 MCP server
2. 集成 Context Engine（上下文注入通过 harness 调 Context Engine）
3. 实现 `services/feishu-docs.ts` + `cli/feishu-docs.ts` + `skills/feishu-docs/SKILL.md`
4. 实现 `services/cross-model.ts` + `cli/cross-model.ts` + `skills/cross-model/SKILL.md`
5. 从 agent-runner-core 移除三个旧 plugin

### Phase 3: Hook 迁移 + 可视化

1. 实现 Hook Manager（统一 Claude/OpenAI 两侧的 hook 注册）
2. 迁移 gatekeeper / loop-detect / code-review 逻辑为 SDK 回调
3. Hook 执行记录写入 StreamEvent（Web UI 可视化）

### Phase 4: OpenAI Agents SDK Adapter

1. 安装 `@openai/agents`（需 Node.js 22+、zod 4+）
2. 实现 OpenAI SDK Adapter（`adapters/openai-sdk.ts`）
3. 实现 OpenAI 文件工具（`openai-file-tools.ts`）
4. 实现 OpenAI 侧的 hook 适配（guardrails / needsApproval）
5. 实现 OpenAI 侧的会话管理（previousResponseId）
6. 验证双 SDK 可切换
7. cross-model skill 的 `--agent openai` 验证

### Phase 5: Memory Agent Harness 化

1. 在 harness 加入 `--mode memory` 分支（跳过 MCP/hooks/skills/stream）
2. 实现 JSONL ↔ SDK 桥接
3. Memory system prompt 模板化（填入动态路径）
4. OpenAI 侧的 memory agent 实现（手动文件工具 + run()）
5. 修改 `src/memory-agent.ts` 的 spawn 目标
6. 验证四种操作（query/remember/session_wrapup/global_sleep）

### Phase 6: 清理

1. 删除 agent-runner/（Claude SDK 直调版）
2. 删除 agent-runner-openai/（OpenAI API 直调版）
3. 删除 memory-agent/（Claude SDK 直调版）
4. 删除 context-compressor.ts（已迁移到 Context Engine）
5. 更新 CLAUDE.md、CLAUDE-full.md、Makefile
6. agent-runner-core 清理无用 export

---

## 12. 风险与待确认

| 风险 | 影响 | 缓解 |
|------|------|------|
| OpenAI Agents SDK 成熟度 | v0.8.0，API 可能变 | 通过 Adapter 接口隔离，SDK 变动只影响 openai-sdk.ts |
| OpenAI SDK 需要 Node 22+ / zod 4+ | 容器基础镜像需升级 | 当前 Dockerfile 已用 node:22-slim，zod 4 需确认兼容性 |
| OpenAI SDK 无内置文件工具 | 需要手动实现 Read/Write/Edit/Glob/Grep/Bash | 实现量不大，但需要保证与 Claude 内置工具行为一致 |
| OpenAI SDK 无 PreCompact 等价物 | 长对话上下文管理更复杂 | Context Engine 主动管理 + previousResponseId 服务端截断 |
| OpenAI SDK 多轮需要重新 run() | 不如 Claude MessageStream push 优雅 | Protocol Bridge 层面处理，对上层透明 |
| 两个 SDK 的 tool calling 行为差异 | 同一 tool 在两个 SDK 下可能表现不同 | 统一 tool 接口 + 充分测试 |
| Memory agent 换底层后行为偏差 | system prompt 是 280 行精细规范，不同模型遵循度不同 | 先用 Claude SDK（Claude 遵循度高），OpenAI 适配时逐步验证 |
| 会话状态跨 SDK 不兼容 | 换 provider 后历史会话丢失 | 接受——换 provider 本身就是新会话 |
| Claude SDK includePartialMessages + maxThinkingTokens 冲突 | 启用扩展思考时可能不产生 stream event | 确认最新版 SDK 是否已修复，否则分开处理 |

---

## 附录：为什么用 SDK 而不是 CLI 套壳

| | CLI 套壳 | SDK 直调 |
|---|---|---|
| **性能** | 每轮 spawn CLI 进程，启动开销大 | in-process，无额外进程开销 |
| **Hook** | shell command，需要序列化/反序列化，进程间通信 | in-process callback，直接访问内存 |
| **MCP** | 需要生成 .mcp.json / config.toml | 直接传 MCP server 对象（Claude）或实例（OpenAI） |
| **类型安全** | 解析 CLI stdout 文本 | TypeScript 类型完整 |
| **调试** | CLI 是黑盒，需要解析日志 | 可设断点、单步调试 |
| **多轮** | 需要 --resume 或重启进程 | MessageStream push（Claude）/ previousResponseId（OpenAI） |
| **依赖** | 需要全局安装 CLI | npm 包依赖，版本锁定 |
| **兼容性** | CLI 版本升级可能破坏输出格式 | SDK API 有语义版本保证 |

当前 agent-runner 已经在用 Claude Agent SDK，效果良好。设计方向应该是统一到 SDK 层面，而不是退回 CLI。
