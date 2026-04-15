# HappyClaw (Fork) — AI 协作者指南

本文档帮助 AI 和工程协作者快速理解项目架构、关键机制与修改边界。

## 1. 项目定位

本项目是 [HappyClaw](https://github.com/riba2534/happyclaw) 的实验性 fork，目标是探索**更好的记忆能力**和**更高的 Agent 自主性**。与上游的核心差异：

- **Memory Agent 系统**：独立的 per-user 记忆子进程，替代上游的 inline MCP 记忆工具，实现自动会话归档、索引自修复和深度整理
- **显式消息路由**：Agent 的 stdout 仅显示在 Web 端，IM 消息必须通过 `send_message` MCP 工具显式发送，Agent 自主控制消息路由
- **Skills 自主创建**：移除上游的注册表安装机制，Agent 通过 `skill-creator` 直接在文件系统中创建和管理 Skills

上游会定期选择性合并。

HappyClaw 是一个自托管的多用户 AI Agent 系统：

- **输入**：飞书 / Telegram / QQ / Web 界面消息（每个用户可独立配置 IM 通道）
- **执行**：Docker 容器或宿主机进程中运行 Claude Agent。主 Agent 基于 Claude Code CLI `claude -p` runner，每个用户拥有独立主容器。Memory Agent 仍使用 Claude Agent SDK
- **输出**：Web 实时流式推送（stdout）；IM 渠道通过 Agent 显式调用 `send_message` 发送
- **记忆**：per-user Memory Agent 子进程管理持久记忆（索引、印象、知识、转录）

## 2. 核心架构

### 2.1 后端模块

| 模块 | 职责 |
|------|------|
| `src/index.ts` | 入口：管理员引导、消息轮询（10s）、IPC 监听（1s）、容器生命周期、Memory Agent 初始化 |
| `src/web.ts` | Hono 框架：路由挂载、WebSocket 升级、HMAC Cookie 认证、静态文件托管 |
| `src/routes/auth.ts` | 认证：登录 / 登出 / 注册、`GET /api/auth/me`（含 `setupStatus`）、设置向导、RBAC、邀请码 |
| `src/routes/sessions.ts` | Session CRUD、消息分页、会话重置、绑定与 runner profile 管理 |
| `src/routes/files.ts` | 文件上传（50MB 限制）/ 下载 / 删除、目录管理、路径遍历防护 |
| `src/routes/config.ts` | Claude / 飞书配置（AES-256-GCM 加密存储）、连通性测试、批量应用到所有容器、per-user IM 通道配置（`/api/config/user-im/feishu`、`/api/config/user-im/telegram`、`/api/config/user-im/qq`） |
| `src/routes/monitor.ts` | 系统状态：容器列表、队列状态、健康检查（`GET /api/health` 无需认证） |
| `src/routes/memory.ts` | 记忆文件读写、全文检索、Memory Agent 状态/手动触发（`/api/memory/status`、`trigger-wrapup`、`trigger-global-sleep`） |
| `src/routes/memory-agent.ts` | Memory Agent 内部 HTTP 端点（`/api/internal/memory/query`、`remember`、`session-wrapup`），agent-runner 通过 Bearer token 调用 |
| `src/memory-agent.ts` | MemoryAgentManager：per-user Memory Agent 子进程生命周期、stdin/stdout JSON-line 通信、idle 超时清理、global_sleep 调度 |
| `src/routes/tasks.ts` | 定时任务 CRUD + 执行日志查询 |
| `src/routes/skills.ts` | Skills 文件系统发现（项目级 + 用户级）、启用/禁用、主机同步 |
| `src/routes/admin.ts` | 用户管理、邀请码、审计日志、注册设置 |
| `src/routes/browse.ts` | 目录浏览 API（`GET/POST /api/browse/directories`，受挂载白名单约束） |
| `src/routes/agents.ts` | Sub-Agent CRUD（`GET/POST/DELETE /api/sessions/:id/agents`） |
| `src/routes/mcp-servers.ts` | MCP Servers 管理（CRUD + `POST /api/mcp-servers/sync-host`，per-user） |
| `src/routes/logs.ts` | Agent 执行日志：列表（分页）、详情（分段解析）、原始文件下载，基于 folder 的权限检查 |
| `src/feishu.ts` | 飞书连接工厂（`createFeishuConnection`）：WebSocket 长连接、消息去重（LRU 1000 条 / 30min TTL）、富文本卡片、Reaction；`file` 消息下载到工作区；`post` 图文消息仅提取文字 |
| `src/telegram.ts` | Telegram 连接工厂（`createTelegramConnection`）：Bot API Long Polling、Markdown → HTML 转换、长消息分片（3800 字符）；`message:photo` 下载为 base64 供 Vision；`message:document` 下载文件到工作区 |
| `src/qq.ts` | QQ 连接工厂（`createQQConnection`）：Bot API v2 WebSocket 长连接、OAuth Token 管理、C2C 私聊 + 群聊 @Bot、消息去重（LRU 1000 条 / 30min TTL）、Markdown → 纯文本、长消息分片（5000 字符）、图片下载为 base64 供 Vision |
| `src/im-downloader.ts` | IM 文件下载工具：`saveDownloadedFile()` 将 Buffer 写入 `downloads/{channel}/{YYYY-MM-DD}/`，处理路径安全、文件名冲突和 50MB 限制 |
| `src/im-manager.ts` | IM 连接池管理器（`IMConnectionManager`）：per-user 飞书/Telegram/QQ 连接管理、热重连、批量断开 |
| `src/container-runner.ts` | 容器生命周期：Docker run + 宿主机进程模式、卷挂载构建（isAdminHome 区分权限）、环境变量注入 |
| `src/agent-output-parser.ts` | Agent 输出解析：OUTPUT_MARKER 流式输出解析、stdout/stderr 处理、进程生命周期回调（从 container-runner.ts 提取的共享逻辑） |
| `src/group-queue.ts` | 并发控制：最大 20 容器 + 最大 5 宿主机进程、会话级队列、任务优先于消息、指数退避重试 |
| `src/runtime-config.ts` | 配置存储：AES-256-GCM 加密、分层配置（容器级 > 全局 > 环境变量）、变更审计日志 |
| `src/task-scheduler.ts` | 定时调度：60s 轮询、cron / interval / once 三种模式、group / isolated 上下文 |
| `src/file-manager.ts` | 文件安全：路径遍历防护、符号链接检测、系统路径保护（`logs/`、`CLAUDE.md`、`.claude/`、`conversations/`） |
| `src/mount-security.ts` | 挂载安全：白名单校验、黑名单模式匹配（`.ssh`、`.gnupg` 等）、非主会话只读强制 |
| `src/db.ts` | 数据层：SQLite WAL 模式、Schema 版本校验（v1→v24）、核心表定义 |
| `src/auth.ts` | 密码工具：bcrypt 哈希/验证、Session Token 生成、用户名/密码校验 |
| `src/permissions.ts` | 权限常量和模板定义（`ALL_PERMISSIONS`、`PERMISSION_TEMPLATES`） |
| `src/schemas.ts` | Zod v4 校验 schema：API 请求体校验 |
| `src/utils.ts` | 工具函数：`getClientIp()`（TRUST_PROXY 感知） |
| `src/web-context.ts` | Web 共享状态：`WebDeps` 依赖注入、群组访问权限检查、WS 客户端管理 |
| `src/middleware/auth.ts` | 认证中间件：Cookie Session 校验、权限检查中间件工厂 |
| `src/im-channel.ts` | 统一 IM 通道接口（`IMChannel`）、Feishu/Telegram 适配器工厂 |
| `src/intent-analyzer.ts` | 消息意图分析：stop/correction/continue 识别 |
| `src/commands.ts` | Web 端斜杠命令处理器（`/clear` 重置会话） |
| `src/im-command-utils.ts` | IM 斜杠命令纯函数工具：`formatWorkspaceList()`、`formatContextMessages()` |
| `src/telegram-pairing.ts` | Telegram 配对码：6 位随机码，5 分钟过期 |
| `src/terminal-manager.ts` | Docker 容器终端管理（node-pty + pipe fallback，WebSocket 双向通信） |
| `src/message-attachments.ts` | 图片附件规范化（MIME 检测、Data URL 解析） |
| `src/image-detector.ts` | 图片 MIME 检测（magic bytes），由 `shared/image-detector.ts` 同步 |
| `src/daily-summary.ts` | 每日对话汇总（**已停用**，被 Memory Agent 替代） |
| `src/script-runner.ts` | 脚本任务执行器（`exec()` + 并发限制 + 超时 + 1MB 输出缓冲） |
| `src/reset-admin.ts` | 管理员密码重置脚本入口 |
| `src/config.ts` | 常量：路径、超时、并发限制、会话密钥（优先级：环境变量 > 文件 > 生成，0600 权限） |
| `src/logger.ts` | 日志：pino + pino-pretty |

### 2.2 前端

| 层次 | 技术 |
|------|------|
| 框架 | React 19 + TypeScript + Vite 6 |
| 状态 | Zustand 5（10 个 Store：auth、chat、groups、tasks、monitor、container-env、files、users、skills、mcp-servers） |
| 样式 | Tailwind CSS 4（teal 主色调，`lg:` 断点响应式，移动端优先） |
| 路由 | React Router 7（AuthGuard + SetupPage 重定向） |
| 通信 | 统一 API 客户端（8s 超时，FormData 120s）、WebSocket 实时推送 + 指数退避重连 |
| 渲染 | react-markdown + remark-gfm + rehype-highlight（代码高亮）、mermaid（图表渲染）、@tanstack/react-virtual（虚拟滚动） |
| UI 组件 | radix-ui + lucide-react |
| PWA | vite-plugin-pwa（生产构建始终启用，开发模式通过 `VITE_PWA_DEV=true` 启用） |

#### 前端路由表

| 路径 | 页面 | 权限 |
|------|------|------|
| `/setup` | `SetupPage` — 管理员创建向导 | 公开（仅未初始化时） |
| `/setup/providers` | `SetupProvidersPage` — Claude/飞书配置 | 登录后 |
| `/setup/channels` | `SetupChannelsPage` — 用户 IM 通道配置引导 | 登录后（注册后跳转） |
| `/login` | `LoginPage` | 公开 |
| `/register` | `RegisterPage` | 公开（可通过设置关闭） |
| `/chat/:groupFolder?` | `ChatPage` — 主聊天界面（懒加载） | 登录后 |
| `/groups` | 重定向到 `/settings?tab=sessions` | 登录后 |
| `/tasks` | `TasksPage` — 定时任务（懒加载） | 登录后 |
| `/monitor` | `MonitorPage` — 系统监控（懒加载） | 登录后 |
| `/memory` | `MemoryPage` — 记忆管理 | 登录后 |
| `/skills` | `SkillsPage` — Skills 管理 | 登录后 |
| `/settings` | `SettingsPage` — 系统设置（懒加载） | 登录后 |
| `/mcp-servers` | `McpServersPage` — MCP Servers 管理 | 登录后 |
| `/logs` | `LogsPage` — Agent 执行日志（懒加载） | 登录后 |
| `/users` | `UsersPage` — 用户管理 | `manage_users` / `manage_invites` / `view_audit_log` |

### 2.3 容器 / 宿主机执行

Agent Runner（`container/agent-runner/`）在 Docker 容器或宿主机进程中执行：

- **输入协议**：stdin 接收初始 JSON（`ContainerInput`：prompt、sessionId、groupFolder、chatJid、isHome、isAdminHome），IPC 文件接收后续消息
- **输出协议**：stdout 输出 `OUTPUT_START_MARKER...OUTPUT_END_MARKER` 包裹的 JSON（`ContainerOutput`：status、result、newSessionId、streamEvent）
- **流式事件**：`text_delta`、`thinking_delta`、`tool_use_start/end`、`tool_progress`、`hook_started/progress/response`、`task_start`、`task_notification`、`status`、`init` —— 通过 WebSocket `stream_event` 消息广播到 Web 端
- **文本缓冲**：`text_delta` 累积到 200 字符后刷新，避免高频小包
- **会话循环**：长生命周期 `claude -p --input-format stream-json` 会话持续接收消息，直到 `_close` sentinel
- **MCP Server**：11 个工具（`send_message`、`send_image`、`send_file`、`schedule_task`、`list/pause/resume/cancel_task`、`register_group`、`memory_query`、`memory_remember`），通过独立 stdio MCP server 暴露
- **消息路由**：stdout 仅输出到 Web 端；IM 消息必须通过 `send_message(channel=...)` 显式发送（详见 §3.1）
- **Hooks**：CLI hooks 在上下文压缩前归档对话到 `conversations/` 目录，并保留 host mode 的 Safety Lite
- **敏感数据过滤**：StreamEvent 中的 `toolInputSummary` 会过滤 `ANTHROPIC_API_KEY` 等环境变量名
- **预定义 SubAgent**：`providers/claude/claude-agent-defs.ts` 定义 `code-reviewer` 和 `web-researcher`，通过 `--agents` 追加注册到 Claude 会话

**Agent Runner 模块结构**（`container/agent-runner/src/`）：

| 文件 | 职责 |
|------|------|
| `index.ts` | 主入口：stdin 读取、provider 选择、query loop 启动 |
| `types.ts` | 共享类型定义（ContainerInput、ContainerOutput 等），re-export StreamEvent |
| `utils.ts` | 纯工具函数（字符串截断、敏感数据脱敏、文件名清理等） |
| `query-loop.ts` | provider 无关的查询编排、IPC polling、overflow / interrupt / drain 处理 |
| `happyclaw-mcp-server.ts` | Claude / Codex 共用的 stdio MCP server 入口 |
| `providers/claude/claude-stream-processor.ts` | StreamEventProcessor 类：流式事件缓冲、工具状态追踪、SubAgent 消息转换 |
| `providers/claude/claude-agent-defs.ts` | 预定义 SubAgent（code-reviewer、web-researcher） |
| `image-detector.ts` | 图片 MIME 检测（由 `shared/image-detector.ts` 构建时同步生成，勿直接编辑） |
| `stream-event.types.ts` | StreamEvent 类型（由 `shared/stream-event.ts` 构建时同步生成，勿直接编辑） |

### 2.4 执行模式

每个注册群组可选择执行模式（`RegisteredGroup.executionMode`）：

| 模式 | 行为 | 适用对象 | 前置依赖 |
|------|------|---------|---------|
| `host` | Agent 作为宿主机进程运行，通过 `claude` CLI 直接访问宿主机文件系统 | admin 主容器（`folder=main`） | 本机 `claude` 命令可用 |
| `container` | Agent 在 Docker 容器中运行，通过卷挂载访问文件，完全隔离 | member 主容器（`folder=home-{userId}`）及其他群组 | Docker Desktop + 构建镜像 |

**is_home 模型**：每个用户在注册时自动创建一个 `is_home=true` 的主容器。`loadState()` 启动时强制执行模式：admin 的主容器（`folder=main`）设为 `host`，member 的主容器（`folder=home-{userId}`）设为 `container`。

宿主机模式通过 `node container/agent-runner/dist/index.js` 启动 agent-runner 进程。主 Agent 直接调用本机 `claude` CLI，并在启动前探测 `claude --version` 与 `claude -p --help` 能力。

宿主机模式支持 `customCwd` 自定义工作目录，使用 `MAX_CONCURRENT_HOST_PROCESSES`（默认 5）作为独立的并发限制。

### 2.5 Docker 容器构建

容器镜像（`container/Dockerfile`）基于 `node:22-slim`：

- 安装 Chromium + 系统依赖（用于 `agent-browser` 浏览器自动化）
- 全局安装 `agent-browser` 和 `@anthropic-ai/claude-code`（始终最新版本）
- 主 Agent 通过容器内已安装的 `claude` CLI 运行 Claude provider。host mode 依赖宿主机本地 `claude`
- entrypoint.sh：加载环境变量 → 发现 Skills（符号链接）→ 编译 TypeScript → 从 stdin 读取 → 执行
- 以 `node` 非 root 用户运行
- 构建命令：`./container/build.sh`（`CACHEBUST` 参数确保跳过缓存）

### 2.6 Memory Agent（Fork 特有）

独立的 per-user 记忆子进程（`container/memory-agent/`），替代上游的 inline MCP 记忆工具。

**架构**：
- `MemoryAgentManager`（`src/memory-agent.ts`）管理 per-user 子进程生命周期
- 每个用户最多 1 个 Memory Agent 进程，系统最多 3 个并发（`MAX_CONCURRENT_MEMORY_AGENTS`）
- 子进程使用 **持久 query 会话**（单个长生命周期的 SDK `query()` 调用），避免反复启动 CLI 进程
- stdin/stdout JSON-line 协议通信，Promise 路由匹配请求/响应
- 空闲 10 分钟自动关闭，下次请求时重新启动
- 共享用户主容器的 OAuth 凭据目录（`data/sessions/{homeFolder}/.claude/`）

**四种操作**：

| 操作 | 触发方式 | 语义 |
|------|---------|------|
| `query` | Agent 调用 `memory_query` MCP 工具 → HTTP → Manager | 同步查询记忆，返回结果 |
| `remember` | Agent 调用 `memory_remember` MCP 工具 → HTTP → Manager | 异步存储信息 |
| `session_wrapup` | 容器退出时自动触发（`exportTranscriptsForUser()`） | 导出对话转录，生成印象/知识，更新索引 |
| `global_sleep` | 定时调度（30min 检查间隔，需满足三个条件） | 备份索引、压缩合并、归档旧印象、knowledge 拆分维护、更新 personality |

**global_sleep 触发条件**（全部满足才执行）：
1. 距上次 global_sleep 超过 6 小时（或从未执行过）
2. 该用户没有活跃的 Agent 会话
3. 有待处理的 wrapup（`state.json` 中 `pendingWrapups` 非空）

**数据目录**（`data/memory/{userId}/`）：
```
index.md              # 随身索引（~200 条目，主 Agent 每次对话加载）
state.json            # 元数据：lastGlobalSleep、lastSessionWrapups、pendingWrapups
personality.md        # 用户交互模式（global_sleep 更新）
knowledge/            # 按领域组织的详细知识（单文件或目录结构，后者由 global_sleep 自动拆分）
impressions/          # 每次 session_wrapup 生成的语义索引
  archived/           #   超过 6 个月的旧索引（global_sleep 归档，query 兜底检索）
transcripts/          # 原始对话记录
  {YYYY-MM-DD}/       #   按日期分目录
    {folder}-{ts}.md  #   每次 session_wrapup 导出的转录
```

**可配置超时**（Web 设置页 `/api/config/system`）：

| 设置 | 默认 | 范围 |
|------|------|------|
| `memoryQueryTimeout` | 60s | 10s ~ 600s |
| `memoryGlobalSleepTimeout` | 300s | 60s ~ 3600s |
| `memorySendTimeout` | 120s | 30s ~ 3600s |

**Web UI**（`/memory` 页面）：Memory Agent 状态面板（上次 wrapup/sleep 时间、待处理数）、手动触发按钮、超时设置。

## 3. 数据流

### 3.1 消息处理与路由

**消息入站**：
```
飞书/Telegram/QQ/Web 消息 → storeMessageDirect(db) + broadcastNewMessage(ws)
     → index.ts 轮询 getNewMessages()（10s 间隔）→ 按 chat_jid 分组去重
     → queue.enqueueMessageCheck() 判断容器/进程状态
         ├── 空闲 → runContainerAgent() 启动容器/进程
         ├── 运行中 → IPC 文件注入（home 群组也走 IPC，不再杀进程重启）
         └── 满载 → waitingGroups 排队等待
```

**消息出站（Fork 特有的显式路由模型）**：
```
Agent stdout → OUTPUT_MARKER → container-runner 解析 → WebSocket stream_event → Web 端显示
                                                    （不发送到 IM）

Agent 调用 send_message(channel="feishu:oc_xxx") → IPC /messages/*.json
     → 主进程 1s 轮询 → sendImWithFailTracking() → 飞书/Telegram/QQ
                       → storeMessageDirect(db) + broadcastToWebClients()（同时 Web 可见）
```

**channel 参数格式**：`feishu:{open_conversation_id}`、`telegram:{chat_id}`、`qq:{user_or_group_id}`、`web:{folder}`。值取自消息的 `source` 属性。

**MCP 消息工具**：
- `send_message(text, channel?)` — 文本消息，省略 channel 则仅 Web 显示
- `send_image(file_path, channel, caption?)` — 图片，10MB 限制
- `send_file(filePath, fileName, channel)` — 文件，30MB 限制

### 3.2 流式显示管道

```
Claude runner (`claude -p`) → 流式事件 (text_delta, tool_use_start, ...)
  → agent-runner 缓冲文本（200 字符阈值），向 stdout 发射 StreamEvent JSON
  → container-runner.ts 解析 OUTPUT_MARKER，通过 WebSocket stream_event 广播到 Web 端
  → 前端 chat store handleStreamEvent()，更新 StreamingDisplay 组件
  → 系统错误 (agent_error, container_timeout) 通过 new_message 事件清除流式状态
```

**注意**：流式事件仅到达 Web 端。IM 用户看不到流式输出、工具调用和思考过程——Agent 通过 `send_message` MCP 工具主动向 IM 发送最终结果。

StreamEvent 类型以 `shared/stream-event.ts` 为单一真相源，构建时通过 `scripts/sync-stream-event.sh` 同步到三处副本：
- `container/agent-runner/src/stream-event.types.ts`（agent-runner 内的 `types.ts` re-export）
- `src/stream-event.types.ts`（后端 `types.ts` re-export）
- `web/src/stream-event.types.ts`（前端 `chat.ts` import）

修改 StreamEvent 类型时，只需编辑 `shared/stream-event.ts`，然后运行 `make sync-types`（`make build` 会自动触发）。`make typecheck` 会通过 `scripts/check-stream-event-sync.sh` 校验同步状态。

`shared/image-detector.ts` 同样通过 `make sync-types` 同步到两处副本：
- `src/image-detector.ts`（后端）
- `container/agent-runner/src/image-detector.ts`（agent-runner）

### 3.3 IPC 通信

| 方向 | 通道 | 用途 |
|------|------|------|
| 主进程 → 容器 | `data/ipc/{folder}/input/*.json` | 注入后续消息 |
| 主进程 → 容器 | `data/ipc/{folder}/input/_close` | 优雅关闭信号 |
| 容器 → 主进程 | `data/ipc/{folder}/messages/*.json` | Agent 主动发送消息（`send_message` MCP 工具） |
| 容器 → 主进程 | `data/ipc/{folder}/tasks/*.json` | 任务管理（创建 / 暂停 / 恢复 / 取消） |

文件操作使用原子写入（先写 `.tmp` 再 `rename`），读取后立即删除。IPC 轮询间隔 1s（`IPC_POLL_INTERVAL`）。

**IPC 投递确认**（Fork 特有）：主进程向容器注入消息后追踪确认事件（`ipc_message_received` status），120s 未确认则告警。支持同一 JID 并发多条消息的独立追踪。

### 3.4 容器挂载策略

| 资源 | 容器路径 | admin 主容器 | member 主容器/其他 |
|------|---------|-------------|-------------------|
| 工作目录 `data/groups/{folder}/` | `/workspace/group` | 读写 | 读写（仅自己） |
| 项目根目录 | `/workspace/project` | 读写 | 不可访问 |
| 用户全局记忆 `data/groups/user-global/{userId}/` | `/workspace/global` | 读写 | 读写（仅自己） |
| Claude 会话 `data/sessions/{folder}/.claude/` | `/home/node/.claude` | 读写 | 读写（仅自己） |
| IPC 通道 `data/ipc/{folder}/` | `/workspace/ipc` | 读写 | 读写（仅自己） |
| 项目级 Skills `container/skills/` | `/workspace/project-skills` | 只读 | 只读 |
| 用户级 Skills `data/skills/{userId}/` | `/workspace/user-skills` | **读写**（Agent 可创建 Skills） | **读写**（仅自己） |
| 环境变量 `data/env/{folder}/env` | `/workspace/env-dir/env` | 只读 | 只读 |
| 额外挂载（白名单内） | `/workspace/extra/{name}` | 按白名单 | 按白名单（`nonMainReadOnly` 时强制只读） |

### 3.5 配置优先级

容器环境变量生效顺序（从低到高）：

1. 进程环境变量
2. 全局 Claude 配置（`data/config/claude-provider.json`）
3. 全局自定义环境变量（`data/config/claude-custom-env.json`）
4. 群组级覆盖（`data/config/container-env/{folder}.json`）

最终写入 `data/env/{folder}/env` → 只读挂载到容器 `/workspace/env-dir/env`。

### 3.6 WebSocket 协议

**服务端 → 客户端（`WsMessageOut`）**：

| 类型 | 用途 |
|------|------|
| `new_message` | 新消息到达（含 `chatJid`、`message`、`is_from_me`） |
| `agent_reply` | Agent 最终回复（含 `chatJid`、`text`、`timestamp`） |
| `typing` | Agent 正在输入指示 |
| `status_update` | 系统状态变更（活跃容器数、宿主机进程数、队列长度） |
| `stream_event` | 流式事件（含 `chatJid`、`StreamEvent`） |
| `agent_status` | Sub-Agent 状态变更（含 `chatJid`、`agentId`、`status`） |
| `terminal_output` | 终端输出数据 |
| `terminal_started` | 终端会话已启动 |
| `terminal_stopped` | 终端会话已停止 |
| `terminal_error` | 终端错误 |
| `docker_build_log` | Docker 镜像构建日志 |
| `docker_build_complete` | Docker 镜像构建完成 |

**客户端 → 服务端（`WsMessageIn`）**：

| 类型 | 用途 |
|------|------|
| `send_message` | 发送消息（含 `chatJid`、`content`，支持 `attachments` 和 `agentId`） |
| `terminal_start` | 启动终端会话 |
| `terminal_input` | 终端输入数据 |
| `terminal_resize` | 终端窗口大小调整 |
| `terminal_stop` | 停止终端会话 |

### 3.7 IM 连接池架构

`IMConnectionManager`（`src/im-manager.ts`）管理 per-user 的 IM 连接：

- 每个用户可独立配置飞书、Telegram 和 QQ 连接（存储在 `data/config/user-im/{userId}/feishu.json`、`telegram.json`、`qq.json`）
- `feishu.ts`、`telegram.ts`、`qq.ts` 均为工厂模式（`createFeishuConnection()`、`createTelegramConnection()`、`createQQConnection()`），返回无状态的连接实例
- 系统启动时 `loadState()` 遍历所有用户，加载已保存的 IM 配置并建立连接
- 首次启动时自动迁移系统级 IM 配置到 admin 的 per-user 配置（`migrateSystemIMToPerUser()`）
- 系统级 API（`/api/config/feishu`、`/api/config/telegram`）已标记 deprecated，新代码应使用 `/api/config/user-im/*`
- 收到 IM 消息时，通过 `onNewChat` 回调自动注册到该用户的主容器（`home-{userId}`）
- 支持热重连（`ignoreMessagesBefore` 过滤渠道关闭期间的堆积消息）
- 优雅关闭时 `disconnectAll()` 批量断开所有连接

## 4. 认证与授权

### 4.1 认证机制

- 密码哈希：bcrypt 12 轮（`bcryptjs`）
- 会话有效期：30 天
- Cookie 认证：HMAC 签名，`HttpOnly` + `SameSite=Lax`
- 会话密钥持久化：`data/config/session-secret.key`（0600 权限），优先级：环境变量 > 文件 > 自动生成
- 登录频率限制：5 次失败后锁定 15 分钟（可通过环境变量调整）

### 4.2 RBAC 权限

角色：`admin`（管理员）、`member`（普通成员）

5 种权限：

| 权限 | 说明 |
|------|------|
| `manage_system_config` | 管理系统配置（Claude / 飞书） |
| `manage_group_env` | 管理群组级容器环境变量 |
| `manage_users` | 用户管理（创建 / 禁用 / 删除） |
| `manage_invites` | 邀请码管理 |
| `view_audit_log` | 查看审计日志 |

权限模板：`admin_full`、`member_basic`、`ops_manager`、`user_admin`

### 4.3 审计事件

完整的审计事件类型（`AuthEventType`）：`login_success`、`login_failed`、`logout`、`password_changed`、`profile_updated`、`user_created`、`user_disabled`、`user_enabled`、`user_deleted`、`user_restored`、`user_updated`、`role_changed`、`session_revoked`、`invite_created`、`invite_deleted`、`invite_used`、`recovery_reset`、`register_success`

### 4.4 用户隔离

每个用户拥有独立的资源空间：

| 资源 | admin | member |
|------|-------|--------|
| 主容器 folder | `main` | `home-{userId}` |
| 执行模式 | `host`（宿主机） | `container`（Docker） |
| IM 通道 | 独立的飞书/Telegram/QQ 连接 | 独立的飞书/Telegram/QQ 连接 |
| 全局记忆写入 | 可读写 | 只读 |
| 项目根目录挂载 | 读写 | 不可访问 |
| 跨组 MCP 操作 | `register_group`、跨组任务管理 | 仅限自己的群组 |
| AI 外观 | 可自定义 `ai_name`、`ai_avatar_emoji`、`ai_avatar_color` | 同左 |
| Web 终端 | 可访问自己的容器终端 | 可访问自己的容器终端 |

用户注册后自动创建主容器（`POST /api/auth/register` → `ensureUserHomeGroup()`）。

## 5. 数据库表

SQLite WAL 模式，Schema 经历 v1→v24 演进（`db.ts` 中的 `SCHEMA_VERSION`）。

| 表 | 主键 | 用途 |
|-----|------|------|
| `chats` | `jid` | 群组元数据（jid、名称、最后消息时间） |
| `messages` | `(id, chat_jid)` | 消息历史（含 `is_from_me`、`source` 标识来源、`attachments`） |
| `scheduled_tasks` | `id` | 定时任务（调度类型、上下文模式、状态、`execution_type`、`script_command`、`created_by`） |
| `task_run_logs` | `id` (auto) | 任务执行日志（耗时、状态、结果） |
| `registered_groups` | `jid` | 注册的会话（folder 映射、容器配置、执行模式、`customCwd`、`is_home`、`init_source_path`、`init_git_url`、`selected_skills`、`require_mention`） |
| `sessions` | `(group_folder, agent_id)` | 会话 ID 映射（Claude session 持久化，支持 Sub-Agent 独立会话） |
| `router_state` | `key` | KV 存储（`last_timestamp`、`last_agent_timestamp`） |
| `users` | `id` | 用户账户（密码哈希、角色、权限、状态、`ai_name`、`ai_avatar_emoji`、`ai_avatar_color`、`avatar_emoji`、`avatar_color`、`ai_avatar_url`、`deleted_at`） |
| `user_sessions` | `id` | 登录会话（token、过期时间、最后活跃） |
| `invite_codes` | `code` | 注册邀请码（最大使用次数、过期时间） |
| `auth_audit_log` | `id` (auto) | 认证审计日志 |
| `group_members` | `(group_folder, user_id)` | 共享工作区成员（用户与群组的多对多关系） |
| `agents` | `id` | Sub-Agent（status、kind、prompt、result_summary，属于特定群组） |
| `usage_records` | `id` | Token 用量明细（per-model 拆行，关联 user_id、group_folder、message_id） |
| `usage_daily_summary` | `(user_id, model, date)` | 日维度用量预聚合（本地时区日期，增量 UPSERT） |
| `user_quotas` | `user_id` | 用户配额（预留，暂不写入数据） |

**注意**：`registered_groups.folder` 允许重复（多个飞书群组可映射到同一 folder）。`registered_groups.is_home` 标记用户主容器。

## 6. 目录约定

所有运行时数据统一在 `data/` 目录下，启动时自动创建（`mkdirSync recursive`），无需手动初始化。旧版 `store/` 和 `groups/` 目录在首次启动时自动迁移到 `data/` 下。

```
data/
  db/messages.db                           # SQLite 数据库（WAL 模式）
  groups/{folder}/                         # 会话工作目录（Agent 可读写）
  groups/{folder}/CLAUDE.md                # 会话私有记忆（Agent 自动维护）
  groups/{folder}/logs/                    # Agent 容器日志
  groups/{folder}/conversations/           # 对话归档（PreCompact Hook 写入）
  groups/{folder}/downloads/{channel}/     # IM 文件/图片下载目录（feishu / telegram，按日期分子目录）
  groups/user-global/{userId}/             # 用户级全局记忆目录
  groups/user-global/{userId}/CLAUDE.md    # 用户全局记忆（Agent 自动维护，per-user 隔离）
  sessions/{folder}/.claude/               # Claude 会话持久化（隔离）
  ipc/{folder}/input/                      # IPC 输入通道
  ipc/{folder}/messages/                   # IPC 消息输出
  ipc/{folder}/tasks/                      # IPC 任务管理
  env/{folder}/env                         # 容器环境变量文件
  memory/{userId}/                         # Memory Agent 数据（index.md、impressions/、impressions/archived/、knowledge/、transcripts/、state.json）
  config/                                  # 加密配置文件
  config/claude-provider.json              # Claude API 配置
  config/feishu-provider.json              # 飞书配置
  config/claude-custom-env.json            # 自定义环境变量
  config/container-env/{folder}.json       # 群组级环境变量覆盖
  config/user-im/{userId}/feishu.json      # 用户级飞书 IM 配置（AES-256-GCM 加密）
  config/user-im/{userId}/telegram.json    # 用户级 Telegram IM 配置（AES-256-GCM 加密）
  config/user-im/{userId}/qq.json          # 用户级 QQ IM 配置（AES-256-GCM 加密）
  config/registration.json                 # 注册设置（开关、邀请码要求）
  config/session-secret.key                # 会话签名密钥（0600 权限）
  config/system-settings.json              # 系统运行参数（容器超时、并发限制等）
  skills/{userId}/                         # 用户级 Skills 数据
  mcp-servers/{userId}/servers.json        # 用户 MCP Servers 配置

config/default-groups.json                 # 预注册群组配置
config/mount-allowlist.json                # 容器挂载白名单
config/global-claude-md.template.md        # 全局 CLAUDE.md 模板

container/skills/             # 项目级 Skills（挂载到所有容器）

shared/                       # 跨项目共享类型定义
  stream-event.ts             # StreamEvent 类型单一真相源（构建时同步到三个子项目）
  image-detector.ts           # 图片 MIME 检测（同步到 src/ 和 agent-runner/src/）

scripts/                      # 构建辅助脚本
  sync-stream-event.sh        # 将 shared/stream-event.ts 同步到各子项目
  check-stream-event-sync.sh  # 校验 StreamEvent 类型副本是否一致（typecheck 时调用）
```

## 7. Web API

### 认证
- `GET /api/auth/status` — 系统初始化状态（`initialized`、是否有用户）
- `POST /api/auth/setup` — 创建首个管理员（仅用户表为空时可用）
- `POST /api/auth/login` · `POST /api/auth/logout` · `GET /api/auth/me`（含 `setupStatus`）
- `POST /api/auth/register` · `PUT /api/auth/profile` · `PUT /api/auth/change-password`

### 会话
- `GET /api/sessions` · `POST /api/sessions`（创建 Web 会话）
- `PATCH /api/sessions/:id` · `DELETE /api/sessions/:id`
- `POST /api/sessions/:id/reset-session`
- `GET /api/sessions/:id/messages`
- `GET|PUT /api/sessions/:id/env`

### 文件
- `GET /api/sessions/:id/files` · `POST /api/sessions/:id/files`（上传，50MB 限制）
- `GET /api/sessions/:id/files/download/:path` · `DELETE /api/sessions/:id/files/:path`
- `POST /api/sessions/:id/directories`

### 记忆
- `GET /api/memory/sources` · `GET /api/memory/search`（全文检索）
- `GET|PUT /api/memory/file`
- `GET /api/memory/status` — Memory Agent 状态（上次 wrapup/sleep、待处理数）
- `POST /api/memory/trigger-wrapup` · `POST /api/memory/trigger-global-sleep` — 手动触发
- `POST /api/memory/stop-active-sessions` — 停止活跃会话（深度整理前置操作）

### 记忆（内部端点，agent-runner 调用）
- `POST /api/internal/memory/query` · `POST /api/internal/memory/remember` · `POST /api/internal/memory/session-wrapup`

### 配置
- `GET|PUT /api/config/claude` · `PUT /api/config/claude/secrets`
- `GET|PUT /api/config/claude/custom-env`
- `POST /api/config/claude/test`（连通性测试） · `POST /api/config/claude/apply`（应用到所有容器）
- `GET|PUT /api/config/feishu`（**deprecated**，使用 `/api/config/user-im/feishu` 代替）
- `GET|PUT /api/config/telegram` · `POST /api/config/telegram/test`（**deprecated**，使用 `/api/config/user-im/telegram` 代替）
- `GET|PUT /api/config/appearance` · `GET /api/config/appearance/public`（外观配置，public 端点无需认证）
- `GET|PUT /api/config/system` — 系统运行参数（容器超时、并发限制等），需要 `manage_system_config` 权限
- `GET /api/config/user-im/status`（所有渠道连接状态，含 QQ）
- `GET|PUT /api/config/user-im/feishu`（用户级飞书 IM 配置，GET 返回 `connected` 字段）
- `GET|PUT /api/config/user-im/telegram`（用户级 Telegram IM 配置，GET 返回 `connected`、`effectiveProxyUrl`、`proxySource`，PUT 支持 `proxyUrl`/`clearProxyUrl`）
- `POST /api/config/user-im/telegram/test`（Telegram Bot Token 连通性测试，使用 per-user proxyUrl）
- `GET|PUT /api/config/user-im/qq`（用户级 QQ IM 配置，GET 返回 `connected` 字段）
- `POST /api/config/user-im/qq/test`（QQ 凭据连通性测试）
- `POST /api/config/user-im/qq/pairing-code`（生成 QQ 配对码）
- `GET /api/config/user-im/qq/paired-chats`（已配对的 QQ 聊天列表）
- `DELETE /api/config/user-im/qq/paired-chats/:jid`（移除 QQ 配对）

### 任务
- `GET /api/tasks` · `POST /api/tasks` · `PATCH /api/tasks/:id` · `DELETE /api/tasks/:id`
- `GET /api/tasks/:id/logs`

### 管理
- `GET /api/admin/users` · `POST /api/admin/users` · `PATCH /api/admin/users/:id`
- `DELETE /api/admin/users/:id` · `POST /api/admin/users/:id/restore`
- `POST /api/admin/invites` · `GET /api/admin/invites` · `DELETE /api/admin/invites/:code`
- `GET /api/admin/audit-log`
- `GET|PUT /api/admin/settings/registration`

### Sub-Agent
- `GET /api/sessions/:id/agents` · `POST /api/sessions/:id/agents`（创建 Sub-Agent）
- `DELETE /api/sessions/:id/agents/:agentId`

### 目录浏览
- `GET /api/browse/directories`（列出可选目录，受挂载白名单约束）
- `POST /api/browse/directories`（创建自定义工作目录）

### MCP Servers
- `GET /api/mcp-servers` · `POST /api/mcp-servers`（CRUD，per-user）
- `PATCH /api/mcp-servers/:id` · `DELETE /api/mcp-servers/:id`
- `POST /api/mcp-servers/sync-host`（从宿主机同步 MCP Server 配置）

### 用量统计
- `GET /api/usage/stats?days=7&userId=&model=`（从 `usage_daily_summary` 查询，支持用户/模型筛选）
- `GET /api/usage/models`（去重模型列表）
- `GET /api/usage/users`（有用量数据的用户列表，admin 可见全部）

### 执行日志
- `GET /api/logs/:groupFolder`（列出日志文件，支持 `offset`/`limit` 分页）
- `GET /api/logs/:groupFolder/:filename`（解析后的日志内容，按 section 分段）
- `GET /api/logs/:groupFolder/:filename/raw`（下载原始日志文件）

### 监控
- `GET /api/status` · `GET /api/health`（无需认证）

### WebSocket
- `/ws`（详见 §3.6 WebSocket 协议）

## 8. 关键行为

### 8.1 设置向导

首次启动时，`GET /api/auth/status` 返回 `initialized: false`（无任何用户）。前端 `AuthGuard` 检测到未初始化状态后重定向到 `/setup`，引导创建管理员账号（自定义用户名 + 密码，调用 `POST /api/auth/setup`）。创建后自动登录并跳转到 `/setup/providers` 完成 Claude API 和飞书配置。

新用户注册后跳转到 `/setup/channels` 引导配置个人 IM 通道（飞书/Telegram），可跳过直接使用 Web 聊天。

不存在默认账号。`POST /api/auth/setup` 仅在用户表为空时可用。

### 8.2 IM 自动注册

未注册的飞书/Telegram/QQ 群组首次发消息时，通过 `onNewChat` 回调自动注册到该用户的主容器（`folder='home-{userId}'`，admin 则为 `folder='main'`）。支持多个 IM 群组映射到同一个 folder。QQ 通道需先通过配对码绑定（`/pair <code>`）。

### 8.3 无触发词

架构层面已移除触发词概念。注册会话中的新消息直接进入处理流程。

### 8.4 会话隔离

每个会话拥有独立的 `groups/{folder}` 工作目录、`data/sessions/{folder}/.claude` 会话目录、`data/ipc/{folder}` IPC 命名空间。非主会话只能发消息给自己所在的群组。

### 8.5 主容器权限层级

每个用户的主容器（`is_home=true`）拥有基础权限，admin 主容器额外拥有特权：

**所有主容器（isHome=true）**：
- AI 记忆能力（`memory_query`、`memory_remember`）
- 自己群组的 IPC 消息发送

**admin 主容器（isAdminHome=true，`folder=main`）额外权限**：
- 挂载项目根目录（读写）
- 全局记忆读写（其他会话只读）
- 跨会话操作（`register_group` MCP 工具）
- IPC 消息可发送到任意群组
- 跨组任务管理（暂停/恢复/取消其他群组的任务）

### 8.6 回复路由（Fork 特有）

主容器在 Web 与 IM 共用历史（通过 `normalizeHomeJid` 映射飞书/Telegram/QQ JID → `web:{folder}`）。

**显式路由模型**：Agent 的 stdout 仅显示在 Web 端。要向 IM 用户回复，Agent 必须调用 `send_message` MCP 工具并指定 `channel` 参数（值取自消息的 `source` 属性）。全局 CLAUDE.md 模板（`config/global-claude-md.template.md`）中包含路由指引。

### 8.7 并发控制

- 最多 20 个并发容器 + 最多 5 个并发宿主机进程（独立计数）
- 任务优先于普通消息
- 失败后指数退避重试（5s→10s→20s→40s→80s，最多 5 次）
- 优雅关闭：`_close` sentinel → `docker stop`（10s） → `docker kill`（5s）
- 容器超时：默认 30 分钟（`CONTAINER_TIMEOUT`）
- 空闲超时：默认 30 分钟（`IDLE_TIMEOUT`），最后一次输出后无新消息则关闭

### 8.8 Per-user 主容器自动创建

用户注册时（`POST /api/auth/register`）自动调用 `ensureUserHomeGroup()` 创建主容器：
- admin：folder=`main`，执行模式=`host`
- member：folder=`home-{userId}`，执行模式=`container`
- 同时创建 `web:{folder}` 的 chat 记录和 `registered_groups` 记录（`is_home=1`）

### 8.9 Per-user AI 外观

用户可通过 `PUT /api/auth/profile` 自定义 AI 外观：
- `ai_name`：AI 助手名称（默认使用系统 `ASSISTANT_NAME`）
- `ai_avatar_emoji`：头像 emoji（如 `🐱`、`🤖`）
- `ai_avatar_color`：头像背景色（CSS 颜色值）

前端 `MessageBubble` 组件根据消息来源的群组 owner 显示对应的 AI 外观。

### 8.10 Memory Agent 生命周期（Fork 特有）

```
容器启动 → Agent 对话中调用 memory_query/memory_remember
         → HTTP → MemoryAgentManager.ensureAgent() 延迟启动子进程
         → 子进程持久运行，处理后续请求

容器退出 → exportTranscriptsForUser() 导出对话转录
         → manager.send(session_wrapup) → 子进程生成印象/更新索引
         → folder 加入 pendingWrapups

每 30 分钟 → runMemoryGlobalSleepIfNeeded() 遍历用户
          → 满足条件（6h+未 sleep、无活跃会话、有 pending）
          → manager.send(global_sleep) → 子进程压缩/归档旧印象/knowledge 拆分/备份

子进程空闲 10 分钟 → 自动关闭，下次请求重新启动
```

### 8.11 IM 通道热管理

通过 `PUT /api/config/user-im/feishu`、`PUT /api/config/user-im/telegram` 或 `PUT /api/config/user-im/qq` 更新 IM 配置后：
- 保存配置到 `data/config/user-im/{userId}/` 目录（AES-256-GCM 加密）
- 断开该用户的旧连接
- 如果新配置有效（`enabled=true` 且凭据非空），立即建立新连接
- `ignoreMessagesBefore` 设为当前时间戳，避免处理堆积消息

### 8.12 IM 斜杠命令

飞书/Telegram/QQ 中以 `/` 开头的消息会被拦截为斜杠命令（未知命令继续作为普通消息处理）。命令在主服务进程的 `handleCommand()` 中分发，纯函数逻辑在 `im-command-utils.ts` 中（便于单测）。

| 命令 | 缩写 | 用途 |
|------|------|------|
| `/list` | `/ls` | 查看所有工作区和对话列表，标记当前位置，显示 Agent 短 ID |
| `/status` | - | 查看当前所在的工作区/对话状态 |
| `/recall` | `/rc` | 调用 Claude CLI（`--print` 模式）总结最近 10 条消息，API 不可用时 fallback 到原始消息列表 |
| `/clear` | - | 清除当前对话的会话上下文 |
| `/require_mention` | - | 切换群聊响应模式：`/require_mention true`（需要 @机器人）或 `/require_mention false`（全量响应） |

`/recall` 通过 `execFile('claude', ['--print'])` + stdin 管道调用 Claude CLI，复用与 Agent Runner 相同的 OAuth 认证机制。

### 8.13 群聊 Mention 控制

飞书群聊支持 per-group 的 @mention 控制，类似 OpenClaw 的 `resolveGroupActivationFor()` 机制：

- **默认模式**（`require_mention=false`）：群聊中所有消息都会被处理
- **Mention 模式**（`require_mention=true`）：群聊中只有 @机器人 的消息才会被处理
- 通过 `/require_mention true|false` 命令切换
- 私聊不受此控制影响，始终响应

**实现原理**：连接飞书时通过 Bot Info API 获取 bot 的 `open_id`，收到群消息后检查 `mentions[].id.open_id` 是否包含 bot。如果 bot 未被 @mention 且该群 `require_mention=true`，则静默丢弃该消息。

**前置条件**：飞书应用需要 `im:message.group_msg` 敏感权限（实时接收群里所有消息）。`im:message:readonly` 仅控制 REST API 读取历史消息，不影响 WebSocket 实时推送。没有 `im:message.group_msg` 权限时，平台层只推送 @消息，`require_mention=false` 无法生效。

## 9. 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `ASSISTANT_NAME` | `HappyClaw` | 助手名称 |
| `WEB_PORT` | `3000` | 后端端口 |
| `WEB_SESSION_SECRET` | 自动生成 | 会话签名密钥 |
| `FEISHU_APP_ID` | - | 飞书应用 ID |
| `FEISHU_APP_SECRET` | - | 飞书应用密钥 |
| `CONTAINER_IMAGE` | `happyclaw-agent:latest` | Docker 镜像名称 |
| `CONTAINER_TIMEOUT` | `1800000`（30min） | 容器最大运行时间（可通过设置页覆盖） |
| `CONTAINER_MAX_OUTPUT_SIZE` | `10485760`（10MB） | 单次输出最大字节（可通过设置页覆盖） |
| `IDLE_TIMEOUT` | `1800000`（30min） | 容器空闲超时（可通过设置页覆盖） |
| `MAX_CONCURRENT_CONTAINERS` | `20` | 最大并发容器数（可通过设置页覆盖） |
| `MAX_CONCURRENT_HOST_PROCESSES` | `5` | 宿主机模式并发上限（可通过设置页覆盖） |
| `MAX_LOGIN_ATTEMPTS` | `5` | 登录失败锁定阈值（可通过设置页覆盖） |
| `LOGIN_LOCKOUT_MINUTES` | `15` | 锁定持续时间（分钟）（可通过设置页覆盖） |
| `TRUST_PROXY` | `false` | 信任反向代理的 `X-Forwarded-For` 头（启用后从代理头获取客户端 IP） |
| `TZ` | 系统时区 | 定时任务时区 |

## 10. 开发约束

- **不要重新引入"触发词"架构**
- **会话隔离是核心原则**，避免跨会话共享运行时目录
- 当前阶段允许不兼容重构，优先代码清晰与行为一致
- 修改容器 / 调度逻辑时，优先保证：不丢消息、不重复回复、失败可重试
- **Git commit message 使用简体中文**，格式：`类型: 简要描述`（如 `修复: 侧边栏下拉菜单无法点击`）
- 系统路径不可通过文件 API 操作：`logs/`、`CLAUDE.md`、`.claude/`、`conversations/`
- StreamEvent 类型以 `shared/stream-event.ts` 为单一真相源，修改后运行 `make sync-types` 同步（`make build` 自动触发，`make typecheck` 校验一致性）
- 主 Agent 依赖 Claude Code CLI。容器模式由镜像安装，host mode 依赖宿主机 `claude` 命令
- 容器内以 `node` 非 root 用户运行，需注意文件权限

## 11. 本地开发

### 常用命令

```bash
make dev           # 启动前后端（首次自动安装依赖和构建镜像）
make dev-backend   # 仅启动后端
make dev-web       # 仅启动前端
make build         # 编译全部（后端 + 前端 + agent-runner）
make start         # 一键启动生产环境
make typecheck     # TypeScript 全量类型检查（后端 + 前端 + agent-runner）
make format        # 格式化代码（prettier）
make install       # 安装全部依赖并编译 agent-runner
make clean         # 清理构建产物（dist/）
make sync-types    # 同步 shared/ 下的类型定义到各子项目
make reset-init    # 重置为首装状态（清空数据库和配置，用于测试设置向导）
make backup        # 备份运行时数据到 happyclaw-backup-{date}.tar.gz
make restore       # 从备份恢复数据（make restore 或 make restore FILE=xxx.tar.gz）
make help          # 列出所有可用的 make 命令
```

### 端口

- 后端：3000（Hono + WebSocket）
- 前端开发服务器：5173（Vite，代理 `/api` 和 `/ws` 到后端）

### 四个独立的 Node 项目

| 项目 | 目录 | 用途 |
|------|------|------|
| 主服务 | `/`（根目录） | 后端服务 |
| Web 前端 | `web/` | React SPA |
| Agent Runner | `container/agent-runner/` | 容器/宿主机内执行引擎 |
| Memory Agent | `container/memory-agent/` | per-user 记忆子进程（Fork 特有） |

每个项目有独立的 `package.json`、`tsconfig.json`、`node_modules/`。此外，`shared/` 目录存放跨项目的共享类型定义（如 `stream-event.ts`），构建时通过 `make sync-types` 同步到各项目。

## 12. 常见变更指引

### 新增 Web 设置项

1. 在对应的 `src/routes/*.ts` 文件中添加鉴权 API
2. 持久化写入 `data/config/*.json`（参考 `runtime-config.ts` 的加密模式）
3. 前端 `SettingsPage` 增加表单

### 将环境变量迁移为 Web 可配置

如需将新的环境变量迁移到 Web 可配置，参考 `runtime-config.ts` 中的 `SystemSettings` 模式：

1. 在 `runtime-config.ts` 的 `SystemSettings` 接口添加字段
2. 在 `getSystemSettings()` 中实现 file → env → default 三级 fallback
3. 在 `saveSystemSettings()` 中添加范围校验
4. 在 `schemas.ts` 的 `SystemSettingsSchema` 添加 zod 校验
5. 前端 `SystemSettingsSection.tsx` 的 `fields` 数组添加表单项

### 新增会话级功能

1. 明确是否需要容器隔离
2. 明确是否写入会话私有目录
3. 同步更新 Web API 路由和前端 Store

### 新增 MCP 工具

1. 在 `container/agent-runner/src/happyclaw-mcp-server.ts` 中注册新的工具定义
2. 主进程 `src/index.ts` 的 IPC 处理器增加对应 type 分支
3. 重建容器镜像：`./container/build.sh`

### 新增 Skills（Fork 特有：Agent 自主创建模型）

**项目级 Skills**：添加到 `container/skills/`（只读挂载到所有容器）。当前包含 `agent-browser`、`skill-creator`、`post-test-cleanup`。

**用户级 Skills**：存储在 `data/skills/{userId}/`，通过 `entrypoint.sh` 符号链接到 `~/.claude/skills/`。Agent 可通过 `skill-creator` 项目级 Skill 自主创建新 Skills，直接写入 `$HAPPYCLAW_SKILLS_DIR`。

**主机同步**：`POST /api/skills/sync-host` 可将宿主机 `~/.claude/skills/` 同步到用户目录。

无需重建镜像，volume 挂载 + entrypoint.sh 符号链接自动发现。上游的注册表安装机制已移除。

### 新增 StreamEvent 类型

1. `shared/stream-event.ts` — 在 `StreamEventType` 联合类型中添加新成员，在 `StreamEvent` 接口中添加对应字段
2. 运行 `make sync-types` 同步到三个子项目
3. `container/agent-runner/src/providers/claude/claude-stream-processor.ts` 或对应 provider 的事件适配层中添加发射逻辑
4. `web/src/stores/chat.ts` — 在 `handleStreamEvent()` / `applyStreamEvent()` 中添加处理分支

### 新增 IM 集成渠道

1. 在 `src/` 目录下创建新的连接工厂模块（参考 `feishu.ts`、`telegram.ts`、`qq.ts` 的接口模式）
2. 在 `src/im-manager.ts` 中添加 `connectUser{Channel}()` / `disconnectUser{Channel}()` 方法
3. 在 `src/routes/config.ts` 中添加 `/api/config/user-im/{channel}` 路由（GET/PUT）
4. 在 `src/index.ts` 的 `loadState()` 和 `connectUserIMChannels()` 中加载新渠道
5. 前端 `SetupChannelsPage` 和设置页添加新渠道的配置表单

### 修改数据库 Schema

1. 在 `src/db.ts` 中增加 migration 语句
2. 更新 `SCHEMA_VERSION` 常量
3. 同时更新 `CREATE TABLE` 语句和 migration ALTER/CREATE 语句
