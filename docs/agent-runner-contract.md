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

## System Prompt 契约

- `QueryConfig.systemPrompt` 是当前 turn 的显式输入。
- query-loop 会在每次 `runQuery()` 前重新构造它。
- runner 必须消费这次传入的值，不允许在内部偷偷重建或缓存上一轮的 system prompt。
- Claude 把它当 append prompt 使用。
- Codex 把它写入 `model_instructions_file` 后再启动本轮。

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

## 新 Runner 接入清单

- 确认 `QueryConfig.systemPrompt` 在每个 turn 都被实际消费。
- 确认 `ipcCapabilities` 与主进程 descriptor 一致，否则进程启动应直接失败。
- 确认 `resume_anchor` 何时发出，并写进实现说明。
- 确认 `getActivityReport()` 的统计粒度不会误导看门狗。
- 确认 `recoverable` 错误只覆盖 query-loop 真能恢复的分支。
- 确认 `tool_use_start / tool_use_end / task_*` 的 parent 关系能被前端正确还原。
- 跑 `make typecheck`。
- 手动验证 Claude 和 Codex 链路至少各一次。
  - 基本发消息
  - memory query
