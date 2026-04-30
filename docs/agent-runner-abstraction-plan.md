# Agent Runner 抽象改造方案

本文档描述 HappyClaw 当前 Agent Runner 抽象的不足、目标状态、完整改造方案和验收标准。

目标不是为了最小变更接入某一个新命令行工具，而是把 runner 做成项目内的一等扩展对象。改造完成后，新增一个命令行类 agent 工具时，主要工作应集中在实现该工具的 runner adapter，而不是在后端、前端、memory、prompt、invoke_agent 等多个位置补硬编码分支。

> 实施状态：核心改造已落地。当前生产 runner 实现集中在 `container/agent-runner/src/runners/{id}/`，descriptor、health helper、StreamEvent 和图片检测逻辑通过 `shared/` 同步到各子项目。

## 1. 当前结论

本文档最初记录的是“已经抽出了运行时主循环，但还没有抽出完整 runner 扩展机制”的状态。当前代码已经完成主链路改造，以下问题表保留作为历史背景和回归检查依据。

已经做得比较好的部分：

| 能力 | 现状 |
|---|---|
| 通用 turn 主循环 | `query-loop.ts` 已经负责 IPC 轮询、等待下一条消息、关闭、打断、drain、活性看门狗、运行时状态写回 |
| Provider 接口 | `runner-interface.ts` 定义了 `AgentRunner`、`QueryConfig`、`NormalizedMessage`、`RuntimePersistenceSnapshot` |
| StreamEvent 统一类型 | `shared/stream-event.ts` 是前后端和 agent-runner 的事件类型单一真相源 |
| 能力矩阵雏形 | `src/runner-registry.ts` 已有 runner descriptor，前端也能展示部分能力 |
| 接入文档雏形 | `docs/agent-runner-contract.md` 已经写了 turn 生命周期、system prompt、resume anchor、activity report 等契约 |

主要不足：

| 层级 | 问题 | 影响 |
|---|---|---|
| Runner 注册 | 后端 registry 和 agent-runner 工厂各自维护 | 新 runner 至少要改两套注册点，容易不一致 |
| 类型约束 | `SupportedRunnerId = 'claude' | 'codex'` 写死在多个文件 | 新 runner 需要改类型、prompt、工厂等硬编码位置 |
| Profile 配置 | `runner_profiles.config_json` 已有表和页面，但启动链路没有真正消费 | Web 上能保存配置，但配置不影响 runner 行为 |
| 模型推断 | `inferRunnerIdFromModel()` 只认识 Claude 和 Codex | 新模型可能被错误归类，或者无法自动匹配 runner |
| Prompt 策略 | 只有 `claude` 用 append，其它全部 full prompt | 新工具如果需要 system prompt 文件、stdin system message 或环境变量注入，就要改代码 |
| Provider 私有状态 | 主进程和 query-loop 理解 Codex 的 `activeThreadId`、`startFreshOnNextTurn` | 抽象泄漏。新 runner 的状态字段可能继续污染通用层 |
| 依赖检查 | 本地 runtime 预检硬要求 `@openai/codex-sdk` | 即使会话不用 Codex，也会被 Codex 依赖影响启动 |
| 可用性检测 | 设置页、登录初始化、`invoke_agent` 只认识 Claude 和 Codex | 新 runner 无法自然出现在 UI 和工具能力里 |
| MCP 来源 | 用户 MCP 加载逻辑带有 `.claude/settings.json` 语义 | 新工具无法声明自己的 MCP 配置来源或注入方式 |
| 事件适配 | 每个 provider 自己映射 StreamEvent，缺少 contract 测试 | 工具卡片、usage、thinking、task 事件容易回归 |

## 2. 目标效果

改造完成后，新接入一个命令行工具时，理想路径应该是：

```text
新增 container/agent-runner/src/runners/newtool/manifest.ts
新增 container/agent-runner/src/runners/newtool/runner.ts
必要时新增 container/agent-runner/src/runners/newtool/session.ts
必要时新增 container/agent-runner/src/runners/newtool/event-adapter.ts
在 shared/runner-descriptor.ts 注册 descriptor
```

然后系统表现为：

| 场景 | 最终效果 |
|---|---|
| Runner 列表 | Web Runner 页面自动出现 NewTool |
| 健康检查 | 显示命令是否存在、认证是否可用、版本信息、缺失原因 |
| 会话选择 | 新建或编辑会话时可以选择 NewTool |
| Profile 配置 | Profile 配置根据 schema 渲染表单，并真实传入 runner |
| Prompt 注入 | Runner 声明自己的 prompt contract，系统按声明注入 |
| 消息处理 | Web 和 IM 消息仍然走统一 query-loop，不需要新 runner 重写主循环 |
| 工具能力 | HappyClaw 工具按 runner 声明通过 MCP 或 native adapter 注入 |
| 状态恢复 | 主进程只保存 opaque provider state，不理解 provider 私有字段 |
| Memory | Memory 页面只允许选择满足能力要求的 runner |
| 子代理调用 | `invoke_agent` 只展示支持 one-shot 调用的 runner |
| 前端观测 | 工具流、思考流、usage、task、lifecycle 能力按 descriptor 明确展示或降级 |

## 3. 设计原则

1. Runner descriptor 是能力和行为声明的单一真相源。
2. AgentRunner 接口只描述运行时交互，不承载注册、模型推断、UI 配置 schema。
3. Provider 私有状态必须保持 opaque，通用层不能读取 provider 内部字段。
4. Prompt、MCP、profile、health check 都应由 runner manifest 声明。
5. 接入新 runner 时，工作应集中在 provider 目录内。
6. 允许先做编译期注册，不急于支持外部动态插件。
7. 先把现有 Claude 和 Codex 迁移到新结构，再接第三个 runner。

## 4. 目标架构

建议目录结构：

```text
shared/
  runner-descriptor.ts

container/agent-runner/src/
  runners/
    index.ts
    types.ts
    base-cli-runner.ts
    claude/
      manifest.ts
      runner.ts
      session.ts
      event-adapter.ts
    codex/
      manifest.ts
      runner.ts
      session.ts
      event-adapter.ts
    newtool/
      manifest.ts
      runner.ts
      session.ts
      event-adapter.ts
```

后端、前端、agent-runner 使用同一份 descriptor 类型。agent-runner 内部额外维护 `createRunner()` 工厂。

### 4.1 Runner Manifest

每个 runner 提供 manifest：

```ts
export interface RunnerManifest {
  descriptor: RunnerDescriptor;
  createRunner(ctx: RunnerFactoryContext): AgentRunner;
  healthCheck?(ctx: RunnerHealthContext): Promise<RunnerHealth>;
  listModels?(ctx: RunnerHealthContext): Promise<RunnerModel[]>;
  createOneShotInvoker?(ctx: OneShotContext): OneShotInvoker | null;
}
```

`RunnerDescriptor` 应包含：

```ts
export interface RunnerDescriptor {
  id: string;
  label: string;
  description?: string;
  defaultModel?: string;
  modelPatterns?: string[];
  capabilities: RunnerCapabilities;
  lifecycle: RunnerLifecycleCapabilities;
  promptContract: RunnerPromptContract;
  runtimeContract: RunnerRuntimeContract;
  toolContract: RunnerToolContract;
  profileSchema?: Record<string, unknown>;
  compatibility: RunnerCompatibility;
}
```

新增字段建议：

| 字段 | 用途 |
|---|---|
| `modelPatterns` | 代替硬编码 `inferRunnerIdFromModel()` |
| `runtimeContract` | 声明需要的命令、依赖、环境变量、认证检测方式 |
| `toolContract` | 声明工具注入方式，比如 MCP stdio、HTTP、native adapter、none |
| `profileSchema` | 前端 profile 表单和后端校验使用 |

### 4.2 AgentRunner 接口保留但收窄职责

现有 `AgentRunner` 接口基本可保留：

```ts
interface AgentRunner {
  readonly ipcCapabilities: IpcCapabilities;
  initialize(): Promise<void>;
  runQuery(config: QueryConfig): AsyncGenerator<NormalizedMessage, QueryResult>;
  pushMessage(text: string, images?: ImageInput[]): string[];
  interrupt(): Promise<void>;
  setPermissionMode?(mode: string): Promise<void>;
  getActivityReport?(): ActivityReport;
  getRuntimePersistenceSnapshot?(): RuntimePersistenceSnapshot;
  betweenQueries?(): Promise<void>;
  cleanup?(): Promise<void>;
}
```

但要调整 `RuntimePersistenceSnapshot`：

```ts
interface RuntimePersistenceSnapshot {
  providerState?: Record<string, unknown>;
  lastMessageCursor?: string | null;
  sessionControl?: {
    clearProviderSession?: boolean;
    clearResumeAnchor?: boolean;
  };
}
```

这样 query-loop 不需要知道 Codex 的 `activeThreadId` 和 `startFreshOnNextTurn`。

## 5. 具体问题与修改方案

### 5.1 Runner 注册重复

现状：

```text
src/runner-registry.ts
container/agent-runner/src/index.ts
container/agent-runner/src/system-prompt.ts
```

都含有 runner 相关硬编码。

方案：

1. 新增 `shared/runner-descriptor.ts`。
2. 后端 registry 只导出 descriptor。
3. agent-runner `runners/index.ts` 导出 manifest map。
4. 启动时校验 `descriptor.capabilities` 和 runner 实例能力一致。
5. 移除 `SupportedRunnerId = 'claude' | 'codex'`。

最终效果：

```text
新增 runner 只需要注册 manifest。
Web、后端 API、agent-runner 启动入口看到的是同一个 runner id。
如果 descriptor 和 runner 实例能力不一致，启动时 fail-fast。
```

### 5.2 Profile 配置没有生效

现状：

`runner_profiles` 表和前端页面已经存在，但 runtime 启动链路没有读取 profile JSON 并传给 agent-runner。

方案：

1. 后端在启动 runtime 前读取 `session.runner_profile_id`。
2. 使用 runner 的 `profileSchema` 校验 `config_json`。
3. 合并配置优先级：

```text
runner 默认配置
  < default profile
  < session.runner_profile_id
  < session.model / thinking_effort
  < executionProfile override
  < 环境变量强制项
```

4. 在 `ContainerInput` 增加：

```ts
runnerConfig?: {
  profileId?: string;
  model?: string;
  thinkingEffort?: 'low' | 'medium' | 'high';
  config?: Record<string, unknown>;
};
```

5. agent-runner 工厂从 `containerInput.runnerConfig` 读取配置，而不是直接读一堆 provider 专属环境变量。

最终效果：

```text
用户在 Runner Profile 页面修改命令路径、模型、参数、环境变量白名单、prompt 注入方式后，下一次会话启动真实生效。
Memory session 选择的 runner profile 也真实生效。
```

### 5.3 Prompt Contract 二分法

现状：

```ts
return runnerId === 'claude'
  ? ctxMgr.buildAppendPrompt()
  : ctxMgr.buildFullPrompt();
```

方案：

让 `RunnerPromptContract` 驱动 prompt 构造：

```ts
type PromptMode =
  | 'append'
  | 'full_prompt'
  | 'instructions_file'
  | 'system_stdin'
  | 'env';
```

行为：

| mode | 用法 |
|---|---|
| `append` | 适合 Claude Code 这类内置基础系统提示词的工具 |
| `full_prompt` | 适合没有内置平台上下文的工具 |
| `instructions_file` | 适合 Codex 这类读取指令文件的工具 |
| `system_stdin` | 适合支持结构化 stdin 的工具 |
| `env` | 适合只支持环境变量传系统提示词的工具 |

最终效果：

```text
新 runner 不需要改 system-prompt.ts。
只要 manifest 声明 promptContract，系统就能按正确方式生成和交付 system prompt。
```

### 5.4 Provider 私有状态泄漏

现状：

主进程和 query-loop 知道 Codex 私有字段：

```text
activeThreadId
startFreshOnNextTurn
```

方案：

1. `providerState` 保持 opaque。
2. 需要清空 session 或 resume anchor 时，由 runner 返回 `sessionControl`。
3. 主进程 bootstrap 只做：

```ts
providerSessionId = runtimeState.provider_session_id ?? legacySessionId
resumeAnchor = runtimeState.resume_anchor
bootstrapState.providerState = parsedOpaqueProviderState
```

4. provider 是否从 `providerState` 里恢复，由 provider 自己决定。

最终效果：

```text
新增 runner 可以保存任意 providerState。
通用层不需要新增字段判断。
Codex 的状态格式变化不会影响主进程。
```

### 5.5 命令行工具通用能力没有基类

现状：

Claude 自己处理 spawn、stdin、stdout JSON、stderr、resume、interrupt。新 CLI 工具很可能会复制一套。

方案：

新增 `BaseCliRunner` 和 `CliRunnerAdapter`：

```ts
interface CliRunnerAdapter {
  buildCommand(ctx: RunnerContext, query: QueryConfig): CliCommand;
  buildInput(ctx: RunnerContext, query: QueryConfig): CliInput;
  parseStdoutLine?(line: string): NormalizedMessage[];
  parseStdoutChunk?(chunk: string): NormalizedMessage[];
  parseStderrChunk?(chunk: string): NormalizedMessage[];
  detectRecoverableError?(eventOrText: unknown): RunnerError | null;
  getResumeAnchor?(eventOrText: unknown): string | null;
  interrupt?(process: ChildProcess): Promise<void>;
}
```

`BaseCliRunner` 负责：

```text
spawn 进程
stdin 写入
stdout/stderr 缓冲
JSON line 解析
中断
超时清理
QueryResult 组装
ActivityReport 基础实现
```

Provider adapter 只负责：

```text
命令参数
输入格式
事件映射
错误识别
resume anchor 提取
```

最终效果：

```text
如果新工具支持流式 JSON，接入成本主要是写一个 event adapter。
如果新工具只支持一次性文本输出，也可以接入为降级 runner。
```

### 5.6 工具注入和 MCP 策略不够泛化

现状：

HappyClaw 工具通过 `happyclaw-mcp-server.ts` 暴露，但用户 MCP 读取和配置仍带 `.claude` 路径语义。

方案：

在 descriptor 中声明：

```ts
toolContract: {
  mode: 'mcp_stdio' | 'mcp_http' | 'native_adapter' | 'none';
  supportsUserMcp: boolean;
  userMcpSources?: Array<'happyclaw' | 'claude_settings' | 'codex_config' | 'profile'>;
}
```

修改点：

1. `loadUserMcpServers()` 改为 runner-aware resolver。
2. `happyclaw-mcp-server.ts` 保持通用，不再默认承担 Claude 语义。
3. JSON Schema 转 Zod 时保留基础类型，不再全部 `z.any()`。
4. 对不支持 MCP 的 runner，prompt 中不要声明不可用工具。

最终效果：

```text
NewTool 如果支持 MCP stdio，可以直接获得 send_message、memory_query、schedule_task 等 HappyClaw 工具。
如果不支持 MCP，Web 会显示工具能力降级，Memory 页面也能据此禁用该 runner。
```

### 5.7 可用性检测和设置页写死

现状：

设置页有 Claude 和 Codex 两个 provider section。登录初始化也只检查 Claude 和 Codex。

方案：

新增通用 API：

```text
GET /api/runners
GET /api/runners/:id/health
GET /api/runners/:id/models
GET /api/runners/:id/profile-schema
```

`health` 返回：

```ts
interface RunnerHealth {
  runnerId: string;
  available: boolean;
  commandDetected?: boolean;
  authenticated?: boolean;
  version?: string;
  details?: Record<string, unknown>;
  missingReasons?: string[];
}
```

前端设置页改为 runner 列表：

```text
Runner
  Claude    可用，已登录，版本 x.y.z
  Codex     可用，已登录，账号 ****
  NewTool   不可用，找不到命令 newtool
```

最终效果：

```text
新增 runner 不需要新增一整套 settings component。
只要 manifest 提供 healthCheck，设置页就能展示。
```

### 5.8 invoke_agent 写死 Claude 和 Codex

现状：

`invoke_agent` 内部直接实现 `invokeClaude()` 和 `invokeCodex()`，并手写 provider enum。

方案：

新增 one-shot invoker contract：

```ts
interface OneShotInvoker {
  runnerId: string;
  invoke(input: {
    prompt: string;
    cwd: string;
    model?: string;
    thinkingEffort?: string;
    timeoutMs: number;
  }): Promise<string>;
}
```

runner manifest 可选提供 `createOneShotInvoker()`。

`invoke_agent` 行为：

1. 从 runner registry 查询所有 `oneShot` 可用 runner。
2. health check 通过才展示。
3. 工具 schema 的 provider enum 动态生成。
4. 不支持 one-shot 的 runner 不出现在工具参数里。

最终效果：

```text
NewTool 只有声明支持 one-shot 时才会出现在 invoke_agent。
不需要在 invoke-agent-plugin.ts 里新增 if 分支。
```

### 5.9 Memory Runner 选择需要依赖能力声明

现状：

`canServeAsMemoryRunner()` 已基于 descriptor 做了初步判断，但 profile 是否生效、工具是否可用、ephemeral session 是否支持，还没有完整约束。

方案：

Memory runner 判定增加：

```text
customTools != none
turnBoundary 支持 native 或 simulated
ephemeralSession 支持
filesystem access 支持
memory 所需插件没有被 runner 禁用
```

Memory 启动时使用同一套 runner config 合并逻辑。

最终效果：

```text
Memory 页面只显示真正可用的 runner。
选择 profile 后，memory query、remember、session_wrapup 都用同一套配置启动。
```

### 5.10 依赖和预检策略需要 runner-aware

现状：

`runtime-runner.ts` 硬检查 agent-runner 的固定依赖。

方案：

1. `agent-runner` 自身基础依赖只检查通用必需项。
2. runner manifest 声明额外依赖：

```ts
runtimeContract: {
  requiredNodePackages?: string[];
  requiredCommands?: string[];
  requiredEnv?: string[];
}
```

3. 启动某个 runner 时只检查该 runner 的依赖。

最终效果：

```text
Claude 会话不会因为 Codex SDK 缺失而启动失败。
NewTool 缺少命令时，错误会明确显示缺少哪个命令或依赖。
```

## 6. 分阶段落地计划

### 阶段一：统一 descriptor

修改内容：

1. 新增共享 runner descriptor 类型。
2. 迁移 `src/runner-registry.ts` 到共享 descriptor。
3. 前端继续使用 `/api/sessions/runners`，但数据来自新 descriptor。
4. 保留旧字段，避免大面积 UI 修改。

最终效果：

```text
Runner 能力矩阵有单一数据来源。
新增 runner descriptor 后，Web Runner 页面能看到它。
```

### 阶段二：agent-runner manifest 工厂化

修改内容：

1. 新增 `container/agent-runner/src/runners/index.ts`。
2. Claude 和 Codex 各自提供 manifest。
3. `container/agent-runner/src/index.ts` 只根据 manifest 创建 runner。
4. 移除 `SupportedRunnerId = 'claude' | 'codex'`。

最终效果：

```text
agent-runner 不再在入口文件里硬编码 runner 工厂。
新增 runner 只改 runners/index.ts。
```

### 阶段三：Runner Profile 注入

修改内容：

1. 后端启动前读取 session profile。
2. 按 schema 校验并合并配置。
3. `ContainerInput` 增加 `runnerConfig`。
4. Claude 和 Codex 改为读取 `runnerConfig`，环境变量只作为 fallback。

最终效果：

```text
Web 上保存的 runner profile 会真实改变运行时行为。
```

### 阶段四：Prompt Contract 驱动

修改内容：

1. `createSystemPromptBuilder()` 接受 descriptor 或 promptContract。
2. 移除 `runnerId === 'claude'` 分支。
3. 为 Claude、Codex manifest 明确声明 prompt mode。

最终效果：

```text
新 runner 可声明系统提示词交付方式，不需要改 prompt builder。
```

### 阶段五：Provider State Opaque 化

修改内容：

1. 扩展 `RuntimePersistenceSnapshot.sessionControl`。
2. CodexRunner 返回清理 session 的标准控制意图。
3. 主进程 bootstrap 不再读取 `activeThreadId`。
4. query-loop 不再读取 `startFreshOnNextTurn`。

最终效果：

```text
通用层不再依赖 provider 私有 state。
Provider state 格式变化只影响 provider 自己。
```

### 阶段六：BaseCliRunner

修改内容：

1. 抽出命令行 runner 通用基类。
2. ClaudeSession 中可复用的 spawn、buffer、JSON line 处理迁移到基类。
3. Claude 和新 CLI 工具逐步使用基类。

最终效果：

```text
接入标准命令行工具时，只需要实现命令构建和事件适配。
```

### 阶段七：工具和 MCP 策略泛化

修改内容：

1. descriptor 增加 `toolContract`。
2. 用户 MCP resolver 变成 runner-aware。
3. MCP schema 转换增强。
4. prompt 中只声明当前 runner 实际可用的工具。

最终效果：

```text
不同 runner 可以选择 MCP、native adapter 或无工具模式。
```

### 阶段八：Health、Models、Settings 泛化

修改内容：

1. 新增 runner health API。
2. 设置页改成 runner list。
3. profile 表单根据 schema 渲染。
4. 登录初始化不再写死 Claude 和 Codex。

最终效果：

```text
新 runner 自动进入设置页、会话编辑页和健康检查。
```

### 阶段九：invoke_agent registry 化

修改内容：

1. 新增 `OneShotInvoker`。
2. Claude 和 Codex 提供 one-shot invoker。
3. `InvokeAgentPlugin` 动态读取 invoker registry。

最终效果：

```text
invoke_agent 的 provider 列表来自 runner registry。
```

### 阶段十：Contract 测试

新增 fake runner：

```text
fake-json-runner
  emit init
  emit text_delta
  emit thinking_delta
  emit tool_use_start
  emit tool_progress
  emit tool_use_end
  emit usage
  emit result
```

测试覆盖：

| 测试 | 目的 |
|---|---|
| descriptor 与 manifest 一致 | 防止后端显示支持但 agent-runner 不支持 |
| profile config 注入 | 防止 profile 继续空转 |
| mid-query push true | 覆盖 Claude 类运行时 |
| mid-query push false | 覆盖 Codex 类运行时 |
| resume anchor 保存和恢复 | 防止长会话断续 |
| providerState opaque | 防止通用层读取 provider 私有字段 |
| tool stream parent 关系 | 防止前端工具卡片显示错误 |
| usage 持久化 | 防止 token 统计回归 |

最终效果：

```text
后续新增 runner 时，有稳定的回归保护。
```

## 7. 新 Runner 接入后的验收标准

以 NewTool 为例，验收应覆盖：

| 类别 | 验收项 |
|---|---|
| 注册 | `/api/sessions/runners` 返回 NewTool |
| 健康检查 | `/api/runners/newtool/health` 能显示命令、认证、版本或缺失原因 |
| 前端 | Runner 页面显示 NewTool 能力矩阵和降级原因 |
| Profile | 能创建 NewTool profile，配置字段来自 schema |
| 启动 | 选择 NewTool 的会话能启动 runtime |
| Prompt | system prompt 按 NewTool 声明方式传入 |
| 消息 | Web 消息能收到正常回复 |
| IM | IM 消息必须通过 `send_message` 送回原 channel |
| 工具 | 支持 MCP 时能调用 `send_message`、`memory_query` 等 HappyClaw 工具 |
| 中断 | 支持中断时，用户 stop 或 correction 能正确生效 |
| Resume | 支持恢复时，下一轮能沿用 resume anchor |
| 降级 | 不支持 usage、thinking、tool streaming 时，前端明确显示降级而不是假装完整支持 |
| Memory | 只有满足 memory 能力时才能被 memory session 选择 |
| invoke_agent | 只有声明 one-shot invoker 时才出现在 `invoke_agent` provider enum |

## 8. 优先级建议

最高优先级：

1. Profile 配置注入。
2. Descriptor 单一真相源。
3. Provider state opaque 化。
4. Prompt contract 驱动。

这四项完成后，新 runner 接入成本会明显下降。

第二优先级：

1. BaseCliRunner。
2. Runner-aware MCP resolver。
3. Health API 泛化。
4. invoke_agent registry 化。

第三优先级：

1. Profile schema 前端表单。
2. fake runner contract 测试。
3. 更完整的模型列表和版本检测。

## 9. 完成后的判断标准

如果新增一个标准命令行 runner 时仍然需要改这些地方，说明抽象还没到位：

```text
src/index.ts
src/runtime-runner.ts 大量 if runnerId === ...
src/routes/auth.ts
src/routes/config.ts 单独新增 provider 页面
container/agent-runner/src/system-prompt.ts
container/agent-runner/src/query-loop.ts
container/agent-runner/src/plugins/invoke-agent-plugin.ts
```

理想状态是：

```text
新增 runner 的主要改动集中在：
container/agent-runner/src/runners/newtool/
shared/runner descriptor 注册
必要时新增 runner 专属 profile schema
```

这才算达到“实现预定义接口就能接入”的工程效果。

## 10. 项目改名计划

项目计划从 HappyClaw fork 逐步改名为新的独立项目名。

推荐名称：

```text
AgentDock
```

推荐 package、目录、命令中的规范化名称：

```text
agentdock
```

推荐 tagline：

```text
Self-hosted agent runtime with memory, tools, and multi-channel messaging.
```

### 10.1 命名理由

`AgentDock` 更贴合改造后的产品定位：

| 语义 | 对应项目能力 |
|---|---|
| Agent | 项目的核心是常驻、自主、可派活的 AI agent |
| Dock | 多 runner、多渠道、多工具、多 MCP 都可以停靠到统一运行时 |
| 中性技术名 | 不绑定 Claude、Codex 或某个单一模型 |
| 可扩展 | 适合未来从 HappyClaw fork 变成独立 agent runtime 项目 |

### 10.2 改名范围

改名不应只改 README 标题，而要分层处理。

| 范围 | 建议 |
|---|---|
| 用户可见产品名 | 改为 `AgentDock` |
| npm package name | 改为 `agentdock`、`agentdock-agent-runner`、`agentdock-agent-runner-core` |
| 目录名 | 仓库目录可改为 `agentdock` |
| Web 页面标题 | 改为 `AgentDock` |
| API 路径 | 暂时保留现有路径，避免迁移成本过高 |
| 数据目录 | 短期保留 `data/` 结构，不强制改路径 |
| 环境变量 | 分阶段从 `HAPPYCLAW_*` 迁移到 `AGENTDOCK_*` |
| MCP server name | 从 `happyclaw` 迁移到 `agentdock`，保留兼容别名 |
| 文档中的 HappyClaw | 按语义替换。历史说明中可保留“formerly HappyClaw fork” |

### 10.3 环境变量迁移策略

当前代码大量使用 `HAPPYCLAW_*`。建议不要一次性破坏兼容。

迁移策略：

```text
读取配置时：
  优先 AGENTDOCK_*
  其次 HAPPYCLAW_*

写入或新文档中：
  只推荐 AGENTDOCK_*

日志中：
  如果使用 HAPPYCLAW_* fallback，输出一次 deprecation warning
```

示例：

```ts
function readRuntimeEnv(name: string): string | undefined {
  return process.env[`AGENTDOCK_${name}`] ?? process.env[`HAPPYCLAW_${name}`];
}
```

需要迁移的主要环境变量类别：

| 类别 | 当前前缀 |
|---|---|
| 工作区路径 | `HAPPYCLAW_WORKSPACE_*` |
| runner 模型和推理强度 | `HAPPYCLAW_MODEL`、`HAPPYCLAW_CODEX_MODEL`、`HAPPYCLAW_THINKING_EFFORT` |
| IPC 和工具配置 | `HAPPYCLAW_DISABLED_PLUGINS`、`HAPPYCLAW_TOOL_SCOPE` |
| Memory | `HAPPYCLAW_MEMORY_*` |
| Skills | `HAPPYCLAW_SKILLS_DIR`、`HAPPYCLAW_PROJECT_SKILLS_DIR` |
| 内部 API | `HAPPYCLAW_API_URL`、`HAPPYCLAW_INTERNAL_TOKEN` |

### 10.4 MCP 工具命名迁移

当前内置 MCP server 名称是 `happyclaw`，Claude allowed tools 中也使用：

```text
mcp__happyclaw__*
```

改名后建议：

```text
mcp__agentdock__*
```

但需要兼容旧会话和旧 prompt。

迁移方案：

1. 新 MCP server 注册名改为 `agentdock`。
2. 短期同时注册 `happyclaw` 兼容别名。
3. Prompt 中只声明 `agentdock`。
4. 旧会话恢复时如果仍调用 `mcp__happyclaw__*`，兼容 server 仍可处理。
5. 一个稳定版本后再评估是否移除旧别名。

最终效果：

```text
新会话看到 agentdock 工具名。
旧会话不会因为工具名前缀变化失效。
```

### 10.5 Package 改名

当前 package：

```text
happyclaw
happyclaw-agent-runner
happyclaw-agent-runner-core
```

建议迁移为：

```text
agentdock
agentdock-agent-runner
agentdock-agent-runner-core
```

如果短期内存在本地 file dependency，可以先保持路径不变，只改包名：

```json
{
  "name": "agentdock-agent-runner-core"
}
```

同时更新依赖：

```json
{
  "agentdock-agent-runner-core": "file:../agent-runner-core"
}
```

注意事项：

| 文件 | 操作 |
|---|---|
| 根目录 `package.json` | 修改 name、description、keywords |
| `container/agent-runner/package.json` | 修改 name 和 file dependency |
| `container/agent-runner-core/package.json` | 修改 name |
| `package-lock.json` | 重新生成 |
| import 路径 | 从 `happyclaw-agent-runner-core` 改为 `agentdock-agent-runner-core` |

### 10.6 代码符号迁移

建议分两类处理：

| 类型 | 策略 |
|---|---|
| 用户可见名称 | 立即改成 AgentDock |
| 内部历史变量、DB 字段 | 只有在顺手重构时再改，避免制造无收益迁移 |

优先改：

```text
Web 标题和导航
README
文档标题
package metadata
MCP server display name
日志里的 Runtime label
```

谨慎改：

```text
数据库表名
已有 data/ 路径
历史 session_state 字段
旧配置文件名
```

### 10.7 文档迁移

文档建议统一使用：

```text
AgentDock
```

对于历史背景可以写：

```text
AgentDock originated as an experimental fork of HappyClaw.
```

中文文档可以写：

```text
AgentDock 源自 HappyClaw 的实验性 fork，后续作为独立的自托管 agent runtime 演进。
```

### 10.8 分阶段执行计划

| 阶段 | 修改内容 | 最终效果 |
|---|---|---|
| 一 | README、文档、Web 标题、package metadata 改名 | 用户可见名称变为 AgentDock |
| 二 | 新增 `AGENTDOCK_*` env fallback，保留 `HAPPYCLAW_*` | 新配置使用新前缀，旧部署继续可用 |
| 三 | package name 和 import 路径迁移 | 代码依赖名与项目名一致 |
| 四 | MCP server name 增加 `agentdock`，保留 `happyclaw` alias | 新工具名前缀生效，旧会话兼容 |
| 五 | 清理文档和设置页中的 HappyClaw 残留 | 产品叙事统一 |
| 六 | 长期评估是否迁移内部 DB 字段和旧路径 | 避免过早做高风险低收益迁移 |

### 10.9 改名验收标准

改名完成后，应满足：

| 验收项 | 期望 |
|---|---|
| Web UI | 页面标题、设置页、Runner 页面显示 AgentDock |
| README | 项目名和定位是 AgentDock |
| package | package name 使用 agentdock 前缀 |
| 环境变量 | 新文档只推荐 `AGENTDOCK_*` |
| 兼容性 | 旧 `HAPPYCLAW_*` 环境变量仍可启动 |
| MCP | 新会话使用 `agentdock` MCP 名称 |
| 旧会话 | 旧的 `happyclaw` MCP 名称不立即失效 |
| 数据 | 现有 `data/` 目录无需迁移即可继续运行 |

### 10.10 与 runner 抽象改造的关系

改名最好和 runner 抽象改造分开提交。

建议顺序：

```text
先完成 runner descriptor / profile 注入等架构改造
再做 AgentDock 可见名称迁移
最后做环境变量和 MCP 名称兼容迁移
```

原因：

1. Runner 抽象改造会触碰核心运行链路。
2. 改名会触碰大量字符串、文档、配置和 import。
3. 两者混在一起会让回归排查困难。

最终目标：

```text
AgentDock 成为项目对外名称。
HappyClaw 只作为历史兼容前缀和迁移说明存在。
```
