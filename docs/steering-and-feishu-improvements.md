# Turn 内 Steering 与飞书能力改进方案

> **实施版修订（2026-07-25）**
>
> 本节是代码实现所遵循的最终契约，优先级高于后文的审计草案、示例代码和分阶段建议。后文保留用于说明问题发现过程；其中与本节冲突的内容均以本节为准。

## 0. 最终实施契约与方案修正

### 0.1 已修正的原方案假设

| 原草案假设                                    | 验证后的问题                                                           | 最终方案                                                                                                                           |
| --------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 同渠道消息只在 batch/max window 内注入        | 长任务中的正常追问会被强制 drain 和冷启动，steering 实际无法命中       | 活跃 turn 的**同渠道消息始终注入现有 runtime**；runner 能 steer 就在 tool 边界注入，暂时不能就由 runner 缓冲到下一个 provider turn |
| `pushMessage()` 返回 `string[]` 即表示拒绝    | 无法区分“已 steer”和“已安全缓冲”，异步 stdin/app-server 错误也表达不了 | `pushMessage()` 改为异步显式结果；Claude、Codex 声明支持 mid-query push，Agy 明确缓冲                                              |
| runner 读到 IPC 即可提交宿主游标              | runtime/runner 在收到后、真正完成 provider query 前仍可能退出          | 使用 UUID `deliveryId` 精确跟踪；区分 `received`、`delivered`、`returned`，只有 query 成功后才发 `delivered`，异常退出则按 ID 重排 |
| 把 `send_file` 从 tasks IPC 搬到 messages IPC | 通道迁移本身不能解决静默失败，且会扩大协议改动                         | 保留 tasks 通道，增加 `requestId`、宿主持久化接收回执、10 秒超时和明确错误                                                         |
| CardKit 流式更新发送增量文本                  | CardKit `cardElement.content` 需要累计内容，增量会覆盖/错乱            | 所有更新发送**完整累计 Markdown**，单元素、全局严格递增 sequence、串行 mutation                                                    |
| 停止按钮由飞书 WebSocket 事件处理             | 卡片 action 是独立 HTTP 回调，并要求签名/解密验证                      | 提供 `/api/feishu/card-action` 公网回调，使用 SDK `CardActionHandler` 校验；action ID 一次性消费并带 TTL                           |
| 文件 outbox 足以做可靠投递                    | 文件状态迁移、并发 claim、FIFO、失败检索和恢复复杂且脆弱               | 使用 SQLite `im_outbox`：原子 claim、按目标 FIFO、跨目标并行、指数退避、启动恢复、失败管理 API/UI                                  |
| “exactly once” 可统一承诺                     | Telegram/QQ 等上游没有等价幂等键                                       | 内部处理保证精确 delivery ID 和不重复确认；飞书通过稳定 UUID 获得 API 幂等，其他渠道为**持久化 at-least-once**                     |

### 0.2 最终数据流

```text
入站 IM / Web
  → 消息落库
  → dirty-bit 立即唤醒主循环
  → TurnManager
      ├─ 同渠道：写入带 deliveryId 的 session IPC
      │    → runner received
      │    → Claude stdin / Codex turn/steer，或安全缓冲
      │    → provider query 成功
      │    → runner delivered
      │    → 宿主按 deliveryId 推进对应游标
      └─ 跨渠道：FIFO 排队 + drain
           → 任意完成 / 失败 / 中断出口幂等 handoff

出站 send_message / send_image / send_file
  → 宿主校验并写入 SQLite outbox
  → 立即返回“已持久化接收”
  → 每个目标严格 FIFO worker
  → 飞书 CardKit / JSON 2.0 / 普通渠道 API
  → 成功完成；失败指数退避，永久失败进入可见管理面
```

### 0.3 必须维持的不变量

1. **宿主游标不以 FIFO 猜测回执归属**：所有注入都以 `deliveryId` 精确对应消息批次。
2. **收到不等于送达**：`received` 只续租，`delivered` 才提交；`returned` 或 runtime 退出重新排队。
3. **同渠道不因时间窗口重启 runtime**：steering 能力由 runner 动态决定，拒绝或竞态必须降级缓冲。
4. **跨渠道隔离不变**：不同 channel 仍在 turn 边界串行交接，handoff 可重复调用但只能生效一次。
5. **工具成功以 durable acceptance 为准**：仅看到 `tool_end`、stdout 或尝试调用 IM API，都不能算已回复。
6. **出站先持久化再确认**：IPC 文件只能在 SQLite 接收成功后删除；网络调用不阻塞工具回执。
7. **飞书 thread 必须显式**：回复只使用触发消息或工具指定的 `replyTo/thread/root`，禁止用“该群最后一条消息”推断。
8. **CardKit mutation 严格串行**：同一张卡共用单调 sequence；内容更新是累计文本；完成后关闭 streaming mode。
9. **敏感配置只加密保存**：卡片 verification token / encrypt key 不通过 GET API 回显明文。
10. **原始坏 IPC 不盲目重放**：可在设置页查看和清理；真正可安全重试的出站消息由 outbox 管理。

### 0.4 实施范围

本轮一次性完成以下内容：

- Claude/Codex turn 内 steering、Agy 安全缓冲、runner 能力描述同步；
- UUID IPC 文件名、delivery 回执/租约/退出归还、跨渠道可靠 handoff；
- 主循环 dirty-bit 唤醒与飞书、Telegram、QQ、微信入站通知；
- SQLite 出站 outbox、失败重试/清理 API 与设置页；
- 飞书 JSON 2.0 静态卡、CardKit 真流式、进度卡和经过验证的停止回调；
- 飞书 thread/root 精确路由，视频、语音、富文本媒体下载；
- `send_file` 校验、大小限制、typed acceptance；
- 回归测试、共享类型同步、全量类型检查和生产构建。

图片下载大小限制不在本轮范围内；这与文件/视频/语音的 `MAX_FILE_SIZE` 校验不是同一条链路。

---

本文档描述五块改进（另含一轮对整条投递链路的系统审计，见 §3.9-§3.17）：

1. **消息进入 runner 的延迟与 turn 内 steering** —— 让 IM 渠道的消息尽快、且在**下一个 tool call 边界**就被 agent 看到，而不是等整轮结束甚至触发 runtime 重启。
2. **飞书卡片渲染** —— 从卡片 JSON 1.0 + 整卡重传，升级到 JSON 2.0 + CardKit 真流式，并重做视觉层级。
3. **飞书其他能力补齐** —— 视频/语音消息丢失、`send_file` 静默失败等。
4. **飞书话题（thread）路由** —— 修「回复乱跑进话题 / 该进话题的发到群里」。
5. **投递语义修复** —— 修重复投递与两条消息丢失路径。

### 最重要的四个结论

**一、「消息多久进 runner 不可控」的主因不是记忆系统，是 turn 路由。**
`TurnManager.routeMessage` 对**同一渠道**的消息，只要距上条超过 5 秒、或当前 turn 已跑超过 30 秒，就判成 `queue` + `drain` —— 写 drain sentinel、跑完整轮、**杀掉 runtime 进程**、重新冷启一个。典型场景（长任务中途补一句话）100% 命中。详见 §1.2、§1.3。
记忆整理已逐条排除，**不在 turn 关键路径上，也不占用 `maxConcurrentRuntimes` 名额**，详见 §1.4。

**二、Steering 两个主力 runner 都原生支持，只是没接上。**
Claude CLI 已在用 `--input-format stream-json` 却主动 `endStdin: true` 关掉了输入流；Codex app-server 有原生 `turn/steer` 方法但代码里从未调用。两者均已**实机验证**可行（§2.3），不是设计推测。

**零、投递链路上还有两条「静默」故障，危害压过其余所有问题。**
① 用户发一次「停」就可能让整个渠道**永久失声**：中断路径清掉 activeTurn 却不接续 `pendingQueue`，之后该 chatJid 的每条消息都被 `already_queued` 静默丢弃，而全局游标早已推进——只有重启才能恢复（§3.9）。
② IM 发送失败被 `catch` 吞掉后**照常删掉 IPC 文件**，消息只进 DB 和 Web、IM 用户永远收不到，且没有任何重试（§3.10）。表现是「bot 突然不说话」而 Web 端一切正常，极难自查。
这两条应排在延迟和观感之前先修，详见 §8.4、§8.5。

**三、重复投递不是玄学，是一个判据用错了，且命中的是常规路径。**
宿主用 `sentReply` 判断「本轮是否已回复」，但它只在 agent 产生 **stdout 文本**时置位。而按架构约定 IM 回复必须走 `send_message` 工具、stdout 只有 Web 可见 —— 所以一个行为完全正确的纯 IM turn，`sentReply` 恒为 `false`。turn 结束后 runner idle 超时被 `_close`，命中 `index.ts:2908` 的 `closed && !sentReply` → 游标不提交 → 下一轮重新读到同一批消息 → **重复回复**。详见 §3.7。
同时发现两条**消息丢失**路径（§3.1、§3.8）与一条**话题路由全缺失**（§3.6）。

> 施工顺序警告：
>
> - §8.1（修「已回复」判据）优先级最高：纯 bug、改动最小、当下就在踩。
> - §4.0（turn 路由）必须在 steering 实现之前。当前路由会让 `pushMessage()` 永远不被调用，顺序反了会得到「代码全对但现象毫无变化」的结果。

第 2 部分依赖的 SDK 能力已核实存在于当前锁定版本（`@larksuiteoapi/node-sdk@1.58.0` 已内置 cardkit v1）。

> 范围说明：图片下载大小限制（`downloadFeishuImage` 无 `MAX_FILE_SIZE` 保护）已确认为已知问题，但本次**不做**，故不在下文任务列表中。

---

## 1. 现状：消息插入链路

```text
飞书/TG/QQ WS 事件
  → 落 DB
  → 主轮询循环 (src/index.ts:4878, POLL_INTERVAL=1000ms)
  → analyzeIntent(src/intent-analyzer.ts)
  → queue.sendMessage() (src/session-runtime-queue.ts:327)
  → 原子写 data/ipc/{folder}/input/{ts}-{rand}.json
  → runner 侧 IPC poller (container/agent-runner/src/query-loop.ts:96, 500ms)
  → onMessage
```

分叉点在 `query-loop.ts:467`：

```ts
onMessage: runner.ipcCapabilities.supportsMidQueryPush
  ? (msg) => { const rejected = runner.pushMessage(msg.text, msg.images); ... }
  : (msg) => pendingMessages.push(msg),
```

**当前 4 个 runner 的 `supportsMidQueryPush` 全部为 `false`**：

| Runner    | 声明位置                            | 值      |
| --------- | ----------------------------------- | ------- |
| claude    | `runners/claude/runner.ts:824`      | `false` |
| codex     | `runners/codex/runner.ts:227`       | `false` |
| agy       | `runners/agy/runner.ts:155`         | `false` |
| fake-json | `runners/fake-json/manifest.ts:121` | `false` |

所以上面的三元表达式**永远走 else 分支**，消息只进 `pendingMessages`，而 `pendingMessages` 要到整个 turn 结束后才被消费（`query-loop.ts:646`）。

### 1.1 由此产生的用户可见行为

| intent       | 判定       | 实际行为                                                                   |
| ------------ | ---------- | -------------------------------------------------------------------------- |
| `continue`   | 默认       | 消息压到当前 turn 完全结束。跑 10 分钟就等 10 分钟                         |
| `correction` | 关键词命中 | 写 `_interrupt` → SIGINT 杀掉 CLI → **整轮作废** → 重启新 query 带上该消息 |
| `stop`       | 关键词命中 | 写 `_interrupt` → 杀进程，消息不投递                                       |

没有中间态。`analyzeIntent` 只对 ≤50 字符的消息生效且是关键词匹配，所以 `"等等，别用那个库，换成 X"` 会命中「等等」→ `correction` → **杀掉进行中的工作**。这是两难中最差的一侧：既中断了，又没利用上已有上下文。

### 1.2 真正的延迟主因：turn 路由把绝大多数消息判成 `queue` + `drain`

**这一条比 §1.1 更致命，且会让 §4 的 steering 改造完全落空。**

`TurnManager.routeMessage` (`src/turn-manager.ts:88-131`) 的判定：

```ts
const sameChannel  = active.channel === channel;
const withinWindow = now - active.lastInjectedAt < batchWindow;   // turnBatchWindowMs
const withinMax    = now - active.startedAt      < maxBatch;      // turnMaxBatchMs

if (sameChannel && withinWindow && withinMax) return { action: 'inject', ... };
// 否则
return { action: 'queue', needsDrain: true };
```

默认值（`src/runtime-config.ts:1348-1349`）：

```text
turnBatchWindowMs = 5000    // 5 秒
turnMaxBatchMs    = 30000   // 30 秒
```

于是**即使同一个渠道**，只要满足任一条：

- 距上一条消息超过 **5 秒**，或
- 当前 turn 已经跑了超过 **30 秒**

消息就走 `queue` + `needsDrain` → `src/index.ts:4684` 写 `_drain` sentinel → runner 跑完当前 turn 后 **`process.exit(0)`**（`query-loop.ts:629`）→ runtime 进程死掉 → 宿主重新 spawn 一个全新 runtime 处理排队消息。

**后果**：`inject` 分支实际上只对「turn 刚开始 5 秒内的连发消息」有效。而典型的 steering 场景——用户在一个跑了 2 分钟的长任务中间补一句话——**100% 落在 `queue` + `drain`**，`queue.sendMessage()` 根本不会被调用，`pushMessage()` 自然也永远不会触发。

所以 §4 的 steering 实现如果不同时修这里，**改完仍然一点效果都没有**。

### 1.3 端到端延迟账

一条飞书消息从送达到真正进入模型上下文，各段耗时：

| 段                   | 耗时                     | 来源                                                                                             |
| -------------------- | ------------------------ | ------------------------------------------------------------------------------------------------ |
| 主轮询循环           | 0–1000ms                 | `index.ts:4878` 裸 `setTimeout(POLL_INTERVAL)`，唤醒机制是死代码（§3.2）                         |
| runner IPC poller    | 0–500ms                  | `query-loop.ts:96`，`IPC_POLL_MS = 500`                                                          |
| **等当前 turn 跑完** | **不可控，可达数十分钟** | `pendingMessages` 只在 turn 结束后消费（§1.1）；或 drain 路径等整轮结束（§1.2）                  |
| runtime 进程退出     | 数百 ms                  | drain 路径                                                                                       |
| 新 runtime 冷启      | **~2–4s**                | 见下                                                                                             |
| 排队消息重新读取     | 0–1000ms                 | `drainQueuedTurn` 只调 `enqueueMessageCheck`，消息本身等下一个 poll 周期（`index.ts:2421-2428`） |

冷启开销实测（开发机）：

```text
claude --version      ~0.7s   ┐ ClaudeCliAdapter.probeCli (runner.ts:313)
claude -p --help      ~1.1s   ┘ 合计 ~1.8s，每次 runtime 重启都重跑
codex app-server initialize 往返   ~1.0s
```

`probeCli` 的 `probedCommandPaths` 缓存是**适配器实例级**的，而每个 runtime 是独立进程，所以**每次 drain 重启都要重新付这 1.8 秒**，纯属浪费。此外 `--resume` 还要重放整个 transcript，会话越长越慢。

结论：**用户感知到的「多久进 runner 完全不可控」，主因是 §1.2 的 drain 重启链路，其次才是 §1.1 的 turn 内不可插入。**固定开销（轮询 + 冷启）约 3–6 秒，可变开销取决于当前 turn 还要跑多久。

### 1.4 排除项：不是记忆系统的问题

已核查，**记忆整理不在 turn 的关键路径上，不会造成串行阻塞**：

- `MemoryOrchestrator` (`src/memory-agent.ts:1687`) 通过 `RuntimeRequestExecutor` **直接**启动 runtime，**不经过 `SessionRuntimeQueue`**。
- `activeCount` 只在 `session-runtime-queue.ts:695/749` 增减，**记忆 runtime 不占用 `maxConcurrentRuntimes` 名额**，不会把会话 turn 挤掉。
- 写入车道是独立的定时轮询（`MEMORY_WRITE_QUEUE_POLL_MS = 2000`，`writeQueueRunning` 单飞标志），与会话 turn 完全解耦。
- `session_wrapup` 在 **claude runner 上是 fire-and-forget**（`runners/claude/hooks.ts:41` 只 enqueue 不 await；`runner-contract.test.ts:404` 明确断言不等待）。codex/agy 的 archive 路径确实 `await waitForSessionWrapupResponse(requestId, 5_000)`（`codex/archive.ts:142`、`agy/archive.ts:103`），但**只在 compact 后触发，且硬上限 5 秒**，不是常态路径。
- `memory_search` 是 agent 在 turn 内主动调用的 MCP 工具，不是 turn 启动前的阻塞步骤。

唯一残留的次要问题：记忆 runtime 与会话 runtime **共用机器资源但没有统一并发上限**，高负载下可能互相拖慢。属于资源竞争，不是串行阻塞，优先级低于 §1.2。

### 1.5 契约与实现不一致

- `runner-interface.ts:118-121` 注释写着 `Claude: true, Codex: false`，与实现相反。
- `ClaudeRunner.pushMessage()` (`runners/claude/runner.ts:839`) 返回 `['当前 Claude runner 已降级为单 turn 进程，不支持运行中追加消息']`。
- `container/agent-runner/tests/runner-contract.test.ts:303` 把 `supportsMidQueryPush: false` 断言成了**预期值**，改造时会红。
- capability 在 `shared/runner-descriptor.ts:209/311/414` 三处声明，`src/index.ts:274` 有 descriptor 与实例的一致性校验（不一致直接启动失败）。改动必须走 `make sync-types`。

---

## 2. 各 Runner 的 Steering 能力（实机验证）

### 2.1 Claude CLI —— 能力已具备，被自己关掉了

`runners/claude/runner.ts:455-461` 已经在用 `--input-format stream-json --output-format stream-json`。但 `buildInput()` (`runner.ts:515-537`) 返回：

```ts
return {
  stdin: `${JSON.stringify({ type: 'user', message: { role: 'user', content: prepared.prompt } })}\n`,
  endStdin: true, // ← 写完第一条就关闭 stdin
};
```

`BaseCliRunner.runQuery` (`base-cli-runner.ts:305-307`) 据此立刻 `proc.stdin.end()`，realtime streaming input 的能力就此关闭。

CLI 本身还提供 `--replay-user-messages`（"Re-emit user messages from stdin back on stdout for acknowledgment"），是专门为注入回执设计的。当前版本 `claude 2.1.220`。

### 2.2 Codex app-server —— 有原生 `turn/steer`

`codex app-server generate-json-schema -o <dir>` 导出的 `ClientRequest.json` 中包含 `turn/steer`：

```jsonc
// TurnSteerParams
{
  "required": ["expectedTurnId", "input", "threadId"],
  "properties": {
    "threadId": { "type": "string" },
    "expectedTurnId": {
      "description": "Required active turn id precondition. The request fails when it does not match the currently active turn.",
    },
    "input": {
      "type": "array",
      "items": { "$ref": "#/definitions/UserInput" },
    },
    "clientUserMessageId": { "type": ["string", "null"] },
  },
}
// TurnSteerResponse: { "turnId": "string" }
```

`UserInput` 支持 `text` / `image`(url) / `localImage`(path) / `audio` / `localAudio` / `skill` / `mention`，图片可直接走 `localImage`。

当前 `CodexSession` (`runners/codex/session.ts`) 只用到 `thread/start`、`thread/resume`、`turn/start`、`turn/interrupt`、`thread/compact/start`、`thread/inject_items`，**没有用 `turn/steer`**。（`thread/inject_items` 目前只在 turn 之间注入 context section，见 `session.ts:542`。）

### 2.3 实测结果

两个 runner 的探针脚本都在开发机上跑通。

**Claude CLI** —— 保持 stdin 打开，10s 时追加一条 user 消息：

```text
[3989ms]  TOOL_USE Bash: sleep 8 && echo one
>>> 注入 @10005ms
[12353ms] USER/REPLAY: tool_result "one"
[12358ms] USER/REPLAY: STEERING PROBE: skip the third command entirely.   ← 紧随 tool_result
[15453ms] TOOL_USE Bash: sleep 8 && echo two
[27329ms] TEXT: "...它在第一条命令结束后到达...第三条 → 已跳过"
```

**Codex app-server** —— 13s 时调 `turn/steer`：

```text
[5844ms]  item/started  cmd="sleep 8 && echo one"
>>> turn/steer @12992ms → OK
[13740ms] item/started  USER="STEERING PROBE: skip the third command entirely."
[13829ms] item/completed cmd="sleep 8 && echo one"
[17761ms] "I received your partway instruction and will apply it"
[29397ms] "只有前两条命令运行了"
```

两条关键语义也单独验证过，**直接决定实现会不会挂死**：

```text
turn/start  → { turn: { id: "019f983a-d907-77d3-b403-b2d6bf948a65" } }
turn/steer  → { turnId: "019f983a-d907-77d3-b403-b2d6bf948a65" }   SAME = true
```

- **steer 返回的 turnId 与 `turn/start` 相同** → turn 不重建，`CodexSession.runTurn` 里 `event.turn_id === turnId` 的完成判定不受影响，**无挂死风险**，`runTurn` 主体无需改动。
- `expectedTurnId` 不匹配时返回 JSON-RPC `-32600`，且错误信息带上真实 turnId：
  ```text
  expected active turn id `019f0000-...` but found `019f983a-d907-...`
  ```
  → 降级路径可干净检测，不需要靠超时猜测。

### 2.4 agy —— 结构上做不到

`agy --print` 每轮 spawn 一次（`runners/agy/runner.ts:508`），stdout 只有助手文本没有结构化事件流，stdin 不接受增量输入。`agy --help` 无任何 stream/input-format 类选项。

**结论：agy 保持 `midQueryPush: false`，只保留"中断+重启"路径。**

### 2.5 能力矩阵（目标状态）

| Runner    | 机制                                     | 目标 `midQueryPush` |
| --------- | ---------------------------------------- | ------------------- |
| claude    | stdin 追加 `{"type":"user",...}` JSON 行 | `true`              |
| codex     | `turn/steer` RPC                         | `true`              |
| agy       | 无                                       | `false`             |
| fake-json | 视测试需要                               | `false`             |

---

## 3. 附带发现的缺陷

改造前需要一并处理，其中 3.1 是真实的消息丢失。

### 3.1 消息可能永久丢失（违反 CLAUDE.md「不丢消息」约束）

IPC poller 在**文件刚排空时**就发 `ipc_message_received`：

```ts
// query-loop.ts:131-142
for (const msg of messages) {
  opts.state.extractSourceChannels(...);
  opts.writeOutput({ status:'stream', result:null,
                     streamEvent: buildIpcAckStreamEvent(...) });   // ← 此时才刚要交给 onMessage
  opts.onMessage(msg);
}
```

宿主收到该 ack 后 `commitIpcCursorOnAck` 推进 DB 游标（`src/index.ts:2537-2548`、`index.ts:371`）。但此刻消息**只存在于 runner 内存的 `pendingMessages` 数组里**。

runtime 之后一旦死掉——活性看门狗触发、`genericError` 走 `process.exit(1)`（`query-loop.ts:568`）、崩溃或重启——`pendingMessages` 随进程消失，而 DB 游标已经推进，**消息永久丢失**。

好消息：重投递机制**已经存在且已正确接线**，缺的只是「什么时候提交」：

- `discardPendingIpcCursorCommits()` (`index.ts:389`) 丢弃未提交项并清理残留 IPC 文件；
- 它已在 runtime 退出路径被调用并触发重投递（`index.ts:2810-2817`）。

所以本项修复**不需要新基础设施**，只需引入两阶段 ack（见 §4.6）。

### 3.2 整套唤醒机制是死代码

`src/message-notifier.ts` 导出 `interruptibleSleep()`，注释说明主循环应该用它以便 IM 消息到达时立刻唤醒。实际：

- **`interruptibleSleep` 全项目零调用**；主循环 `index.ts:4878` 用的是裸 `await new Promise(r => setTimeout(r, POLL_INTERVAL))`。
- `notifyNewImMessage()` 只有 `src/wechat.ts:701` 调用，且因为没有任何地方注册 `wakeup`，它是 no-op。
- 飞书/Telegram/QQ 入站**根本没调用**它。

结果：每条 IM 消息白吃 0–1s 固定延迟（`POLL_INTERVAL = 1000`，`src/config.ts:6`）。

### 3.3 `send_file` 所有失败对 agent 静默

MCP 工具侧（`container/agent-runner-core/src/plugins/messaging.ts:202`）立刻返回乐观结果：

```ts
writeIpcFile(path.join(ctx.workspaceIpc, 'tasks'), data);
return { content: `Sending file "${args.fileName}"...` };
```

宿主侧 `src/index.ts:4094-4168` 每条失败路径都只是 `logger.warn/error` 后 `break`：

| 失败情形                    | 位置                           | agent 收到                          |
| --------------------------- | ------------------------------ | ----------------------------------- |
| 跨群未授权                  | `index.ts:4106`                | `Sending file...`                   |
| 路径穿越                    | `index.ts:4127`                | `Sending file...`                   |
| 文件不存在                  | `index.ts:4136`                | `Sending file...`                   |
| 上传/发送抛异常（含 >30MB） | `index.ts:4160`                | `Sending file...`                   |
| `targetChannel` 缺失        | `index.ts:4144` 的 `if` 不成立 | `Sending file...`，且**什么都没做** |

agent 既无法重试，也无法告知用户。另外 `send_file` 走 `ipc/tasks/`，而 `send_message`/`send_image` 走 `ipc/messages/`，两条链路不一致。

### 3.4 飞书入站消息类型缺失

`extractMessageContent` (`src/feishu.ts:174-362`) 覆盖 `text / post / image / file / sticker / audio / share_chat / share_user / merge_forward / system`。

| 类型                    | 现状                                                                                                                             | 后果                                               |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| **`media`（视频）**     | **完全没有分支** → 落到 `feishu.ts:354` 的 `return { text: '' }` → `feishu.ts:915` 判空 → `'No text or image content, skipping'` | **整条消息静默丢弃**，用户发视频机器人毫无反应     |
| **`audio`（语音）**     | `feishu.ts:299` 只产出 `[语音消息: 5s]` 占位文本                                                                                 | 不下载资源，机器人等于听不见。飞书语音消息占比很高 |
| post 内 `media` segment | `feishu.ts:256` 只 push `'[视频]'`                                                                                               | 不取 `file_key`，视频内容丢失                      |

`downloadFeishuFileToDisk` (`feishu.ts:652`) 用的 `im.messageResource.get({ params: { type: 'file' } })` 对 audio/media 资源同样适用，复用即可。

### 3.5 飞书事件订阅面过窄

`feishu.ts:1502` 的 EventDispatcher 只注册 4 个事件：`im.message.receive_v1`、`im.chat.member.bot.added_v1`、`im.chat.member.bot.deleted_v1`、`im.chat.disbanded_v1`。

缺 **`card.action.trigger`** —— 这意味着卡片上做任何按钮都不会有回调，§5 阶段 C 依赖它。

---

### 3.6 飞书话题（thread）路由完全没有实现

对应现象：**bot 一直把回复发到话题里而不回群，或偶尔把该发话题的发到群里。**

根因：**代码里没有任何 thread 概念。** 回复目标完全由「回复哪条消息」隐式决定，而飞书的语义是——`im.v1.message.reply` 到一条位于话题内的消息，回复就会落进那个话题。

回复目标的选取链（`src/index.ts:3531-3546`）：

```ts
const triggerMsg = triggerMap?.get(data.targetChannel);
const lastInbound =
  triggerMsg || getLastInboundMessage(data.chatJid, data.targetChannel);
if (agentReplyMode && data.replyToMsgId)
  sendOptions.replyToMsgId = data.replyToMsgId;
else if (lastInbound?.id) sendOptions.replyToMsgId = lastInbound.id;
```

再加上 `src/feishu.ts:1653` 的兜底 `options?.replyToMsgId || lastMessageIdByChat.get(chatId)`。

**这四个来源没有一个是 thread-aware 的：**

| 来源                              | 问题                                                                           |
| --------------------------------- | ------------------------------------------------------------------------------ |
| `data.replyToMsgId`（agent 指定） | 仅 `replyThreadingMode: 'agent'` 生效；但 agent **拿不到 thread 信息**（见下） |
| `triggerMessagesByFolder`         | 只记 `{id, sender}`，无 thread                                                 |
| `getLastInboundMessage()`         | 取该渠道最近一条入站消息，无 thread 过滤                                       |
| `lastMessageIdByChat`             | **按 chatId 全局记最后一条消息**，群里任何人发言都会刷新它                     |

于是：

- 某次触发消息来自话题 → `lastInbound.id` 指向话题内消息 → 之后**每一条**回复都 reply 到它 → **全部掉进那个话题**，且会一直粘住。
- `triggerMap` / `lastMessageIdByChat` 被群根的新消息刷新 → 该回话题的回复跑到群根。
- 群里第三方发言刷新 `lastMessageIdByChat` → bot 去回复一个不相干的人的消息。

**更根本的问题：agent 即使在 `'agent'` 模式下也无法做对。** `formatMessages` (`src/index.ts:1990-2028`) 给 agent 的属性只有：

```xml
<message sender="…" source="feishu:oc_xxx" id="om_xxx"
         reply-to="…" reply-to-sender="…" reply-to-preview="…" time="…">正文</message>
```

**没有任何 thread / topic 标记。** 系统让 agent 决定 `reply_to_message_id`，却不告诉它哪些消息在话题里、哪些在群根——这是无解的。

另外 `parent_id` 其实已经在入站时被解析并写进 DB（`feishu.ts:1517` 取值、`:1176` 落库），但**全项目再无任何地方读取它**，是纯写入的死数据。

还有一个连带问题：`feishu.ts:1655` 的逻辑是 `if (lastMsgId) { reply } else { create }`，而 `lastMessageIdByChat` 几乎总是有值，所以 **bot 实际上永远无法向群里发一条独立的新消息**，永远是引用回复。

### 3.7 消息重复投递

对应现象：**bot 偶尔会收到并处理重复的消息。**

先回答「有没有重投递功能」：**有，而且有 7 条路径**——

| #   | 路径                                              | 位置                               |
| --- | ------------------------------------------------- | ---------------------------------- |
| 1   | IPC 游标 120s 未 ack 过期 → 清文件 + 重新入队     | `index.ts:352-365`                 |
| 2   | runtime 退出时丢弃未提交游标 → 重新入队           | `index.ts:2810-2817`               |
| 3   | `closed` 且未回复 → 保留游标待重试                | `index.ts:2908-2913`               |
| 4   | 错误退出且未回复 → 保留游标待重试                 | `index.ts:2997`                    |
| 5   | 路由判 `queue` → 故意不推进游标，drain 后重读     | `index.ts:4680-4691`               |
| 6   | 队列指数退避重试                                  | `session-runtime-queue.ts:806-824` |
| 7   | 入站去重：`messageExists(messageId)` + `msgCache` | `feishu.ts:860-875`                |

入站去重（#7）是可靠的。**问题出在 #3 和 #4 用错了「是否已回复」的判据。**

`sentReply` 只在两处被置 true：

- `index.ts:2766` —— agent 产生了 **stdout 文本**时
- `index.ts:3101` —— silent-success 兜底发送时

但按 CLAUDE.md 的架构，**IM 回复必须通过 `send_message` 工具显式发送，stdout 只有 Web 可见**。所以一个行为完全正确的纯 IM turn：

```text
agent 调用 send_message(channel="feishu:oc_xxx")  → sawSendMessageTool = true
agent 不产生 stdout 文本                          → sentReply 仍为 false   ← 问题在这
```

然后：

```ts
// index.ts:2908
if (output.status === 'closed' && !sentReply) {
  logger.warn(..., 'Container closed during query without reply, keeping cursor for retry');
  return true;      // ← 游标未提交，且直接 return，连 :3081 的兜底块都跳过了
}
```

**`closed` 是常规路径**：每轮结束后 runner 在 `waitForIpcMessage` 空转，`idleTimeout` 到了触发 `queue.closeStdin()`（`index.ts:2304`）写 `_close`，runner 退出，最终状态就是 `closed`。

于是：agent 已经通过 `send_message` 回复过了 → 但 `sentReply === false` → 游标不提交 → 下一个 poll 周期重新读到同一批消息 → **agent 再处理一遍 → 用户收到重复回复。**

`index.ts:2997` 的 `isErrorExit && !sentReply` 是同一个 bug。讽刺的是那里的注释（`:2998-3001`）写的正是「避免回滚导致重复回复」，但它检查的标志恰恰漏掉了 IM 这条路。

注意 `sawSendMessageTool` 不能直接拿来当判据：它在每次消费新 IPC 消息时会被重置为 false（`index.ts:2553`），这对 silent-success 兜底逻辑是对的（「又欠一条新回复」），但因此**不是**「本轮到底回没回过」的累计标志。需要新增一个累计标志。

另外 `index.ts:2907` 的注释还写着 "the cursor was already committed at line 722"——行号早已失效，说明这块逻辑漂移过。

### 3.8 drain 会丢弃已 ack 的缓冲消息

`query-loop.ts` 的退出分支顺序：

```ts
622: if (result.drainDetectedDuringQuery || shouldDrain(ipcPaths)) {
623:   await runner.cleanup?.();
628:   writeOutput({ status: 'drained', ... });
629:   process.exit(0);          // ← 直接退出
630: }
...
646: if (pendingMessages.length > 0) { ... }   // ← 永远到不了
```

`pendingMessages` 里的消息在 drain 退出时被**直接丢弃**。而它们的游标早在 IPC 排空时就被 ack 提交了（§3.1），宿主侧 `output.status === 'drained'` 又会 `commitCursor()`（`index.ts:2918`），所以这些消息**不会被重投递 → 永久丢失**。

这与 §3.1 是同一个病根（ack 语义），但触发条件不同、且因为 §1.2 让 drain 成为常态而非常容易发生。§4.6 的两阶段 ack 修好后此路径自然消失，但 drain 分支仍应显式把 `pendingMessages` 交回宿主或落盘，不能静默丢。

### 3.9 Turn 队列泄漏 → 渠道永久静默（最严重）

**触发条件：用户发一条被判为 `stop` 的消息（「停」「算了」…）。**

链路：

```text
index.ts:4759 / :4853   broadcastInterruptedTurn(folder, chatJid, '用户主动中断')
  → index.ts:2199       turnManager.interruptTurn(folder)
  → turn-manager.ts:212 this.activeTurns.delete(folder)     ← activeTurn 没了
                        ※ 但 pendingQueue 一条没动，也没有调用 drainQueuedTurn()
```

之后 `processGroupMessages` 收尾时：

```ts
// index.ts:2847-2867
const activeTurn = turnManager.getActiveTurn(group.folder);
if (activeTurn) {          // ← 已经是 null 了
  finalizeCurrentTurn(...);
  drainQueuedTurn();       // ← 永远不执行
}
```

于是 `pendingQueue[folder]` 里的条目**永久滞留**。而 `routeMessage` 的第一道检查是：

```ts
// turn-manager.ts:116-120
const alreadyQueued = queue.some((q) => q.chatJid === chatJid);
if (alreadyQueued) return { action: 'already_queued' };
```

主循环拿到 `already_queued` 就 `continue`（`index.ts:4671-4677`），**而全局游标早在 `index.ts:4622` 就无条件推进过了**。

**结果：该 chatJid 之后的每一条消息都被静默丢弃，机器人对这个渠道彻底失声，直到进程重启**（只有 `recoverOnStartup` 会清 `pendingQueue`）。

`pendingQueue` 没有 TTL、没有容量上限、没有任何巡检。

### 3.10 IM 发送失败 = 消息永久丢失，无重试

`index.ts:3554-3588`：

```ts
try {
  imMsgId = await imManager.sendMessage(data.targetChannel, data.text, ...);
  imSendFailCounts.delete(data.targetChannel);
} catch (err) {
  logger.warn({ imJid: data.targetChannel, err }, 'Failed to relay message to IM');
  // 累计失败数、可能自动解绑……然后就没有然后了
}
// 继续往下：存 DB + 广播 Web
await sendMessage(data.chatJid, data.text, { sendToIM: false, externalMsgId: imMsgId });
```

异常被吞掉后流程继续，最终 `fs.unlinkSync(filePath)`（`index.ts:3730`）把 IPC 文件删了。

**消息只进了 DB 和 Web，IM 用户永远收不到，且没有任何重试队列。** 表现就是「bot 莫名其妙不说话了」，而 Web 端看起来一切正常——这会让排查极其困难。

### 3.11 崩溃窗口导致重复发送

同一段代码的另一个方向：`fs.unlinkSync(filePath)` 在**处理完成之后**才执行。若进程在 `imManager.sendMessage` 成功返回之后、`unlinkSync` 之前崩溃或被 kill，文件留在盘上，**下次启动重新处理 → 用户收到重复消息**。

窗口不大，但 `sendMessage` 之后还有 `await sendMessage(DB 写入)`，实际窗口是「IM 已送达 → DB 写入 → unlink」这一整段。

### 3.12 出站消息未排序（未兜住的假设）

```ts
// index.ts:3497-3499
const messageFiles = fs.readdirSync(messagesDir).filter((f) => f.endsWith('.json'));
for (const file of messageFiles) { ... }
```

**没有 `.sort()`。** 而入站方向的两个读取器都显式排了序：

- `container/agent-runner/src/ipc-handler.ts:161-163` → `.sort()`
- `container/agent-runner-core/src/ipc.ts:80-82` → `.sort()`（注释明写 "Returns messages in FIFO order"）

`readdirSync` 的返回顺序**不由 POSIX 或 Node 保证**，取决于文件系统实现。

诚实说明：在本机 ext4 上构造了「反复写入+删除制造目录碎片」的 churn 场景实测，当前**仍然是有序的**。所以这是一个**没有兜住的假设**，不是已复现的 bug。但项目自己在另外两处都显式排序了，这里不排是不一致，修复成本一行，建议直接补上。

`IPC_POLL_INTERVAL = 1000ms`，agent 一轮里先发「我看看哦」再发结果是常见模式，两个文件同批出现的概率很高——一旦换文件系统或目录规模变化，这就会变成真 bug。

### 3.13 同毫秒文件名无法定序

```ts
// container/agent-runner-core/src/ipc.ts:61
const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
```

同一毫秒内的两次 `writeIpcFile`，文件名只差随机后缀，**即使排序也是随机顺序**。应改为「时间戳 + 进程内单调递增计数器」，让排序成为可靠的 FIFO。

（`session-runtime-queue.ts:365` 的入站文件名有同样问题。）

### 3.14 `ipc/errors/` 是静默黑洞

`index.ts:3736` 和 `:3792` 在处理失败时把消息/任务文件 rename 进 `data/ipc/errors/`：

```ts
const errorDir = path.join(ipcBaseDir, 'errors');
fs.renameSync(filePath, path.join(errorDir, `${sourceGroup}-${file}`));
```

**此后没有任何代码读取、重试、清理它，也不在 UI 暴露。** 全项目对 `errors` 的引用只有三处：这两处写入，加上 `index.ts:3459` 的「扫描时跳过这个目录」。

一条用户可见的回复可以就这样消失，只留一行日志。当前该目录为空（未在生产触发过），但它是一条设计上的静默丢失路径。

### 3.15 释放的并发槽不会重新分配（饥饿）

`session-runtime-queue.ts:834-846`：

```ts
private drainGroup(groupJid: string): void {
  const activeRunner = this.findActiveRunnerFor(groupJid);
  if (activeRunner && activeRunner !== groupJid) {
    this.waitingGroups.add(groupJid);
    return;                       // ← 没有 drainWaiting()
  }
  if (!this.hasCapacityFor(groupJid)) {
    this.waitingGroups.add(groupJid);
    return;                       // ← 没有 drainWaiting()
  }
  ...
  this.drainWaiting();            // ← 只有「本组无待办」时才会走到
}
```

runtime 退出后，如果**本组**不能立刻重启，函数直接返回，**刚释放出来的并发槽不会分给其它等待中的组**。它们只能等到某个「退出且自己无待办」的组恰好触发 `:864` 才被唤醒。

`hasCapacityFor` 除全局 `maxConcurrentRuntimes` 外还包含**按用户的并发上限**（`:164-167`），所以存在真实的饥饿场景：用户 A 的组因自身用户配额被挡住 → 直接 return → 用户 B 的等待组明明有全局容量却拿不到调度。

### 3.16 `getLastInboundMessage` 排序键无意义

```sql
-- db.ts:2051-2052
ORDER BY timestamp DESC, id DESC LIMIT 1
```

`id` 是飞书的 `om_xxx` 随机串，**不单调**，作为 tiebreaker 没有意义。同一 timestamp 内会取到错误的「最后一条入站消息」。

这个函数正是 §3.6 回复目标选取链的一环，所以它会**直接加重话题/回复错乱**。应改为 `ORDER BY rowid DESC`（rowid 严格单调，且 `getNewMessages` 等查询本就以 rowid 为准）。

### 3.17 结构性风险：两个游标推进时机不对称

`globalMessageCursor` 在 `index.ts:4622` **无条件地、在任何路由决策之前**推进并 `saveState()`：

```ts
globalMessageCursor = newCursor;
saveState();
// ↓ 之后才开始 routeMessage / sendMessage / enqueue
```

因此 `getNewMessages` 永远不会再返回这批消息。所有「重投递」都只能依赖 `processGroupMessages` 从 `lastAgentTimestamp[chatJid]` 重新 fetch（`index.ts:2239-2240`）。

**这意味着一条不变量：凡是 `routeMessage` 没有走到 `inject` / `start_new` 的分支，都必须保证最终有且仅有一次 `processGroupMessages` 被触发；否则消息永久消失。**

§3.9 正是这条不变量被打破的具体实例。这个结构本身不一定要改，但必须把不变量写成显式约束并加断言/巡检，否则以后每加一条路由分支都可能再踩一次。

## 4. 方案一：Turn 内 Steering

### 4.0 先修 turn 路由（前置，否则以下全部白做）

对应 §1.2。目标：**同一渠道的后续消息，只要 runtime 还活着，一律走 `inject`，不再 drain 重启。**

`src/turn-manager.ts:88-131` 的判定改为：

```ts
const sameChannel = active.channel === channel;

// 同渠道 + runner 支持 steering → 无条件 inject，不再看时间窗
if (sameChannel && canSteer(folder)) {
  active.lastInjectedAt = now;
  active.messageIds.push(...messageIds);
  return { action: 'inject', turnId: active.id };
}

// 同渠道但 runner 不支持 steering（agy）→ 保留原有时间窗批量语义
if (sameChannel && withinWindow && withinMax) { ... }

// 跨渠道 → 仍然 queue + drain（会话隔离要求，不改）
```

要点：

- **时间窗的原始用途是「把连发的碎片消息批量成一轮」，不是「决定能不能插入」。** steering 可用后，这两件事必须解耦：批量仍按窗口合并首轮 prompt，但**窗口过期不应再降级成 drain 重启**。
- `canSteer(folder)` 需要宿主知道该 session 当前 runner 的 capability。`SessionRuntimeQueue` 已持有 `runtimeIdentifier`（`session-runtime-queue.ts:281`），据此查 `shared/runner-descriptor.ts` 的 `midQueryPush` 即可。
- **跨渠道仍然 drain**，这是会话隔离的有意设计（CLAUDE.md），本次不动。
- `turnMaxBatchMs` 对 inject 路径失去意义，但对「无 steering 的 runner」仍需保留。建议在设置页加说明，避免误解为全局节流。

**冷启开销顺带优化**（可选，独立收益）：`ClaudeCliAdapter.probeCli` (`runners/claude/runner.ts:313`) 每次 runtime 重启都要跑 `claude --version` + `claude -p --help` 共 ~1.8s。可把探测结果按 `commandPath + mtime` 缓存到 `data/state/` 下的文件，跨进程复用。

验收：一个跑 5 分钟的 turn，中途第 2 分钟从同一飞书会话发消息 —— 日志应显示 `action: 'inject'`，**不应**出现 `Drain sentinel written`，runtime 进程 PID 不变。

### 4.1 契约变更

**`AgentRunner.pushMessage` 改为异步：**

```ts
// container/agent-runner/src/runner-interface.ts
/**
 * 向活跃 query 注入后续消息。
 * @returns 空数组 = 已成功交付模型；非空 = 未交付，元素为原因（调用方应降级为 buffer）
 */
pushMessage(
  text: string,
  images?: Array<{ data: string; mimeType?: string }>,
): Promise<string[]>;
```

理由：Codex 的 `turn/steer` 是 JSON-RPC 往返，同步签名塞不下；且返回值语义需要从"被拒绝的图片原因"扩展为"是否成功交付"，以驱动降级。

同步更新 `runner-interface.ts:118-121` 的 `IpcCapabilities` 注释（当前与实现相反）。

**capability 声明**：改 `shared/runner-descriptor.ts` 三处 `midQueryPush`（:209/:311/:414 对应 claude/codex/agy，以实际顺序为准），然后 `make sync-types` 同步到 `src/runner-descriptor.types.ts` 和 `container/agent-runner/src/runner-descriptor.types.ts`。`src/index.ts:274` 的一致性校验会在启动时兜底。

同步修 `container/agent-runner/tests/runner-contract.test.ts:303` 的过时断言。

### 4.2 query-loop：改为「先试后降级」

当前是靠静态 capability 二选一，改为动态降级——即使声明支持，运行时失败（如 Codex 的 turn 已结束）也要能落回 buffer。

```ts
// query-loop.ts —— createUnifiedIpcPoller 内
// poll 改为 async，并在 await onMessage 之后再 setTimeout(poll)，
// 以此串行化注入，避免多条消息乱序 steer。
for (const msg of messages) {
  opts.state.extractSourceChannels(msg.text, opts.imChannelsFile);
  opts.writeOutput({ ...buildIpcAckStreamEvent(...) });   // 阶段一：受理（见 §4.6）
  await opts.onMessage(msg);
}
```

```ts
// runQueryLoop 内
onMessage: async (msg) => {
  const rejected = await runner.pushMessage(msg.text, msg.images).catch(
    (err) => [`steering 失败: ${err instanceof Error ? err.message : String(err)}`],
  );
  if (rejected.length === 0) {
    emitDelivered(msg);          // 阶段二：真交付
    return;
  }
  log(`Steering unavailable (${rejected.join('; ')}), buffering for next turn`);
  pendingMessages.push(msg);     // 统一降级路径
},
```

注意 `poll` 变 async 后，`pollerState.isActive` 的检查要在 await 之后再判一次，避免 stop 后仍继续调度。

### 4.3 ClaudeRunner 实现

**改动点：**

1. `runners/claude/runner.ts:515-537` `buildInput()` 改 `endStdin: false`。
2. `BaseCliRunner` 暴露写 stdin 的能力：

```ts
// base-cli-runner.ts
protected writeStdinLine(line: string): boolean {
  const proc = this.activeProcess;
  if (!proc || proc.killed || !proc.stdin?.writable) return false;
  return proc.stdin.write(line);
}
protected endStdin(): void {
  this.activeProcess?.stdin?.end();
}
```

`activeProcess` 目前是 `private`，需改 `protected`。

3. `ClaudeRunner.pushMessage` 实现：

```ts
async pushMessage(text, images): Promise<string[]> {
  const prepared = prepareClaudePromptWithImages(text, images, this.imagesDir, log);
  const ok = this.writeStdinLine(
    JSON.stringify({ type: 'user', message: { role: 'user', content: prepared.prompt } }) + '\n',
  );
  if (!ok) return ['Claude CLI stdin 不可写（进程可能已退出）'];
  return prepared.rejected;   // 图片被拒的原因，仍算已交付文本
}
```

图片复用现有 `prepareClaudePromptWithImages`（落盘 + 路径引用），与首轮 prompt 同一条路径。

4. **必须在收到 `result` 事件后关闭 stdin**。实测中 CLI 在 stdin 保持打开时会正常 emit `result`，但进程要等 stdin 关闭才退出。若不关，`BaseCliRunner` 的 `queue.close()` 永不触发，runQuery 挂死。建议在 claude adapter 的 `parseStdoutLine` 检测到 `type === 'result'` 时调用 `endStdin()`。

5. 加 `--replay-user-messages` 到 `buildCommand` 的 args（`runner.ts:455`），用 replay 出来的 user 事件做真送达回执（§4.6 阶段二）。注意 replay 会把**首轮 prompt 也回放一次**，解析时要能区分（可用 `clientUserMessageId` 或按序号跳过第一条）。

6. **竞态**：`runQuery` 的 `finally` 会把 `activeProcess` 置 null（`base-cli-runner.ts:338`）。`pushMessage` 与 turn 结束并发时 `writeStdinLine` 返回 false → 自动降级 buffer，行为正确。

### 4.4 CodexRunner 实现

1. `CodexSession` 增加 `steer()`：

```ts
// runners/codex/session.ts
async steer(input: UserInput[]): Promise<void> {
  if (!this.threadId || !this.activeTurnId) {
    throw new Error('no active turn');
  }
  await this.request('turn/steer', {
    threadId: this.threadId,
    expectedTurnId: this.activeTurnId,
    input,
  });
  // 返回的 turnId 与 turn/start 相同（已验证），无需更新 activeTurnId
}
```

2. `CodexRunner.pushMessage`：

```ts
async pushMessage(text, images): Promise<string[]> {
  const paths = images?.length ? saveImagesToTempFiles(images, this.tmpDir) : [];
  const input = [
    { type: 'text', text },
    ...paths.map((p) => ({ type: 'localImage', path: p })),
  ];
  try {
    await this.session.steer(input);
    return [];
  } catch (err) {
    return [`codex turn/steer 失败: ${err instanceof Error ? err.message : String(err)}`];
  }
}
```

3. `runTurn` **无需改动**（turnId 不变已验证）。
4. `-32600`（`expectedTurnId` 不匹配）与 "no active turn" 都自然落到 catch → 返回非空 → query-loop 降级 buffer。

### 4.5 AgyRunner

保持 `midQueryPush: false`，`pushMessage` 改异步并返回明确原因：

```ts
async pushMessage(): Promise<string[]> {
  return ['agy print 模式不支持运行中追加消息，消息将在下一轮送达'];
}
```

### 4.6 两阶段 ack（修 §3.1 消息丢失）

引入两个语义不同的信号，**不改动现有重投递基础设施**：

| 阶段   | StreamEvent                     | 触发时机               | 宿主动作                                                          |
| ------ | ------------------------------- | ---------------------- | ----------------------------------------------------------------- |
| 受理   | `ipc_message_received`（现有）  | IPC 文件排空时         | **仅**清除 `IPC_DELIVERY_TIMEOUT_MS` 投递看门狗，**不再提交游标** |
| 真交付 | `ipc_message_delivered`（新增） | 消息真正进入模型上下文 | 提交 DB 游标（`commitIpcCursorOnAck`）                            |

「真交付」的判定：

- **claude**：`--replay-user-messages` 回放出该条 user 消息时；
- **codex**：`turn/steer` RPC 成功返回时；
- **降级 buffer**：`pendingMessages` 被 merge 成下一轮 `prompt` 时（`query-loop.ts:646` 与 `:679` 两处）。

宿主侧改动：

- `src/index.ts:2537` 的 `ipc_message_received` 分支拆成两个，`commitIpcCursorOnAck` 只挂到新事件上。
- `deferIpcCursorCommit` 的 120s 定时器（`index.ts:352`）在收到「受理」时**刷新/取消**，否则长于 2 分钟的 turn 会误判过期并重复投递。runtime 真死掉时由 `index.ts:2810` 的 `discardPendingIpcCursorCommits` 兜底重投递。

新事件需在 `shared/stream-event.ts` 定义，`make sync-types` 同步，Web 端 `web/src/stores/chat.ts` 至少不能因未知事件报错。

### 4.7 intent 策略调整

`src/intent-analyzer.ts` 的启发式在 steering 可用后，`correction` 不应再杀进程：

- `stop` → 保持 `interruptQuery`（用户确实想停）。
- `correction` → **改为直接注入**，不再 `interruptQuery`。
- `src/session-runtime-queue.ts:353-360` 的 correction 分支去掉 `this.interruptQuery(groupJid)`。
- `src/index.ts:4755-4768` 与 `:4849-4862`、`src/web.ts:360-366` 的 `interrupted_correction` 处理相应简化。

若 runner 不支持 steering（agy），`correction` 保持原有中断语义——按 `pushMessage` 返回值决定即可。

### 4.8 唤醒机制（修 §3.2）

1. `src/index.ts:4878` 改用 `interruptibleSleep(POLL_INTERVAL)`。
2. 飞书 (`src/feishu.ts` 入库后)、Telegram (`src/telegram.ts`)、QQ (`src/qq.ts`) 入站落库后调用 `notifyNewImMessage()`，与 `src/wechat.ts:701` 对齐。

预期收益：砍掉每条 IM 消息 0–1s 的固定延迟。

### 4.9 明确非目标

**不做「持久 CLI 进程」。** 实测发现 `claude -p` 在 stdin 保持打开时可跨多轮接收消息，理论上可以一个进程服务整个 session，省掉每轮 `--resume` 的重放开销。但这会牵动 session state、resume anchor、context 重建、崩溃恢复等一整套逻辑，风险远超本次收益。留作后续独立议题。

### 4.10 验收标准

| 场景                                        | 期望                                                                                   |
| ------------------------------------------- | -------------------------------------------------------------------------------------- |
| **跑 5 分钟的 turn，第 2 分钟同渠道发消息** | 日志显示 `action: 'inject'`，**无** `Drain sentinel written`，runtime PID 不变（§4.0） |
| 跨渠道发消息                                | 仍然 drain + 排队（会话隔离不变）                                                      |
| claude runner 执行长任务时从飞书发一条消息  | 在**下一个 tool call 边界**出现在模型上下文中；日志可见 delivered 事件                 |
| codex runner 同上                           | 同上；`turn/steer` 返回成功                                                            |
| agy runner 同上                             | 消息在**下一轮**送达（现状行为），且 runner 日志给出明确降级原因                       |
| steer 时 turn 恰好结束                      | 自动降级 buffer，消息不丢、不重复                                                      |
| 注入后 kill -9 runtime                      | 消息从 DB 重新投递（游标未提交），无重复无丢失                                         |
| turn 时长 > 2 分钟且消息被 buffer           | **不**触发重复投递                                                                     |
| 发送 `"等等，换个方式"`                     | 不再杀进程，作为 steering 注入                                                         |
| 发送 `"停"`                                 | 仍然中断当前 turn                                                                      |
| 启动时 descriptor 与实例 capability 不一致  | `index.ts:274` 校验报错（说明 `make sync-types` 漏跑）                                 |

---

## 5. 方案二：飞书卡片渲染

### 5.1 现状问题

两套卡片**都是卡片 JSON 1.0**：`{ config: { wide_screen_mode }, header, elements }`。

`src/feishu-streaming-card.ts` 文件头注释写着 "Implements CardKit 2.0 streaming cards" —— **与实现不符**，它构造 1.0 卡片并靠 `im.v1.message.patch` **整卡重传**（`feishu-streaming-card.ts:424`）。

| 问题                               | 位置                                          | 后果                                                                                        |
| ---------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 每次更新重传整张卡                 | `feishu-streaming-card.ts:415-438`            | 文字越长越贵；1200ms 节流 + 50 字符阈值（`:146`）正是为绕开频率限制而设，长回复后期几乎卡住 |
| 无打字机效果                       | —                                             | 用户看到每 1.2s 跳一大段                                                                    |
| 只用 markdown / hr / note 三种元素 | `feishu-progress-card.ts:197-289`             | 工具轨迹是一坨纯文本行                                                                      |
| 工具轨迹硬截断 15 条               | `feishu-progress-card.ts:139`                 | 长任务看不到全貌                                                                            |
| 思考内容全量 blockquote 铺开       | `feishu-progress-card.ts:167-176`             | 卡片被撑得极长                                                                              |
| `wide_screen_mode`                 | 两文件                                        | 2.0 已由 `width_mode` 取代                                                                  |
| header 只有 title + template       | 两文件                                        | 未用 subtitle / icon / text_tag_list                                                        |
| 卡片上无任何按钮                   | `feishu.ts:1502` 未注册 `card.action.trigger` | 交互组件做了也没人接                                                                        |

### 5.2 已核实的可用能力

**当前锁定的 `@larksuiteoapi/node-sdk@1.58.0 已内置 cardkit v1**，无需升级 SDK 也无需手写 HTTP：

```text
client.cardkit.v1.card         → create / update / settings / batchUpdate / idConvert
client.cardkit.v1.cardElement  → content / create / update / patch / delete

/open-apis/cardkit/v1/cards
/open-apis/cardkit/v1/cards/:card_id
/open-apis/cardkit/v1/cards/:card_id/settings
/open-apis/cardkit/v1/cards/:card_id/batch_update
/open-apis/cardkit/v1/cards/:card_id/elements/:element_id/content
/open-apis/cardkit/v1/cards/id_convert
```

卡片 JSON 2.0（`"schema": "2.0"`）提供：

- `config.streaming_mode` + `config.streaming_config`（`print_frequency_ms` / `print_step` / `print_strategy`）—— **原生打字机**
- `config.width_mode`：`default`(600px) / `compact`(400px) / `fill`
- `header`：`subtitle` / `icon` / `text_tag_list`（最多 3 个）/ `padding`
- `body`：`direction` / `padding` / `vertical_spacing` / `horizontal_spacing`
- `collapsible_panel` 折叠面板组件

**两个必须提前设计的约束：**

1. cardkit 所有写操作的 `sequence` **必须严格递增**（跨 create/content/settings 共享同一序号空间）。
2. 流式模式服务端约 **120s 超时**，长回复需要续期或分段策略。

### 5.3 阶段 A —— 骨架升级到 JSON 2.0 + 视觉重设计

不涉及新 API，纯渲染层改造，风险最低，建议先做。这一阶段决定「好不好看」，值得按设计稿实现而不是简单平移。

#### 5.3.1 进度卡当前长什么样

`buildProgressCard` (`feishu-progress-card.ts:191-290`) 产出的实际形态：

```text
┌─────────────────────────────────┐
│ ⚡ Agent 执行中          (wathet) │   ← header 只有一行，标题恒定无信息量
├─────────────────────────────────┤
│ ⚡ **执行中** · ⏱ 2m15s          │   ← 和 header 完全重复
│ 💬 正在查看配置文件…              │
│ 💭 正在思考...                    │
│ > 用户想要改的是卡片渲染这块        │   ← 思考全量 blockquote，无限撑长
│ > 我需要先看一下现在的实现           │
│ > ……（可能几十行）                 │
│ ───────────────────────────────  │
│ **子 Agent**                     │
│ ✅ 🤖 [explore] 找卡片代码: …(12s) │
│ ───────────────────────────────  │
│ ✅ Read `feishu.ts` (1s)          │   ← 全部塞进一个 markdown 字符串
│ ✅ Bash `npm test` (30s)          │
│ ✅ Read `card.ts` (1s)            │
│ …（硬截断，只留最后 15 条）         │
│ 🔧 Grep `foo` (2s)                │
└─────────────────────────────────┘
```

问题不在「元素不够」，而在**信息层级全平**：所有内容都是同一号字、同一颜色的 markdown 行，emoji 当唯一的视觉区分手段，最重要的「现在在干什么」和最不重要的「10 分钟前读过哪个文件」占用同等视觉权重。

#### 5.3.2 目标形态

```text
┌──────────────────────────────────────────┐
│ 🔧 改飞书卡片渲染          [2m15s][opus-5] │  ← title=任务摘要, text_tag_list
│ 正在查看 feishu-progress-card.ts          │  ← subtitle=当前动作，一行说清
├──────────────────────────────────────────┤
│ 🔧 Grep  `collapsible_panel`      2s     │  ← 活跃工具常驻，左右分栏对齐
│                                          │
│ 💬 我先看一下现在卡片是怎么拼的            │  ← commentary 正常段落
│                                          │
│ ▸ 💭 思考过程                             │  ← collapsible_panel，默认折叠
│ ▸ 🔧 工具调用 (23)                        │  ← collapsible_panel，展开看全部
│ ▸ 🤖 子 Agent (1)                         │
└──────────────────────────────────────────┘
```

核心改动：

| 项               | 现状                           | 目标                                                         |
| ---------------- | ------------------------------ | ------------------------------------------------------------ |
| header title     | 恒为 `⚡ Agent 执行中`，零信息 | 任务摘要（可复用 im-commentary 的产出）                      |
| header subtitle  | 无                             | **当前正在做什么**，单行，这是用户最想看的                   |
| header 状态      | emoji 前缀                     | `icon`（`ud_icon`）+ `template` 配色                         |
| 耗时/模型/工具数 | 混在正文首行                   | `text_tag_list`（最多 3 个 tag）                             |
| 状态行与 header  | 内容重复                       | 删掉正文里的重复状态行                                       |
| 活跃工具         | 混在历史轨迹末尾               | **单独常驻**一行，`column_set` 左右分栏（名称 / 耗时右对齐） |
| 思考内容         | 全量 blockquote 铺开           | `collapsible_panel` 默认折叠                                 |
| 工具轨迹         | 平铺 + 15 条硬截断             | `collapsible_panel`，标题带计数，**展开可看全部**            |
| 子 Agent         | 平铺                           | `collapsible_panel`，标题带计数                              |
| 完成态           | 与执行态同构                   | 全部折叠，只留结果摘要 + 耗时/token tag                      |

#### 5.3.3 回复卡（streaming card）

`buildStreamingCard` (`feishu-streaming-card.ts:53-131`) 目前会**猜标题**：扫描前几行找 `^#{1,3}\s+`，找不到就截取第一行前 40 字符当 title（`:72-80`）。这在实际回复里经常抓到半句话或一个列表项当标题，是当前最明显的「不美观」来源。

改为：

- header title **固定**（会话名或「回复」），不再从正文猜；正文完整保留，不再被切走第一行。
- 去掉 `CARD_MD_LIMIT = 4000` 的多 element 切分造成的视觉断裂 —— 阶段 B 的 CardKit 流式天然按元素增量更新，不需要切。
- `\n---\n` 拆 `hr` 的逻辑（`:92-97`）保留，但改用 2.0 的分割线组件。

#### 5.3.4 实现要点

1. 新建 `src/feishu-card-builder.ts`，统一产出 `schema: "2.0"` 结构，供 progress card 与 streaming card 共用；两个 controller 只负责状态管理，不再各自拼 JSON。
2. `config.wide_screen_mode` → `config.width_mode`。
3. **去掉 `MAX_LOG_ENTRIES = 15` 硬截断**（`feishu-progress-card.ts:139`）；折叠面板内可容纳全部，仅在极端长度时才截断并注明省略条数。
4. 折叠面板的默认展开状态：执行中时「工具调用」折叠、活跃工具常驻；完成后全部折叠。
5. emoji 保留但减量 —— 状态改用 `icon` + `template` 表达，正文只在语义必要处保留（🔧/🤖/💭）。

验收：飞书桌面端与移动端渲染正常；折叠面板可展开；长任务不再截断轨迹；回复卡不再出现被截断的伪标题。

### 5.4 阶段 B —— CardKit 真流式

改造 `src/feishu-streaming-card.ts`，从整卡 patch 换为卡片实体增量更新：

```text
1. cardkit.v1.card.create      建卡片实体（含 streaming_mode + streaming_config）
2. im.v1.message.create        content = {"type":"card","data":{"card_id":"..."}}
3. cardkit.v1.cardElement.content   逐次只推文本 delta（非整卡）
4. cardkit.v1.card.settings    结束时关闭流式模式
```

必须实现：

- 严格递增的 `sequence` 计数器（建议放在 `StreamingCardController` 实例上）。
- 120s 超时的续期或分段兜底。
- **保留现有 `im.message.patch` 路径作为 fallback**：已存在的 `streamingCard` 配置项（`src/runtime-config.ts:106`、`src/routes/config.ts:597`，默认 `false`）正好用作灰度开关。
- `FlushController`（`feishu-streaming-card.ts:135`）的节流阈值在真流式下应显著放宽，否则打字机效果被自己的节流吃掉。

验收：长回复（>4000 字）全程平滑输出无卡顿；关闭开关可回退旧路径；`sequence` 冲突有重试或明确报错。

### 5.5 阶段 C —— 卡片交互

1. 在 `src/feishu.ts:1502` 的 EventDispatcher 注册 `card.action.trigger`。
2. 进度卡加「停止」按钮 → 直连 `queue.interruptQuery(groupJid)`。
3. 与方案一呼应：steering 让"补充说明"不必中断，按钮让"真的要停"有一键入口。

验收：点击按钮能中断当前 turn，卡片状态相应更新。

---

## 6. 方案三：飞书能力补齐

### 6.1 视频消息静默丢弃（最高优先）

`extractMessageContent` (`src/feishu.ts:174`) 增加 `media` 分支：

```ts
if (messageType === 'media') {
  const fileKey = parsed.file_key;
  const filename = parsed.file_name || '';
  if (fileKey) {
    return {
      text: `[视频: ${filename || fileKey}]`,
      fileInfos: [{ fileKey, filename: filename || `${fileKey}.mp4` }],
    };
  }
}
```

复用现有 `downloadFeishuFileToDisk` 落盘链路（`feishu.ts:652`）——它用的 `im.messageResource.get({ params: { type: 'file' } })` 对 media 资源同样适用。

同时修 post 内的 `media` segment（`feishu.ts:256`），提取 `file_key` 而非只 push `'[视频]'`。

验收：用户发视频 → 机器人有响应，文件落到 `downloads/feishu/{date}/`，agent 拿到路径。

### 6.2 语音消息

`feishu.ts:299` 的 `audio` 分支增加资源下载（opus），落盘后把路径给 agent，文本保留时长信息：

```ts
if (messageType === 'audio') {
  const fileKey = parsed.file_key;
  const duration = parsed.duration
    ? `${Math.round(parsed.duration / 1000)}s`
    : '';
  if (fileKey) {
    return {
      text: `[语音消息${duration ? ': ' + duration : ''}]`,
      fileInfos: [{ fileKey, filename: `voice_${fileKey}.opus` }],
    };
  }
}
```

转写能力不在本次范围内，先保证「拿得到文件」。

验收：发语音 → 机器人有响应，opus 落盘，agent 知道文件路径。

### 6.3 `send_file` 结果回传

分两层修：

**MCP 工具侧（`container/agent-runner-core/src/plugins/messaging.ts:161-203`）**——把能同步判定的错误直接返回，不再乐观：

- `channel` 必填校验（当前 schema 已 required，但宿主侧 `data.targetChannel` 缺失时会静默无动作，需一致）；
- 文件存在性、大小上限已在工具侧检查（`:184-191`），保持；
- 明确文案：成功时说明"已提交发送"，而不是暗示已送达。

**链路一致性**——把 `send_file` 从 `ipc/tasks/` 迁到与 `send_image` 一致的 `ipc/messages/` 链路，宿主侧失败时通过既有回注机制告知 agent。

**宿主侧（`src/index.ts:4094-4168`）**——每条失败路径除 log 外，向 agent 回注一条错误说明。

验收：文件不存在 / 超 30MB / 未授权 / 上传失败四种情况，agent 都能拿到明确错误并可据此回复用户。

---

## 7. 方案四：飞书话题（thread）路由

对应 §3.6。原则：**回复目标必须由「消息属于哪个会话上下文」显式决定，不能由「最后一条消息碰巧是谁」隐式决定。**

### 7.1 打通 thread 数据（前置）

1. **入站补齐**：`feishu.ts` 的 `im.message.receive_v1` handler 除 `parent_id` 外，同时取 `thread_id`（飞书话题群/话题消息会带）和 `root_id`，一并落库。DB 需要加列，走 `db.ts` migration + `SCHEMA_VERSION`。
2. **`parent_id` 目前是死数据**（只写不读），本次一并接上读取路径。
3. 增加 `getLastInboundMessageInThread(chatJid, sourceJid, threadId)`，替代无条件的 `getLastInboundMessage`。

### 7.2 让 agent 看得见话题

`formatMessages` (`src/index.ts:1990-2028`) 增加属性：

```xml
<message sender="…" source="feishu:oc_xxx" id="om_xxx"
         thread="omt_xxx"        ← 新增：消息所在话题；无则省略 = 群根
         reply-to="…" time="…">正文</message>
```

对应地，`send_message` 工具（`container/agent-runner-core/src/plugins/messaging.ts:25`）增加 `thread` 参数，并在 description 里说清语义：

- 传 `thread="omt_xxx"` → 回到该话题
- 显式传空 / 不传且上下文在群根 → 发到群里
- **不要**默认沿用上一条消息的话题

当前 `'agent'` 模式让 agent 决定 `reply_to_message_id` 却不给 thread 信息，是"要求 agent 做一个信息不足的决策"，必须先补 §7.2 才谈得上 `'agent'` 模式可用。

### 7.3 修回复目标选取

`src/index.ts:3531-3546` 改为按话题维度解析：

```ts
// 1. agent 显式指定 thread → 用之
// 2. 否则用「触发本轮的那条消息」的 thread（而不是"最后一条入站消息"）
// 3. 群根消息 → 用 im.v1.message.create 直发群，不 reply
```

配套改动：

- `triggerMessagesByFolder` 的 value 从 `{id, sender}` 扩成 `{id, sender, threadId}`。
- **删掉 `feishu.ts:1653` 的 `lastMessageIdByChat` 兜底**，或至少限制为「同话题内」。按 chatId 全局记最后一条消息会让 bot 去回复第三方的发言，是明确的错误行为。
- `feishu.ts:1655` 的 `if (lastMsgId) reply else create` 改为：**只有确实需要回到某话题/引用某条消息时才 `reply`，否则一律 `create` 直发**。当前实现让 bot 几乎永远无法向群里发独立消息。
- 需要主动开话题时使用 `reply` 的 `reply_in_thread: true`（目前全项目未使用）。

### 7.4 验收标准

| 场景                                     | 期望                                             |
| ---------------------------------------- | ------------------------------------------------ |
| 用户在群根 @bot                          | 回复发到**群根**，不进任何话题                   |
| 用户在话题 A 内 @bot                     | 回复发到**话题 A**                               |
| 话题 A 对话后，用户回到群根发新消息      | 回复发到**群根**，不再粘在话题 A                 |
| 群里第三方发言后，bot 回复上一条用户消息 | 回复目标是**用户那条**，不是第三方那条           |
| `replyThreadingMode: 'agent'`            | agent 能从 prompt 里读到 `thread` 属性并正确指定 |

## 8. 方案五：投递语义修复（重复投递 / 丢失）

对应 §3.7、§3.8。

### 8.1 修「已回复」判据（这是重复投递的主因）

新增一个**本轮累计**标志，覆盖所有用户可见的回复方式：

```ts
let deliveredUserVisibleReply = false;   // 整轮累计，不随 IPC 消息重置

// stdout 文本（Web）
if (text) { ...; deliveredUserVisibleReply = true; }
// send_message 工具（IM）—— 与 sawSendMessageTool 同点触发，但不重置
if (_se.toolName?.endsWith('__send_message')) {
  sawSendMessageTool = true;
  deliveredUserVisibleReply = true;
}
// send_image / send_file 同理
```

然后把 `index.ts:2908` 和 `:2997` 的 `!sentReply` 换成 `!deliveredUserVisibleReply`。

保留 `sawSendMessageTool` 原有的**逐消息重置**语义不变——它服务的是 `:3081` 的 silent-success 兜底（「刚消费了新消息，又欠一条回复」），两者职责不同，不要合并。

顺带清理 `index.ts:2907` 那条指向已失效行号的注释。

### 8.2 `closed` 分支不应跳过兜底

`index.ts:2908-2913` 命中时直接 `return true`，绕过了 `:3081` 的 silent-success 兜底和 `:3112` 的 `commitCursor()`。改为：先判定是否真的没回复过，确实没有才保留游标；回复过则走正常收尾路径。

### 8.3 drain 不得丢弃缓冲消息

`query-loop.ts:622-630` 的 drain 分支在 `process.exit(0)` 前，必须把 `pendingMessages` 交回宿主：

```ts
if (result.drainDetectedDuringQuery || shouldDrain(ipcPaths)) {
  await runner.cleanup?.();
  if (pendingMessages.length > 0) {
    // 回写为未消费状态，或随 drained 输出上报，由宿主重新入队
    writeOutput({ status: 'stream', result: null,
                  streamEvent: { eventType: 'status', statusText: 'ipc_messages_returned', ... } });
  }
  writeOutput({ status: 'drained', ... });
  process.exit(0);
}
```

§4.6 的两阶段 ack 落地后，这些消息的游标本就未提交，宿主的 `discardPendingIpcCursorCommits`（`index.ts:2810`）会自动重投递——但仍应显式上报，不要依赖隐式行为。

### 8.4 修 Turn 队列泄漏（§3.9，最高优先）

三处一起改，缺一不可：

1. **`broadcastInterruptedTurn` 必须接续队列。** `index.ts:2199` 调完 `turnManager.interruptTurn(folder)` 后，补一次 `drainQueuedTurn()`（或让调用方补）。当前中断路径把 activeTurn 清了却不接队列，是泄漏源头。
2. **把 `drainQueuedTurn()` 移出 `if (activeTurn)`。** `index.ts:2847-2867` 现在只有存在 activeTurn 时才排空队列；应改为「无论本轮怎么结束，只要 `pendingQueue[folder]` 非空就必须接续」。
3. **给 `pendingQueue` 加保护栏。** `TurnManager` 增加：
   - 条目 TTL（超过 N 分钟未被 drain 则告警并强制 `enqueueMessageCheck`）；
   - 长度上限 + 超限日志；
   - 一个周期性巡检：`pendingQueue` 非空但该 folder 既无 activeTurn 也无活跃 runtime → 说明泄漏，直接补一次 `enqueueMessageCheck`。

第 3 条是**兜底不变量**（见 §3.17），即使前两条漏了某条路径也不会静默失声。建议同时加一条 `logger.warn`，让泄漏在日志里可见而不是无声。

### 8.5 出站投递可靠性（§3.10 / §3.11 / §3.14）

**失败重试。** `index.ts:3554-3588` 的 IM 发送失败必须进重试，而不是吞掉后删文件：

```text
send 失败 → 不 unlink，写入 attempts + nextRetryAt 到文件（或旁路 state）
         → 指数退避重试
         → 超过上限 → 移入 errors/ 并同时：
              · 给该会话推一条系统消息（用户看得见）
              · 在 Web UI 暴露
```

**幂等。** 消灭 §3.11 的崩溃窗口：处理前先把文件 rename 到 `messages/.inflight/`，成功后再删。重启时扫描 `.inflight/`，按已记录的外部消息 ID 判断是否真的发出去过——有 `imMsgId` 就只补 DB 写入，不重发。

**`errors/` 不能是黑洞。** 至少要有：启动时扫描并告警计数、Web 上可见、可手动重投或清理。当前它连日志之外的任何出口都没有。

### 8.6 出站顺序（§3.12 / §3.13）

1. `index.ts:3498` 补 `.sort()`，与 `ipc-handler.ts:163`、`agent-runner-core/ipc.ts:82` 对齐。
2. `writeIpcFile` (`agent-runner-core/src/ipc.ts:61`) 的文件名改为 `${Date.now()}-${String(seq++).padStart(6,'0')}-${random}`，让排序成为可靠 FIFO。`session-runtime-queue.ts:365` 的入站命名同改。

两处都是小改动，但没有它们「先发 ack 再发结果」的顺序就没有任何保证。

### 8.7 并发槽再分配（§3.15）

`session-runtime-queue.ts:834-846` 的两个提前 `return` 分支，在 `waitingGroups.add()` 之后都要调用 `this.drainWaiting()`：本组用不了这个槽，不代表别的组用不了（尤其是被**按用户配额**挡住的情况）。

注意 `drainWaiting` 会遍历并可能递归触发 `runForGroup`，要确认不会自激；当前实现每次都先 `waitingGroups.delete(jid)` 再启动，且容量检查是同步递增的，加调用是安全的。

### 8.8 回复目标排序键（§3.16）

`db.ts:2051-2052` 的 `ORDER BY timestamp DESC, id DESC` 改为 `ORDER BY rowid DESC`。属于 §7 话题路由的前置修复，建议跟 §7.1 一起做。

### 8.9 验收标准

| 场景                                                                     | 期望                                                                 |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| 纯 IM turn（agent 只用 `send_message`，无 stdout），idle 超时后 `closed` | 游标**提交**，不重复投递                                             |
| 同上，但结尾是错误退出                                                   | 同上，不回滚游标                                                     |
| agent 完全没回复就 `closed`                                              | 游标**保留**，下轮重投递（现有行为，需保持）                         |
| 注入消息后触发 drain                                                     | 消息不丢，在新 runtime 里被处理，且不重复                            |
| 飞书 WS 重连回放                                                         | `messageExists` 去重生效，无重复（现有行为，需回归）                 |
| **发「停」中断，再发新消息**                                             | 新消息被正常处理；`pendingQueue` 不泄漏；**渠道不失声**（§3.9 回归） |
| 跨渠道排队时中断当前 turn                                                | 排队渠道仍能被接续处理                                               |
| IM 发送失败（断网 / 撤销授权）                                           | 自动重试；超限后用户在会话里**看得到**失败提示，不是静默消失         |
| IM 发送成功后立刻 `kill -9`，重启                                        | 用户**不会**收到重复消息                                             |
| agent 一轮内连发两条 `send_message`                                      | 用户侧顺序与发送顺序一致                                             |
| 用户配额挡住 A 组时 B 组有全局容量                                       | B 组能拿到刚释放的槽，不饥饿（§3.15 回归）                           |

## 9. 实施顺序

```text
第零批（止血：静默失声 / 静默丢失，优先级压过一切）
  0a. §8.4 Turn 队列泄漏          —— 发一次「停」就可能让渠道永久失声
  0b. §8.5 出站失败重试 + 幂等    —— IM 发送失败 = 消息永久蒸发，且 Web 看起来正常

第一批（正确性，用户当下就在踩）
  1. §8.1-8.2 修「已回复」判据    —— 独立、改动小、直接消掉重复投递
  1b. §8.6 出站顺序 + §8.7 并发槽 + §8.8 排序键 —— 三个小改，可合一个 PR
  2. §7 话题路由                  —— 8.8 → 7.1 数据 → 7.2 prompt → 7.3 选取逻辑

第二批（延迟与 steering）
  3. §4.0 turn 路由修复           —— 前置。不做这个，后面的 steering 完全不会被触发
  4. §4.1-4.9 steering 全套       —— 4.6 与 4.2 强耦合，建议同一 PR
  5. §8.3 drain 不丢缓冲消息      —— 跟着 4.6 一起做

第三批（能力与观感）
  6. 飞书视频 + 语音（§6.1、§6.2）—— 独立小改，风险低
  7. send_file 回传（§6.3）
  8. 卡片阶段 A（§5.3）           —— 视觉收益最大的一步
  9. 卡片阶段 B（§5.4）
 10. 卡片阶段 C（§5.5）           —— 依赖 card.action.trigger，与方案一呼应
```

五处强约束：

- **§8.4 和 §8.5 是止血项，排在所有事情之前。** 前者会让一个渠道在用户发一次「停」之后**永久失声**直到重启；后者会让 IM 消息**静默蒸发**且 Web 端毫无异常，两者都属于「用户完全无法自查、也不会报错」的类型，危害远大于延迟和观感问题。
- **§8.1 紧随其后。** 纯 bug、改动最小、用户当下就在踩（每个纯 IM turn 走 idle-close 都可能重复投递）。不依赖任何其他改动。
- **§4.0 必须在 §4.1-4.9 之前。** 当前 turn 路由把跑超过 30 秒的 turn 的所有后续消息都判成 `queue` + `drain`，`pushMessage()` 永远不会被调用 —— 顺序反了会得到「代码全对但现象毫无变化」的结果。
- **§4.6（两阶段 ack）与 §4.2（query-loop 降级）必须一起做完**，否则中间态比现状更容易丢消息：steering 生效后消息交付时机变了，而 ack 语义还停在「文件排空即提交」。
- **§7.2 必须在 §7.3 之前。** 不先把 `thread` 属性喂给 agent，`replyThreadingMode: 'agent'` 就是在要求 agent 做一个信息不足的决策。

§4.0 单独上线即可显著改善「消息多久进 runner」的体感（省掉整轮等待 + 进程重启 + ~1.8s CLI 探测 + transcript 重放），即使 §4.1-4.9 还没做完 —— 消息仍会落到 `pendingMessages`，但至少不再触发 runtime 重启。

注意 §4.0 与 §8 有交互：放宽 inject 后 drain 变少，§3.8 的丢失路径触发频率随之下降，但 §8.3 仍需实现以覆盖跨渠道 drain。

## 10. 风险

| 风险                                                                            | 缓解                                                                                                                                                              |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §4.0 放宽 inject 后，同渠道消息不再触发 drain，长 turn 可能被持续追加而无限延长 | 保留 `turnMaxBatchMs` 作为「强制切轮」的上限逃生阀，但改为只在**用户显式要求**或超长阈值时才 drain；并在卡片上显示已注入条数                                      |
| §4.0 需要宿主查 runner capability                                               | 用 `SessionRuntimeQueue` 已有的 `runtimeIdentifier`（`session-runtime-queue.ts:281`）查 descriptor；查不到时保守回落到原有时间窗逻辑                              |
| claude stdin 不关导致进程不退出                                                 | §4.3 第 4 点：`result` 事件后必须 `endStdin()`；加进程退出超时兜底                                                                                                |
| `--replay-user-messages` 回放首轮 prompt 造成重复 ack                           | 按 `clientUserMessageId` 或序号跳过第一条                                                                                                                         |
| `pushMessage` 改异步波及所有 runner 与测试                                      | 一次性改完 4 个 runner + `runner-contract.test.ts`                                                                                                                |
| capability 三处声明不同步                                                       | `make sync-types`；`index.ts:274` 启动校验兜底                                                                                                                    |
| CardKit `sequence` 冲突                                                         | 单实例内计数器 + 冲突重试                                                                                                                                         |
| CardKit 120s 流式超时                                                           | 续期或分段；保留 patch fallback                                                                                                                                   |
| 卡片 2.0 在旧版飞书客户端渲染异常                                               | 阶段 A 先行、单独验证后再上阶段 B                                                                                                                                 |
| §8.1 把「已回复」放宽后，真正没回复的 turn 被误判为已回复 → 变成**丢失**        | 只统计确实产生了用户可见输出的信号（stdout 文本 / `send_message` / `send_image` / `send_file` 工具调用成功）；工具调用失败不计入。配合 §6.3 的 send_file 结果回传 |
| §7 新增 DB 列需要 migration                                                     | `db.ts` 加 migration + 更新 `SCHEMA_VERSION`，同步 CREATE TABLE（见 CLAUDE.md 常见变更指引）                                                                      |
| §7.3 删掉 `lastMessageIdByChat` 兜底后，某些历史场景失去回复目标                | 失去目标时改为 `im.v1.message.create` 直发群，而不是回退到任意一条消息 —— 发到群里是安全的默认，回错人不是                                                        |
| §7 话题语义依赖飞书行为（reply 到话题内消息即入话题）                           | 上线前在真实话题群手工验证 §7.4 的五个场景                                                                                                                        |

## 11. 参考

- 验证用探针脚本思路见 §2.3；`codex app-server generate-json-schema -o <dir>` 可随时重新导出协议真相源。
- [飞书卡片 JSON 2.0 结构](https://open.feishu.cn/document/feishu-cards/card-json-v2-structure)
- Claude CLI：`claude -p --help`（`--input-format`、`--replay-user-messages`）
- 相关既有文档：[agent-runner-contract.md](agent-runner-contract.md)、[agent-runner-abstraction-plan.md](agent-runner-abstraction-plan.md)
