# HappyClaw (Fork) — AI 协作者指南

> 完整架构文档：`CLAUDE-full.md`。按需阅读详细模块、数据流、接口与行为规范。

## 1. 项目定位

[HappyClaw](https://github.com/riba2534/happyclaw) 的实验性 fork，探索更好的记忆能力和更高的 Agent 自主性。

**核心差异**：runner-agnostic Memory Orchestrator、显式消息路由、Skills 自主创建。

**系统概要**：单用户多 Session 的本地 AI workbench。输入来自飞书、Telegram、QQ 与 Web。所有主会话、worker 和 memory 请求都由本地子进程 runtime 启动已选择的 runner。输出通过 Web 流式推送，IM 渠道必须显式发送。

## 关键架构要点

**四个活跃 Node 项目**：根目录后端、`web/` React SPA、`container/agent-runner-core/` 共享运行时核心、`container/agent-runner/` 执行引擎。

**执行模式**：统一使用 `src/runtime-runner.ts` 的本地子进程 runtime，不再存在 Docker 与 member 执行分支。

**消息路由**：Agent stdout 仅 Web 可见。IM 必须 `send_message(channel=...)`。channel 格式：`feishu:{id}`、`telegram:{id}`、`qq:{id}`、`web:{folder}`。

**会话隔离**：每个 Session 拥有独立工作目录、provider 状态目录和 IPC 目录。隔离对象是会话文件、运行时状态和消息通道。Claude 使用同一个本地操作者的物理登录，这是单用户模型下的有意设计。

**IPC**：文件通信，`data/ipc/{folder}/input/` 入、`messages/` 出、`tasks/` 任务。原子写入，1s 轮询。

**Memory Agent**：`src/memory-agent.ts` 中的 `MemoryOrchestrator` 使用并行只读查询车道与串行写入车道。普通查找由 `memory_search` 直接检索 Markdown；remember、批量 session_wrapup、索引修复与 global_sleep 通过 SQLite 持久队列执行。数据位于 `data/memory/{ownerKey}/`。

**共享类型**：`shared/stream-event.ts`、`shared/image-detector.ts`、`shared/runner-descriptor.ts` 和 `shared/runner-health.ts` 是单一真相源，由 `make sync-types` 同步。

**并发**：本地 runtime 进程池上限由 `runtime-config.ts` 的 `maxConcurrentRuntimes` 控制，默认 20。任务优先于消息，失败使用指数退避重试。

## 目录约定

```
data/
  db/messages.db                           # SQLite WAL
  groups/{folder}/                         # 会话工作目录
  groups/{folder}/CLAUDE.md                # 会话工作区指令
  groups/{folder}/conversations/           # 对话归档
  groups/user-global/{ownerKey}/            # 操作者全局指令与文件
  sessions/{folder}/                       # provider 会话状态与配置
  ipc/{folder}/                            # IPC 通道
  env/{folder}/env                         # runtime 环境变量
  memory/{ownerKey}/                       # Memory Agent 数据
  config/                                  # 加密配置
  skills/{ownerKey}/                       # 用户级 Skills
  mcp-servers/{ownerKey}/servers.json      # MCP Servers 配置

container/skills/                          # 项目级 Skills
shared/                                    # 跨项目共享类型
```

## 开发约束

- **不要重新引入"触发词"架构**
- **会话隔离是核心原则**，避免跨会话共享运行时目录
- 当前阶段允许不兼容重构，优先代码清晰与行为一致
- 修改 runtime 或调度逻辑时，优先保证：不丢消息、不重复回复、失败可重试
- **Git commit message 使用简体中文**，格式：`类型: 简要描述`
- 系统路径不可通过文件 API 操作：`logs/`、`CLAUDE.md`、`AGENTS.md`、provider 状态目录、`conversations/`
- StreamEvent 类型以 `shared/stream-event.ts` 为单一真相源，修改后运行 `make sync-types` 同步

## 本地开发

```bash
make dev           # 启动前后端
make build         # 编译全部
make start         # 生产环境启动
make typecheck     # 全量类型检查
make format        # prettier 格式化
make sync-types    # 同步 shared/ 类型
make help          # 所有命令
```

端口：后端 3000、前端 dev 5173（代理 `/api` `/ws` 到后端）。

## 常见变更指引

**新增 MCP 工具**：`container/agent-runner/src/happyclaw-mcp-server.ts` 暴露工具 → `src/index.ts` 或对应 route 与 IPC 处理器补宿主逻辑

**新增 StreamEvent**：`shared/stream-event.ts` 加类型 → `make sync-types` → 对应 runner 发射 → `web/src/stores/chat.ts` 处理

**新增 IM 渠道**：创建连接工厂 → `im-manager.ts` 加方法 → `routes/config.ts` 加路由 → `index.ts` loadState 加载 → 前端配置表单

**新增 Web 设置项**：`routes/*.ts` 加 API → `data/config/*.json` 持久化 → 前端表单

**环境变量→Web 可配置**：`runtime-config.ts` SystemSettings 加字段 → getSystemSettings() 三级 fallback → saveSystemSettings() 校验 → `schemas.ts` zod → 前端 `SystemSettingsSection.tsx` fields

**修改 DB Schema**：`db.ts` 加 migration → 更新 `SCHEMA_VERSION` → 同步 CREATE TABLE

**新增 Skills**：项目级放 `container/skills/`；用户级由 Agent 通过 `skill-creator` 创建到 `$HAPPYCLAW_SKILLS_DIR`。不要写入 `~/.claude/skills`、`~/.codex/skills`、`~/.agents/skills` 等 provider 原生目录。无需重建镜像。
