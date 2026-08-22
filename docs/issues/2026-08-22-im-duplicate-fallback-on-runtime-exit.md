# HappyClaw 问题分析与修复方案报告

**问题编号/名称**：Runtime 进程退出时误触发 IM 兜底逻辑重发历史消息  
**日期**：2026-08-22  
**涉及模块**：`src/index.ts`（`runLocalRuntime` 收尾逻辑）、`container/agent-runner/`（Runner 事件适配与 IPC 状态）  
**影响范围**：使用 `agy`（Antigravity CLI）及其他无结构化流式工具事件的 runner 时，会话闲置退出时必现；长连接模式下存在消息重复推送风险。

---

## 1. 问题现象描述

用户在飞书客户端与 HappyClaw 主会话进行对话。在对话结束约 2 小时后（期间用户和系统未主动产生任何新消息），飞书客户端在 **18:47** 突然再次收到 **16:47** Agent 曾经回复过的一模一样的历史消息：
> “随时都在呀宝宝～今天一天都在忙啥呢？是宅在家里休息，还是出去逛了逛？”

此行为并非 Agent 被外部唤醒重新推理，而是系统内部机制异常导致的**历史回复重复重发**。

---

## 2. 现场复盘与完整时间线

根据远端服务器日志（`logs/launchd.stdout.log`）、Trace 记录（`data/traces/main/`）与 SQLite 消息数据库（`data/db/messages.db`）比对还原：

| 北京时间 | 事件行为 | 详细描述 |
| :--- | :--- | :--- |
| **16:25:48** | 用户发起会话 | 用户在飞书发送消息，系统拉起主会话（`web:main`）的 `agent-runner` 长驻进程（runner: `agy`, model: `Gemini 3.7 Flash`）。 |
| **16:47:33** | 用户发送新消息 | 用户在飞书发送消息：“还好啦，没事，就是想找你聊聊天了”。 |
| **16:47:48** | Agent 正常回复并发送 | Agent 通过 MCP 工具 `agentdock/send_message` 向飞书发送回复：“随时都在呀宝宝～今天一天都在忙啥呢？……”。飞书当时已正常收到消息。 |
| **16:47 ～ 18:47** | 进程挂起等待 | 用户未再发送新消息，`agent-runner` 进程在后台处于 `waitForIpcMessage` 轮询等待状态，累计运行了约 142 分钟（8521577 ms）。 |
| **18:47:51** | 进程闲置超时正常退出 | `agent-runner` 达到会话空闲/生命周期上限正常退出（exitCode=0, status='success'）。 |
| **18:47:51** | **触发异常重发 Bug** | 宿主收尾逻辑执行，判定 `sawSendMessageTool == false`，误认为 Agent 未向用户回复，抓取了 16:47 的历史消息并重新推送到飞书。 |

---

## 3. 核心根因分析（Root Causes）

该问题由 **Runner 事件流适配差异** 与 **宿主收尾兜底逻辑缺陷** 共同叠加造成：

### 根因一：`sawSendMessageTool` 标记无法被 Agy 等 Runner 触发
在 [`src/index.ts:3880-3884`](file:///Users/ar8327/dev/happyclaw/src/index.ts#L3880-L3884) 中：
```typescript
const isOutboundTool =
  typeof _se.toolName === 'string' &&
  /(?:^|__)send_(?:message|image|file)$/.test(_se.toolName);
if (_se.eventType === 'tool_use_start' && isOutboundTool) {
  sawSendMessageTool = true;
}
```
1. **Stream 事件缺失**：Agy Runner 是通过命令行启动并在内部加载 MCP Server 的，stdout 输出为纯文本，**不向宿主发射 `tool_use_start` 流式事件**（Claude/Codex 等结构化 JSON 输出的 runner 才会发射）。
2. **状态重置**：当 mid-turn 注入 IPC 消息时，代码在 [`src/index.ts:3917`](file:///Users/ar8327/dev/happyclaw/src/index.ts#L3917) 会将 `sawSendMessageTool` 重置为 `false`。
3. **结果**：对于 Agy runner，宿主上下文中的 `sawSendMessageTool` 自始至终恒为 `false`。

### 根因二：`runLocalRuntime` 退出收尾时的 Fallback 机制存在设计漏洞
在 [`src/index.ts:4530-4566`](file:///Users/ar8327/dev/happyclaw/src/index.ts#L4530-L4566) 中：
```typescript
if (!isErrorExit && latestSourceChannel && !sawSendMessageTool) {
  const fallbackText = latestSubstantiveAssistantReply?.content || '收到啦。';
  const fallbackOutboxId = crypto.randomUUID();
  const fallbackOptions = applyFeishuThreadModeForTarget({
    targetChannel: latestSourceChannel,
    sourceGroup: effectiveGroup.folder,
    trigger: latestConsumedMessage,
  });
  enqueueImDelivery({
    id: fallbackOutboxId,
    sourceChatJid: chatJid,
    targetJid: latestSourceChannel,
    kind: 'text',
    payload: {
      text: fallbackText,
      options: fallbackOptions,
    },
  });
  ...
  logger.warn(
    {
      chatJid,
      imJid: latestSourceChannel,
      forwardedExistingReply: !!latestSubstantiveAssistantReply,
    },
    'Sent IM fallback for successful turn without send_message',
  );
}
```
**设计漏洞表现**：
1. **设计初衷与长连接模式冲突**：该逻辑初衷是“当单次短运行 Agent 成功但漏调 send_message 时兜底回复”。但在支持多轮对话的长连接进程中，进程可能存活数小时，进程退出并不等于“刚刚完成了一轮交互”。
2. **缺乏投递状态去重**：系统仅凭 `!sawSendMessageTool` 为 true，就无条件从数据库获取 `latestSubstantiveAssistantReply`，**完全未校验该消息是否早在历史轮次中就已经成功通过 IPC 发送过**。
3. **时空错乱重发**：将 2 小时前已经发送成功的消息直接作为当前退出时的 fallback 再次投递到了飞书。

---

## 4. 现场日志证据

远端服务器日志 `logs/launchd.stdout.log` 记录：
```json
[2026-08-22 18:47:51.222] INFO (1748): Local Runtime completed (streaming mode)
    group: "operator Home"
    duration: 8521577
    newSessionId: "f583158c-541d-41d6-b92a-6af874dd1ca1"
    finalStatus: "success"
[2026-08-22 18:47:51.224] WARN (1748): Sent IM fallback for successful turn without send_message
    chatJid: "web:main"
    imJid: "feishu:oc_2853481d88ecd9fadd4a4e46cea72680"
    forwardedExistingReply: true
```

---

## 5. 推荐修复方案

建议从以下三个维度进行修复，确保彻底杜绝重复发送：

### 方案 1：基于实际 IPC 发送记录设置响应标记（推荐，最健壮）
**思路**：不要单纯依赖脆弱的 stdout `tool_use_start` 正则匹配，而是在宿主接收/处理到实际的 IM 发送行为时打标记。
- 当处理 `data/ipc/{folder}/messages/` 中的出站消息或 `send_message` IPC 调用时，在当前 turn 上记录 `hasSentImReply = true` 或在内存映射中记录已消费的 user message 已被回复。
- 在退出收尾判断时，若已确认有实际 IM 发送行为，则禁止进入 fallback。

### 方案 2：Fallback 触发增加消息投递去重检查
**思路**：在执行 `enqueueImDelivery` 之前，检查 `latestSubstantiveAssistantReply` 是否已经向 `latestSourceChannel` 投递过。
- 如果该回复消息已经在历史消息流或 IPC 出站表中被标记为已投递（或该消息的产生时间与当前退出时间差过大，例如超过 3 分钟），则视为过期历史消息，不执行重发。

### 方案 3：Runner 层补全或归一化工具事件
- 对于 `agy` 等基于命令行/MCP 的 runner，若有条件可在其适配器中对 MCP 工具调用进行拦截或日志感知，发射标准化的 `tool_use_start` 事件，使前端与宿主状态保持一致。

---

## 6. 实际修复（2026-08-22）

采用**方案 1 的修正版**。核实代码后对原报告的三点补充与订正：

**订正一：正确的信号早已存在，只是这一处没接上。**
`src/index.ts` 中的 `durableOutboundTracker`（`DurableOutboundTracker`）只在宿主**真正接受了 IPC 出站写入**时才自增（`markDurableOutboundAcceptance`，覆盖 text / image / file 三条路径）。它与 runner 无关，是判断"本次是否真的发出去了"的唯一可靠依据。退出收尾的另外两处判断（container closed、error exit）都已用 `hasDurableUserVisibleReply()`，唯独silent-success fallback 漏用。

**订正二：不能直接复用 `hasDurableUserVisibleReply()`。**
两个原因：
1. 它包含 `deliveredUserVisibleReply`，而后者只要 Agent 有任何 stdout 文本就置 true。用它当条件会让"Agent 输出了文本但漏调 `send_message`"这一 fallback 的**原始设计场景彻底失效**，IM 侧变成纯静默。
2. 它的 baseline 是**整个 runtime 生命周期**取一次的。长连接进程第 1 轮正常发了 `send_message`，计数器就永久大于 baseline，第 2 轮真漏发时也不再兜底。

因此引入独立的 `TurnOutboundGate`（`src/durable-outbound-tracker.ts`）：
- 构造时取一次基线；
- 在 `ipc_message_received`（Agent 消费新用户消息，`agent-runner-core/src/ipc.ts` 统一发射，runner 无关）时 `beginTurn()` **重新取基线并清除工具信号**；
- `sentThisTurn()` = 工具信号 `||` 计数器已越过本轮基线。

退出收尾改为 `if (!isErrorExit && latestSourceChannel && !turnOutboundGate.sentThisTurn())`。原 `sawSendMessageTool` 局部变量被 gate 的 `markToolSignal()` 取代，claude/codex 的既有行为不变（工具信号仍作为 OR 项保留，避免 IPC 响应与进程退出之间的竞态）。

**订正三：方案 3 不予采纳。**
`src/index.ts` 中 `durableOutboundTracker` 声明处的注释已说明理由：provider 的工具事件无法区分成功结果与 `isError` 结果，补发 `tool_use_start` 并不能证明"发送成功"。归一化工具事件对前端展示有价值，但不应作为投递判据。

**方案 2 不再需要**：信号修正后无需时间差启发式。

### 变更文件
- `src/durable-outbound-tracker.ts`：新增 `TurnOutboundGate`
- `src/index.ts`：接入 gate，替换 `sawSendMessageTool`
- `src/durable-outbound-tracker.test.ts`：新增 gate 回归用例（`npm run test:durable-outbound`）

### 已知残留
Agent 只输出 stdout、完全不调用 `send_message` 时，兜底仍在**进程退出时**才投递。长连接场景下这可能迟到数小时。彻底解决需要把兜底时机从进程退出移到**每轮结束**，属于更大范围的重构，本次未做。
