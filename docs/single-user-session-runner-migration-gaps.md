# 单用户多 Session 迁移 — 收口结果

> 配套文档：`docs/single-user-session-runner-migration-plan.md`
> 最后复核：2026-04-15
> 当前 `SCHEMA_VERSION = 42`

本文件原先用于记录 Phase 2 的剩余缺口。到 2026-04-15 为止，文中列出的缺口已经全部收口完成，保留这份文档是为了给后续复盘一个明确结论，不再作为待办清单使用。

---

## 当前结论

- Phase 0 / 1 / 2 / 3 / 4 / 5 已达到本轮迁移目标
- `registered_groups`、`group_members`、`user_sessions`、`invite_codes`、`auth_audit_log`、billing 旧表都已退出数据库主链
- 正式模型已经稳定在 `sessions + worker_sessions + session_channels + session_bindings + session_state`
- 单用户 operator 已固定，本地 Web `auth` 只保留兼容外形，不再承载首装注册、邀请码或应用层登录流程

---

## 已完成的关键收口

| 范围 | 结果 |
|------|------|
| Session 主模型 | `Session` 成为唯一正式执行对象，主会话、workspace、worker、memory 全部统一进 `sessions` |
| 渠道路由 | IM 显式绑定统一写入 `session_bindings`，渠道元数据统一写入 `session_channels` |
| owner 语义 | `sessions.owner_key` 成为唯一 owner 真源，memory 与 runtime 不再回退 `created_by` |
| 单用户化 | 本地 operator 固定注入，`users` 仅保留兼容资料与统计关联 |
| 旧平台能力退场 | 邀请码、登录会话、共享成员、billing 兼容层与旧 `llm_provider` fallback 已删除 |
| 文档与验收 | 主文档、知识库、构建和真实 HTTP 烟测已按当前实现重新核对 |

---

## 仍然保留但属于有意兼容的部分

- `users` 表仍在，用于本地 operator 资料与用量聚合，不再承担登录态真源
- `/api/auth/*` 仍在，用于兼容旧前端与固定本地 operator 注入
- 运行时对象中的 `is_home` 只作为兼容投影存在，不是数据库字段
- 少量 `group` 命名仍保留在历史函数名、注释和兼容层对象中，但正式语义已经按 Session 理解

---

## 如果后面还要继续复查

建议优先检查三类问题：

1. 文档是否又把兼容对象写成正式模型
2. 新增 API 是否重新引入 `group`、`home`、`created_by`、`llm_provider` 之类旧字段
3. 真实 HTTP 链路是否仍能覆盖会话创建、改名、删除、消息发送、任务调度和 memory 状态查询

## 关键代码位置

| 范围 | 位置 |
|------|------|
| Schema & migration | `src/db.ts` |
| Session API | `src/routes/sessions.ts` |
| Auth / 多租户 | `src/routes/auth.ts`, `src/auth.ts`, `src/billing.ts` |
| Memory | `src/memory-agent.ts`, `src/memory-profile.ts`, `src/memory-orchestrator.ts`, `src/memory-runner-adapter.ts` |
| Runner | `src/runtime-runner.ts`, `src/runner-registry.ts`, `src/session-runtime-manager.ts` |
| Worker | `src/worker-session.ts`, `src/routes/agents.ts` |
| Owner 推导热点 | `src/index.ts`（多处 `resolveSessionOwnerKey`） |
| IM 连接器 | `src/feishu.ts`, `src/telegram.ts`, `src/qq.ts`, `src/wechat.ts`, `src/im-manager.ts` |
| 前端 | `web/src/pages/SessionsPage.tsx`, `web/src/stores/*`, `web/src/types.ts` |
