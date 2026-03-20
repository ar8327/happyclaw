# HappyClaw (Fork) — AI 协作者指南

> 完整架构文档：`CLAUDE-full.md`（§2-§8 详细模块、数据流、API、行为规范）。按需 Read。

## 1. 项目定位

[HappyClaw](https://github.com/riba2534/happyclaw) 的实验性 fork，探索更好的记忆能力和更高的 Agent 自主性。

**核心差异**：Memory Agent 系统（per-user 记忆子进程）、显式消息路由（stdout→Web，IM 需 `send_message`）、Skills 自主创建。

**系统概要**：自托管多用户 AI Agent 系统。输入：飞书/Telegram/QQ/Web。执行：Docker 容器或宿主机进程（Claude Agent SDK）。输出：Web 流式推送 + IM 显式发送。

## 关键架构要点

**四个 Node 项目**：根目录（后端）、`web/`（React SPA）、`container/agent-runner/`（执行引擎）、`container/memory-agent/`（记忆子进程）。

**执行模式**：`host`（admin 主容器，folder=`main`）| `container`（member，folder=`home-{userId}`）。

**消息路由**：Agent stdout 仅 Web 可见。IM 必须 `send_message(channel=...)`。channel 格式：`feishu:{id}`、`telegram:{id}`、`qq:{id}`、`web:{folder}`。

**会话隔离**：每会话独立 `data/groups/{folder}/` 工作目录 + `data/sessions/{folder}/.claude/` + `data/ipc/{folder}/`。

**IPC**：文件通信，`data/ipc/{folder}/input/` 入、`messages/` 出、`tasks/` 任务。原子写入，1s 轮询。

**Memory Agent**：per-user 子进程，query/remember/session_wrapup/global_sleep 四种操作。数据在 `data/memory/{userId}/`。

**共享类型**：`shared/stream-event.ts` 为单一真相源，`make sync-types` 同步。`shared/image-detector.ts` 同理。

**并发**：最多 20 容器 + 5 宿主机进程。任务优先于消息。指数退避重试。

## 目录约定

```
data/
  db/messages.db                           # SQLite WAL
  groups/{folder}/                         # 会话工作目录
  groups/{folder}/CLAUDE.md                # 会话私有记忆
  groups/{folder}/conversations/           # 对话归档
  groups/user-global/{userId}/             # 用户全局记忆
  sessions/{folder}/.claude/               # Claude 会话持久化
  ipc/{folder}/                            # IPC 通道
  env/{folder}/env                         # 容器环境变量
  memory/{userId}/                         # Memory Agent 数据
  config/                                  # 加密配置
  skills/{userId}/                         # 用户级 Skills
  mcp-servers/{userId}/servers.json        # MCP Servers 配置

config/default-groups.json                 # 预注册群组
config/mount-allowlist.json                # 挂载白名单
config/global-claude-md.template.md        # 全局 CLAUDE.md 模板
container/skills/                          # 项目级 Skills
shared/                                    # 跨项目共享类型
```

## 开发约束

- **不要重新引入"触发词"架构**
- **会话隔离是核心原则**，避免跨会话共享运行时目录
- 当前阶段允许不兼容重构，优先代码清晰与行为一致
- 修改容器 / 调度逻辑时，优先保证：不丢消息、不重复回复、失败可重试
- **Git commit message 使用简体中文**，格式：`类型: 简要描述`
- 系统路径不可通过文件 API 操作：`logs/`、`CLAUDE.md`、`.claude/`、`conversations/`
- StreamEvent 类型以 `shared/stream-event.ts` 为单一真相源，修改后运行 `make sync-types` 同步
- Claude SDK 和 CLI 始终使用最新版本（`make update-sdk`）
- 容器内以 `node` 非 root 用户运行

## 本地开发

```bash
make dev           # 启动前后端
make build         # 编译全部
make start         # 生产环境启动
make typecheck     # 全量类型检查
make format        # prettier 格式化
make sync-types    # 同步 shared/ 类型
make update-sdk    # 更新 Claude Agent SDK
make help          # 所有命令
```

端口：后端 3000、前端 dev 5173（代理 `/api` `/ws` 到后端）。

## 常见变更指引

**新增 MCP 工具**：`agent-runner/src/mcp-tools.ts` 添加 tool() → `src/index.ts` IPC 处理器加分支 → `./container/build.sh`

**新增 StreamEvent**：`shared/stream-event.ts` 加类型 → `make sync-types` → `stream-processor.ts` 发射 → `web/src/stores/chat.ts` 处理

**新增 IM 渠道**：创建连接工厂 → `im-manager.ts` 加方法 → `routes/config.ts` 加路由 → `index.ts` loadState 加载 → 前端配置表单

**新增 Web 设置项**：`routes/*.ts` 加 API → `data/config/*.json` 持久化 → 前端表单

**环境变量→Web 可配置**：`runtime-config.ts` SystemSettings 加字段 → getSystemSettings() 三级 fallback → saveSystemSettings() 校验 → `schemas.ts` zod → 前端 `SystemSettingsSection.tsx` fields

**修改 DB Schema**：`db.ts` 加 migration → 更新 `SCHEMA_VERSION` → 同步 CREATE TABLE

**新增 Skills**：项目级放 `container/skills/`；用户级由 Agent 通过 `skill-creator` 创建到 `$HAPPYCLAW_SKILLS_DIR`。无需重建镜像。
