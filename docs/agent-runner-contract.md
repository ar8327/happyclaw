# AgentRunner Contract

这份文档补充 `container/agent-runner/src/runner-interface.ts` 里没有完全展开的运行时约定，给新 runner 接入和回归检查用。

## Turn 生命周期

```text
进程启动
  -> initialize()
  -> runQuery()
  -> query-loop 写回 runtimeState
  -> betweenQueries()
  -> 等待下一条消息
  -> runQuery()
  -> ...
  -> cleanup()
```

补充说明：

- `initialize()` 只调用一次。适合放 SDK 初始化、provider state 恢复、MCP 配置准备。
- `betweenQueries()` 是 turn 边界钩子。只在一轮 `runQuery()` 正常返回后调用，不会在同一轮里重复调用。
- `cleanup()` 是最终收尾钩子。idle drain、显式 drain、最终退出都会走到这里。

## ContextBundle 投递契约

- `ContextBundle` 是模型上下文的结构化单一入口。每个 section 都有稳定的 `id`、`content` 与 `stability`。
- `stability` 分为 `static`、`session`、`turn`。query-loop 每轮都重新构造 bundle，并在 `runQuery()` 前调用 `runner.applyContext()`。
- descriptor 的 `nativeProvides` 声明 runner 原生提供的 section。共享 builder 必须过滤这些 section，避免原生上下文与显式注入重复。
- runner 必须保证每个 canonical section 恰好出现一次。不得缓存上一轮的动态 section，也不得在内部另建一套 HappyClaw prompt。
- Claude 通过原生 identity、环境、工作区规则与 Skill 发现提供部分 section，其余 section 作为 append prompt。
- Codex 在新 thread 的 instructions file 中放 static 与 session section；turn section 通过 `thread/inject_items` 注入。resume 后 section 内容变化时按 hash 增量注入，删除 section 时注入失效标记。
- Antigravity 每轮把完整渲染结果写入隔离 HOME 的 `GEMINI.md`。
- `QueryConfig.systemPrompt` 只保留为 runner 调用层的渲染结果，不再驱动环境变量或临时 instructions file 通用分支。

## Descriptor 握手契约

- 主进程会把 runner descriptor 里的 IPC 能力声明写进 `ContainerInput.declaredIpcCapabilities`。
- container 启动后会在 `initialize()` 前对拍 `runner.ipcCapabilities`。
- 当前只校验两个可运行时验证的字段：
  - `midQueryPush`
  - `runtimeModeSwitch`
- 任一字段不一致都必须直接 fail-fast，不能带着错误声明继续运行。
- `lifecycle`、`promptContract` 和 `nativeProvides` 是静态契约，`context-conformance.test.ts` 负责验证 section 覆盖、动态刷新与 Codex 增量投递。

## Resume Anchor 契约

- `resume_anchor` 表示“从这里继续最稳妥”的 provider 私有锚点。
- Claude 可以在一个 turn 里更新多次。
  - 常见时机：assistant 产出正文后、tool result 回来后。
- Codex 通常每个 turn 只在末尾给一次 thread id。
- query-loop 会把最近一次收到的 anchor 写回 `session_state.resume_anchor`。

## ActivityReport 契约

- `hasActiveToolCall=true`
  - 表示当前确实还有工具执行没结束，query-loop 应延长活性超时。
- `activeToolDurationMs`
  - 应该对应当前最老的活跃工具调用耗时，不是任意一个工具的耗时。
- `hasPendingBackgroundTasks=true`
  - 只在 provider 自己还有后台工作、当前 turn 仍需要保活时返回 true。
  - 不要把“队列里未来可能要做的事”或者“已经脱离本 turn 的异步任务”算进去。

## Recoverable 错误约定

- `recoverable=true` 只给 query-loop 已经实现恢复路径的错误。
- 当前明确可恢复的类型：
  - `context_overflow`
  - `session_resume_failed`
- `unrecoverable_transcript` 必须返回不可恢复错误。
- 普通 SDK 异常、网络错误、实现缺陷，不要标成 recoverable。

## Tool Stream 语义

- 顶层工具调用
  - `parentToolUseId` 为空
  - `isNested=false`
- 嵌套工具调用
  - 发生在 Task、Skill 或其他工具内部
  - `parentToolUseId` 指向父工具
  - `isNested=true`
- Claude stream processor 会对某些 SDK 没显式标出来的嵌套场景做补齐。
  - 典型例子：Skill 内部工具调用缺少 `parent_tool_use_id` 时，仍会补成 nested。

## Runner 能力差异

- Claude 的 `code-reviewer` 与 `web-researcher` 通过 `--agents` 原生注入，descriptor 以 `predefinedSubagents: true` 明确声明。这是能力差异，不属于 ContextBundle section。
- Claude 支持 `PreToolUse` hook，HappyClaw 会用 safety-lite 拦截明显破坏性的 Bash 命令。Codex 依赖 sandbox，Antigravity 当前没有等价的工具前置 hook。
- memory query 只能选择可强制只读的 runner。Claude 限制为 Read、Grep、Glob，Codex 使用 read-only sandbox，Antigravity 不参与深度只读查询选择。

## 新 Runner 接入清单

- 确认 `applyContext()` 在每个 turn 都消费新构造的 `ContextBundle`。
- 声明并验证 `nativeProvides`，确保 canonical section 不重不漏。
- 确认 `ipcCapabilities` 与主进程 descriptor 一致，否则进程启动应直接失败。
- 确认 `resume_anchor` 何时发出，并写进实现说明。
- 确认 `getActivityReport()` 的统计粒度不会误导看门狗。
- 确认 `recoverable` 错误只覆盖 query-loop 真能恢复的分支。
- 确认 `tool_use_start / tool_use_end / task_*` 的 parent 关系能被前端正确还原。
- 如果修改 Codex SDK 版本，先验证 `model_instructions_file` 和 `thread/inject_items` 仍按约定生效。
- 跑 `make typecheck`。
- 手动验证 Claude、Codex 和 Antigravity 链路至少各一次。
  - 基本发消息
  - memory query
