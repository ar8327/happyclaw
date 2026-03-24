# HappyClaw Agent Harness 设计稿

> 状态：草案 v4（Codex SDK 方案，评审修订版）
> 日期：2026-03-24

## 1. 目标

六件事：

1. **Tool 梳理**：飞书文档等平台 tool → 可插拔 skill；ask_model/delegate_task → 合并为 cross-model MCP tool（可指定 agent/model）；核心 tool → MCP server
2. **Agent Harness**：agent-runner + agent-runner-openai 统一为 agent-harness，底层通过 SDK Adapter 调用 Claude Agent SDK / Codex SDK
3. **凭据管理**：OAuth 校验/刷新/存储从各模块抽出，统一为独立的 Credential Manager
4. **Context Engine**：拆为两层——harness 侧（上下文注入管道 + token 预算追踪）+ 宿主机侧（压缩触发 + 历史归档）
5. **Hook 管理**：Claude 侧用 SDK HookCallback（完整能力）；Codex 侧无 Hook 支持（可接受降级），Memory wrapup 通过 token 用量追踪在 Protocol Bridge 侧触发
6. **Memory Agent**：共享 SdkAdapter 层，保持独立入口和 JSONL 协议

### 不变的

- ContainerInput/Output 协议（宿主机 ↔ harness 的 stdin/stdout 约定）
- IPC 文件通信机制（input/、messages/、tasks/、哨兵文件）
- StreamEvent 类型体系（shared/stream-event.ts）
- 宿主机侧的 GroupQueue、TurnManager、WebSocket 广播——全部不动
- Memory Agent 的 JSONL 通信协议（宿主机 ↔ memory-agent 的 stdin/stdout）
- data/memory/{userId}/ 目录结构

### 要变的

- agent-runner（Claude SDK 直调）、agent-runner-openai（Chat Completions / Codex Responses 直调）→ agent-harness（统一入口，SDK Adapter 抽象）
- memory-agent（Claude SDK 直调）→ 独立入口，但复用 agent-harness 的 SdkAdapter 层
- FeishuDocsPlugin → skill（CLI 工具 + SKILL.md）
- CrossModelPlugin + DelegatePlugin → cross-model MCP tool（保持 in-process，需要凭据访问）
- HappyClaw tools（messaging/tasks/memory/groups）→ MCP server
- Hooks → Claude: SDK HookCallback（完整）/ Codex: 无（降级接受，见 §3.5）
- OAuth/API Key 管理 → Credential Manager（独立模块，宿主机侧 HTTP 端点供 harness 调用）
- 上下文管理 → Context Engine（harness 侧注入 + 宿主机侧压缩）

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
│  │ 职责清单↓    │  │ token 预算  │  │ EventNorm-   │ │
│  │              │  │             │  │ alizer 适配  │ │
│  └─────────────┘  └─────────────┘  └──────────────┘ │
│                                                       │
│  ┌─────────────────────────────────────────────────┐ │
│  │              SDK Adapter                         │ │
│  │                                                   │ │
│  │  ┌──────────────┐  ┌───────────────────────┐    │ │
│  │  │ claude        │  │ codex                  │    │ │
│  │  │               │  │                        │    │ │
│  │  │ query({       │  │ thread.runStreamed(     │    │ │
│  │  │   prompt,     │  │   prompt               │    │ │
│  │  │   options     │  │ )                      │    │ │
│  │  │ })            │  │                        │    │ │
│  │  │               │  │ Codex SDK              │    │ │
│  │  │ Claude Agent  │  │ (@openai/codex-sdk)    │    │ │
│  │  │ SDK           │  │                        │    │ │
│  │  │               │  │ 内置工具:              │    │ │
│  │  │ 内置工具:      │  │ Shell execution        │    │ │
│  │  │ Read/Write/   │  │ File patch             │    │ │
│  │  │ Edit/Glob/    │  │ Web search             │    │ │
│  │  │ Grep/Bash     │  │ OS 级沙箱              │    │ │
│  │  └──────────────┘  └───────────────────────┘    │ │
│  └─────────────────────────────────────────────────┘ │
│                                                       │
│  ┌─────────────────────────────────────────────────┐ │
│  │          MCP Server（内置，随 harness 启动）      │ │
│  │                                                   │
│  │  send_message  │ memory_query   │ schedule_task  │ │
│  │  send_image    │ memory_remember│ list_tasks     │ │
│  │  send_file     │                │ pause/resume/  │ │
│  │  cross_model   │                │ cancel_task    │ │
│  │                │                │ register_group │ │
│  └─────────────────────────────────────────────────┘ │
│                                                       │
│  ┌─────────────────────────────────────────────────┐ │
│  │          Hook / Memory Wrapup                    │ │
│  │                                                   │
│  │  Claude:                                         │ │
│  │    SDK HookCallback（PreToolUse/PostToolUse/     │ │
│  │    PreCompact/Stop）— 完整能力                   │ │
│  │                                                   │
│  │  Codex:                                          │ │
│  │    无 Hook（可接受降级）                          │ │
│  │    OS 级沙箱替代 gatekeeper                      │ │
│  │    Memory wrapup: turn.completed usage 追踪      │ │
│  │    → 阈值触发归档 + session_wrapup IPC           │ │
│  └─────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────┘
```

### Memory Agent 架构（共享 SdkAdapter，独立入口）

```
MemoryAgentManager（宿主机，不变）
  │ stdin/stdout JSONL（不变）
  ▼
memory-agent（独立入口）
  │
  ├── JSONL Bridge（读请求、写响应）
  ├── 调用 SdkAdapter（复用 agent-harness 的 adapter 层）
  │     Claude: query({ prompt, options })
  │     Codex:  thread.run(prompt)
  └── 无 MCP / 无 Hook / 无 Stream 转换
```

---

## 3. 核心模块设计

### 3.1 Protocol Bridge

**职责**：宿主机 ContainerInput/Output 协议 ↔ SDK Adapter 的输入/输出。

#### 完整职责清单

Protocol Bridge 不只是 stdin→SDK→stdout 的管道，它承担了当前 agent-runner 的全部编排职责：

| 职责集群 | 具体内容 | SDK 相关性 |
|---------|---------|-----------|
| **I/O 协议** | stdin 解析 ContainerInput、OUTPUT_MARKER 包裹写回 stdout | 无关 |
| **IPC 管理** | 轮询 input/ 文件夹、处理哨兵文件（_close/_drain/_interrupt）、消息合并 | 无关 |
| **图片预处理** | 维度检测（PNG/JPEG/GIF/BMP/WebP 头解析）、MIME 校验、超尺寸过滤 | 无关 |
| **IM 频道追踪** | 从消息提取 source channel、持久化到 .recent-im-channels.json、compact 后注入路由提醒 | 无关 |
| **活动看门狗** | 5 分钟查询空闲超时、20 分钟工具执行硬超时、卡死检测 | 部分（interrupt 机制不同）|
| **权限模式切换** | 检测 ExitPlanMode/EnterPlanMode 工具调用，切换 SDK 权限模式 | Claude 特定（Codex 用 sandboxMode）|
| **会话恢复** | 跟踪 lastResumeUuid（Claude）/ threadId（Codex），防止 fan-out 分支 | SDK 特定 |
| **错误恢复** | 上下文溢出重试（3 次）、不可恢复 transcript 检测、EPIPE 优雅降级 | SDK 特定 |
| **Memory Wrapup** | 追踪累计 token 用量，阈值触发归档 + session_wrapup IPC（两侧统一） | 部分（触发源不同）|
| **MCP 生命周期** | 查询间重建 MCP server（防止 transport 断开）| SDK 特定 |
| **信号处理** | SIGTERM/SIGINT 优雅关闭、uncaughtException/unhandledRejection 兜底 | 无关 |

**SDK 无关**的部分是 Protocol Bridge 的核心——两个 adapter 共享。**SDK 特定**的部分由各 adapter 内部处理。

#### 多轮对话：两种模式

两个 SDK 的多轮对话模型根本不同，Protocol Bridge 需要分别处理：

**Claude Agent SDK — push 模型**：
```
1. harness 创建 MessageStream，push 首条消息
2. 调用 query({ prompt: stream, ... })，进入 for-await 循环
3. IPC 消息到达 → stream.push()，注入正在运行的 query（不中断）
4. _drain → 等 query 当前轮完成后 stream.end()
5. _interrupt → queryRef.interrupt()
6. 一个 query() 调用处理整个会话生命周期
```

**Codex SDK — thread-per-turn 模型**：
```
1. 创建 thread = codex.startThread({ workingDirectory, ... })
2. 调用 thread.runStreamed(prompt)，for-await 消费事件
3. run 完成后，阻塞等待下一条 IPC 消息
4. IPC 消息到达 → 同一 thread 发起新的 thread.runStreamed()
5. _drain → 等 run 完成后退出
6. _interrupt → 无直接等价，需等 run 自然完成或 kill 子进程
7. 每条用户消息触发一次 runStreamed() 调用
```

**Protocol Bridge 的抽象策略**：Bridge 不试图统一这两种模式，而是对 adapter 暴露两个入口：

```typescript
// 方式 A：Claude 适配器使用——一次启动，持续推送
interface PushAdapter {
  start(opts: AdapterOptions): AsyncIterable<AdapterEvent>;
  pushMessage(message: string, images?: Image[]): void;
  interrupt(): void;
  end(): void;
}

// 方式 B：Codex 适配器使用——每轮独立运行
interface TurnAdapter {
  runTurn(input: TurnInput, opts: AdapterOptions): AsyncIterable<AdapterEvent>;
  dispose(): Promise<void>;
}
```

Protocol Bridge 通过检查 adapter 类型决定使用哪种消费模式。这比强行统一为一个接口更诚实。

### 3.2 Context Builder

**职责**：动态生成注入到 SDK agent 的上下文。**必须在 harness 内**——需要实时读取本地文件和追踪 token 消耗。

不同 SDK 有不同的注入方式：

| 上下文内容 | Claude Agent SDK | Codex SDK |
|-----------|-----------------|-----------|
| 通信规则（IM routing） | `systemPrompt.append` | `.codex/instructions.md` 或 config |
| 工作区 CLAUDE.md | SDK 自动读取 cwd 下的 CLAUDE.md | 拼接写入 instructions 文件 |
| Memory recall | `systemPrompt.append` | 拼接写入 instructions 文件 |
| Channel routing | `systemPrompt.append` | 拼接写入 instructions 文件 |
| 可用 skill 列表 | SDK 自动发现 skills/ | 写入 instructions 或通过 MCP 注册 |

**动态内容**（每轮可能变化）：
- IM channel 列表（从 IPC 消息的 source 字段提取）
- Memory index（从 data/memory/{userId}/index.md 读取）
- 上一轮的 context summary（compact 后）

**Codex 的 instructions 注入**：Codex SDK 没有直接的 `systemPrompt` 参数。Context Builder 在每轮 `runStreamed()` 前将动态上下文写入 `{cwd}/.codex/instructions.md`，Codex CLI 启动时自动读取。

### 3.3 Stream Converter

**职责**：SDK 的事件流 → HappyClaw StreamEvent。

#### EventNormalizer 策略

现有 `stream-processor.ts`（913 行）与 Claude SDK 消息格式深度耦合（61% 代码）。直接改写成本高。

**策略**：在 stream-processor 前加一层 EventNormalizer（~30 行），把各 SDK 的原始事件转换为 Claude SDK 消息的 shape，stream-processor 本体改动控制在 15%。

```
Claude SDK messages ──→ stream-processor（基本不动）──→ StreamEvent
                          ↑
Codex SDK events ──→ EventNormalizer（新增，~30 行）──┘
```

**Claude Agent SDK 事件映射**（不变）：

| SDK message.type | StreamEvent |
|-----------------|-------------|
| `stream_event` (content_block_delta, text_delta) | `text_delta` |
| `stream_event` (content_block_delta, thinking_delta) | `thinking_delta` |
| `tool_use_summary` | `tool_use_start` + `tool_use_end` |
| `tool_progress` | `tool_progress` |
| `result` | `usage`（提取 token 信息）|

**Codex SDK 事件映射**：

| Codex ThreadEvent | 经 EventNormalizer → | StreamEvent |
|-------------------|---------------------|-------------|
| `item.updated` (agent_message, text content) | 合成 text_delta | `text_delta` |
| `item.started` (command_execution / file_change) | 合成 tool_use_start | `tool_use_start` |
| `item.completed` (command_execution / file_change) | 合成 tool_use_summary | `tool_use_end` |
| `turn.completed` (含 usage) | 合成 result | `usage` |

**注意**：Codex SDK 的事件粒度是 item 级别（非逐 token），前端打字机效果会比 Claude 侧粗糙。这是可接受的降级。

### 3.4 MCP Server（内置）

**职责**：把核心 tool 以 MCP 协议暴露给 SDK agent。

当前的 ContextPlugin 接口已经定义好了 ToolDefinition，只需要包一层 MCP server：

```typescript
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

Claude Agent SDK（in-process MCP server）：
```typescript
import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';

const sdkMcpServer = createSdkMcpServer(mcpServer);
query({
  prompt: stream,
  options: { mcpServers: { happyclaw: sdkMcpServer } }
});
```

Codex SDK（config 注入 MCP）：

Codex CLI 原生支持 MCP server。harness 启动 MCP server 为 stdio 子进程，通过 Codex config 注入：

```typescript
// 方式 1：写 .codex/config.toml
// [mcp_servers.happyclaw]
// type = "stdio"
// command = "node"
// args = ["mcp-server.js"]

// 方式 2：Codex SDK config 选项（如果 SDK 支持）
const thread = codex.startThread({
  workingDirectory: cwd,
  // MCP config 待 SDK API 确认
});
```

**备选方案**：如果 Codex SDK 的 MCP 配置不够灵活，MCP tools 可以作为 prompt 中的 "可用工具说明" 注入 instructions，模型通过 shell 命令调用 MCP client CLI。

**cross_model 保持为 MCP tool**（不是 CLI skill）：需要通过 HTTP 端点访问 Credential Manager 获取实时凭据。

### 3.5 Hook / Memory Wrapup

**职责**：Claude 侧管理 hook 的注册、执行和可视化；Codex 侧实现 memory wrapup 的等价逻辑。

#### Claude Agent SDK Hook 实现

不变——复用现有 safety-hooks.ts / review-hooks.ts 核心逻辑：

```typescript
hooks: {
  PreToolUse: [{ hooks: [gatekeeper] }],   // → additionalContext 或 deny
  PostToolUse: [{ hooks: [loopDetect, codeReview] }],  // → additionalContext
  Stop: [{ hooks: [finalReview] }],
  PreCompact: [{ hooks: [archiveTranscript, memoryWrapup] }],
}
```

**关键能力**：hook 返回 `hookSpecificOutput.additionalContext` 会被 SDK 注入到 agent 的下一轮上下文，实现 coaching。

#### Codex SDK：无 Hook（可接受降级）

Codex SDK 没有等价的 HookCallback 系统。降级评估：

| 现有 hook | Claude 功能 | Codex 替代 | 降级影响 |
|-----------|-----------|-----------|---------|
| PreToolUse (gatekeeper) | 拦截危险操作 | **Codex OS 级沙箱**（Seatbelt/Landlock），`sandboxMode: "workspace-write"` | 沙箱更强；但失去细粒度 GPT 风险评估 |
| PostToolUse (loop detect) | 循环检测 + coaching | 无 | 模型自行判断，当前 OpenAI runner 本来也没有 |
| PostToolUse (code review) | 变更收集 + GPT review | run 完成后从 `result.items` 提取 `file_change` 做事后审查 | 从实时变为事后 |
| Stop (final review) | 最终代码评审 | 同上，run 完成后处理 | 等价 |
| PreCompact (archive + memory) | 归档 + memory wrapup | **Protocol Bridge token 追踪**（见下） | 等价 |

**为什么可接受**：当前 `agent-runner-openai` 本来就没有任何 hooks。Codex 侧的 OS 级沙箱实际上比现有的 `assertWithinWorkspace()` 路径校验更安全。降级只是"维持现状"。

#### Memory Wrapup：token 追踪方案

PreCompact hook 做两件事：归档对话 + 写 session_wrapup IPC。hook 返回 `{}`，不注入任何内容回对话——纯旁路操作。

因此不需要拦截 compact 事件，只需要在"差不多该 compact 的时候"触发即可。

**Codex 侧实现**：

```typescript
let cumulativeInputTokens = 0;
let wrapupTriggered = false;
const WRAPUP_THRESHOLD = 120_000; // 上下文窗口 60%

for await (const event of thread.runStreamed(prompt)) {
  // 追踪 token 用量
  if (event.type === 'turn.completed' && event.usage) {
    cumulativeInputTokens += event.usage.input_tokens;

    if (cumulativeInputTokens > WRAPUP_THRESHOLD && !wrapupTriggered) {
      // 跟 PreCompact 做完全一样的事
      archiveConversation(thread, groupFolder);
      writeSessionWrapupIpc(groupFolder, userId);
      wrapupTriggered = true;
    }
  }

  writeStreamEvent(convertToStreamEvent(event));
}
```

**为什么这样就够了**：
- session_wrapup 从 DB 读消息（不是内存 transcript），用游标去重——触发早一点晚一点都不丢数据
- 归档内容从 `result.items` 的 `file_change` / `command_execution` / `agent_message` 提取
- Claude 侧也继续用 PreCompact hook，行为不变

**Claude 侧 memory wrapup 同时保留两种触发**：
1. PreCompact hook（SDK 自动触发）
2. Protocol Bridge token 追踪（作为补充，统一两侧逻辑）

#### Hook 可视化

Claude 侧不变——每次 hook 执行时写 StreamEvent：

```typescript
{ eventType: 'hook_started', hookName: 'gatekeeper', toolName: 'Bash', ... }
{ eventType: 'hook_response', hookName: 'gatekeeper', hookOutcome: 'blocked', ... }
```

Codex 侧无 hook 事件。

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
| `claude` | API key / OAuth profile | 系统级 | SDK 自管 OAuth profile（共享 .claude/ 目录） |
| `openai` | API key / Codex OAuth | 系统级 | API key 静态；Codex OAuth 走 `codex login`（token 存 ~/.codex/） |
| `feishu` | OAuth token | per-user | refresh_token 自动刷新 |

#### 存储

延续现有的加密存储（AES-256-GCM in `data/config/`），但统一入口：
- `data/config/credentials/claude.json`
- `data/config/credentials/openai.json`
- `data/config/credentials/feishu-{userId}.json`

#### Harness ↔ Credential Manager 通信

Credential Manager 运行在宿主机侧。Harness（容器/子进程内）通过 HTTP 端点获取凭据：

```typescript
// 已有模式：cross-model.ts 的 getCredentials() 已经在用
const res = await fetch(`${HAPPYCLAW_API_URL}/api/internal/credentials/${provider}`, {
  headers: { Authorization: `Bearer ${HAPPYCLAW_INTERNAL_TOKEN}` },
});
const creds = await res.json();
```

这沿用现有的 `GET /api/internal/memory/openai-credentials` 模式，扩展为通用端点。

**静态凭据**（启动时不变的）仍通过环境变量注入，避免运行时 HTTP 开销。**动态凭据**（可能过期刷新的）走 HTTP 端点。

### 3.7 Context Engine

**职责**：上下文管理。拆为两层，解决现有 token 消耗过大问题。

#### 现状问题

1. **SDK 自带 compact 不可控**：Claude SDK 自己决定什么时候 compact，我们只能通过 PreCompact hook 做善后
2. **context-compressor.ts 是独立的压缩器**：用 Haiku 总结对话历史，重置 session——但它跟 SDK 的 compact 是两套并行机制
3. **上下文膨胀**：memory index、channel routing、system prompt append 等每轮都注入，吃上下文
4. **没有 token 预算管理**：不知道当前 session 用了多少 token，也不知道离 compact 还有多远

#### 架构：两层分离

```
┌──────────────────────────────────────────┐
│  harness 侧：Context Builder             │  ← 在 agent-harness 进程内
│                                           │
│  ┌───────────┐  ┌──────────────────────┐ │
│  │ Budget     │  │ Injection Pipeline   │ │
│  │ Tracker    │  │                      │ │
│  │            │  │ system prompt        │ │
│  │ 从 SDK     │  │ → memory index       │ │
│  │ usage 事件 │  │ → channel routing    │ │
│  │ 实时追踪   │  │ → context summary    │ │
│  │            │  │ → CLAUDE.md          │ │
│  └───────────┘  └──────────────────────┘ │
└──────────────────────────────────────────┘

┌──────────────────────────────────────────┐
│  宿主机侧：Compression Manager           │  ← 在宿主机进程内
│                                           │
│  ┌───────────┐  ┌──────────────────────┐ │
│  │ Trigger    │  │ Summary Generator    │ │
│  │ Strategy   │  │                      │ │
│  │            │  │ 用 Haiku 压缩对话   │ │
│  │ 80 条消息  │  │ 提取知识写 memory    │ │
│  │ 或手动触发 │  │ 归档到 conversations │ │
│  └───────────┘  └──────────────────────┘ │
└──────────────────────────────────────────┘
```

**为什么必须拆开**：
- Budget Tracker 需要实时消费 SDK 的 usage 事件——只有 harness 进程内有这个信息
- Injection Pipeline 需要读本地文件（memory index、CLAUDE.md）——容器内执行
- 而 Compression Manager 需要访问 messages.db、调 Haiku API、管理 session——宿主机侧
- 两者通过 ContainerInput（contextSummary 字段）和 IPC 通信

#### Token 预算管理策略

```
上下文窗口（如 200k）
├── 固定开销（~10k）
│   ├── system prompt 基础部分
│   ├── tool 定义（MCP tools + SDK 内置 tools）
│   └── skill 元数据
├── 动态注入（Context Builder 管理，按预算裁剪）
│   ├── memory index（按重要性排序，超预算截断）
│   ├── channel routing（固定，很短）
│   ├── context summary（上次 compact 的摘要）
│   └── CLAUDE.md 内容
└── 对话历史（SDK 自行管理）
    ├── Claude: SDK 自动 compact，通过 PreCompact hook 参与
    └── Codex: Codex CLI 内部管理，harness 通过 token 追踪触发 memory wrapup
```

**裁剪策略**：当 token 预算紧张时，Context Builder 按优先级裁剪注入内容：
1. 最先裁剪：context summary 的细节部分
2. 其次裁剪：memory index 的低优先级条目
3. 最后裁剪：CLAUDE.md 的非关键部分
4. 不裁剪：channel routing、tool 定义

#### 与现有 context-compressor.ts 的关系

现有的 `context-compressor.ts` 的核心逻辑（Haiku 总结、知识提取）迁移到宿主机侧的 Compression Manager 中。宿主机侧的主动压缩触发（AUTO_COMPRESS_THRESHOLD = 80 条消息）保留。

---

## 4. Memory Agent

### 4.1 现状

Memory agent 是 per-user 长驻子进程，直接调 Claude SDK `query()`：
- 模型：Opus 4.6（默认，可配 Sonnet）
- 协议：stdin/stdout JSONL（requestId 匹配请求响应）
- 工具：Read/Write/Edit/Grep/Glob/Bash（SDK 内置工具）
- 生命周期：MemoryAgentManager 管理（最多 3 并发，20 请求后重启，10 分钟闲置清理）
- 上下文：一个 280 行的 system prompt（行为规范）

### 4.2 方案：共享 SdkAdapter，保持独立入口

Memory agent 和主 agent 的共同点只有 SDK 调用。差异太大——通信协议、工具集、Hook、生命周期全部不同。用 `--mode memory` 塞进同一个二进制会引入不必要的条件分支。

**正确做法**：提取 SdkAdapter 为共享包，两个入口各自引用。

```
container/
  sdk-adapter/              ← 共享包（新建）
    src/
      types.ts              ← AdapterEvent、AdapterOptions
      claude-adapter.ts     ← Claude Agent SDK 封装
      codex-adapter.ts      ← Codex SDK 封装
      index.ts              ← 工厂函数 createAdapter(provider)
    package.json

  agent-harness/            ← 主 agent 入口
    src/
      index.ts              ← Protocol Bridge
      context-builder.ts
      stream-converter.ts
      hook-manager.ts
      mcp-server.ts
    package.json            ← 依赖 sdk-adapter

  memory-agent/             ← Memory agent 入口（保留）
    src/
      index.ts              ← JSONL Bridge + SDK 调用
    package.json            ← 依赖 sdk-adapter
```

### 4.3 迁移工作量评估

Memory agent 切换 SDK 的实际工作量：

| 组件 | 范围 | 工作量 |
|------|------|-------|
| **System prompt 重写** | 280 行中 ~160 行引用 Claude 工具名（Grep/Read/Write/Edit） | 高 |
| **query() 调用替换** | import + 调用签名 + options 对象 | 中 |
| **SDKUserMessage 类型** | 接口定义 + MessageStream 类 | 中 |
| **consumeQuery 循环** | 消息类型判断逻辑 | 中 |
| **架构模式** | 持久化 session、async iterator、JSONL 桥接——SDK 无关，不变 | 无 |

**总体**：~40-50% 的文件需要改动（545 行中 ~220-270 行），预计 2-3 天。

**System prompt 改动示例**：
```
# 之前（Claude 工具名）
处理流程：
1. Grep index.md 快速查找
2. 没命中 → Grep impressions/ 语义索引文件
3. 命中 → Read knowledge/ 获取细节

# 之后（Codex shell 命令）
处理流程：
1. 使用 grep 命令快速查找：grep "关键词" index.md
2. 没命中 → 递归搜索：grep -r "关键词" impressions/ --exclude-dir=archived
3. 命中 → 读取文件：cat knowledge/xxx.md
```

### 4.4 Codex 侧的 Memory Agent

Codex CLI 内置 shell execution + file patch 工具，覆盖 Memory Agent 需要的文件操作能力：

```typescript
import { Codex } from '@openai/codex-sdk';

const codex = new Codex({ apiKey: process.env.OPENAI_API_KEY });
const thread = codex.startThread({
  model: 'gpt-5.4',
  workingDirectory: MEMORY_DIR,
  sandboxMode: 'workspace-write',  // 限制在工作目录内写入
  approvalPolicy: 'never',         // 全自动
});

const result = await thread.run(memoryPrompt);
// result.items 包含 command_execution、file_change 等
```

### 4.5 宿主机侧变更

`src/memory-agent.ts` 的 `MemoryAgentManager` 基本不变——它负责进程生命周期和 JSONL 路由。只是 spawn 的目标不变（仍然是 `node memory-agent/dist/index.js`），但 memory-agent 内部改为通过 SdkAdapter 调用 SDK。

环境变量新增 `HAPPYCLAW_SDK_PROVIDER`（默认 `claude`），决定 memory-agent 用哪个 SDK。

Codex 侧的 OAuth 凭据：挂载 `~/.codex/` 配置目录到容器/子进程（类似 Claude 的 `.claude/.credentials.json` 共享机制）。

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

**凭据获取**：CLI skill 通过 `HAPPYCLAW_API_URL` + `HAPPYCLAW_INTERNAL_TOKEN` 调用宿主机 HTTP 端点获取飞书 OAuth token（与 cross-model 相同模式），不需要在 CLI 进程内持有 token。

### 5.2 cross-model（保持为 MCP tool）

**变化**：合并 ask_model + delegate_task 为一个 MCP tool `cross_model`，支持指定 agent/model：

```typescript
mcpServer.tool('cross_model', {
  description: '调用其他 AI agent 获取第二意见或执行子任务',
  parameters: {
    prompt: { type: 'string', description: '任务描述' },
    agent: { type: 'string', enum: ['claude', 'codex'], optional: true },
    model: { type: 'string', optional: true },
    workspace: { type: 'boolean', optional: true },  // 是否创建 worktree
  },
  execute: async (args) => {
    const creds = await fetchCredentials(args.agent || 'codex');
    const adapter = createAdapter(args.agent || 'codex');
    // ...
  },
});
```

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
  ├── Codex SDK: codex.resumeThread(threadId) 或 startThread()
  │   会话持久化在 ~/.codex/sessions/
  │
  ├── Claude SDK compact 后可能产生新 session ID
  │   harness 从 result message 中捕获，写回 ContainerOutput.newSessionId
  │
  ├── Codex SDK: thread.id 在 startThread 时确定
  │   harness 写回 ContainerOutput.newSessionId
  │
  └── 宿主机侧更新 DB（已有逻辑，不变）
```

### 6.2 会话持久化

**Claude Agent SDK**：

不变：`data/sessions/{folder}/.claude/`

**Codex SDK**：

Codex CLI 管理自己的会话持久化（`~/.codex/sessions/`）。harness 需要：

1. 将 `~/.codex/sessions/` 映射到 `data/sessions/{folder}/.codex/`（通过环境变量或 symlink）
2. 从 ContainerInput 恢复 threadId
3. 在 ContainerOutput 中返回 threadId 作为 newSessionId

```typescript
// 恢复会话
const thread = input.sessionId
  ? codex.resumeThread(input.sessionId)
  : codex.startThread({ workingDirectory: cwd, ... });

// 返回 session ID
writeOutput({ newSessionId: thread.id });
```

---

## 7. 目录结构变更

### 现有（删除）

```
container/
  agent-runner/                 ← 删除（逻辑迁移到 agent-harness）
  agent-runner-openai/          ← 删除（逻辑迁移到 agent-harness）
```

### 新增

```
container/
  sdk-adapter/                  ← 新增：共享 SDK 适配层
    src/
      types.ts                  ← AdapterEvent、AdapterOptions 接口
      claude-adapter.ts         ← Claude Agent SDK 封装
      codex-adapter.ts          ← Codex SDK 封装
      index.ts                  ← createAdapter() 工厂
    package.json

  agent-harness/                ← 新增：主 agent 入口
    src/
      index.ts                  ← Protocol Bridge
      context-builder.ts        ← 动态上下文生成（harness 侧）
      stream-converter.ts       ← EventNormalizer + SDK 事件 → StreamEvent
      hook-manager.ts           ← Hook 注册（Claude）+ memory wrapup（两侧）
      mcp-server.ts             ← 内置 MCP server
      hooks/
        gatekeeper.ts           ← 安全网关逻辑（从 safety-hooks.ts 迁移，仅 Claude）
        loop-detect.ts          ← 循环检测逻辑（从 safety-hooks.ts 迁移，仅 Claude）
        code-review.ts          ← 代码评审逻辑（从 review-hooks.ts 迁移，仅 Claude）
    package.json                ← 依赖 sdk-adapter + agent-runner-core

  memory-agent/                 ← 保留，修改内部 SDK 调用
    src/
      index.ts                  ← 改为通过 sdk-adapter 调用
    package.json                ← 新增依赖 sdk-adapter

  agent-runner-core/            ← 保留，调整
    src/
      plugins/
        messaging.ts            ← 保留（MCP server 使用）
        tasks.ts                ← 保留
        groups.ts               ← 保留
        memory.ts               ← 保留
        cross-model.ts          ← 保留，合并 delegate 逻辑，改为 agent-agnostic
        feishu-docs.ts          ← 删除（→ services/）
        delegate.ts             ← 删除（→ 合并到 cross-model）
      services/                 ← 新增
        feishu-docs.ts          ← 从 plugin 提取
      cli/                      ← 新增
        feishu-docs.ts          ← CLI 入口

  skills/
    feishu-docs/SKILL.md        ← 新增

src/                            ← 宿主机侧调整
  credential-manager.ts         ← 新增（统一凭据管理 + HTTP 端点）
  context-compressor.ts         ← 重命名/重构为 compression-manager.ts
```

---

## 8. SDK Adapter 接口

```typescript
/** 统一的适配器事件（屏蔽两个 SDK 的差异） */
type AdapterEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_use_start'; toolName: string; toolId: string; input?: unknown }
  | { type: 'tool_use_end'; toolId: string; output?: string; isError?: boolean }
  | { type: 'tool_progress'; toolName: string; text: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number; cacheRead?: number; cacheCreation?: number }
  | { type: 'session_id'; sessionId: string }
  | { type: 'compact'; newSessionId: string }
  | { type: 'error'; message: string; recoverable: boolean }
  | { type: 'done'; status: 'success' | 'error' };

/** Claude 适配器：push 模型 */
interface PushModelAdapter {
  readonly kind: 'push';
  readonly provider: 'claude';

  /** 启动长活 query，返回事件流 */
  start(opts: AdapterOptions): AsyncIterable<AdapterEvent>;

  /** 向正在运行的 query 推送消息（IPC 消息注入） */
  pushMessage(text: string, images?: ImageData[]): void;

  /** 请求 query 优雅停止（stream.end()） */
  requestStop(): void;

  /** 中断当前查询（queryRef.interrupt()） */
  interrupt(): void;

  /** 强制中止（AbortController） */
  abort(): void;
}

/** Codex 适配器：turn 模型 */
interface TurnModelAdapter {
  readonly kind: 'turn';
  readonly provider: 'codex';

  /** 执行单轮对话，返回事件流 */
  runTurn(input: TurnInput, opts: AdapterOptions): AsyncIterable<AdapterEvent>;

  /** 清理资源 */
  dispose(): Promise<void>;
}

type SdkAdapter = PushModelAdapter | TurnModelAdapter;

interface AdapterOptions {
  cwd: string;
  systemPrompt: string;           // Context Builder 生成的完整 system prompt
  sessionId?: string;             // Claude: resume UUID / Codex: threadId
  env: Record<string, string>;
  mcpServers: McpServerConfig[];
  hooks: HooksConfig;             // 仅 Claude 使用
  model?: string;
  maxThinkingTokens?: number;
  sandboxMode?: string;           // 仅 Codex 使用
}

interface TurnInput {
  text: string;
  images?: ImageData[];
}

/** 工厂函数 */
function createAdapter(provider: 'claude' | 'codex'): SdkAdapter;
```

### Protocol Bridge 消费逻辑

```typescript
const adapter = createAdapter(sdkProvider);

if (adapter.kind === 'push') {
  // Claude: 一次启动，持续推送
  const events = adapter.start(options);
  startIpcPolling((msg) => adapter.pushMessage(msg.text, msg.images));

  for await (const event of events) {
    trackUsageForMemoryWrapup(event);  // 两侧统一的 token 追踪
    writeStreamEvent(convertToStreamEvent(event));
  }

} else {
  // Codex: 逐轮运行
  // 首轮
  for await (const event of adapter.runTurn({ text: prompt, images }, options)) {
    trackUsageForMemoryWrapup(event);
    writeStreamEvent(convertToStreamEvent(event));
  }

  // 后续轮：阻塞等待 IPC 消息
  while (true) {
    const msg = await waitForIpcMessage();
    if (!msg) break;  // _close 或 _drain

    for await (const event of adapter.runTurn({ text: msg.text, images: msg.images }, options)) {
      trackUsageForMemoryWrapup(event);
      writeStreamEvent(convertToStreamEvent(event));
    }
  }

  await adapter.dispose();
}
```

### Claude Adapter 实现要点

```typescript
class ClaudeAdapter implements PushModelAdapter {
  readonly kind = 'push';
  readonly provider = 'claude';
  private stream = new MessageStream();
  private queryRef: QueryRef | null = null;

  async *start(opts: AdapterOptions): AsyncIterable<AdapterEvent> {
    this.stream.push({ role: 'user', content: opts.systemPrompt ? ... });

    const q = query({
      prompt: this.stream,
      options: {
        model: opts.model || 'opus',
        cwd: opts.cwd,
        resume: opts.sessionId,
        systemPrompt: { type: 'preset', preset: 'claude_code', append: opts.systemPrompt },
        permissionMode: 'bypassPermissions',
        allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'],
        mcpServers: opts.mcpServers,
        hooks: buildClaudeHooks(opts.hooks),
        includePartialMessages: true,
        maxThinkingTokens: opts.maxThinkingTokens || 16384,
      },
    });
    this.queryRef = q;

    for await (const message of q) {
      yield* convertClaudeMessage(message);  // 复用现有 stream-processor 映射
    }
  }

  pushMessage(text: string, images?: ImageData[]) {
    this.stream.push({ role: 'user', content: text }, images);
  }

  requestStop() { this.stream.end(); }
  interrupt() { this.queryRef?.interrupt(); }
  abort() { this.queryRef?.abort(); }
}
```

### Codex Adapter 实现要点

```typescript
class CodexAdapter implements TurnModelAdapter {
  readonly kind = 'turn';
  readonly provider = 'codex';
  private codex: Codex;
  private thread: Thread | null = null;

  constructor() {
    this.codex = new Codex({
      apiKey: process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY,
    });
  }

  async *runTurn(input: TurnInput, opts: AdapterOptions): AsyncIterable<AdapterEvent> {
    if (!this.thread) {
      // 首轮：创建或恢复 thread
      if (opts.sessionId) {
        this.thread = this.codex.resumeThread(opts.sessionId);
      } else {
        this.thread = this.codex.startThread({
          model: opts.model || 'gpt-5.4',
          workingDirectory: opts.cwd,
          sandboxMode: opts.sandboxMode || 'workspace-write',
          approvalPolicy: 'never',  // 全自动
          // instructions 通过 .codex/instructions.md 文件注入
        });
      }
      yield { type: 'session_id', sessionId: this.thread.id };
    }

    // 写入动态 instructions（每轮更新）
    writeInstructionsFile(opts.cwd, opts.systemPrompt);

    const { events } = await this.thread.runStreamed(input.text);

    for await (const event of events) {
      yield* convertCodexEvent(event);
    }
  }

  async dispose() {
    // Codex SDK 自行清理子进程
  }
}

/** Codex 事件 → AdapterEvent（EventNormalizer 的一部分） */
function* convertCodexEvent(event: ThreadEvent): Generator<AdapterEvent> {
  switch (event.type) {
    case 'item.updated':
      if (event.item.type === 'agent_message') {
        yield { type: 'text_delta', text: event.item.content };
      }
      break;

    case 'item.started':
      if (event.item.type === 'command_execution' || event.item.type === 'file_change') {
        yield {
          type: 'tool_use_start',
          toolName: event.item.type,
          toolId: event.item.id,
          input: event.item,
        };
      }
      break;

    case 'item.completed':
      if (event.item.type === 'command_execution' || event.item.type === 'file_change') {
        yield {
          type: 'tool_use_end',
          toolId: event.item.id,
          output: JSON.stringify(event.item),
          isError: event.item.exitCode !== 0,
        };
      }
      break;

    case 'turn.completed':
      if (event.usage) {
        yield {
          type: 'usage',
          inputTokens: event.usage.input_tokens,
          outputTokens: event.usage.output_tokens,
          cacheRead: event.usage.cached_input_tokens,
        };
      }
      yield { type: 'done', status: 'success' };
      break;

    case 'turn.failed':
      yield { type: 'error', message: event.error?.message || 'unknown', recoverable: true };
      yield { type: 'done', status: 'error' };
      break;
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
+ hostEnv['HAPPYCLAW_SDK_PROVIDER'] = llmProvider === 'openai' ? 'codex' : 'claude';
```

Codex 模式需要额外挂载：
- `~/.codex/` → `data/sessions/{folder}/.codex/`（会话持久化 + OAuth token）
- Codex CLI 二进制需要在容器镜像内或通过 volume 挂载

其余逻辑（进程 spawn、超时管理、IPC 目录创建、环境变量注入）基本不变。harness 从 stdin 读 ContainerInput、往 stdout 写 ContainerOutput，协议层完全兼容。

---

## 10. SDK 能力对比与差异处理

| 能力 | Claude Agent SDK | Codex SDK (@openai/codex-sdk) | 差异处理 |
|------|-----------------|-------------------------------|---------|
| **底层实现** | spawn Claude CLI 子进程 | spawn Codex CLI (Rust) 子进程 | 架构对称 |
| **Tool calling 循环** | SDK 内置 | Codex CLI 内置 | 统一 ✓ |
| **内置开发工具** | Read/Write/Edit/Glob/Grep/Bash | Shell execution + File patch + Web search | Codex 的 shell 覆盖多个 Claude 工具 |
| **沙箱安全** | `permissionMode` + `allowedTools` | OS 级沙箱（Seatbelt/Landlock）+ `sandboxMode` | Codex 更强 |
| **MCP 支持** | `createSdkMcpServer` (in-process) | config.toml MCP 配置 | 共享 MCP server 逻辑 |
| **流式输出** | `includePartialMessages: true`（逐 token） | `runStreamed()`（item 级别） | Codex 粒度更粗，前端体验略降 |
| **多轮对话** | `MessageStream.push()` (push 模型) | 同一 thread 多次 `.run()` (turn 模型) | 两种 adapter 接口 |
| **会话 resume** | `resume: sessionId` (本地 SQLite) | `resumeThread(threadId)` (本地 sessions/) | 语义等价 |
| **Hook 系统** | PreToolUse/PostToolUse/PreCompact/Stop（完整） | **无** | Codex 降级接受 |
| **Memory Wrapup** | PreCompact hook 触发 | Protocol Bridge token 追踪触发 | 行为等价（§3.5） |
| **上下文压缩** | SDK auto-compact + PreCompact hook | Codex CLI 内部管理 | 各自处理 |
| **扩展思考** | `maxThinkingTokens` | Codex CLI 配置 | 分别配置 |
| **Sub-agent** | `agents` 选项 (predefined agents) | Codex 内置 subagents | 分别实现 |
| **System prompt** | `systemPrompt.append` / preset | `.codex/instructions.md` 文件 | Context Builder 统一写入 |
| **Working directory** | `cwd` 选项 | `workingDirectory` 选项 | Adapter 内部处理 |
| **结构化输出** | 无直接支持 | `outputSchema` JSON Schema | Codex 优势 |
| **图片输入** | 支持 | 支持（local_image） | 统一 ✓ |

### Codex CLI 内置工具说明

Codex CLI 自带的工具（不需要手写，替代现有 `local-tools.ts`）：

- **Shell execution**：等价 Bash/Read/Grep/Glob。OS 级沙箱限制（比 `assertWithinWorkspace()` 更强）
- **File patch**：等价 Edit/Write。基于 patch 格式的文件修改
- **Web search**：内置 web 搜索
- **Subagents**：并行子任务执行
- **Todo list**：任务规划追踪

---

## 11. 实施计划

**原则**：每个 Phase 独立可交付、独立可验证。不要求前一个 Phase 完成才能开始下一个（除非有显式依赖）。

### Phase 1: Credential Manager（独立模块，无依赖）

1. 实现 `src/credential-manager.ts`
2. 整合现有的 `getClaudeProviderConfig()`、`getOpenAIProviderConfig()`、飞书 OAuth
3. 统一凭据读取/刷新/存储接口
4. 新增通用 HTTP 端点 `GET /api/internal/credentials/:provider`（扩展现有 `/api/internal/memory/openai-credentials` 模式）
5. 迁移 `container-runner.ts` 中的环境变量注入逻辑
6. **验证**：所有现有凭据消费方切换到 Credential Manager，行为不变

### Phase 2: SDK Adapter 抽取 + Claude Adapter（核心重构）

1. 创建 `container/sdk-adapter/` 共享包
2. 定义 `PushModelAdapter` / `TurnModelAdapter` / `AdapterEvent` 接口
3. 实现 Claude Adapter（从现有 `agent-runner/src/index.ts` 提取 SDK 调用逻辑）
4. 实现 EventNormalizer 层（~30 行适配层，让 stream-processor 基本不动）
5. stream-processor.ts → 适配为 `convertClaudeMessage()` 纯函数
6. **验证**：agent-harness + Claude Adapter 替代现有 agent-runner，端到端可用

### Phase 3: Agent Harness Protocol Bridge

1. 创建 `container/agent-harness/` 项目结构
2. 实现 Protocol Bridge（stdin/stdout + IPC + 活动看门狗 + 错误恢复 + memory wrapup token 追踪）
3. Context Builder（从 agent-runner 提取上下文构建逻辑）
4. Stream Converter（含 EventNormalizer）
5. MCP Server（从 agent-runner-core plugins 包装）
6. **验证**：agent-harness 替代 agent-runner，宿主机侧 container-runner.ts 只改 spawn 路径

### Phase 4: Hook 迁移（仅 Claude 侧）

1. 实现 Hook Manager（Claude 侧包装 HookCallback）
2. 迁移 gatekeeper / loop-detect / code-review 核心逻辑
3. Hook 执行记录写入 StreamEvent（Web UI 可视化）
4. **验证**：safety hooks 在 Claude Adapter 下行为与迁移前一致

### Phase 5: Codex SDK Adapter

依赖：Phase 2（adapter 接口）

1. 安装 `@openai/codex-sdk`，验证 Codex CLI 二进制在容器内可运行
2. 实现 Codex Adapter（`codex-adapter.ts`）
3. 实现 `convertCodexEvent()` 事件转换
4. Context Builder 适配（`.codex/instructions.md` 写入）
5. MCP 配置注入（config.toml 或 Codex SDK config）
6. 会话管理（thread.id 持久化 + resumeThread）
7. Memory wrapup token 追踪集成
8. **验证**：双 SDK 可切换，同一会话文件夹可以在 Claude/Codex 间切换 provider（新会话）

### Phase 6: Memory Agent 适配

依赖：Phase 2（sdk-adapter 包）

1. memory-agent 内部改为通过 sdk-adapter 调用 SDK
2. Codex 侧 system prompt 重写（Claude 工具名 → shell 命令，~160 行）
3. 验证 Codex 侧的文件操作行为（sandboxMode 限制、路径处理）
4. **验证**：四种操作（query/remember/session_wrapup/global_sleep）在两个 SDK 下行为一致

### Phase 7: Skill 迁移 + 清理

1. feishu-docs skill（services/ + cli/ + SKILL.md + 凭据走 HTTP 端点）
2. cross-model MCP tool 重构（合并 ask_model + delegate_task，支持 --agent 参数）
3. 删除 agent-runner/、agent-runner-openai/
4. 删除 context-compressor.ts（迁移到 compression-manager.ts）
5. 更新 CLAUDE.md、CLAUDE-full.md、Makefile
6. agent-runner-core 清理无用 export

---

## 12. 风险与待确认

| 风险 | 影响 | 缓解 |
|------|------|------|
| Codex SDK 成熟度（v0.116.0） | API 可能变 | 通过 SdkAdapter 接口隔离，SDK 变动只影响 codex-adapter.ts |
| Codex CLI 二进制在容器内运行 | Rust 二进制可能有 glibc 兼容问题 | 提前验证：在 node:22-slim 容器内测试 Codex CLI |
| Codex CLI OS 沙箱在 Docker 内的行为 | Seatbelt (macOS) 不适用于 Linux 容器；Landlock 需要内核 5.13+ | 确认 Docker 宿主机内核版本；必要时用 `sandboxMode: "danger-full-access"` + 容器级隔离 |
| Codex OAuth token 在容器内的刷新 | `~/.codex/` 需要可写挂载 | 挂载 `data/sessions/{folder}/.codex/` 为 rw |
| Codex 事件粒度粗（item 级别） | 前端打字机效果变粗糙 | 接受降级；或在 item.updated 事件内做文本 diff 模拟逐字输出 |
| Codex MCP 配置灵活度 | config.toml 可能不支持动态 MCP server | 备选：MCP tools 注入 instructions，通过 shell 调用 MCP client |
| sdk-adapter 作为共享包的构建复杂度 | monorepo 内多包依赖管理 | 用 npm workspaces，构建顺序：sdk-adapter → agent-harness / memory-agent |
| Memory agent 换 SDK 后行为偏差 | system prompt 280 行精细规范，不同模型遵循度不同 | 先用 Claude SDK 验证 adapter 正确性，再切 Codex 逐步验证 |
| 会话状态跨 SDK 不兼容 | 换 provider 后历史会话丢失 | 接受——换 provider 就是新会话 |
| Protocol Bridge 复杂度 | 从 1727 行 index.ts 迁移，容易遗漏边界情况 | 完整职责清单（§3.1）逐项核对 + 端到端测试 |

### 待验证事项（PoC）

在正式开发前需要验证：

1. **Codex CLI 在 Docker 容器内能否正常运行**：安装 `@openai/codex`，在 node:22-slim 容器内执行简单任务
2. **Codex SDK MCP 配置**：验证 config.toml 的 MCP server 配置是否能在 SDK 调用中生效
3. **Codex OAuth 在容器内**：预配置 `~/.codex/` 目录后，Codex CLI 能否正常认证
4. **事件流完整性**：`thread.runStreamed()` 的事件是否足够重建 StreamEvent（特别是 tool 的 start/end 时机）

---

## 附录 A：为什么两侧用不同的 SDK 策略

| | Claude 侧 | Codex 侧 |
|---|---|---|
| **SDK 选择** | Claude Agent SDK（直调 SDK） | Codex SDK（包装 CLI 二进制） |
| **原因** | Claude Agent SDK 提供 in-process 调用、完整 Hook 系统、精细事件流 | Codex SDK 是唯一能用 ChatGPT OAuth 的编程接口；Codex CLI 自带 OS 级沙箱 |
| **Hook** | 完整：PreToolUse/PostToolUse/PreCompact/Stop | 无：可接受降级（沙箱替代 gatekeeper，token 追踪替代 PreCompact） |
| **性能** | in-process，无额外进程开销 | spawn Rust 子进程，有启动开销 |
| **MCP** | in-process MCP server | config 注入 MCP server |
| **事件粒度** | 逐 token（text_delta） | item 级别（粗糙） |

两侧策略不对称是有意为之——Claude Agent SDK 能力更强，应该充分利用；Codex 侧用 SDK 包装 CLI 虽然粒度粗，但获得了 OAuth 支持和 OS 沙箱，tradeoff 合理。

## 附录 B：Codex SDK 关键能力参考

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
