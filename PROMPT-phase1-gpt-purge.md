# Phase 1: GPT 大清洗

## 你在做什么

你正在从 HappyClaw 项目中删除所有 OpenAI/GPT 代码（~6000 行）。这个 prompt 会被 Ralph Loop 反复喂给你。每次迭代，先用 `git log --oneline -20` 检查哪些 Group 已完成，然后从下一个未完成的 Group 继续。

## 设计参考

详细规格参见 `docs/design-agent-harness.md` §3.8（GPT 大清洗）和 §6（宿主机侧变更）。

## 进度追踪

每完成一个 Group，创建一个 commit。用 commit message 中的 "Group X" 关键词判断是否已完成。

预期 commits（按顺序）：
- Group A: 删除整个文件/目录
- Group B: 清理容器侧 imports
- Group C: 清理宿主机后端
- Group D: 清理前端
- Group E: 更新 Makefile
- Group F: 最终验证 + 残留扫描

## 决策规则

1. 先跑 `git log --oneline -20`。如果某个 Group 的 commit 已存在，跳过。
2. 每个 Group 完成后跑 typecheck。失败则修复后再 commit。
3. Group A-D 用细粒度 typecheck（各子项目单独 `npx tsc --noEmit`），Group E 后用 `make typecheck && make build`。
4. Git commit message 使用简体中文，格式：`清理: ...（Phase 1 Group X）`

---

## Group A: 删除整个文件/目录

用 `git rm -r` 删除以下目标：

```
container/agent-runner-openai/                          # 整个目录 (~1130 行)
container/agent-runner/src/safety-hooks.ts               # 328 行
container/agent-runner/src/review-hooks.ts               # 649 行
container/agent-runner/src/gpt-client.ts                 # 219 行
container/agent-runner/src/risk-rules.ts                 # 259 行
container/agent-runner/src/review-context/               # 整个目录 (~1206 行)
container/agent-runner-core/src/tool-adapters.ts         # 51 行
container/agent-runner-core/src/plugins/cross-model.ts   # ~360 行
container/agent-runner-core/src/plugins/delegate.ts      # ~665 行
web/src/components/settings/OpenAIProviderSection.tsx    # 474 行
```

Commit: `清理: 删除所有 OpenAI/GPT 专用文件（Phase 1 Group A）`

---

## Group B: 清理容器侧 imports

### 1. container/agent-runner/src/index.ts
- 删除 imports：`safety-hooks`、`review-hooks`、`review-context`（靠近文件顶部）
- 删除 `reviewContextConfig` 变量声明及赋值块
- 简化 hooks 对象：**只保留 PreCompact**，删除 PreToolUse（createGatekeeperHook）、PostToolUse（createPostToolUseReviewHook + createLoopRecoveryHook）、Stop（createStopReviewHook）

### 2. container/agent-runner/src/mcp-adapter.ts
- 删除 `CrossModelPlugin`、`DelegatePlugin` 的 import 行
- 在 `createContextManager()` 中删除这两个 `.register()` 调用

### 3. container/agent-runner-core/src/index.ts
- 删除 `CrossModelPlugin`、`DelegatePlugin`、`toOpenAITools`、`toCodexTools` 的 export/re-export
- 删除相关类型导出

验证：`cd container/agent-runner-core && npx tsc --noEmit && cd ../agent-runner && npx tsc --noEmit`

Commit: `清理: 移除容器侧 GPT hooks 和插件引用（Phase 1 Group B）`

---

## Group C: 清理宿主机后端

**按此顺序处理**（先删消费者再删提供者，避免级联 import 失败）：

### 1. src/im-commentary.ts
- 删除 `CODEX_API_URL` 和 `COMMENTARY_MODEL` 常量
- 删除 `useGpt` 参数（从 `sendToolCommentary` 和 `generateExplanation` 函数签名中移除）
- 删除整个 `tryGpt()` 函数
- 删除 `getOpenAIProviderConfig` import
- 简化 `generateExplanation()`：只保留 Haiku → 启发式 fallback

### 2. src/index.ts
- 删除 `getOpenAIProviderConfig` import
- 删除限流自动切换 OpenAI 逻辑（搜索 `autoSwitchToOpenAIOnRateLimit`，删除整个 if 块）
- 删除 IM Commentary 调用处的 `useGpt` 参数（搜索 `useGpt:`）

### 3. src/container-runner.ts
- 删除 `getOpenAIProviderConfig` import
- 删除 OpenAI runner 选择逻辑（`isOpenAI` 变量 + runner 目录选择分支）→ 硬编码为 `'agent-runner'`
- 当 `group.llm_provider === 'openai'` 时打 warn 日志，不阻塞
- 删除 OpenAI 凭据注入块（`OPENAI_*`、`CROSSMODEL_*` 环境变量设置）

### 4. src/runtime-config.ts
- 删除整个 OpenAI provider config 模块（~577 行，从 `OPENAI_CONFIG_FILE` 常量开始到文件末尾附近的所有 OpenAI 函数）：
  - `getOpenAIProviderConfig` / `saveOpenAIProviderConfig`
  - `initiateDeviceCodeAuth` / `pollDeviceCodeAuth`
  - `refreshOpenAIOAuthTokens` / `disconnectOpenAIOAuth`
  - `initiatePkceAuth` / `completePkceAuth`
  - `scheduleOpenAITokenRefresh`
  - `encryptOpenAISecrets` / `decryptOpenAISecrets`
  - 相关类型和常量
- 删除 `SystemSettings.autoSwitchToOpenAIOnRateLimit` 字段 + get/save/buildEnvFallback 中对应逻辑
- 删除 `UserFeishuConfig.imCommentaryUseGpt` 字段 + read/save 中对应逻辑

### 5. src/routes/config.ts
- 删除所有 OpenAI 相关 import
- 删除全部 `/api/config/openai*` 路由（GET/PUT/PATCH + OAuth 路由共 ~300 行）

### 6. src/routes/usage.ts
- 删除 `getOpenAIProviderConfig` import
- 删除 `GET /api/usage/openai-subscription` 端点（~180 行，包含类型定义和缓存逻辑）

### 7. src/routes/memory-agent.ts
- 删除 `getOpenAIProviderConfig` import
- 删除 `GET /api/internal/memory/openai-credentials` 端点

### 8. src/schemas.ts
- 删除 `imCommentaryUseGpt: z.boolean().optional()` 字段
- 删除 `autoSwitchToOpenAIOnRateLimit: z.boolean().optional()` 字段
- 保留 `llm_provider: z.enum(['claude', 'openai']).optional()`（向后兼容）

验证：`npx tsc --noEmit`（根目录）

Commit: `清理: 移除宿主机侧所有 OpenAI 逻辑（Phase 1 Group C）`

---

## Group D: 清理前端

### 1. web/src/pages/SettingsPage.tsx
- 删除 `import OpenAIProviderSection`
- 从 `VALID_TABS` / `SYSTEM_TABS` 中删除 `'openai'`
- 删除条件渲染 `OpenAIProviderSection` 的分支
- 删除标题映射中的 `openai: 'OpenAI 提供商'`

### 2. web/src/components/settings/SettingsNav.tsx
- 删除 `{ key: 'openai', label: 'OpenAI 提供商', ... }` 导航项

### 3. web/src/components/settings/SystemSettingsSection.tsx
- 删除 `autoSwitchToOpenAIOnRateLimit` 相关 state 声明、加载逻辑、保存逻辑、UI 控件和文案

### 4. web/src/components/settings/types.ts
- 删除 `autoSwitchToOpenAIOnRateLimit: boolean` 字段
- 从 `SettingsTab` 类型中删除 `'openai'`（如果有的话）

### 5. web/src/stores/usage.ts
- 删除 `OpenAIRateWindow`、`OpenAICredits`、`OpenAIAccountData`、`OpenAIAccountResponse` 类型
- 删除 `openaiAccount*` 状态字段
- 删除 `loadOpenAIAccount()` 方法
- 删除 `/api/usage/openai-subscription` API 调用

### 6. web/src/pages/UsagePage.tsx
- 删除 `OpenAIRateWindow` import
- 删除 `formatPlanType()`（ChatGPT 计划映射）
- 删除 `OpenAIRateWindowRow` 组件
- 删除 `OpenAISubscriptionUsageCard` 组件
- 删除页面中渲染该卡片的部分

### 7. web/src/components/chat/ContainerEnvPanel.tsx
- 删除 `OPENAI_MODEL_ENV_KEY`、`OPENAI_MODEL_PRESETS`、`OPENAI_REASONING_EFFORT_KEY`、`OPENAI_REASONING_SUMMARY_KEY` 常量
- 删除提供商切换 UI（`'claude' | 'openai'` 按钮组）
- 删除 `handleProviderChange` 相关逻辑
- 删除 OpenAI 特有字段（模型选择、推理深度、推理摘要）
- 添加迁移提示横幅：当 `group.llm_provider === 'openai'` 时显示黄色 warning，告知"OpenAI 提供商已移除，此工作区已自动切换为 Claude"，附"确认切换"按钮调用 `PATCH /api/groups/:jid { llm_provider: 'claude' }`

### 8. web/src/components/settings/FeishuChannelCard.tsx
- 删除 `imCommentaryUseGpt?: boolean` 接口字段
- 删除 `hasGptProvider?: boolean` 接口字段
- 删除 `savingImCommentaryUseGpt` state
- 删除"使用 GPT 生成解说"toggle UI 及相关 API 调用

验证：`cd web && npx tsc --noEmit`

Commit: `清理: 移除前端所有 OpenAI 相关 UI 和状态（Phase 1 Group D）`

---

## Group E: 更新 Makefile

编辑 `Makefile`：
- 删除 `npm --prefix container/agent-runner-openai run build`（build 目标）
- 删除 `npm --prefix container/agent-runner-openai install` 和 `npm --prefix container/agent-runner-openai run build`（install 目标）
- 从 `@touch ...` 行中删除 `container/agent-runner-openai/node_modules`
- 删除 `rm -rf container/agent-runner-openai/dist`（clean 目标）

验证：`make typecheck && make build`

Commit: `清理: 从 Makefile 移除 agent-runner-openai 构建目标（Phase 1 Group E）`

---

## Group F: 最终验证 + 残留扫描

1. 运行 `make typecheck && make build`
2. 全局搜索残留引用（排除 docs/、node_modules/、dist/、*.md、package-lock.json）：
   ```bash
   grep -ri --include='*.ts' --include='*.tsx' --include='*.json' \
     'openai\|getOpenAIProvider\|GPT_\|gpt-client\|safety-hooks\|review-hooks\|review-context\|risk-rules\|CrossModel\|Delegate\|toOpenAITools\|toCodexTools' \
     src/ container/ web/src/ | grep -v node_modules | grep -v dist | grep -v '\.md'
   ```
3. 对找到的残留：清理或添加注释说明为何保留（如 `llm_provider` 类型联合用于向后兼容）
4. 如有修改：commit `清理: 清除 GPT/OpenAI 残留引用（Phase 1 Group F）`

当 `make typecheck && make build` 都通过且残留扫描干净，输出：

<promise>PHASE1_DONE</promise>
