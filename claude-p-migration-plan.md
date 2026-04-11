# Claude SDK Runner -> `claude -p` 迁移方案

## 目标

将 HappyClaw 当前基于 `@anthropic-ai/claude-agent-sdk` 的 Claude runner，整体替换为基于 `claude -p` 的 subprocess runner。

- **不做灰度**
- **不保留长期双实现**
- 允许必要的功能降级，但必须明确列出

## 当前实现结论

### Runner 结构

- 入口：`container/agent-runner/src/index.ts`
- 抽象接口：`container/agent-runner/src/runner-interface.ts`
- Claude runner：`container/agent-runner/src/providers/claude/claude-runner.ts`
- Claude session：`container/agent-runner/src/providers/claude/claude-session.ts`
- Claude hooks：`container/agent-runner/src/providers/claude/claude-hooks.ts`
- Codex runner：`container/agent-runner/src/providers/codex/codex-runner.ts`
- 通用 query loop：`container/agent-runner/src/query-loop.ts`

当前 provider 选择逻辑由 `HAPPYCLAW_LLM_PROVIDER` 控制，默认走 Claude。

### Claude runner 的关键能力

当前 Claude 实现不是简单的“单次请求”，而是 **长生命周期 query + 中途 IPC 注入 + SDK hooks + 自动 compact 协同**：

1. `ClaudeSession.run()` 用 SDK `query()` 启动常驻 query
2. `pushMessage()` 可把 IPC 消息直接注入活跃 query
3. `setPermissionMode()` 可在运行时切换 mode
4. `PreCompact` hook 在 compact 前归档 transcript，并触发 memory `session_wrapup`
5. 收到 `compact_boundary` 后，会补发 IM routing reminder
6. HappyClaw 内建工具目前通过 SDK tool adapter 注入，不是外部 stdio MCP server

### Codex runner 的关键差异

Codex 侧已经是更接近 CLI 的模式：

- turn-based
- 无 mid-query push
- 无 runtime mode switch
- 通过独立 `codex-mcp-server.ts` 暴露 HappyClaw tools

这意味着：**Claude 迁到 `claude -p` 后，架构会更像现在的 Codex runner。**

## `claude -p` 研究结论

### 文档确认

官方文档表明 `claude -p` 支持：

- `--output-format stream-json`
- `--include-partial-messages`
- `--input-format stream-json`
- `--resume`
- `--settings`
- `--mcp-config`
- `--include-hook-events`
- hooks 配置

参考：

- https://docs.anthropic.com/en/docs/claude-code/cli-reference
- https://docs.anthropic.com/en/docs/claude-code/headless
- https://docs.anthropic.com/en/docs/claude-code/hooks

### 本机实测结论

在本机当前 `Claude Code 2.1.91` 上补充验证并确认：

1. `claude -p --output-format stream-json --verbose` 会输出 `system/init`、`assistant`、`result`、`rate_limit_event`
2. `--output-format stream-json` 在 `--print` 模式下**必须**搭配 `--verbose`，否则 CLI 会直接报错
3. `--resume <session_id>` 能正确恢复上下文，但公开 CLI 参数里没有与 SDK `resumeSessionAt` 对等的 message-anchor 恢复入口
4. `--input-format stream-json` 可在**同一进程**内接收多条 user message，并维持同一个 `session_id`
5. 同一进程内每一轮新 user message 开始前，CLI 都可能再次输出 `system/init`。该事件应视为“turn 级元数据包”，不能等同于“创建了全新 session”
6. 图片输入的**可靠方式**是把图片先落成真实文件，再在 prompt 或 stream-json user content 里直接提供图片路径，例如 `Analyze this image: /abs/path/to/image.png`
7. `@/path/to/image.png` 不应作为迁移方案依赖。本机实测同一张 PNG 用 `@` 引用会返回 `invalid_request_error: Could not process image`
8. `--input-format stream-json` 下直接发送 SDK 风格的 inline `image` block 也不应依赖。本机实测同样会返回 `invalid_request_error: Could not process image`
9. `--strict-mcp-config` 可阻止 CLI 混入本机已有的全局 MCP server。不加这个参数时，即使传了 `--tools ""`，CLI 仍可能暴露用户机器上的外部 MCP 工具
10. `--strict-mcp-config` 只能隔离 MCP 配置，不能清空 Claude CLI 自带的默认 `agents`、`skills` 和部分内建 slash command 元数据
11. `--agents <json>` 会将自定义 agent **追加**到 CLI 默认 agent 集合中，不是替换默认集合
12. CLI 中断语义不能等同于 SDK `queryRef.interrupt()`。本机实测无论是 TTY 下 `Ctrl-C`，还是无 TTY 子进程上发送 `SIGINT`，CLI 都会产出“用户拒绝本次 tool use”的 user message，最终给出 `result.subtype=error_during_execution`
13. `claude -p --resume <session_id> "/compact"` 在 headless 下可用，并会输出 `status=compacting`、`system/init`、`compact_boundary`，随后把 compact summary 写回 transcript
14. Claude CLI 会把 session transcript 持久化到 `~/.claude/projects/<cwd-derived-dir>/<session_id>.jsonl`。文件中除 `user`、`assistant` 外，还可能包含 `queue-operation`、`attachment`、`last-prompt` 等记录
15. 基于本地 transcript 做“分支恢复”在当前版本上可行，但它依赖 CLI 内部存储结构，只能作为冷恢复 fallback，不能作为主路径设计前提

## 迁移后的目标架构

### 保持不变的层

以下层建议保持不变，避免扩大改动面：

- `AgentRunner` 抽象
- `query-loop.ts`
- IPC 协议与 sentinel 机制
- `ContainerOutput`
- `shared/stream-event.ts`
- 前端 stream event 消费逻辑

### 替换的层

仅替换 Claude provider 的底层执行方式：

1. `ClaudeSession`：SDK -> `claude -p` 子进程
2. `ClaudeRunner.runQuery()`：SDK message -> CLI NDJSON message
3. Claude tools 注入：SDK in-process tools -> 外部 stdio MCP server
4. Claude hooks：SDK callback hooks -> CLI hooks 配置 + 脚本

新增一条架构约束：

- **优先依赖长生命周期 CLI session 本身来保持连续性**
- 只有在 CLI 进程丢失、需要冷恢复到某个历史锚点时，才启用 transcript branching fallback

## 推荐实现方案

### 1. 新增通用 `happyclaw-mcp-server`

目标：替代当前 Claude 专用的 SDK tool 注入方式。

建议做法：

- 参考 `container/agent-runner/src/providers/codex/codex-mcp-server.ts`
- 抽出一个 Claude/Codex 都能复用的 stdio MCP server
- 由它统一桥接 `ContextManager.getActiveTools()`

这样可以：

- 保持 HappyClaw tools 能力不变
- 降低 Claude/Codex 两套接入逻辑的差异
- 让 `claude -p` 通过 `--mcp-config` 或 session `settings.json` 直接加载工具

### 2. 重写 `ClaudeSession`

建议将 `claude-session.ts` 改为管理一个长生命周期 subprocess，核心职责如下：

- `spawn('claude', [...args])`
- stdin 写入 `--input-format stream-json` 协议消息
- stdout 按行解析 `stream-json`
- 保存当前 `session_id`
- 识别重复出现的 `system/init`，将其当作 turn 边界元数据，而不是新的 session
- 支持 `interrupt()`
- 支持 `end()`
- 将 IPC/base64 图片先落盘为 session 级临时文件，再把图片路径编码进 user message 文本
- 在需要冷恢复时，支持基于本地 transcript 的 fork / branch 恢复
- 通过显式 CLI 参数和 provider 侧过滤，尽量稳定工具面与事件面，避免读取宿主机的隐式 MCP 配置

建议 CLI 参数：

```bash
claude -p \
  --input-format stream-json \
  --output-format stream-json \
  --verbose \
  --include-partial-messages \
  --include-hook-events
```

除固定参数外，再按会话配置追加：

- `--resume <session_id>`
- `--model ...`
- `--permission-mode ...`
- `--mcp-config ...` 或 `--settings ...`
- `--strict-mcp-config`
- `--setting-sources project,user`
- `--tools ...`
- `--allowedTools ...`
- `--agents <json>`
- `--disable-slash-commands`

### 2.0 CLI 启动参数约束

为了让 CLI runner 的行为尽量接近当前 SDK runner，建议把下面几项作为**必选约束**，而不是“按需要追加”：

| 参数 | 是否必选 | 原因 |
| --- | --- | --- |
| `--verbose` | 是 | `stream-json` 依赖它 |
| `--input-format stream-json` | 是 | 承接长生命周期 session + mid-query push 降级语义 |
| `--output-format stream-json` | 是 | 统一事件解析 |
| `--include-partial-messages` | 是 | 尽量保住文本流式体验 |
| `--include-hook-events` | 是 | 保住 `hook_*` 前端事件 |
| `--mcp-config <generated-json>` | 是 | 注入 HappyClaw MCP server 和用户允许的 MCP server |
| `--strict-mcp-config` | 是 | 防止宿主机全局 MCP 污染工具面 |
| `--tools <builtin-list>` | 是 | 显式锁定可见内建工具集合 |
| `--allowedTools <allowlist>` | 是 | 继续保留当前 runner 的 allowlist 语义，包括 `mcp__happyclaw__*` |
| `--agents <json>` | 是 | 追加注册 HappyClaw 预置 agent |
| `--disable-slash-commands` | 建议开启 | 降低宿主机 slash command 对会话元数据的干扰 |

实现建议：

- `--tools` 只放需要暴露给 Claude 的内建工具，范围与当前 `DEFAULT_ALLOWED_TOOLS` 对齐
- `--allowedTools` 继续作为最终 allowlist，保留现有 `mcp__happyclaw__*` 规则
- `--strict-mcp-config` 与生成态 `--mcp-config` 必须一起使用，不要依赖用户本机已有 `.mcp.json`
- `--setting-sources` 保持显式，避免 session 行为随宿主机配置漂移
- 不把 `system/init.tools`、`system/init.agents` 当作“唯一可信配置源”
- 对 HappyClaw 前端和 Task 适配层，只消费 allowlist 内工具和 HappyClaw 自己注册的 agent 标识
- CLI 默认 `agents`、`skills` 即使仍出现在 `system/init` 中，也只视为宿主机内建能力，不纳入 HappyClaw 自己的契约面

结论：

- `claude -p` 本身能承接工具与 agent 配置
- 但 `--strict-mcp-config` 只解决 MCP 污染，不能单独解决 CLI 默认 agent 和 skill 的可见性
- 因此迁移后的稳定性要靠两层保证：
  - 启动参数约束 Claude CLI 可用能力
  - provider 侧只暴露 HappyClaw 真正依赖的工具和 agent 语义

### 2.0.1 stream-json 协议约束

CLI runner 不能把 `stream-json` 事件形状简单等同为 SDK 事件。

需要明确：

1. `system/init` 可能在同一个 `session_id` 内反复出现
2. 重复的 `system/init` 表示**新一轮 turn 的元数据初始化**
3. provider 只应在以下条件下向上层 yield `session_init`
   - 首次观测到 `session_id`
   - 或 `session_id` 发生变化
4. 其余重复的 `system/init` 应只用于刷新本轮 tools、agents、permissionMode 等元数据，不应被当成“新建会话”

这条约束必须写进实现。否则长生命周期 subprocess 在多轮输入下会误触发多次 session 初始化逻辑。

### 2.0.1.1 IPC 能力声明调整

迁移到 CLI 后，Claude provider 在 `AgentRunner.ipcCapabilities` 上不应继续沿用 SDK 版语义。

需要明确改为：

- `supportsMidQueryPush = false`
- `supportsRuntimeModeSwitch = false`

原因：

1. 当前 `query-loop.ts` 会根据这两个布尔值决定是“直接推入活跃 query”，还是“缓存到下一轮”
2. CLI 虽然支持同一进程内连续接收多条 stream-json user message，但这不等于现有接口意义上的“中途注入活跃 query”
3. `--permission-mode` 是启动参数。迁移首版不应假设当前长生命周期进程能在不中断 turn 的前提下无缝切换 mode

结论：

- IPC 新消息继续由 `query-loop` 缓存到下一轮处理
- mode change 也由 `query-loop` 记录，并在下一次启动 Claude CLI query 时生效
- 长生命周期 CLI session 只负责保留上下文，不再对上暴露 SDK 级别的 mid-query push 和 runtime mode switch 能力

### 2.0.2 `resumeAt` 替代方案

CLI 公开参数只有 `--resume <session_id>`，没有与 SDK `resumeSessionAt` 对等的 message-anchor 参数。

因此迁移后不应继续假设：

- “把 assistant uuid 直接传给 CLI 就能恢复”

推荐改为分层方案：

#### 主路径：长生命周期 session

在同一个 `claude -p --input-format stream-json` 子进程仍然存活时：

- 后续 turn 直接继续写 stdin
- 不做冷恢复
- 不依赖 `resumeAt`

这条路径可以承接绝大多数正常对话、工具调用和多轮 follow-up。

#### 冷恢复路径：transcript branching fallback

只在下面场景启用：

- Claude CLI 子进程异常退出
- 需要回退到某个已知稳定锚点
- 需要避免把“半轮执行结果”继续带入后续恢复

实现思路：

1. 定位当前 session 的 transcript 文件：
   - 不硬编码目录名公式
   - 优先使用当前进程已观测到的 transcript 路径
   - 若当前进程已丢失，则在 `~/.claude/projects/*/<session_id>.jsonl` 下按 `session_id` 搜索
2. 找到目标锚点：
   - assistant 文本消息 `uuid`
   - 或 `user.tool_result` 消息 `uuid`
3. 将 transcript **复制**到新的 fork session 文件，不原地修改原文件
4. 保留锚点及其之前、且通过自检的记录
5. 自检至少覆盖以下记录类型：
   - `queue-operation`
   - `user`
   - `assistant`
   - `attachment`
   - `last-prompt`
6. 将保留记录里的 `sessionId` 改写为新的 fork session id
7. 重建与末条 user 消息一致的 `last-prompt`
8. 如目录下存在与该 session 关联的 sidecar 子目录，默认**不复制**。只有实测证明恢复依赖它时，才纳入 fork 逻辑
9. 用 `claude -p --resume <fork_session_id>` 从分支 transcript 继续

本机实测表明：

- assistant 文本锚点可行
- `user.tool_result` 锚点可行

这条路径可以近似重建当前 SDK `resumeAt` 的效果，但必须明确其性质：

- **它是 fallback**
- **它依赖 Claude 本地 transcript 的内部格式**
- **CLI 更新后存在失效风险**

因此需要：

- 启动前 capability probe
- transcript 结构自检
- 失败时回退到普通 `session_id` 恢复或直接报错

### 2.1 图片输入迁移

这一项不能直接沿用 SDK message 结构。

当前 SDK 版 Claude runner 的图片输入是：

- `pushMessage(text, images)`
- 直接发送多模态 content block
- 图片以 base64 内联方式进入 query

迁移到 `claude -p` 后，建议改成和 Codex runner 类似的思路：

1. 新增一个 Claude 专用图片辅助模块，职责参考 `container/agent-runner/src/providers/codex/codex-image-utils.ts`
2. 将 `config.images` 和 `pushMessage(..., images)` 里的 base64 图片写入 session 临时目录
3. 生成稳定的绝对路径列表，例如：
   - `/tmp/happyclaw-claude-xxxx/img-1.png`
   - `/tmp/happyclaw-claude-xxxx/img-2.jpeg`
4. 将原始用户文本重写为：

```text
<original prompt>

Attached images:
- /abs/path/img-1.png
- /abs/path/img-2.jpeg
```

5. 把这段纯文本写入 `--input-format stream-json` 的 user message.content
6. 在 session 结束时清理临时目录

原因：

- 官方文档明确支持“Provide an image path to Claude”
- 本机实测表明，这条路径在 `claude -p` 和 `--input-format stream-json` 下可用
- 相反，`@image-path` 与 inline `image` block 在当前实测版本上都不可靠，不应作为实现基础

结论：

- **图片能力可以保留**
- 但实现方式必须从“inline base64 block”改为“临时文件 + 路径引用”
- 同时仍需保留当前本地图片预处理逻辑：
  - 超限图片过滤
  - MIME 自动修正

不要只复用 `codex-image-utils.ts` 的“落盘”能力，而漏掉当前 `image-utils.ts` 的校验行为。否则迁移后会把本地 warning 退化成运行时 API 错误。

### 2.2 sub-agent 迁移

当前 SDK 版 Claude runner 通过 `agents: PREDEFINED_AGENTS` 注册内建 sub-agent。

迁移后必须保留这层能力，做法是：

1. 将 `container/agent-runner/src/providers/claude/claude-agent-defs.ts` 的内容序列化为 CLI `--agents <json>`
2. 在 session 启动时显式传入，不依赖用户本机已有 agent 配置
3. 明确 `--agents` 是**追加**语义，不是假设能替换 Claude CLI 默认 agent 集合
4. 继续沿用当前的 Task / background task 事件适配逻辑，但 HappyClaw 侧只对自己注册的 agent 标识提供稳定契约

这样可以保住：

- `code-reviewer`
- `web-researcher`
- 后续由 HappyClaw 自己定义的预置 sub-agent

需要额外写清楚：

- `system/init.agents` 里出现 Claude CLI 默认 agent 属于预期现象
- 前端展示、日志归因和 Task 适配不要把默认 agent 误判成 HappyClaw 自己的预置 agent

如果这一步漏掉，迁移后虽然主流程能跑，但 Task 工具的可用目标和事件归因都会变脏，属于真实行为变化，不应接受

### 2.3 interrupt 语义重定义

当前 SDK 版是：

- `queryRef.interrupt()`
- provider 内部能比较自然地表达“中断当前活跃 query”

CLI 版不能直接假设有等价 API，因此必须在方案里先定义语义：

1. `ClaudeSession` 子进程应以可中断方式启动
2. 首选实现是向 Claude CLI 发送 `SIGINT`，而不是直接 `kill -9`
3. `ClaudeRunner.runQuery()` 在解析 `result` 时，需要把“用户中断”与“执行错误”区分开

建议判定规则：

- 若 CLI 在中断后产出“tool use 被用户拒绝”相关 user message
- 且最终 `result.subtype=error_during_execution`
- 且 `stop_reason=tool_use`

则应视为：

- query 被用户中断
- **不是** 普通执行错误
- 不触发 overflow / transcript error / session resume failed 分支

本机实测表明这条语义在以下两种方式下都成立：

- TTY 下发送 `Ctrl-C`
- 无 TTY 子进程发送 `SIGINT`

因此 `interrupt()` 不需要以“必须依赖伪终端”为前提来设计。

这一步必须写清楚。否则迁移后 `interrupt()` 会被误报为失败，直接改变 query-loop 的控制流

### 2.4 `context overflow` 恢复策略重写

当前 SDK 实现默认依赖：

- `sessionId`
- `resumeAt`

来在 overflow 后自动重试当前轮。

CLI 迁移后，不建议继续沿用“遇到 overflow 就重新拉起进程并重放当前 prompt”的思路。推荐改成两层恢复：

#### 第一优先级：在当前 session 内触发 compact

做法：

1. 保持当前长生命周期 CLI 进程不退出
2. 在检测到上下文逼近上限，或确认 overflow 后，向同一 session 发送 `/compact`
3. 等待：
   - `status=compacting`
   - `compact_boundary`
4. compact 完成后再继续后续 turn

本机实测已确认：

- `claude -p --resume <session_id> "/compact"` 在 headless 下可用
- CLI stream 会输出 `compact_boundary`
- compact summary 会写回 transcript

#### 第二优先级：冷恢复到分支 transcript

如果：

- 当前 CLI 进程已经不可用
- 或 compact 仍不足以恢复

则再走 2.0.2 的 transcript branching fallback。

这意味着迁移后的 overflow 策略不应再表述为：

- “继续保留当前基于 `resumeAt` 的自动重试”

而应改为：

- “优先使用 CLI 原生 compact，必要时再做 transcript branching 恢复”

### 3. 重写 `ClaudeRunner.runQuery()`

新 `ClaudeRunner` 继续输出当前 `NormalizedMessage` 协议，但输入源改为 CLI NDJSON。

保留的逻辑：

- `StreamEventProcessor`
- usage 提取
- background task / sub-agent 事件适配
- context overflow 检测
- unrecoverable transcript error 检测
- resume anchor / session id 管理

需要改写的逻辑：

- 解析 CLI 输出事件，而不是 SDK message 对象
- 从 CLI 的 `assistant` / `result` 消息中提取文本和 usage
- 根据 CLI hook/system 事件映射现有 `hook_*` / `status` stream event
- 识别 CLI 的“用户中断”结果，并单独映射到 query-loop 可接受的中断语义
- 兼容 hook 事件可能早于 `system/init` 到达的情况
- 兼容同一 `session_id` 内重复出现的 `system/init`
- 将 `compact_boundary` 视为可消费的 CLI 事件，而不是待定能力

### 4. 将 hooks 迁移到 CLI hooks

当前 `claude-hooks.ts` 是 SDK callback 形式，不能直接给 CLI 使用。

建议改造为：

1. 新增一个 Node hook handler 脚本
2. `PreCompact` 逻辑迁过去
3. `PreToolUse` Safety Lite 逻辑迁过去
4. 由 session 级 `settings.json` 或临时 hooks 配置文件接入 CLI

必须保留的 hook 行为：

- compact 前 transcript 归档
- home 会话触发 memory `session_wrapup`
- host mode Safety Lite

### 5. 保留 query-loop，不改上层协议

`query-loop.ts` 现有职责本身是 provider-agnostic 的，建议继续复用：

- IPC polling
- close / drain / interrupt sentinel
- activity watchdog
- overflow retry
- turn 结束后等待下一条消息

迁移后只要新的 Claude runner 仍实现 `AgentRunner` 接口，上层不必重写。

## 功能映射

| 能力 | 当前 Claude SDK runner | `claude -p` 迁移后 | 结论 |
| --- | --- | --- | --- |
| 流式文本 / thinking / tool 事件 | 有 | 有 | 保留 |
| session resume | 有 | 有 | 保留 |
| message-anchor resume | 有，基于 `resumeAt` | 无公开参数，需 transcript branching fallback | 近似保留 |
| hook 事件输出 | 有 | 有 | 保留 |
| PreCompact hook | 有 | 有，但需重写为 CLI hook | 保留 |
| PreToolUse Safety Lite | 有 | 有，但需重写为 CLI hook | 保留 |
| HappyClaw tools | SDK 内嵌 | 需改为 stdio MCP | 保留 |
| 图片输入 | SDK inline base64 image block | 临时文件 + 图片路径引用 | 保留 |
| 预置 sub-agent | SDK `agents` | CLI `--agents <json>` 追加注册，默认 agent 作为宿主机内建能力容忍存在 | 保留 |
| mid-query push | 直接注入活跃 query | `query-loop` 缓存到下一轮 | 降级 |
| runtime permission mode switch | 即时 | `query-loop` 记录后在下一轮生效 | 降级 |
| interrupt | SDK query reference | 需重定义为 CLI 中断语义并单独判定 | 保留 |
| compact 后 routing reminder | 有 | 可直接依赖 CLI `compact_boundary` | 保留 |

## 明确允许的功能降级

以下降级是可接受的，但需要在实现和发布说明里明确写出：

### 1. IPC 中途消息注入语义变弱

当前 SDK 版 Claude runner 支持把 IPC 消息直接推入活跃 query。  
迁移到 `claude -p` 后，虽然同一进程可接收多条 user message，但更稳妥的预期应当是：

- **消息在当前 turn 结束后再处理**
- 不保证即时并入当前正在运行的工具链路

### 2. 运行时 mode 切换可能变为下一 turn 生效

当前 `setPermissionMode()` 依赖 SDK query reference。  
CLI 版大概率无法在当前 turn 内无缝变更，应按以下语义处理：

- 当前 turn 保持原 mode
- 下一 turn 启动时带上新的 `--permission-mode`

### 3. `resumeAt` 不再是公开 CLI 参数

迁移后不再保留：

- “通过官方 CLI 参数直接恢复到某条 message uuid”

替代为：

- 主路径使用长生命周期 session
- 冷恢复时使用 transcript branching fallback

## 不建议接受的降级

以下能力不建议在首版迁移时丢掉：

1. **compact 前 transcript 归档**
2. **memory `session_wrapup` 触发**
3. **HappyClaw tools 能力**
4. **hook 事件向前端透传**
5. **预置 sub-agent 能力**
6. **图片输入能力**

如果这些丢失，迁移不是“替换底层实现”，而是会改变用户可见行为。

## 待补专项验证

以下几项不阻止继续细化实现，但在真正切换前必须完成专项验证：

1. **auto-compact 场景下 `compact_boundary` 的稳定性**
   - 手动 `/compact` 已确认可产出 `compact_boundary`
   - 仍建议补测“真正因上下文逼近上限而触发 auto-compact”时的事件形状

2. **transcript branching fallback 的结构稳健性**
   - 需确认不同 Claude CLI 更新后 `jsonl` 结构是否仍兼容当前自检逻辑
   - 需定义 transcript 自检失败时的降级路径
   - 需确认 fork 后是否还需要同步目录内的其他 sidecar 元数据

3. **图片临时文件在多轮会话中的生命周期**
   - 当前建议是 session 结束时统一清理
   - 还需确认 compact / resume / interrupt 后不会留下不可控垃圾文件

## 一次性切换策略

既然不做灰度，推荐采用下面的切换顺序：

### 阶段 1：实现新 Claude CLI runner

- 完成新 `ClaudeSession`
- 完成 Claude CLI hooks
- 完成通用 MCP server
- 保证编译通过

### 阶段 2：让 `provider=claude` 直接指向新实现

- `index.ts` 保持 provider 分流逻辑不变
- 但 Claude provider 对应的底层实现已经切到 CLI
- 不在 runtime 增加 feature flag

### 阶段 3：验证通过后删除旧 SDK 代码

- 移除 `@anthropic-ai/claude-agent-sdk` 依赖
- 删除旧 `claude-mcp-adapter.ts` / SDK-only session 逻辑
- 清理无用类型和桥接代码

## Host / Container 侧需要补的事情

### Container 模式

容器里已经安装了 `@anthropic-ai/claude-code`，迁移阻力较小。  
但仍需补：

- CLI hooks 配置写入
- MCP config 注入
- 启动前 capability probe

### Host 模式

这是本次迁移最容易漏掉的部分。

当前 host mode 并不依赖本机 `claude` 可执行文件。迁移后必须新增：

1. 本机 `claude` 存在性检测
2. 必需参数与输出形状的 capability probe
3. 启动前错误提示
4. 凭据和 `settings.json` 的兼容性验证

## 风险与应对

### 风险 1：CLI 输入协议边界行为与 SDK 不完全一致

应对：

- 把 mid-query push 明确定义为“下一 turn 生效”
- 不试图模拟 SDK 级即时注入
- Claude provider 的 `ipcCapabilities` 显式改为与新语义一致

补充：

- 明确 `system/init` 是 turn 级事件，不能在长生命周期 session 中误判为新 session

### 风险 2：hook 配置与 session 目录耦合

应对：

- 统一由 runner 在启动时生成临时/会话级 hooks 配置
- 不依赖用户手写 hooks

### 风险 3：tools 注入方式变化较大

应对：

- 优先复用 Codex 现有 `codex-mcp-server.ts` 的模式
- 先打通 Read/Bash/Task/Memory/InvokeAgent，再补其余工具

### 风险 4：host mode 环境不一致

应对：

- 启动前做 CLI 探测
- 缺少 CLI 时直接 fail fast

### 风险 5：transcript branching 依赖 CLI 内部存储格式

应对：

- 只把 branching 作为冷恢复 fallback，不作为主路径
- 启动时做 capability probe
- fork transcript 时先做结构自检
- 永远复制原 transcript，不原地修改
- 分支恢复失败时回退到普通 `session_id` 恢复或直接报错

## 验收标准

迁移完成后，至少应验证以下场景：

1. 普通文本对话
2. 文件读写工具调用
3. Bash 工具调用
4. Task / 子 agent 事件
5. hooks 事件展示
6. session resume
7. transcript branching fallback 到 assistant 锚点
8. transcript branching fallback 到 `user.tool_result` 锚点
9. compact 触发后的 transcript 归档
10. memory `session_wrapup`
11. interrupt / drain / close sentinel
12. host mode 与 container mode 都能跑通

## 最终建议

**建议迁移，但实现方式应是“保留上层协议，重写 Claude provider 底层”。**

不要把这次迁移理解成：

- “把 SDK `query()` 换成一条 shell command”

而应该理解成：

- “把 Claude provider 从 SDK execution backend，替换成 CLI subprocess backend”

这样才能既完成替换，又把变更面控制在 Claude provider 内部。
