# 单用户多 Session 与 Runner 平台化重构规划

## 1. 结论

本次重构不应被视为若干独立功能调整，而应被视为一次架构转向：

```text
当前：多用户隔离 Agent 平台
目标：单用户多 Session Agent Workbench
```

这次转向包含五个核心变化：

1. 删除多用户、权限、邀请码、计费等平台能力
2. 删除 Docker 与 host/container 双执行模式
3. 将多工作区降级为多 Session，不再做 ownership / home / member 隔离
4. 将 memory 纳入统一 runner 体系，但保留其特殊 orchestration 语义
5. 删除应用层鉴权管理，鉴权完全下沉到各 runner 实际调用的服务内部处理

关键判断：

- 现有系统已经具备较好的执行层抽象
- 现有系统的主要复杂度不在 runner，而在 `group/home/user/container` 这套对象模型
- 如果不先把对象模型改掉，后续继续接更多 runner 只会把旧架构继续固化

因此推荐的优先级不是先继续接 runner，而是先完成模型重构。

---

## 2. 当前架构为什么不适合直接演进

### 2.1 当前核心对象不是 runner，而是 group

当前系统里，`registered_groups` 承载了过多职责：

- 聊天入口
- 工作目录
- owner 归属
- home 语义
- host/container 执行模式
- IM 路由目标
- memory 归属
- skills / mcp / model 配置

这意味着 `group` 不是一个轻量聊天会话，而是一个重型平台对象。

### 2.2 当前真实依赖图

```text
Web / IM / Task
   │
   ▼
group / folder / owner / home 语义
   │
   ├─ created_by
   ├─ is_home
   ├─ executionMode
   ├─ group_members
   ├─ target_main_jid / target_agent_id
   └─ folder sibling routing
   │
   ▼
GroupQueue / TurnManager / DB state
   │
   ▼
container-runner / host-runner
   │
   ▼
agent-runner
   ├─ Claude
   └─ Codex
```

### 2.3 关键耦合点

#### 多用户耦合

- `users`
- `user_sessions`
- `group_members`
- `permissions`
- `invite_codes`
- per-user IM 配置
- per-user home group
- per-user memory 目录

#### 鉴权管理耦合

- 应用层 auth mode
- provider 级 API key / token 配置入口
- 登录态与 provider 调用权限的混用
- 将“谁能使用系统”和“runner 如何向外部服务鉴权”绑在一起

#### 执行模式耦合

- `executionMode = host | container`
- Docker image build
- volume mounts
- uid / chmod 修复
- host 与 container 的环境注入分叉

#### 会话语义耦合

- `home group`
- `folder -> sibling jid`
- `target_main_jid`
- `target_agent_id`
- `group.created_by`

#### Memory 归属耦合

- memory 按 user 或 home group 组织
- transcript export 和 wrapup 通过 owner / folder 推导
- memory 进程与主运行时是两套系统

---

## 3. 重构目标

### 3.1 新的产品定位

目标不是继续做一个多租户平台，而是做一个单用户本地 workbench：

- 一个使用者
- 多个 Session
- 每个 Session 可选择 runner / model / cwd
- Session 可以绑定 IM 渠道
- Memory 也是一种特殊 profile，而不是独立的特化系统
- runner 调用外部服务时的鉴权由其自身处理，应用层不保存、不分发、不推断 provider 凭据

### 3.2 目标架构

```text
单用户应用
├─ Sessions
│  ├─ main
│  ├─ workspace
│  ├─ worker
│  └─ memory
├─ Runner Registry
│  ├─ claude
│  ├─ codex
│  └─ future CLI runners
├─ Session Runtime Manager
│  ├─ queue
│  ├─ turn
│  ├─ interrupt / drain / resume
│  └─ observability
└─ Channel Bindings
   ├─ IM channel -> session
   └─ Web UI -> session
```

### 3.3 新的第一原则

1. `Session` 是一等对象，`group` 退出核心模型
   这里的 `Session` 指可独立运行、可持有 runtime state 的执行会话，不包括纯 IM 绑定行
2. `cwd` 是 Session 属性，不再引出隔离语义
3. `runner_id` 是 Session 属性，不再使用 `llm_provider` 双分支
4. IM 只绑定 Session，不再绑定 home/main/agent 双层目标
5. memory 通过统一 runner 执行，但保留专门的 request protocol 和 orchestration
6. 最终状态下，应用层不再承担 provider 鉴权职责，不感知 token、apikey、oauth session 等 runner 内部认证细节

---

## 4. 新数据模型

## 4.1 建议的新表

### sessions

所有交互型和内部型会话的统一模型。

建议字段：

```text
id TEXT PRIMARY KEY
name TEXT NOT NULL
kind TEXT NOT NULL
parent_session_id TEXT
cwd TEXT NOT NULL
runner_id TEXT NOT NULL
runner_profile_id TEXT
runtime_mode TEXT NOT NULL DEFAULT 'container'
model TEXT
thinking_effort TEXT
context_compression TEXT DEFAULT 'off'
knowledge_extraction INTEGER DEFAULT 0
is_pinned INTEGER DEFAULT 0
archived INTEGER DEFAULT 0
created_at TEXT NOT NULL
updated_at TEXT NOT NULL
```

`kind` 建议枚举：

- `main`
- `workspace`
- `worker`
- `memory`

补充约束：

- `sessions.id` 是应用层稳定 Session 主键
- provider 自己的 session 或 thread 标识不能作为主键
- `parent_session_id` 用于表达 `worker -> main/workspace` 这类从属关系
- `runtime_mode` 是过渡期兼容字段，只用于承接当前 `executionMode = host | container`
- Phase 3 删除 dual mode 之后，这个字段应一并移除

这里必须明确：

- 不是所有 `registered_groups` 行都迁成 `sessions`
- 只有当前真正能独立承接 runtime 的对象才迁成 Session
- 当前自动注册的 IM group 行、以及只负责绑定到主会话或 agent 的路由行，应迁入 `session_bindings`

### session_bindings

IM 渠道与 Session 的绑定关系。

```text
channel_jid TEXT PRIMARY KEY
session_id TEXT NOT NULL
binding_mode TEXT NOT NULL
activation_mode TEXT NOT NULL DEFAULT 'auto'
require_mention INTEGER DEFAULT 0
display_name TEXT
created_at TEXT NOT NULL
updated_at TEXT NOT NULL
```

`binding_mode` 建议枚举：

- `direct`
- `source_only`
- `mirror`

这里需要一并承接当前 IM 绑定上的门控语义：

- `activation_mode`
- `require_mention`

这里承接的不是“Session 本体”，而是当前这几类绑定语义：

- 自动注册 IM group 指向 home 或 workspace 主会话
- IM group 显式绑定到 `target_main_jid`
- IM group 显式绑定到 `target_agent_id`
- 当前 `reply_policy = source_only | mirror`

也就是说，现有 `registered_groups` 里相当一部分记录，迁移后应只留下 channel binding，不应继续保留为 Session 实体。

### session_state

provider/runtime 的持久状态，替代当前散落的 resume state。

```text
session_id TEXT PRIMARY KEY
provider_session_id TEXT
resume_anchor TEXT
provider_state_json TEXT
recent_im_channels_json TEXT
im_channel_last_seen_json TEXT
current_permission_mode TEXT
last_message_cursor TEXT
updated_at TEXT NOT NULL
```

这里不要只按“resume state”理解。至少要覆盖当前 runtime 已经显式维护的会话级状态：

- 这里的 `session_id` 指 `sessions.id`
- `provider_session_id` 才是 runner 自己的会话标识
- resume anchor
- provider-specific state
- recent IM channels
- IM channel lastSeen
- current permission mode

否则 Phase 0 即使完成双写，也会先把当前 Claude compact 后依赖的 routing reminder 连续性做丢。

同时要明确：

- 不能用 provider `session_id` 作为 `session_state` 主键
- 因为当前恢复失败后，provider session 可能被重建，但应用层 Session 身份不能漂移
- 当前旧 `sessions(group_folder, agent_id, session_id)` 表里存的是 provider session id，不是新 `session_state` 的主键

### worker_sessions

用于承接当前 `agents` 表承载的 worker 或 sub-agent 元数据。

```text
session_id TEXT PRIMARY KEY
parent_session_id TEXT NOT NULL
source_chat_jid TEXT NOT NULL
name TEXT NOT NULL
kind TEXT NOT NULL
prompt TEXT NOT NULL
status TEXT NOT NULL
created_at TEXT NOT NULL
completed_at TEXT
result_summary TEXT
```

这里不是再造一套独立 Session，而是补齐 `sessions(kind='worker')` 不适合直接承载的 worker 元数据：

- 原始 prompt
- 名称
- worker 类型
- worker 状态
- 完成摘要
- 从哪个主会话派生

`kind` 至少要覆盖当前 `agents.kind` 的现状：

- `task`
- `conversation`

否则无法承接当前“只有 conversation agent 可以绑定 IM”的现有语义。

这样才能完整替代当前 `agents` 表，以及现有 `target_agent_id -> virtual jid -> worker runtime` 这条链路。

### runner_profiles

runner 的配置实例，不再把 provider 配置硬拆成 Claude 和 Codex 两套页面模型。

这里的 `config_json` 应只承载 runner 行为配置，不承载应用层代管的 provider 凭据。

```text
id TEXT PRIMARY KEY
runner_id TEXT NOT NULL
name TEXT NOT NULL
config_json TEXT NOT NULL
is_default INTEGER DEFAULT 0
created_at TEXT NOT NULL
updated_at TEXT NOT NULL
```

### app_state

单用户应用全局配置。

用于替代：

- appearance
- system defaults
- IM channels
- monitor preferences

---

## 4.2 旧表与新表映射

| 旧模型 | 新模型 | 处理方式 |
|------|------|------|
| `registered_groups` | `sessions + session_bindings` | 必须先拆成“可独立运行的 Session”与“纯渠道绑定”两类，不能整表平移 |
| `group_members` | 删除 | 单用户后无意义 |
| `users` | 删除或退化为单管理员表 | 推荐极简化 |
| `invite_codes` | 删除 | 无意义 |
| `billing_*` | 删除 | 无意义 |
| 自动注册 IM group 行 | `session_bindings` | 不再作为 Session 实体存在 |
| `target_main_jid` | `session_bindings.session_id` | 显式绑定 |
| `target_agent_id` | `session_bindings.session_id` | 仅在 worker session 元数据与虚拟路由一起迁完后替换 |
| `reply_policy` / `activation_mode` / `require_mention` | `session_bindings` | 保留 IM 渠道门控与回流策略 |
| `sessions` 旧表 | `session_state.provider_session_id` | 不能直接平移，需按稳定的 `sessions.id` 反查写入；其中 `agent_id=''` 是主会话，其余是 worker / sub-agent 会话 |
| `agents` | `sessions(kind='worker') + worker_sessions` | 不能只迁 session id，必须把 prompt/status/result_summary/parent 关系一起迁移 |
| `llm_provider` | `runner_id` | 扩展为 registry |
| `executionMode` | `sessions.runtime_mode` | 仅作过渡承接，Phase 3 删除 dual mode 时一并删除 |
| provider 鉴权配置 | 迁移后删除 | 在 runner 自鉴权链路落地前保留兼容桥接 |

---

## 5. Runtime 目标设计

### 5.1 执行层保留什么

以下执行层资产值得保留：

- `TurnManager`
- `query-loop`
- `AgentRunner` 接口
- `StreamEvent` 协议
- `ContextManager`
- shared plugins
- transcript export
- context compression

这些已经是平台化方向的资产，不应推翻重写。

### 5.2 执行层要重命名什么

建议把这些名称改掉，以免旧语义继续渗透：

| 旧名称 | 新名称 |
|------|------|
| `GroupQueue` | `SessionRuntimeManager` |
| `container-runner.ts` | `session-launcher.ts` 或 `runtime-launcher.ts` |
| `runContainerAgent` | `runSessionAgent` |
| `groupFolder` | 过渡期保留 `sessionKey`，最终收敛到 `sessionId` |

### 5.3 删除 host/container 双路径

目标状态：

```text
SessionRuntimeManager
   └─ 本地子进程
      └─ agent-runner
```

不再存在：

- Docker build
- container volume mount
- chmod 修复
- host/container capability 分叉
- Monitor 页面中的 Docker 指标

保留：

- `cwd`
- 路径白名单
- interrupt / drain / restart
- 统一 runtime env 注入

如果 Phase 2 先于 Phase 3 执行，那么新的 `sessions` 模型必须暂时承接 `runtime_mode`，否则主链路仍在依赖的 host 和 container 分支会失去落点。

---

## 6. Runner Registry 设计

## 6.1 为什么必须先有 registry

当前 `llm_provider` 只表达：

- `claude`
- `openai -> codex`

这只够容纳双 provider 特例，不够容纳未来的 runner 平台。

未来应改为：

```ts
interface RunnerDescriptor {
  id: string
  label: string
  supports: RunnerCapabilities
  defaultProfileFactory?: () => object
}
```

### 6.2 不能只抽象 query loop

如果只保留当前这类抽象：

```text
runner = 能 initialize / runQuery / interrupt 的对象
```

那它只够解决“怎么跑一轮 turn”，不够解决“这个 runner 在平台里能不能承接 memory、任务、IM、多轮恢复、前端观测”。

真正需要的平台判断不是：

- 这个 runner 能不能跑

而是：

- 这个 runner 的会话连续性有多强
- 这个 runner 的工具注入能力是什么形态
- 这个 runner 有没有原生 lifecycle / hook 事件
- 如果没有原生 hook，平台能不能模拟出等价语义

因此 `RunnerRegistry` 不能只有一个轻量 label 列表，必须升级为工程级 contract。

### 6.3 工程级 RunnerDescriptor

建议改为：

```ts
interface RunnerDescriptor {
  id: string
  label: string
  capabilities: RunnerCapabilities
  lifecycle: RunnerLifecycleCapabilities
  promptContract: RunnerPromptContract
  defaultProfileFactory?: () => object
}
```

### 6.4 RunnerCapabilities

`RunnerCapabilities` 解决的是“执行期能力”和“交互期能力”，不解决 hook/lifecycle。

```ts
interface RunnerCapabilities {
  sessionResume: 'none' | 'weak' | 'strong'
  interrupt: 'none' | 'weak' | 'strong'
  imageInput: boolean
  usage: 'none' | 'approx' | 'exact'
  midQueryPush: boolean
  runtimeModeSwitch: boolean
  toolStreaming: 'none' | 'coarse' | 'fine'
  backgroundTasks: boolean
  subAgent: 'native' | 'tool-only' | 'none'
  customTools: 'native' | 'mcp' | 'none'
  mcpTransport: Array<'stdio' | 'http' | 'sse'>
  skills: Array<'native' | 'tool-loader'>
}
```

这里要特别注意：

- `sessionResume` 不能只用 boolean，因为“能恢复”和“能可靠恢复到什么粒度”不是一回事
- `customTools` 与 `mcpTransport` 需要单独声明，否则前端和 settings 无法判断某 runner 是否支持用户自定义工具
- `skills` 不能只用单值枚举，因为有些 runner 同时存在 native skill 与 tool-loader 兼容路径
- `toolStreaming` 不能只用 boolean，因为“完全没有流式”和“只有粗粒度 item/tool 事件”不是一回事

### 6.5 RunnerLifecycleCapabilities

这是当前设计里最缺的一层，也是 memory、归档、compact、host 安全兜底最依赖的一层。

平台不能只问“这个 runner 有没有 hook”，而要问“这个 runner 能不能提供等价的生命周期语义”。

```ts
interface RunnerLifecycleCapabilities {
  turnBoundary: 'native' | 'simulated'
  archivalTrigger: Array<'pre_compact' | 'turn_threshold' | 'cleanup_only' | 'external'>
  contextShrinkTrigger: 'native_event' | 'synthetic' | 'none'
  beforeToolExecutionGuard: 'native_hook' | 'tool_wrapper' | 'sandbox_only' | 'none'
  hookStreaming: 'none' | 'begin_end' | 'progress'
  postCompactRepair: 'native' | 'synthetic' | 'none'
}
```

这些字段的意义：

- `turnBoundary`
  表示平台是否能稳定知道“一轮结束了”
- `archivalTrigger`
  表示对话归档与 `session_wrapup` 可由哪些触发点驱动
- `contextShrinkTrigger`
  表示 compact 或等效上下文收缩之后，平台能否收到一个可观测的事件
- `beforeToolExecutionGuard`
  表示安全兜底是在 runner 原生 hook、工具包装器还是纯 sandbox 上完成
- `hookStreaming`
  表示前端能否看到 hook 生命周期
- `postCompactRepair`
  表示 compact 后的 routing reminder、补系统约束等修复逻辑，是原生事件驱动还是平台模拟

### 6.6 Native Hook 与 Synthetic Hook 要分开建模

未来接更多 CLI coding runner 时，不能假设所有 runner 都像 Claude 一样有 `PreCompact`、`PreToolUse`、`compact_boundary`。

因此平台需要承认两种实现方式：

```text
Native Hook
├─ runner 自己提供 lifecycle / hook 事件
└─ 例如 PreCompact / PreToolUse / compact_boundary

Synthetic Hook
├─ 平台在 runner 外层模拟出等价语义
└─ 例如 token 阈值归档 / cleanup 强制 flush / tool wrapper
```

几个典型例子：

- 没有 `PreCompact`
  可降级为“按 token 阈值归档 + runner cleanup 时强制归档”
- 没有 `compact_boundary`
  可降级为“上下文收缩完成后由平台主动补发 routing reminder”
- 没有 `PreToolUse`
  可降级为“工具包装器检查”或“仅依赖 sandbox”

但要注意：

- 平台可以接受没有原生 hook
- 平台不能接受 lifecycle 语义完全缺失且又无人声明

### 6.7 哪些能力必须支持，哪些可以降级

对于交互型 coding runner，建议最低接入标准如下：

| 类别 | 能力 | 级别 |
|------|------|------|
| 执行 | `runQuery` / `interrupt` / `cwd` | 必须 |
| 会话 | `sessionResume` | 必须声明，允许 `none` |
| 工具 | `customTools` | 必须声明，`none` 代表不能承接完整 coding 场景 |
| 生命周期 | `turnBoundary` | 必须 |
| 生命周期 | `archivalTrigger` | 必须 |
| 生命周期 | `contextShrinkTrigger` | 必须声明，允许 `none` |
| 错误语义 | context overflow / resume failed / unrecoverable transcript 分类 | 强烈建议 |
| 观测 | `usage` / `toolStreaming` / `hookStreaming` | 可降级 |
| 交互 | `midQueryPush` / `runtimeModeSwitch` | 可降级 |

也就是说，平台要接受下面这种 runner：

```text
能跑
+ 能中断
+ 能声明 resume 强弱
+ 能注入工具
+ 能提供 turn / archive / cleanup 语义
- 但没有 mid-query push
- 也没有 hook streaming
```

但平台不应接受下面这种 runner 直接进入主路径：

```text
只能单次执行
完全没有工具注入
没有明确的 turn 边界
没有归档/cleanup 触发点
没有任何 lifecycle 声明
```

### 6.8 RunnerPromptContract

prompt 注入方式也需要显式声明，否则后续会继续把 provider 特性硬编码在 runner 内部。

```ts
interface RunnerPromptContract {
  mode: 'append' | 'full_prompt' | 'instructions_file'
  dynamicContextReload: 'none' | 'turn' | 'mid_turn'
}
```

这决定：

- ContextManager 产出的内容如何交给 runner
- `contextSummary`、recent channels、memory recall 何时重载
- compact 后是否需要下一轮重新注入修复提示

### 6.9 TypeScript 级正式接口草案

下面这版接口不是示意图，而是建议后续直接落到代码里的正式 contract。

```ts
type ResumeStrength = 'none' | 'weak' | 'strong'
type InterruptStrength = 'none' | 'weak' | 'strong'
type UsageQuality = 'none' | 'approx' | 'exact'
type ToolStreamingMode = 'none' | 'coarse' | 'fine'
type SubAgentMode = 'native' | 'tool-only' | 'none'
type CustomToolsMode = 'native' | 'mcp' | 'none'
type SkillsMode = 'native' | 'tool-loader'
type McpTransport = 'stdio' | 'http' | 'sse'

type TurnBoundaryMode = 'native' | 'simulated'
type ArchivalTrigger =
  | 'pre_compact'
  | 'turn_threshold'
  | 'cleanup_only'
  | 'external'
type ContextShrinkTriggerMode = 'native_event' | 'synthetic' | 'none'
type BeforeToolExecutionGuardMode =
  | 'native_hook'
  | 'tool_wrapper'
  | 'sandbox_only'
  | 'none'
type HookStreamingMode = 'none' | 'begin_end' | 'progress'
type PostCompactRepairMode = 'native' | 'synthetic' | 'none'

type PromptMode = 'append' | 'full_prompt' | 'instructions_file'
type DynamicContextReloadMode = 'none' | 'turn' | 'mid_turn'

interface RunnerCapabilities {
  sessionResume: ResumeStrength
  interrupt: InterruptStrength
  imageInput: boolean
  usage: UsageQuality
  midQueryPush: boolean
  runtimeModeSwitch: boolean
  toolStreaming: ToolStreamingMode
  backgroundTasks: boolean
  subAgent: SubAgentMode
  customTools: CustomToolsMode
  mcpTransport: McpTransport[]
  skills: SkillsMode[]
}

interface RunnerLifecycleCapabilities {
  turnBoundary: TurnBoundaryMode
  archivalTrigger: ArchivalTrigger[]
  contextShrinkTrigger: ContextShrinkTriggerMode
  beforeToolExecutionGuard: BeforeToolExecutionGuardMode
  hookStreaming: HookStreamingMode
  postCompactRepair: PostCompactRepairMode
}

interface RunnerPromptContract {
  mode: PromptMode
  dynamicContextReload: DynamicContextReloadMode
}

interface RunnerCompatibility {
  chat: 'full' | 'degraded' | 'unsupported'
  memory: 'full' | 'synthetic' | 'unsupported'
  im: 'full' | 'degraded' | 'unsupported'
  observability: 'full' | 'degraded' | 'unsupported'
}

interface RunnerDescriptor {
  id: string
  label: string
  capabilities: RunnerCapabilities
  lifecycle: RunnerLifecycleCapabilities
  promptContract: RunnerPromptContract
  compatibility: RunnerCompatibility
  defaultProfileFactory?: () => object
}
```

推荐配套两条规则函数：

```ts
function canServeAsMemoryRunner(d: RunnerDescriptor): boolean
function explainRunnerDegradation(d: RunnerDescriptor): string[]
```

用途：

- `canServeAsMemoryRunner`
  用于 settings、runtime 校验和迁移脚本
- `explainRunnerDegradation`
  用于 Session 编辑页、Memory 页面、Monitor 页面展示降级说明

### 6.10 初版 Capability Matrix

下面这张表的目的不是做长期文档展示，而是作为当前代码状态的基线。
后续每接一个 runner，都应先补 matrix，再补实现。

#### 执行与工具能力

| runner | `sessionResume` | `interrupt` | `customTools` | `mcpTransport` | `skills` | `midQueryPush` | `runtimeModeSwitch` | `toolStreaming` | `backgroundTasks` | `subAgent` |
|------|------|------|------|------|------|------|------|------|------|------|
| Claude 当前实现 | `strong` | `strong` | `mcp` | `stdio` | `['native', 'tool-loader']` | 当前代码已降为 `false` | 当前代码已降为 `false` | `fine` | `true` | `tool-only` |
| Codex 当前实现 | `weak` | `weak` | `mcp` | `stdio` | `['tool-loader']` | `false` | `false` | `coarse` | `false` | `tool-only` |
| future generic CLI runner 最低可接入线 | `none` 或更高 | `weak` 或更高 | `mcp` 或 `native` | 至少一种 | 任意，但必须声明 | `false` 可接受 | `false` 可接受 | `none` 可接受 | `false` 可接受 | `none` 可接受 |

说明：

- Claude 当前代码虽然底层具备更强的 query 内交互潜力，但现有 `AgentRunner` 暴露层已经按保守语义收敛
- Codex 的 `toolStreaming` 只能视为弱流式，因为缺少 token 级与 hook 级细粒度事件
- future generic CLI runner 不要求一步到位，但不能没有工具注入和中断能力

#### Lifecycle 与 Hook 能力

| runner | `turnBoundary` | `archivalTrigger` | `contextShrinkTrigger` | `beforeToolExecutionGuard` | `hookStreaming` | `postCompactRepair` | `memory` 兼容级别 |
|------|------|------|------|------|------|------|------|
| Claude 当前实现 | `native` | `['pre_compact']` | `native_event` | `native_hook` | `progress` | `native` | `full` |
| Codex 当前主路径 | `native` | `[]` | `none` | `sandbox_only` | `none` | `none` | `unsupported` |
| Codex 目标状态 | `native` | `['turn_threshold', 'cleanup_only']` | `synthetic` | `sandbox_only` | `none` | `synthetic` | `synthetic` |
| future generic CLI runner 最低可接入线 | `native` 或 `simulated` | 非空数组 | 允许 `none`，但必须声明 | 任意，但必须声明 | `none` 可接受 | `none` 可接受 | `synthetic` 或 `unsupported` |

这里要明确：

- Claude 是 native hook 主导型 runner
- Codex 方向上必须依赖 synthetic lifecycle
- generic CLI runner 允许没有原生 hook，但不能没有 archive / cleanup / turn boundary 语义

#### 当前代码状态下的关键结论

| 结论 | 判断 |
|------|------|
| Claude 已经具备完整 lifecycle 语义 | 是 |
| Codex 的 archive / wrapup fallback 已形成完整闭环 | 否，设计已明确但仍需接入主路径 |
| 仅凭当前 `AgentRunner` 接口就能判断 memory 兼容性 | 否，必须结合 lifecycle contract |
| 前端是否能展示 hook 过程可由现有接口稳定推导 | 否，必须看 `RunnerLifecycleCapabilities.hookStreaming` |

因此本次重构里，matrix 不是附录，而是 registry 的一部分。

### 6.11 Session 与 runner 的关系

每个 Session 持有：

- `runner_id`
- `runner_profile_id`
- `model`
- `thinking_effort`

这样可以支持：

- 同一 runner 多个 profile
- chat 与 memory 选择同 runner，不同 profile
- 某个 Session 独立覆盖 model

### 6.12 鉴权边界

新的边界应明确为：

```text
App / Session / Runtime
   └─ 只决定调用哪个 runner、用什么 profile、在哪个 cwd 运行

Runner
   └─ 自行决定如何向其实际调用的服务完成鉴权
```

最终目标下，这意味着应用层不再负责：

- 管理 provider API key / token
- 维护 provider 登录态
- 判断某个用户或某个 Session 是否“有权调用某 provider”
- 将应用内权限模型映射到外部服务认证模型

应用层只保留：

- Session 选择哪个 runner
- runner profile 的非敏感行为配置
- runtime 生命周期管理
- 审计、日志、失败观测

但迁移阶段必须单独说明一条现实约束：

- 在现有启动链路里，应用层仍负责把 Claude 和 Codex 的凭据、登录态和会话文件桥接给 runner
- 因此 provider 鉴权页面、配置存储和启动时注入逻辑，不能在 Phase 1 先删
- 正确顺序应是先落地 runner 自鉴权和启动契约，再删除应用层兼容桥接

---

## 7. Memory 的重构方案

## 7.1 目标

将当前独立的 memory agent 体系改造成：

```text
MemoryOrchestrator
├─ typed requests
│  ├─ query
│  ├─ remember
│  ├─ session_wrapup
│  └─ global_sleep
├─ memory profile
│  ├─ runner_id
│  ├─ profile
│  ├─ model
│  └─ state strategy
└─ execution backend
   └─ unified agent runner
```

## 7.1.1 Memory 不是只依赖 tool surface，也依赖 lifecycle 语义

memory 相关机制不能只看：

- 这个 runner 能不能调用 `memory_query`
- 这个 runner 能不能调用 `memory_remember`

还要看：

- 对话什么时候归档
- `session_wrapup` 什么时候触发
- compact 或等效上下文收缩之后，平台有没有机会补修复提示
- runner 退出时能不能做 cleanup flush

因此 MemoryOrchestrator 对 runner 的依赖，至少包括下面四类 lifecycle 语义：

| lifecycle 语义 | 用途 |
|------|------|
| `turnBoundary` | 判断何时做 query 后整理、观测与状态推进 |
| `archivalTrigger` | 触发 transcript export 与 `session_wrapup` |
| `contextShrinkTrigger` | compact 后补 routing reminder、补记忆相关提示 |
| `cleanup` | runner 退出前补做 force wrapup / force archive |

如果一个 runner 没有原生 hook，但平台能通过 synthetic lifecycle 提供这些语义，那么 memory 仍然可以兼容。

如果这些语义不存在，memory 就不能被视为“只是换个 runner 就能跑”。

## 7.2 不能把 memory 简化成普通聊天 session

不建议的错误方向：

```text
memory = 普通 session + 一段不同的 prompt
```

原因：

- memory 有自己的 request protocol
- memory 有自己的文件权限边界
- memory 有自己的维护任务
- memory 的成功判定不是“回答一段文本”，而是“正确更新记忆结构”

所以 memory 应该依然保持专用 orchestration。

## 7.3 建议保留的 memory 分层

### MemoryOrchestrator

职责：

- 接收请求
- 控制并发
- 处理 timeout / retry / lock
- 管理 transcript export
- 调度 session_wrapup / global_sleep

### MemoryRunnerAdapter

职责：

- 用统一 runner 执行 memory profile
- 处理 resume / restart / fallback
- 提供 typed result
- 根据 runner lifecycle 能力决定是否启用 native hook、synthetic hook 或强制降级路径

### MemoryProfile

职责：

- 限制工具集
- 限制可访问目录
- 提供 system prompt
- 控制模型与 runner

## 7.4 Memory profile 的特殊约束

建议能力约束如下：

| 能力 | 要求 |
|------|------|
| 文件读写 | 必须 |
| resume | 强烈建议 |
| 图片输入 | 不需要 |
| send_message | 禁止 |
| tasks | 禁止 |
| invoke_agent 递归 | 禁止 |
| Web / IM 路由 | 不需要 |
| usage | 可选 |

## 7.5 Memory 与 chat 的耦合边界

允许共享：

- runner registry
- runtime launcher
- process lifecycle
- stream event protocol

不应共享：

- prompt
- tool surface
- state semantics
- success criteria

## 7.6 Memory 对 runner 的兼容策略

建议将 memory 的兼容策略写成明确规则，而不是散落在 provider 实现里：

### A. 原生支持型

条件：

- runner 提供 `archivalTrigger = pre_compact`
- runner 提供 `contextShrinkTrigger = native_event`

行为：

- 直接使用 runner 原生 compact / hook 语义
- `session_wrapup` 由 native hook 驱动

### B. 模拟支持型

条件：

- runner 没有 native compact hook
- 但平台可提供 `turnBoundary`、`cleanup`、token usage 或其他阈值信号

行为：

- 按 token / turn 阈值触发 archive
- 在 cleanup 时强制 flush
- 将 `session_wrapup` 挂到 synthetic archive 完成后
- 将 post-compact repair 挂到 synthetic context-shrink 之后

### C. 不支持型

条件：

- 无工具注入
- 无稳定 turnBoundary
- 无 archive / cleanup 触发点

行为：

- 不允许作为 memory runner
- 只能作为受限 chat runner，或根本不接入

## 7.7 Memory ownership 必须先显式化，再谈 runner 化

当前 memory 不是按 Session 组织，而是按 user 或 home group 组织：

- 目录是 `data/memory/{userId}`
- transcript export 通过 owner 或 home 语义推导
- `global_sleep` 也是按 user 扫描

因此在 Memory Runner 化之前，必须先补一层显式 ownership：

```text
Memory Owner Key
├─ 可以先等于旧 userId
├─ 但不能再由 `created_by` / `home group` 临时推导
└─ 需要被 Session、memory state、global_sleep 调度共同引用
```

建议要求：

- 先把 memory 路径解析从“运行时推导 user 或 home”改成“读取显式 owner key”
- 物理目录可以在一段兼容期内继续放在 `data/memory/{ownerKey}`
- 但 ownership 语义必须先脱离 `created_by`、`is_home`、`ownerHomeFolder`

否则 Phase 2 声称“runtime 与 memory 路径解析不再依赖 `created_by`”就无法成立。

---

## 8. 前端与路由层重构方向

## 8.1 页面结构应如何变化

建议的设置页结构：

```text
Settings
├─ Runners
├─ Sessions
├─ Channels
├─ Memory
├─ Skills
├─ MCP Servers
├─ Agent Definitions
└─ System
```

应删除：

- 用户管理
- 注册管理
- 权限相关说明
- 应用层鉴权配置入口
- billing 页面

### 8.2 群组页改为 Session 页

`GroupsPage` 和 `GroupDetail` 应整体改为：

- `SessionsPage`
- `SessionCard`
- `SessionDetail`

展示内容改为：

- name
- kind
- cwd
- runner
- model
- binding 状态
- memory / compression 配置

不再展示：

- owner
- member
- execution mode

但要注意两点：

- UI 可以不再展示 `owner/home` 术语
- runtime 与数据迁移阶段仍然需要显式承接“主会话”和“memory 归属”的现有语义，直到路径和 transcript export 全部从 `created_by / home group` 迁走

### 8.3 聊天页中的关键改造

当前聊天页和聊天视图大量依赖：

- `groupFolder`
- `is_home`
- `execution_mode`
- `created_by`
- `shared group`

这些都应被替换为：

- `sessionId`
- `sessionKind`
- `cwd`
- `binding summary`

### 8.4 Monitor 页的目标状态

Monitor 页面改为 runtime 监控：

- 运行中的 Session 数
- 活跃 turn 数
- background task 数
- runner 分布
- 失败重启记录

不再出现：

- Docker image build
- container 状态
- host/container 区分

---

## 9. 分阶段迁移计划

## Phase 0：兼容层与命名清理

目标：

- 不改变行为
- 先为后续重构建立新的语言层

动作：

1. 引入 `Session` 领域类型
2. 增加 `RunnerRegistry` 空壳
3. 在 runtime 层新增按 session 命名的新接口
4. `group -> session` 先通过 adapter 映射
5. 新增 `session_state` 表，先双写 runtime state

验收标准：

- 新代码不再扩散 `group/home/container` 术语
- 不影响现有行为

补充要求：

- `session_state` 的双写范围必须包含当前 `SessionState` 中已落盘的 IM channel state，而不是只写 session id / resume anchor
- Phase 0 必须定义清楚“谁负责回写 `session_state`”
- 当前 runtime state 分散在主进程 DB、agent-runner 内存和 IPC 文件，不能只加表不加回传链路
- 至少要有一条明确路径将 `provider_session_id`、`resume_anchor`、IM channel state、permission mode 从 runner 回写到主进程

## Phase 1：单用户化

目标：

- 删除多租户平台特征

动作：

1. 删除用户管理、邀请码、RBAC、计费
2. IM 配置改为全局单份配置
3. 应用层 provider 鉴权先收敛为兼容桥接层，停止扩散新的 provider 特化模型
4. 认证简化为单管理员模式，或直接无登录模式
5. 页面结构去掉 users / registration / billing
6. provider auth 页面可先折叠或标记为迁移兼容，不在本阶段强删

验收标准：

- 应用只有一个 operator
- 不再新增用户维度逻辑分支
- 核心入口可以在单 operator 假设下运行
- 现有 runner 仍可正常启动，不因过早删除凭据桥接而中断

这里不要把目标写得过头。当前 IM 连接选择、memory 路径鉴权、session_wrapup ownership 推导仍依赖 `user.id` 或 `created_by`。Phase 1 的正确目标是“收敛到单用户假设并停止继续扩散”，而不是在这一阶段就宣称所有用户维度分支已经消失。

## Phase 2：group -> session 模型替换

目标：

- 用 `sessions` 取代 `registered_groups`

动作：

1. 新建 `sessions` 与 `session_bindings`
2. 先把 `registered_groups` 拆成两类：
   - 可独立运行的 web workspace 或主会话，迁为 `sessions`
   - 自动注册 IM group 与纯路由行，迁为 `session_bindings`
3. 在 Phase 3 完成前，`sessions` 临时承接 `runtime_mode`，避免当前 host 和 container 分支失去配置来源
4. 将旧 `sessions(group_folder, agent_id, session_id)` 拆迁为 `session_state.provider_session_id` 与稳定的 `sessions.id`
5. 将 `agents` 迁为 `sessions(kind='worker') + worker_sessions`，并保留 `name`、`kind` 等当前 conversation agent 语义，同时替换现有 worker 虚拟 JID 与 agent 详情接口依赖
6. 先引入显式 memory owner key，再迁移 `data/groups/user-global/{userId}`、`data/memory/{userId}`、`ownerHomeFolder` 这类按用户推导的路径语义
7. 将 `reply_policy`、`activation_mode`、`require_mention` 迁入 `session_bindings` 或等价 channel policy
8. `GroupsPage` 改为 `SessionsPage`
9. `/api/groups` 系列路由迁移为 `/api/sessions`
10. 在上述迁移完成后，再移除 `home`、`created_by`、`group_members`
11. 在 worker session 路由、虚拟 JID、agent API 都迁完后，再移除 `target_main_jid`、`target_agent_id`

验收标准：

- Session 成为唯一一等交互对象
- IM 只绑定 Session
- runtime 与 memory 路径解析不再依赖 `created_by`
- worker 不再依赖旧 `agents + target_agent_id + virtual jid` 组合语义

## Phase 3：删除 Docker 与 dual mode

目标：

- 扁平化 runtime

动作：

1. 删除 Docker build / monitor
2. 删除 `executionMode`
3. 统一本地子进程 runtime
4. `GroupQueue` 重命名并重构为 `SessionRuntimeManager`

验收标准：

- 所有会话通过统一本地 runtime 执行
- 不再有 host/container 分支

## Phase 4：Runner Registry 平台化

目标：

- 新 runner 接入不再污染主流程

动作：

1. `llm_provider -> runner_id`
2. 引入工程级 `RunnerDescriptor`、`RunnerCapabilities`、`RunnerLifecycleCapabilities`
3. 将 Claude/Codex 配置改为 registry 驱动
4. 在 runner 自鉴权链路落地后，再移除 provider 鉴权表单与校验逻辑
5. Session 编辑页按 capabilities 与 lifecycle 能力展示约束
6. 为无原生 hook 的 runner 建立 synthetic lifecycle adapter
7. `invoke_agent` 改造为 registry 驱动

验收标准：

- 接入新 runner 时不需要修改 group/session 主模型
- 接入新 runner 时不需要在应用层新增任何 provider 鉴权管理流程
- memory、IM、前端观测不再依赖 provider 名字硬编码判断能力

## Phase 5：Memory Runner 化

目标：

- memory 统一进入 runner runtime，但仍保留自己的 orchestration

动作：

1. `MemoryAgentManager -> MemoryOrchestrator`
2. 保持 typed request API
3. 增加 memory profile
4. 允许单独选择 memory runner / model
5. 基于 `RunnerLifecycleCapabilities` 选择 native hook 或 synthetic hook 策略
6. 保留现有 memory prompt 与 typed request 逻辑
7. 目录结构允许物理兼容迁移，但不得再依赖 `created_by` / `home group` 临时推导 ownership

验收标准：

- 可切换 memory runner
- chat 与 memory 的语义边界清晰
- 对每个 memory runner，都能明确说明其 wrapup / archive / compact repair 来源
- memory ownership 已显式化，不再通过 user 或 home 关系临时反推

---

## 10. 保留 / 删除 / 重写清单

## 10.1 保留

- `TurnManager`
- `query-loop`
- `AgentRunner`
- `StreamEvent`
- `ContextManager`
- transcript export
- context compression
- shared plugins

## 10.2 删除

- 用户管理
- 权限系统
- 邀请码
- billing
- 应用层 provider 鉴权管理
- provider 登录态管理页面与接口
- Docker build / monitor
- host/container dual mode
- home group 语义
- group member 语义

上面两项仅在 runner 自鉴权落地后删除，不应前置。

## 10.3 重写

- `registered_groups` 模型
- session/binding API
- settings 导航结构
- IM binding 模型
- runtime state 存储路径
- runner descriptor / capability registry
- lifecycle compatibility layer
- memory orchestration backend
- provider config UI 为 runner registry UI

---

## 11. 风险与防守策略

## 11.1 风险：旧模型兼容时间过长

问题：

- `registered_groups` 兼容层如果拖太久，会让新模型持续被旧字段污染

策略：

- Phase 0 可以 adapter
- Phase 2 后必须切换主存储

## 11.2 风险：过早改 memory

问题：

- session 模型和 runtime 未稳定时就重做 memory，会导致两边一起漂移

策略：

- 先保留现有 memory protocol
- 最后替换执行 backend

## 11.3 风险：worker / memory / main 混成一类 session

问题：

- UI 和 runtime 都会变乱

策略：

- 一开始就定义 `sessions.kind`
- worker 与 memory 默认隐藏或单独分组

## 11.4 风险：术语不统一

问题：

- 代码改叫 session，页面仍然叫群组，会持续误导实现

策略：

- 术语一次性统一
- UI 与 route 名称一起改

## 11.5 风险：只抽象执行，不抽象 lifecycle

问题：

- 如果只抽象 `runQuery`、`interrupt` 这类执行接口，而不抽象 archive、compact、hook、cleanup 语义
- 那么 memory、IM routing repair、host 安全兜底仍然会继续绑定在 Claude 这类 provider 特例上
- 后续每接一个 runner，都要重新审源码判断能不能兼容 memory 与观测

策略：

- Phase 4 必须同时落地 `RunnerLifecycleCapabilities`
- 明确区分 native hook 与 synthetic hook
- memory 接入条件改为“是否具备所需 lifecycle 语义”，而不是“是不是某个已知 provider”

---

## 12. 推荐的第一阶段交付物

如果正式开工，建议第一阶段只做下面四项：

1. 完成 Phase 0：补 `session_state` 双写与 runtime 回传链路
2. 删除 users / registration / billing 入口与页面，provider auth 先保留为兼容层
3. 将 IM 配置改为全局单份配置，并同时梳理 binding 上的 `activation_mode` / `require_mention`
4. 在不切主存储的前提下，为 `GroupsPage` 和 `/api/groups` 增加 `Session` adapter 视图层

这四项完成后：

- 新方向被锁定
- 旧平台化语义开始退场
- 继续做 `group -> session` 硬切换、Docker 删除和 memory ownership 迁移时不会反复返工

---

## 13. 建议的实施策略

推荐采用长分支推进，不建议在主干上做碎片化兼容。

推荐顺序：

```text
0. Phase 0 兼容层与 session_state 双写
1. 单用户化
2. group -> session 硬切换
3. 删除 Docker
4. Runner Registry
5. Memory Runner 化
```

不推荐顺序：

```text
1. 先接更多 runner
2. 再慢慢删多用户和 Docker
```

原因：

- 这会让新 runner 被迫适配旧对象模型
- 会把 `group/home/container/user` 继续固化到更多模块中

---

## 14. 最终目标状态

最终系统应当像这样：

```text
单用户 Agent Workbench
├─ Session 列表
│  ├─ main
│  ├─ repo-a
│  ├─ repo-b
│  ├─ worker-x
│  └─ memory
├─ 每个 Session 可选 runner / profile / model / cwd
├─ IM channel 可直接绑定任意 Session
├─ 应用层不管理任何 provider 鉴权，runner 自行完成外部服务认证
├─ Memory 使用专门 profile，通过统一 runner 执行
└─ 新增 runner 时，只需注册 descriptor 与 adapter
```

达到这个状态后，项目才算真正准备好承接“越来越多的 CLI coding runner”。
