# 上下文一致性与记忆系统整改方案（v2）

> **v2 修订说明**：v1 错误地按「多用户系统」理解记忆瓶颈（被顶层 CLAUDE.md 的过期描述误导）。本版基于单用户前提重新审计并重写第二部分（记忆系统），重新定性 P1-4（claude 隔离），并新增第四部分（项目文档更新）。第一部分（上下文抽象）与第三部分其余条目不受影响。
>
> 本文档基于 2026-07-24 对三个生产 runner（claude / codex / agy）上下文注入链路与记忆系统的全量代码审计，面向实施者编写，自包含：每个问题附带代码证据（file:line），每项改造附验收标准。
>
> 前置阅读：`docs/agent-runner-abstraction-plan.md`（上一轮 runner 抽象改造，已落地，本文是其后继）、`docs/agent-runner-contract.md`（runner 契约，本文多处引用其条款）。
>
> 行号基于 commit `74bb598`。实施时以符号名（函数/常量名）定位为准，行号仅作辅助。

> **实施状态，2026-07-24**：本文列出的 P0、P1、P2 与文档整改均已落地。上下文主链路已切换为 `ContextBundle + applyContext()`；Memory 已切换为并行只读车道、串行写车道与 SQLite 持久队列；快速检索、批量 wrapup、防饿死、保留策略和监控指标均已接入。对应回归测试由 `make typecheck` 统一执行。下文保留基线证据与设计推导，便于后续审计。

四个整改目标：

1. **上下文注入一致性**：抽象所有注入给 runner 的内容，切换 runner 后模型看到的 HappyClaw 侧上下文应当无差别；等价性由测试强制。
2. **记忆系统扩展性**：修复单用户多 Session 场景下、几百上千个会话规模的结构性瓶颈（全局单车道、超时失效、wrapup 风暴、global_sleep 饿死）。
3. **审计发现的 bug 修复**：按优先级列出，含证据与验收标准。
4. **项目文档更新**：顶层 CLAUDE.md 等文档与单用户现实严重脱节（v1 方案本身就是受害者），作为独立工作流纳入。

---

## 第〇部分：审计发现摘要（实施背景）

### 0.0 系统形态（先读这节，别信旧文档）

本项目已迁移为**单用户多 Session 本地 workbench**（commit `6b83246` "migrate to single-user session runtime" 起）：

- 固定本地 operator：`src/middleware/auth.ts:9-12` 无条件注入 `getLocalWorkbenchAuthUser()`；`src/local-user.ts` 维护唯一操作者。
- **ownerKey 基数 = 1**（DB 实测：`users` 表 1 行；`sessions` 按 kind：main=1、workspace=18、memory=2——其中一个是字面量 `'system'`）。worker（子代理）会话直接继承父 main 会话的 owner_key（`src/db.ts:4687-4724`，关键行 `:4692`），不产生新 owner。
- 无 Docker：旧容器实现（`src/container-runner.ts`、`container/Dockerfile`）已在 `6b83246`/`7a5ebd4` 删除，统一走本地子进程 runtime（`src/runtime-runner.ts` 的 `runHostAgent`）。
- **顶层 `CLAUDE.md` 是过期的**（仍称多用户/Docker/member 模式/「Memory Agent 仍使用 Claude Agent SDK」），README 与 CLAUDE-full.md 已部分更新——文档修复见第四部分。

### 0.1 上下文注入现状

**共享骨架（三 runner 一致）**：

- 消息信封由宿主统一组装：`src/index.ts` `formatMessages()`（约 :1990-2028）产出 `<messages><message sender source time>...` XML；定时任务走同一信封（sender=`__task__` + `[task:N]` 前缀，`src/task-scheduler.ts:69-117`）；新会话前置 `<recent_context>` 块。
- prompt 正文骨架在 `container/agent-runner-core/src/prompt-builder.ts`：
  - `buildAppendPrompt()`（:183-224）：全局 CLAUDE.md（仅 isHome）→ 交互原则 → Skill 存储规范 → 输出格式 → WebFetch 策略 → 后台任务指引 → contextSummary → IM 渠道路由 → 插件段（Memory/Skills）。静态段刻意放前以命中 prompt cache。
  - `buildFullPrompt()`（:230-239）= `buildBasePrompt()`（身份声明 + 环境段 + 会话 CLAUDE.md + 全局 CLAUDE.md）+ append 版。
- happyclaw MCP server（`container/agent-runner/src/happyclaw-mcp-server.ts`）三 runner 都以 stdio 子进程挂载，注册名 `agentdock`（+ `happyclaw` 别名），工具集一致。
- compact 后的「渠道路由提醒」轻提醒（`buildChannelRoutingReminder`，`prompt-builder.ts:246-264`，注入点 `query-loop.ts:452-457`）三 runner 统一。

**每 runner 差异（核心矩阵）**：

| 维度 | claude | codex | agy |
|---|---|---|---|
| prompt 注入 | `--append-system-prompt`，追加在 CLI 原生 preset 后（`claude/runner.ts:422-423`），每轮真实重传 | 写 instructions 文件传 `model_instructions_file`（`codex/runner.ts:382-392`，`codex/session.ts:648-650`） | 每轮全量重写隔离 HOME 的 `~/.gemini/GEMINI.md`（`agy/agy-env.ts:92-96`，`agy/runner.ts:256`） |
| prompt 内容 | 仅 append 段（环境/会话 CLAUDE.md 靠 CLI 原生发现，group 目录 `git init` 防向上泄漏，`src/runtime-runner.ts:408-427`） | full 版 | full 版 |
| **动态刷新** | ✅ 每轮生效 | ❌ **同进程内只首轮生效**（见 bug P0-2） | ✅ 每轮生效 |
| skills | 原生 `Skill` 工具，prompt 不列 skills 段 | tool-loader（prompt 列表 + `list_skills`/`load_skill`） | 同 codex |
| 工具审批 | `bypassPermissions` + `--allow-dangerously-skip-permissions` 恒开（`claude/runner.ts:424-426`） | `approvalPolicy:'never'` + `dangerFullAccess` 三处写死（`codex/session.ts:466-467,641-642`、`one-shot-invokers.ts:172-173`、`src/codex-exec-adapter.ts:60`） | `--dangerously-skip-permissions` 写死（`agy/runner.ts:493`） |
| hooks | 仅 PreCompact（同步阻塞等归档，`claude/hooks.ts:29-64`） | 无 | 无 |
| compact | CLI 原生，压缩前归档，同 session 续 | CLI 原生，压缩后归档 + `thread/inject_items` 注回 summary+记忆索引（`codex/session.ts:538-548`） | 无原生：逆向 SQLite 估 token（默认 250k 阈值）→ 归档 → 丢会话重开，summary 拼 prompt 开头（`agy/runner.ts:259-271,379-483`） |
| resume 失败 | 正则识别 → 静默重开自愈（`claude/runner.ts:169-176` + `query-loop.ts:505-510`） | **throw → 容器进程崩溃**（见 bug P0-1） | agy 静默新建，runner 侦测后提示用户（`agy/runner.ts:322-335`） |
| 配置目录隔离 | ❌ 无（共享宿主真实 `~/.claude`，见 P1-4 重新定性） | `CODEX_CONFIG_DIR` → `data/sessions/{folder}/.codex` | `env.HOME` → `.agy`，oauth token/keychain 软链回真实 HOME |
| 图片 | 落盘 + 文本路径提示 | 原生结构化 `localImage`（`codex/session.ts:660-668`） | 落盘 + 文本提示 |
| 流式/usage | fine / exact | coarse / approx（工具参数丢失、todo 压扁，`codex/event-adapter.ts:58-105`） | none / none |

### 0.2 记忆系统现状（单用户前提）

- 每个操作（query / remember / session_wrapup / continuation_summary / global_sleep）都是一次**完整 ephemeral LLM 会话**：`MemoryOrchestrator.execute()` → `runRequest()`（`src/memory-agent.ts:1338-1396`）→ `runSessionAgent()` → 全新进程 spawn。无常驻进程。
- 五种操作**全部汇入同一个 ownerKey 的 `runSerialized()` 尾链**（`memory-agent.ts:1208-1230`），无任何绕行路径。单用户下 ownerKey 只有一个实际值 → **系统级只有一条串行通道**。`memory_remember` 表面 fire-and-forget（HTTP 立即 200，`src/routes/memory-agent.ts:147-157`），底层仍排同一条队尾。
- 一次 wrapup = 2 次串行 LLM 调用（session_wrapup + continuation_summary，`src/index.ts:4270-4344`），预算峰值 240s；一次 query 预算 60s。凭证刷新（`closeAllActiveForCredentialRefresh`，`session-runtime-queue.ts:431-453`）会让全部活跃会话同时退出触发 wrapup，最坏排队时长 ≈ N × 240s（N=300 时约 20 小时），期间所有 memory_query 排在风暴后面。
- **query 不是只读**：query 类会话的 prompt 明确要求「找到答案后顺手做 1-3 处轻量索引修复」（`memory-agent.ts:864-879`）；工具面/目录挂载对五种请求类型完全相同（`src/memory-profile.ts:20-62`，`allowedDirectories: [globalDir, memoryDir]` 一视同仁）；`toolScope: 'isolated'` 写进了 profile 但 `HAPPYCLAW_TOOL_SCOPE` 环境变量全仓库无消费者（死配置）。**当前这条串行队列是防止并发写坏 index.md 的唯一安全网**——问题不是串行本身，而是锁粒度太粗。
- `MAX_CONCURRENT_MEMORY_AGENTS = 3`（`memory-agent.ts:49`）语义是「同时追踪的 owner 数」，单用户下实测最多 2 个 entry（operator + `'system'`），**永不触发**——多用户时代的遗留旋钮，现提供的并行度为零。

### 0.3 契约违约实锤

`docs/agent-runner-contract.md`「System Prompt 契约」明确要求：*「query-loop 会在每次 runQuery() 前重新构造它。runner 必须消费这次传入的值，不允许在内部偷偷重建或缓存上一轮的 system prompt。」* —— codex runner 当前行为（bug P0-2）直接违反此条款。

---

## 第一部分：上下文注入统一抽象（ContextBundle）

### 1.1 病根

- `promptContract.mode` 是元数据不是驱动：声明 `instructions_file` 的 codex/agy 都没走 `base-cli-runner.ts` 的通用 `buildPromptEnv()`（该函数因此是死代码，:20-59——唯二继承基类的 claude/fake-json 用的是 append/system_stdin 模式），而是各自手写注入路径。
- append vs full 是两条代码路径而非可枚举数据，导致「同一段内容在不同 runner 上或有或无」无法被测试约束。
- 「注入什么」（内容）与「怎么投递」（通道）耦合在每个 runner 的实现里。
- codex 的投递通道（`model_instructions_file`）只在 `thread/start`/`thread/resume` 时被读取，`turn/start` 不带该字段（`codex/session.ts:433-447,462-470`），每轮重写文件是无效动作。

### 1.2 设计

#### 1.2.1 单一真相源：`ContextBundle`

在 `container/agent-runner-core/src/` 新增（示意，字段名可调）：

```ts
type SectionId =
  | 'identity'                // 身份声明（现 buildBasePrompt 首段）
  | 'environment'             // 工作目录/群组信息
  | 'workspace-instructions'  // 会话 CLAUDE.md
  | 'global-instructions'     // 用户全局 CLAUDE.md（仅 isHome）
  | 'platform-guidelines'     // 交互原则/Skill存储/输出格式/WebFetch/后台任务（静态合集）
  | 'memory-index'            // 记忆索引 + personality + memory 工具说明
  | 'context-summary'         // continuation summary
  | 'channel-routing'         // IM 渠道路由 + recentImChannels
  | 'skills-catalog';         // skills 列表（按能力条件生成）

interface ContextSection {
  id: SectionId;
  stability: 'static' | 'session' | 'turn'; // 决定投递通道与缓存友好性
  content: string;
}

interface ContextBundle { sections: ContextSection[]; }
```

`buildContextBundle(ctx, dynamic)` 取代 `buildFullPrompt`/`buildAppendPrompt` 成为唯一权威。现有 prompt-builder 的段落 1:1 映射为 section；section 排序保持「静态在前」。

stability 归类建议：`platform-guidelines`/`channel-routing` 骨架 = static；`identity`/`environment`/`workspace-instructions`/`global-instructions`/`skills-catalog` = session；`memory-index`/`context-summary`/`recentImChannels` 动态部分 = turn。

实施时顺带核对：`isHome`/`isAdminHome` 语义在单用户 workbench 下的实际含义（现在只区分 main/workspace 会话），`global-instructions` 的「仅 isHome 注入」规则是否仍符合预期——结论写入第四部分的文档更新。

#### 1.2.2 「原生已提供」降为 descriptor 数据

descriptor 新增字段：

```ts
nativeProvides: SectionId[];
// claude: ['identity', 'environment', 'workspace-instructions']  ← CLI preset + 原生 CLAUDE.md 发现
// codex:  []
// agy:    []
```

渲染统一为 `render(bundle, { exclude: descriptor.nativeProvides })`。append vs full 的区别从此是**数据**，不是分支。未被 native 覆盖的 section 在所有 runner 上**逐字节一致**。

注意：descriptor 在 `src/runner-descriptor.types.ts` 和 `container/agent-runner/src/runner-descriptor.types.ts` 是两份手工同步的文件（运行时有 `validateDeclaredRunnerDescriptor()` 深比对兜底，`container/agent-runner/src/index.ts:285-311`），新增字段两边都要改（另见 P2-13）。

#### 1.2.3 投递契约变成真接口

`AgentRunner` 接口新增强制方法，query-loop 每轮 `runQuery()` 前调用：

```ts
applyContext(rendered: {
  sessionStatic: string;  // static + session 级 sections
  turnDynamic: string;    // turn 级 sections
}): Promise<void>;
```

每 runner 的通道映射：

| runner | sessionStatic | turnDynamic |
|---|---|---|
| claude | `--append-system-prompt`（每轮全量重传，现状即正确，两路可合并传） | 同左 |
| codex | `model_instructions_file`（接受「仅 thread 首建时生效」的现实，只放静态/会话级内容） | **每轮 `thread/inject_items` developer 消息**（复用现有 post-compact 注入通道 `codex/session.ts:538-548`；需做内容 diff，仅在 turn 级内容变化时注入，避免每轮塞重复文本膨胀上下文） |
| agy | 每轮重写 GEMINI.md（现状即正确，两路合并写入） | 同左 |

这一步**结构性修复 bug P0-2**：记忆索引更新、CLAUDE.md 修改、contextSummary 从此在 codex 每轮生效。

同时废除 `codex/runner.ts:285-297` 的 `buildResumeInstructions()` 精简 stub 机制——resume 提示内容并入 turnDynamic。

#### 1.2.4 contextSummary 去进程常量化

现状：`containerInput.contextSummary` 是进程启动时固定的常量，进程内发生 compact 后仍每轮注入旧摘要（`system-prompt.ts:95-102`）。改为：turn 级 section 每轮从 `SessionState` 取值，compact/归档成功后更新或清空。三 runner 一起受益。

#### 1.2.5 工具面对齐

- `happyclaw-mcp-server.ts` 当前 `createMcpContextManager()` 不传 `nativeCapabilities`（:18-35），导致 claude 的 prompt 不提 `list_skills`/`load_skill` 但工具照样注册（prompt 文本与工具面脱节）。修法：通过环境变量（如 `HAPPYCLAW_NATIVE_CAPABILITIES`）把主进程算出的 `nativeCapabilitiesForRunner(descriptor)` 结果传给 MCP server 子进程，两边用同一份过滤。
- subagent 定义（`claude/agent-defs.ts` 的 code-reviewer/web-researcher，经 `--agents` 注入）是 claude 独有能力差异。决策：**保留**，但在 descriptor 中显式声明（如 `capabilities.predefinedSubagents: true`），并在 `agent-runner-contract.md` 说明这是能力差异而非上下文差异。

#### 1.2.6 死代码清理（随迁移一并做）

- 删 `base-cli-runner.ts` `buildPromptEnv()`（:20-59）及 `promptContract.mode` 中不再需要的枚举值。
- 删 `container/agent-runner/src/runners/codex/mcp-server.ts`（与 `happyclaw-mcp-server.ts` 重复、全仓库无引用的死文件）。
- 清理 `UserMcpSource` 中声明但无人使用的 `'happyclaw'` 枚举（`runner-descriptor.types.ts:37-42`；`index.ts:144-146` 已把它与 `agentdock` 当同义词）——改名收尾或删除，二选一。

### 1.3 迁移步骤与验收

**Phase A（零行为变化）**：
1. 为三 runner 的当前渲染结果建立 characterization 快照测试（固定 ctx 输入 → 快照 systemPrompt 文本）。
2. 引入 `ContextBundle` 类型 + `buildContextBundle()` + `render()`，内部改写 `buildFullPrompt`/`buildAppendPrompt` 为基于 bundle 的实现。
3. **验收**：快照逐字节不变；`make typecheck` 通过。

**Phase B（切换投递接口）**：
1. `AgentRunner` 加 `applyContext()`；query-loop 每轮调用；claude/agy 直接适配（行为等价），codex 实现 turn-dynamic 的 `thread/inject_items` 注入。
2. 删 `buildResumeInstructions()` stub 路径。
3. **验收**：新增集成测试——同一会话跑 3 轮，第 2 轮前修改会话 CLAUDE.md / 记忆 index.md，断言三个 runner 第 3 轮的模型可见上下文都包含更新后的内容（codex 通过检查 inject_items 调用参数验证）。

**Phase C（等价性进 CI）**：
1. conformance 测试：对每个 runner 模拟「模型实际看到的全部注入文本」（各通道拼接 + nativeProvides 占位），断言 (a) 每个 canonical section 恰好出现一次；(b) 共享 section 跨 runner 文本一致；(c) 每个 stability 等级都有可达通道。
2. 该测试挂入 CI；`agent-runner-contract.md` 更新为以 `applyContext` 为准的新契约。
3. 死代码清理（1.2.6）。
4. **验收**：conformance 全绿；故意在某 runner 漏投一个 section 时测试必须失败（反向验证）。

---

## 第二部分：记忆系统扩展性改造（单用户前提，v2 重写）

### 2.1 病根链（全部有代码证据）

多用户时代的「per-owner 串行 + 3 owner 并发」设计，在单用户多 Session 前提下**坍缩成一条全局单车道**：原本用来隔离故障、提供并行度的机制现在什么都不隔离、什么并行度都提供不了；唯一真正起作用的安全网（防止并发写坏 index.md/knowledge/）恰恰是这条队列本身。所以改造方向**不是拆掉串行，而是把锁粒度做细**。

1. **全局单车道 head-of-line blocking（核心瓶颈，其他问题的放大器）**：五种操作全部汇入唯一 ownerKey 的 `runSerialized()` 尾链（`memory-agent.ts:1208-1230,1421-1506,1538-1540`），无绕行路径。任意一个会话的慢 wrapup 卡住所有会话的 query/remember；「多 Session workbench」恰恰意味着用户常并行开多个会话。
2. **超时从未生效**：`query/send/continuationSummary` 算出的 `timeoutMs` 传进 `runRequest()`（:1338-1396）后被静默丢弃——无 `Promise.race`/`AbortController`。调用方（容器 `memory.ts:191`，65s；IPC `session-wrapup-ipc.ts:115-157`，120s）超时放弃后，宿主侧 ephemeral 执行继续裸奔（仅受 5 分钟不活动看门狗约束，`src/runtime-runner.ts:973-1001`）。**单车道下一次失控请求 = 记忆功能对全部会话 100% 瘫痪**。
3. **query 并非只读，锁却按最粗粒度打**：query prompt 要求「顺手做 1-3 处轻量索引修复」（`memory-agent.ts:864-879`）；`buildMemoryProfile` 对五种请求类型给同一套读写工具与目录（`memory-profile.ts:20-62`）；`toolScope:'isolated'` 是无消费者的死配置（`memory-profile.ts:16,47` → env `HAPPYCLAW_TOOL_SCOPE` 全仓库无读取方）。因此不能简单并行化 query——必须先把读写语义拆开。
4. **wrapup 多路触发、无去重、cursor 竞态**：claude PreCompact / codex·agy 阈值与进程退出 `forceArchive`（`codex/archive.ts:117-171`、`agy/archive.ts:78-136`）/ 宿主 `addOnRuntimeExitListener`（`src/index.ts:5707-5720`，任何进程退出都触发）三路互不感知；防重复守护 `isTranscriptCommitObsolete()`（`memory-agent.ts:476-490`）是从未被调用的死代码；cursor 读写在 `runSerialized` 锁外（`src/index.ts:4244-4364`）。凭证刷新（`closeAllActiveForCredentialRefresh`，`session-runtime-queue.ts:431-453`）= 全量会话同时退出 → wrapup 风暴集中打在单车道上，最坏排队 ≈ N × 240s。
5. **wrapup 阻塞压缩的级联（单车道下加剧）**：codex/agy「wrapup 不成功不重置计数/不压缩」（`codex/archive.ts:159-170`、`agy/archive.ts:122-133`）——现在等的不是自己那次 LLM 调用，而是「预算 + 排在前面所有请求」；claude PreCompact 同步阻塞同理（`claude/hooks.ts:29-64`）。队列拥堵直接传导为主对话卡死 / 上下文爆表（agy 因 `usage:'none'` 无法感知逼近上限）。
6. **global_sleep 会被饿死**：触发条件要求该 owner 名下**所有** primary 会话同时空闲（`hasBusySession` 门槛，`memory-agent.ts:1648-1657`）。会话数越多、使用越频繁，「全员空闲」窗口越难出现——index.md 可能永远等不到整理。多用户时代的「每 30 分钟 3 个 owner」吞吐上限在单用户下无意义。
7. **remember 静默丢失 + 隐形排队**：`src/routes/memory-agent.ts:147-157` fire-and-forget，失败仅一行 `logger.error`，无重试无死信；且它仍占用单车道时间片——高频「记住」指令在用户无感知的情况下拖慢所有后续 query。
8. **只增不减**：`state.json.lastSessionWrapups` 只 append（`memory-agent.ts:452-474`），单用户下全部会话的 cursor 集中在这一份文件；transcripts/logs/backups 无宿主侧保留策略。
9. **遗留旋钮**：`MAX_CONCURRENT_MEMORY_AGENTS=3`（`memory-agent.ts:49`，`ensureAgent` 超限同步 throw :1188-1206）在单用户下永不触发（实测 owner entry 最多 2 个：operator + `'system'`），是多用户遗留——不作为风险项，作为清理/重定义项。

### 2.2 P0 — 止血（三项互相独立，可并行实施）

| # | 改造 | 要点 | 验收 |
|---|---|---|---|
| M-P0-1 | 落实超时 | `runRequest` 内 `AbortController` + 超时 kill 子进程 + 释放队列位；每类操作用各自已算出的 `timeoutMs`（`runtime-config.ts:1338-1340`） | 单测：mock 一个永不返回的执行，断言在 timeoutMs 后子进程被 kill、队列继续消费下一个请求；集成：人为卡死一次 query，后续 query 在超时后恢复可用 |
| M-P0-2 | 按语义拆车道 | 目标形态：**读写分离**。(a) query 去写化：删除 query preamble 里的「顺手索引修复」指令（`memory-agent.ts:864-879`），query 会话给只读工具面（强制手段与 `toolScope` 死配置的处理见 2.2.1 / M-P2-3）——此后 query 之间可并行（并行度可配，建议默认 2-3），与写车道也可并行；(b) 写车道（remember/wrapup/continuation_summary/global_sleep）维持严格互斥；(c) query 发现的索引问题经**修复 backlog** 延迟执行，完整设计见 2.2.1。过渡形态（如 (a) 工程量大）：先给 query 单独一条与写车道互不阻塞的串行道，query 内部仍串行——head-of-line 至少从「全局」缩小到「读内部」 | 集成：一个人为放慢的 wrapup 进行中，并发发起 memory_query 能在正常时延内返回；并发 3 个 query 与 1 个 remember，index.md 无丢失更新（写车道串行保证） |
| M-P0-3 | 解耦 wrapup 与压缩 | codex/agy 不再以 wrapup 成功为压缩/重置前提——先保住主对话（照常 compact/重开），未归档 transcript 段靠 cursor 天然持久，后台补归档；claude PreCompact hook 改异步（入队即返回，原生 compact 本就保留上下文） | 人为让 wrapup 持续失败：agy 会话仍能在阈值处正常重开新会话；claude 压缩无分钟级卡顿；恢复后积压的 transcript 段被补归档（cursor 校验无遗漏） |

#### 2.2.1 query 去写化的具体设计：修复 backlog

**记录通道——结构化响应字段，而非写工具。** query 会话保持零写工具；它的最终输出本来就经 `ResponseParserHook.afterRun`（`memory-agent.ts:1101-1125`）解析，在响应 schema 中增加可选 `repairs` 数组：

```json
{
  "answer": "...",
  "repairs": [
    { "file": "knowledge/projects.md",
      "issue": "索引第 3 条指向已删除的 transcript",
      "suggestion": "移除该条或改指 conversations/2026-06-xx.md" }
  ]
}
```

落 backlog 由宿主 orchestrator（单 Node 进程）完成——query 会话自身不落任何字节，读并行天然安全，也不存在并发写 backlog 的问题。

**存储——与 remember journal 统一为一张「写车道待办」表。** M-P1-4 的 remember journal 与修复 backlog 形状相同（都是延迟执行的记忆写操作），统一为 DB 表 `memory_write_queue`：`id / kind('remember'|'index_repair') / payload / dedup_key / status('pending'|'done'|'obsolete'|'dropped') / attempts / created_at / updated_at`。`index_repair` 的 `dedup_key = hash(file + normalize(issue))`——同一问题被后续多次 query 反复报告时只保留一条。

**消化时机（三条）**：

1. **搭车**：写车道的 session_wrapup / global_sleep 执行时，宿主把 pending 的 top-K（建议 K=10）修复项注入该次会话 prompt（「顺手处理以下积压索引修复」）；会话在结构化响应中回报已处理的 id，宿主标记 `done`。**不搭 remember 的车**——remember 的任务是准确记录单一事实，掺入修复会稀释注意力。
2. **异步专项**：backlog 超过阈值（如 20 条）或最老条目超龄（如 7 天）、且写车道空闲时，调度一次专门的「repair sweep」ephemeral 会话批量处理。
3. **随 sleep 作废**：global_sleep 本就通读整理全量 index——一次成功的 sleep 后，将 sleep 开始时刻之前创建的 pending 修复项批量标记 `obsolete`（已被全量整理覆盖，无需单独执行）。

**生命周期护栏**：attempts 上限（建议 3 次）后标 `dropped`；表尺寸上限。修复项是**建议性**的——索引问题本来就会被下一次 wrapup/sleep 自然覆盖，丢弃不造成数据损失，可放心激进清理。队列指标接入 M-P1-6。

**只读的强制手段（按 runner 能力分级）**：prompt 声明「不得修改任何文件」只是第一层。工具面强制：claude——query 类会话用工具白名单（Read/Grep/Glob，无 Write/Edit/Bash）；codex——原生 `sandbox: 'read-only'`；agy——无强制手段，建议 `resolveMemoryRunnerId`（`runner-registry.ts:94-105`）对 query 类请求跳过 agy（或接受 prompt-only 风险并在文档记录）。实现上需要把 profile 级的工具限制透传到 runner 配置——正好借此真正实现（而非删除）`toolScope` 死配置（M-P2-3）。另加检测兜底：query 会话结束后宿主对 memDir 做 mtime/hash 快照比对，发现意外写入则告警（检测而非阻止，防回归）。

### 2.3 P1 — 结构性缓解

| # | 改造 | 要点 | 验收 |
|---|---|---|---|
| M-P1-1 | 查询降本分层 | 现在每次 memory_query = 一次 60s+ 完整 ephemeral LLM 会话，而 prompt 又鼓励「不确定就先查」（`memory.ts:154-158`）——量价双高。分层：(a) index.md 已每轮注入主 Agent prompt（零成本路径，保留）；(b) 新增**非 LLM 检索工具**（记忆目录就是 markdown：grep/关键词打分返回匹配片段），覆盖「查一下」场景，毫秒级、天然只读、可任意并行；(c) LLM ephemeral 会话仅留给需要综合推理的查询 | 常规查询 P50 从分钟级降到秒级；LLM 路径仍可用；主 Agent prompt 指引同步更新（先廉价检索，不足再升级） |
| M-P1-2 | wrapup 去重与合并 | 接线 `isTranscriptCommitObsolete()`（死代码复活）；cursor 读写移入写车道互斥范围；同 owner 在途 wrapup 按 folder+cursor 去重；**风暴合并**：凭证刷新等批量退出场景，N 个会话的导出合并为按 folder 分组的批量 wrapup（一次 LLM 会话处理多个 folder 的增量），而非 N×2 次 LLM 调用 | 模拟 `closeAllActiveForCredentialRefresh`：LLM 调用次数远小于 2N；同 folder 双触发只处理一次消息区间 |
| M-P1-3 | global_sleep 防饿死 | 触发不再要求「全部会话空闲」：改为写车道空闲即可入队（写车道互斥已保证不与 wrapup/remember 并发），或按「距上次 sleep 时长」强制上限（如 >24h 必跑一次，排队即可，不抢占 query 读车道） | 构造持续有会话活跃的场景，sleep 仍能在上限周期内执行；index.md 得到整理 |
| M-P1-4 | remember 落盘 journal | 请求先写持久 journal——即 2.2.1 的统一 `memory_write_queue` 表（`kind='remember'`），后台 worker 带退避重试消化；失败可查询；journal 消化在写车道内低优先级执行（不与用户实时 query 抢资源——query 已在独立读车道，此项主要是不挤占 wrapup） | 断掉 memory runner 凭证后调 memory_remember → 表中有 pending 记录；恢复后自动补写成功 |
| M-P1-5 | 保留策略 | 宿主侧定期任务：transcripts 超 N 天打包、backups 保留最近 K 份、logs 轮转、`lastSessionWrapups` 按活跃 folder 裁剪 | 清理任务有日志与指标；老数据按策略消失 |
| M-P1-6 | 可观测性 | monitor 路由暴露：两条车道各自的队列深度/在途/等待时长、失败计数、journal 积压、距上次 global_sleep 时长（现全为黑箱，`MemoryOrchestrator.activeCount` 存在但未接入 `routes/monitor.ts`） | 前端/接口可见上述指标；建议与 M-P0 同批实施以便验证效果 |

### 2.4 P2 — 清理与长期项

| # | 项 | 说明 |
|---|---|---|
| M-P2-1 | `MAX_CONCURRENT_MEMORY_AGENTS` 重定义或删除 | 单用户下永不触发的多用户遗留。建议随 M-P0-2 重定义为「读车道并行槽位数」并接入 `getSystemSettings()`；或直接删除简化心智模型 |
| M-P2-2 | 常驻 memory worker / FTS | 每次冷 spawn 的启动开销、grep 检索升级 SQLite FTS/embedding——等 P0/P1 上线后按指标决定 |
| M-P2-3 | `toolScope` 死配置 | `memory-profile.ts:16,47` 写入、无人读取。随 M-P0-2 真正实现（query 只读工具面）或删除 |
| M-P2-4 | 记忆错误文案 | `memory.ts:206-212` 的错误映射按新车道语义重写（旧 503 文案「上一个查询还在处理」在单用户语境下同样误导） |

---

## 第三部分：Bug 修复清单

### P0（影响线上行为，先行修复）

**P0-1 codex resume 失败导致容器进程崩溃**
- 证据：`codex/session.ts:426-447` `thread/resume` 失败直接 throw；`codex/runner.ts:475-483` 非 Abort 一律上抛；逃出 `query-loop.ts:469-481` 后撞 `container/agent-runner/src/index.ts:489-497` 顶层 catch → `process.exit(1)`。对比 claude（`claude/runner.ts:169-176` → `query-loop.ts:505-510` 自愈）与 agy（`agy/runner.ts:352`）。
- 修法：捕获 resume 类错误，映射为 `QueryResult.sessionResumeFailed = true`，走统一自愈路径（清 sessionId/resumeAnchor 静默重开）。
- 验收：给 DB 塞一个无效 thread id 后发消息，codex 会话自动重开并正常回复，进程不退出。

**P0-2 codex 完整 system prompt 同进程内只首轮生效（违反 runner 契约）**
- 证据：`codex/runner.ts:384-392` 有 resume 目标即用 5 行静态 stub 替换整份 systemPrompt；`codex/session.ts:433-447` 同进程内 `threadId` 相同时连 RPC 都不发；`turn/start` 参数不含 `model_instructions_file`（:462-470）。违反 `agent-runner-contract.md`「System Prompt 契约」。
- 修法：结构性修复 = 第一部分 1.2.3（turn-dynamic 走 `inject_items`）。若需先行热修：resume 轮把 turn 级动态内容前缀进 user prompt（agy 同款做法，`agy/runner.ts:259-271`）。
- 验收：同第一部分 Phase B 验收。

**P0-3 记忆系统单车道 + 超时失效 + wrapup 级联** — 即第二部分 M-P0-1/2/3，此处列入强调优先级。

### P1（架构完整性 / 一致性）

**P1-4 claude 配置目录未隔离（v2 重新定性）**
- 证据：claude 子进程从未设置 HOME/`CLAUDE_CONFIG_DIR`（`claude/runner.ts:447-451` env 无 HOME 键；descriptor 无 `configDirEnv`），共享宿主真实 `~/.claude`；契约测试显式断言不得设 `CLAUDE_CONFIG_DIR`（`container/agent-runner/tests/runner-contract.test.ts:275,303-307`）。git 历史证实旧 Docker 架构靠 volume mount 实现每会话独立 `.claude`（commit `6b83246`/`7a5ebd4` 删除时未替换）。
- **单用户下的重新定性**：凭证共享不再是安全问题（只有一个操作者，与 agy 的全局单账号同理）；claude 原生 transcript 按 cwd 分桶天然按会话分开。真正遗留的问题收窄为三点：
  1. `data/sessions/{folder}/.claude/settings.json` 的 `env` 块（`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` 等三个 flag，`src/runtime-runner.ts:64-100` 写入）**实际不被 CLI 加载**（CLI 用 `--settings <os临时目录>` + `--setting-sources project,user`，都不指向该目录；该文件唯一消费者是回读 `mcpServers` 字段，`container/agent-runner/src/index.ts:150-164`）——要么让这些 flag 通过真实生效的通道传入（子进程 env 或临时 settings 合并），要么删掉死写入。
  2. **待验证项**：skills 符号链接同步进 `data/sessions/{folder}/.claude/skills`（`src/runtime-runner.ts:549-601`），但 CLI 的原生 skill 发现读的是 cwd `.claude` 和真实 `~/.claude`，可能从未指向该目录——**claude 的原生 Skill 发现可能整体失效**（而 prompt 又因 `skills:['native']` 不注入 skills 列表）。实施前先实测：在会话中让 claude 列出可用 skills，确认原生发现是否工作；若失效，修正链接目标（cwd `.claude/skills`）或改回 tool-loader 模式。
  3. 「单一物理登录为有意设计」写入文档（第四部分），消除与「会话隔离」原则表述的冲突。
- 验收：三个 `CLAUDE_CODE_*` flag 经真实通道生效（或被移除）；skills 发现路径验证有结论并修正；文档更新。

**P1-5 prompt 文本与 MCP 工具面脱节** — 即 1.2.5。

**P1-6 workflow 节点 AI 调用漏 agy；invoke_agent 递归防护不统一**
- 证据：`src/workflow-invokers.ts:132-246` 硬编码仅 `claude`/`codex`；`HAPPYCLAW_INVOKE_DEPTH` 仅 agy one-shot 设置（`one-shot-invokers.ts:90`），claude one-shot 靠「结构性没挂 MCP」硬防（:189-285）。
- 修法：workflow-invokers 改为走 runner manifest 的 one-shot invoker 注册表（与 `invoke-agent-plugin.ts:22-32` 同源）；三条 one-shot 路径统一设置 depth 变量。
- 验收：workflow AI 节点可选 agy；depth 防护有单测。

**P1-7 safety-lite hook 死代码；codex/agy 无工具执行防护**
- 证据：`claude/hooks.ts:93-126` `evaluateSafetyLite`/`createSafetyLiteHook`（拦 `rm -rf /`、fork bomb 等）从未被 `buildSettingsConfig()`（`claude/runner.ts:88-104`，现只注册 PreCompact）注册。codex 三处写死 `dangerFullAccess` 且审批请求自动 decline（`codex/session.ts:733-755`）；agy `beforeToolExecutionGuard:'none'` 且 `--add-dir` 直接放开记忆数据目录（`agy/runner.ts:498-501`）。
- 修法：claude 侧把 safety-lite 接进 settings hook（或删除死代码并记录决策）；codex/agy 无 hook 机制，作为**已接受风险**写入文档；agy 的 memoryDir 直通可评估收窄（M-P0-2 的只读化会部分覆盖）。
- 验收：claude 会话中 `rm -rf /` 类命令被 hook 拦截（若选择接线）。

### P2（清理 / 一致性）

| # | 问题 | 证据 | 修法 |
|---|---|---|---|
| P2-9 | 手动「压缩上下文」按钮与 runner 脱钩 | `src/context-compressor.ts:386-504` 硬编码 Anthropic API + `claude-haiku-4-5`（:24），仅 Claude 凭证可用（:192-195） | 改走 runner-agnostic 的 session_wrapup 管线（复用 `resolveMemoryRunnerId`） |
| P2-10 | `/clear` 不清 continuation summary | `src/commands.ts:51-107` 未调 `deleteContextSummary`，reset 后冷启动仍注入旧摘要（`src/index.ts:3234-3241`） | reset 时一并删除 `context_summaries` 条目 |
| P2-11 | 孤儿项目 `container/memory-agent/` | 全仓库无 spawn 引用；`Makefile:14,29,38,65,89,90,99` 仍在构建 | 删除子项目 + Makefile 目标；文档修正并入第四部分 |
| P2-12 | codex 用户 MCP 读 `.codex/config.json` 而非原生 `config.toml` | `container/agent-runner/src/index.ts:152-164` | 支持解析 config.toml，或改名该 source 避免误导 |
| P2-13 | descriptor 双份真相源靠人工同步 | `src/runner-descriptor.types.ts` vs `container/agent-runner/src/runner-descriptor.types.ts`，`make sync-types` 不覆盖 | 纳入 `make sync-types`（与 stream-event 同套机制） |
| P2-14 | codex 事件流信息损失 | `codex/event-adapter.ts:58-105` 不填 `toolInputSummary`；todo 压扁成计数（:95-100）而 `todo_update` 结构化类型现成 | 补齐字段；descriptor `observability` 可从 `degraded` 上调 |
| P2-15 | 小项 | agy stderr 只留末尾 8KB（`agy/runner.ts:119`）；`AGENTS.md` 幽灵路径（`src/file-manager.ts:24-30` 保护了从不生成的文件） | 各自小修；随手带上 |

---

## 第四部分：项目文档更新（独立工作流）

文档过期已经造成实际损失（本方案 v1 的记忆瓶颈判断即被顶层 CLAUDE.md 误导）。作为独立工作项处理，并要求后续每批代码改动的 DoD 包含对应文档同步。

**D-1 重写顶层 `CLAUDE.md` 系统概要（最高优先级）**。逐条核对并修正：
- 「自托管多用户 AI Agent 系统」→ 单用户多 Session 本地 workbench（固定 local operator）。
- 「执行：Docker 容器或宿主机进程」「执行模式 host(admin)/container(member)」「容器内以 node 非 root 用户运行」「必要时重建容器镜像」→ 统一本地子进程 runtime（`runHostAgent`），无 Docker/member 模式。
- 「Memory Agent 仍使用 Claude Agent SDK」「per-user 子进程」→ 实际为 `src/memory-agent.ts` 的 `MemoryOrchestrator` 经通用 agent-runner 跑 ephemeral 会话（runner-agnostic，`resolveMemoryRunnerId`）；`container/memory-agent/` 为孤儿代码（随 P2-11 删除后同步移除相关描述）。
- 「最多 20 容器 + 5 宿主机进程」→ 以 `runtime-config.ts` 的 `maxConcurrentRuntimes`（默认 20，本地进程池）为准重写。
- 目录约定表核对：`home-{userId}` 等多用户痕迹、`data/memory/{userId}` → 单 owner 现实。
- 「会话隔离是核心原则」的表述与 P1-4 的结论对齐（明确：隔离指会话工作目录/IPC/运行时状态，claude 单一物理登录为有意设计）。

**D-2 `CLAUDE-full.md` 全文核对**（§2-§8）：执行模式、记忆系统、并发调度、API 清单章节与现实对齐；已部分更新（§359-370 认证语义），需通篇过一遍消灭残留多用户描述。

**D-3 `docs/agent-runner-contract.md` 更新**：Phase C 落地后以 `applyContext` 为准重写 System Prompt 契约章节；补充 turnDynamic/sessionStatic 的语义与每 runner 通道映射；补充「codex 曾因违反此契约导致动态上下文失活」的回归提示。

**D-4 `docs/agent-runner-abstraction-plan.md` 收尾标注**：文首加指向本文档的后继链接，避免两份方案并立造成困惑。

**D-5 README 交叉核对**：README 已是最新（单用户描述准确），改动后保持同步即可；架构图中「Memory Orchestrator（单用户串行调度）」在 M-P0-2 落地后更新为双车道描述。

**验收**：新读者只读 CLAUDE.md + README 能得到与代码一致的系统心智模型；抽查 v1 曾被误导的三个点（多用户、Docker、Memory Agent SDK）全部修正。

---

## 落地顺序与依赖

```
第 1 批（并行，互不依赖）: P0-1、M-P0-1（超时）、M-P0-3（解耦压缩）、D-1（CLAUDE.md 重写）
第 2 批: M-P0-2（拆车道，含 toolScope 处理）、M-P1-6（可观测性，用于验证第 1/2 批效果）
第 3 批: 第一部分 Phase A → Phase B（结构性修掉 P0-2）
第 4 批: M-P1-1..M-P1-5 + P1-4..P1-7
第 5 批: Phase C（conformance 进 CI）+ P2 全部 + D-2..D-5
```

若 Phase B 排期靠后，P0-2 可先按「热修」方案落地（turn-dynamic 前缀进 user prompt），Phase B 时再收编。

## 开放决策点（已按推荐值写入方案，如需变更请同步修改对应条目）

1. ~~query 去写化 vs 独立读车道~~（M-P0-2）：**已拍板**——采用「query 只读化 + 修复 backlog」目标形态，完整设计见 2.2.1；「query 独立串行道」仅作为工程受限时的过渡台阶。
2. **查询降本的检索实现**（M-P1-1）：推荐先 grep/关键词版（零依赖、天然只读）；FTS/embedding 留到 M-P2-2 按指标决定。
3. **claude 原生 Skill 发现**（P1-4 待验证项）：若实测失效，选「修正链接目标」或「claude 也改 tool-loader」——前者保留原生体验，后者与 codex/agy 完全一致（对第一部分的 conformance 也更简单）。
4. **safety-lite 的去留**（P1-7）：推荐接线 claude 侧；若认为多余则删除死代码并在文档记录「无工具级防护」为接受的风险。

## 验收总览（全部完成后的系统性检查）

1. conformance 测试全绿：任一 runner 切换后，模型可见的 HappyClaw 侧上下文 section 集合与文本一致。
2. 记忆压测（单用户多 Session）：一个慢 wrapup 进行中，其他会话的 memory_query 时延不受影响；批量会话退出风暴后，LLM 调用次数远小于 2N 且 query 车道保持可用；query P50 秒级（廉价检索路径）。
3. 故障注入：无效 resume anchor / wrapup 持续失败 / memory runner 无凭证，三种场景下主对话均不崩溃、不卡死、不永久丢数据。
4. 文档抽查：CLAUDE.md/CLAUDE-full.md 与代码一致；`agent-runner-contract.md` 与 `applyContext` 实现一致。
