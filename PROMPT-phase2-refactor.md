# Phase 2: SessionState + 模块提取 + ClaudeSession + Query Runner

## 你在做什么

你正在重构 `container/agent-runner/src/index.ts`（~1727 行 → ~200 行），通过提取模块来降低复杂度。这个 prompt 会被 Ralph Loop 反复喂给你。每次迭代，先用 `git log --oneline -20` 检查哪些 Step 已完成，然后从下一个未完成的 Step 继续。

## 前置条件

Phase 1（GPT 大清洗）必须完成。验证：`git log --oneline | grep "Phase 1"` 应该能看到 Group A-F 的 commits。如果没有，输出 "ERROR: Phase 1 not complete" 并停止。

## 设计参考

详细规格参见 `docs/design-agent-harness.md`：
- §3.2 SessionState
- §3.3 ClaudeSession
- §3.4 Context Builder
- §3.6 MCP Server
- §3.7 Hooks
- §4 目录结构变更
- §5 会话管理

## 进度追踪

用 commit message 中的 "Step N" 关键词判断是否已完成。

预期 commits（按顺序）：
- Step 1: 创建 session-state.ts
- Step 2: 创建 safety-lite.ts
- Step 3: 提取 image-utils.ts
- Step 4: 提取 ipc-handler.ts
- Step 5: 提取 transcript-archive.ts
- Step 6: 提取 context-builder.ts
- Step 7: 创建 claude-session.ts
- Step 8: 提取 query-runner.ts
- Step 9: 瘦身 index.ts

## 决策规则

1. 先跑 `git log --oneline -20`。如果某个 Step 的 commit 已存在，跳过。
2. 每个 Step 完成后跑 `make typecheck`。失败则修复后再 commit。
3. Steps 1-6（Phase 2a）可以顺序独立完成。
4. Steps 7-9（Phase 2b）依赖 Steps 1-6 完成。
5. 搬移代码时：**替换模块级变量访问为 SessionState 参数**，更新 index.ts 的 import。
6. 每步保持 index.ts 可编译。
7. Git commit message 使用简体中文，格式：`重构: ...（Phase 2 Step N）`

---

## Step 1: session-state.ts (~80 行)

创建 `container/agent-runner/src/session-state.ts`。

收敛 index.ts 中 5 个模块级变量为一个显式类：

```typescript
export class SessionState {
  // --- IM 渠道追踪 ---
  recentImChannels = new Set<string>();
  imChannelLastSeen = new Map<string, number>();
  private imPersistTimer: ReturnType<typeof setTimeout> | null = null;

  /** 从 .recent-im-channels.json 恢复 */
  loadImChannels(groupDir: string): void { /* 从 index.ts 搬入 loadPersistedImChannels 逻辑 */ }

  /** 防抖持久化到磁盘 */
  schedulePersistImChannels(groupDir: string): void { /* 从 index.ts 搬入 */ }

  /** 从 source="..." 提取渠道并更新 lastSeen */
  extractSourceChannels(text: string): void { /* 从 index.ts 搬入 extractSourceChannels 逻辑 */ }

  /** 返回活跃渠道列表（24h TTL 过滤） */
  getActiveImChannels(): string[] { /* 从 index.ts 搬入，基于 imChannelLastSeen 过滤 */ }

  // --- 权限 ---
  currentPermissionMode: PermissionMode = 'bypassPermissions';

  // --- 中断追踪 ---
  lastInterruptRequestedAt = 0;
}
```

然后更新 index.ts：
- 在 main() 中创建 `const state = new SessionState()`
- **在 index.ts 原地**将访问这 5 个模块级变量的函数改为接收 `state: SessionState` 参数
- 删除 5 个模块级变量声明
- 确保编译通过

**重要**：先在 index.ts 原地改签名（编译通过），后续 Step 再搬移函数到新文件。

验证：`cd container/agent-runner && npx tsc --noEmit`

Commit: `重构: 提取 SessionState 收敛 5 个模块级变量（Phase 2 Step 1）`

---

## Step 2: safety-lite.ts (~40 行)

创建 `container/agent-runner/src/safety-lite.ts`——全新文件，替代已删除的 GPT gatekeeper。

```typescript
const DANGEROUS_PATTERNS = [
  /rm\s+-rf\s+\/(?!tmp|workspace)/,
  /DROP\s+(DATABASE|TABLE)\s/i,
  />\s*\/dev\/sd/,
  /mkfs\./,
  /:\(\)\{ :\|:& \};:/,
];

export function createSafetyLiteHook(): HookCallback {
  return async ({ tool_name, tool_input }) => {
    if (tool_name !== 'Bash') return { decision: 'approve' };
    const cmd = typeof tool_input?.command === 'string' ? tool_input.command : '';
    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(cmd)) {
        return { decision: 'deny', reason: `Safety-lite blocked: ${pattern}` };
      }
    }
    return { decision: 'approve' };
  };
}
```

更新 index.ts 的 hooks 配置：添加 `PreToolUse: isHostMode ? [{ hooks: [createSafetyLiteHook()] }] : []`。
`isHostMode` 通过环境变量 `HAPPYCLAW_HOST_MODE` 判断。

验证：`cd container/agent-runner && npx tsc --noEmit`

Commit: `重构: 新增 safety-lite hook 替代已删除的 GPT gatekeeper（Phase 2 Step 2）`

---

## Step 3: image-utils.ts

从 index.ts 提取图片处理函数：
- `resolveImageMimeType()`
- `getImageDimensions()`
- `filterOversizedImages()`

纯工具函数，无共享状态依赖。直接剪切-粘贴 + 添加 import/export。

验证：`cd container/agent-runner && npx tsc --noEmit`

Commit: `重构: 提取 image-utils 模块（Phase 2 Step 3）`

---

## Step 4: ipc-handler.ts

从 index.ts 提取 IPC 处理函数（**使用 index.ts 的本地实现，不使用 core/ipc.ts 版本**）：
- `shouldClose()`
- `shouldDrain()`
- `shouldInterrupt()`
- `drainIpcInput()`
- `waitForIpcMessage()`

这些函数需要 SessionState 参数（用于中断宽限期追踪 `lastInterruptRequestedAt`）。

另外提取中断相关辅助函数：
- `isInterruptRelatedError()`
- `markInterruptRequested()` / `clearInterruptRequested()`

验证：`cd container/agent-runner && npx tsc --noEmit`

Commit: `重构: 提取 ipc-handler 模块（Phase 2 Step 4）`

---

## Step 5: transcript-archive.ts

从 index.ts 提取对话归档相关：
- `createPreCompactHook()` — PreCompact hook 创建函数
- `parseTranscript()` — 解析 SDK transcript JSON
- `formatTranscriptMarkdown()` — 格式化为 Markdown

index.ts 改为 import `createPreCompactHook` 并传入 hooks 配置。

验证：`cd container/agent-runner && npx tsc --noEmit`

Commit: `重构: 提取 transcript-archive 模块（Phase 2 Step 5）`

---

## Step 6: context-builder.ts

从 index.ts 提取系统 prompt 构建：

```typescript
export interface ContextBuilderInput {
  state: SessionState;
  containerInput: ContainerInput;
  groupDir: string;
  globalDir: string;
  memoryDir: string;
}

/** 返回拼接好的 systemPrompt.append 字符串 */
export function buildSystemPromptAppend(input: ContextBuilderInput): string;

/** 单独导出，供 compact_boundary 后重新注入路由提醒 */
export function buildChannelRoutingReminder(activeChannels: string[]): string;
```

同时搬入以下内部函数：
- `readMemoryIndex()`
- `readPersonality()`
- `buildMemoryRecallPrompt()`
- 所有静态指引字符串（作为模块级常量）

拼接顺序（8 个段落）：
1. globalClaudeMd（仅 isHome）
2. contextSummary
3. interactionGuidelines
4. channelRoutingGuidelines（含动态 activeImChannels）
5. memoryRecall
6. outputGuidelines
7. webFetchGuidelines
8. backgroundTaskGuidelines

验证：`cd container/agent-runner && npx tsc --noEmit`

Commit: `重构: 提取 context-builder 模块（Phase 2 Step 6）`

---

## Step 7: claude-session.ts (~120 行)

创建 `container/agent-runner/src/claude-session.ts`。

封装 Claude Agent SDK 的完整查询生命周期：

```typescript
export interface ClaudeSessionConfig {
  sessionId?: string;
  resumeAt?: string;
  cwd: string;
  additionalDirectories?: string[];
  model?: string;
  permissionMode?: PermissionMode;
  allowedTools?: string[];
  disallowedTools?: string[];
  systemPromptAppend: string;
  isHostMode: boolean;
  isHome: boolean;
  isAdminHome: boolean;
  groupFolder: string;
  userId?: string;
}

export class ClaudeSession {
  private stream: MessageStream | null = null;
  private queryRef: QueryRef | null = null;

  async *run(config: ClaudeSessionConfig, mcpServers: Record<string, unknown>): AsyncIterable<SDKMessage> {
    // 每次 run() 重建 stream
    // 组装 hooks：PreCompact（始终）+ safety-lite（仅 host 模式）
    // 调用 query() with SDK options
    // yield SDK 原始消息
  }

  pushMessage(text: string, images?: ImageData[]): string[] { ... }
  async setPermissionMode(mode: PermissionMode): Promise<void> { ... }
  async interrupt(): Promise<void> { ... }
  end(): void { ... }
}
```

关键决策：
- `run()` 直接 yield Claude SDK 原始消息，不包装
- hooks/MCP 组装内化到 ClaudeSession
- `loadUserMcpServers()` 保留在 index.ts（protocol-bridge），由 main() 组装后传入
- MessageStream 每次 run() 重建

更新 index.ts：用 `ClaudeSession.run()` 替换内联的 `query()` 调用。

验证：`cd container/agent-runner && npx tsc --noEmit`

Commit: `重构: 提取 ClaudeSession 封装 SDK 查询生命周期（Phase 2 Step 7）`

---

## Step 8: query-runner.ts (~460 行)

从 index.ts 提取 runQuery 函数体，拆为 3 个函数：

### runQuery()（编排，~80 行）
- 接收 ClaudeSession + SessionState + 业务参数
- 调用 context-builder 生成 systemPromptAppend
- 启动 IPC poller
- 调用 processMessages
- 错误恢复（上下文溢出重试、不可恢复 transcript 检测）
- 返回 QueryResult

### processMessages()（消息循环，~300 行）
- for-await 遍历 SDK 消息流
- 分发给 stream-processor
- 追踪 UUID（lastAssistantUuid, lastResumeUuid）
- 处理系统消息（compact_boundary → 重新注入路由提醒）
- **activity watchdog**（5 min 无事件 → 强制中断；20 min 工具超时 → 强制中断）
- 后台任务协调

### createIpcPoller()（轮询闭包，~80 行）
- 每 500ms 检查哨兵
- 排空 IPC 输入
- 处理 `set_mode` 权限切换
- 推送消息到 session

返回类型：
```typescript
interface QueryResult {
  newSessionId?: string;
  lastAssistantUuid?: string;
  lastResumeUuid?: string;
  closedDuringQuery: boolean;
  contextOverflow?: boolean;
  unrecoverableTranscriptError?: boolean;
  interruptedDuringQuery: boolean;
  sessionResumeFailed?: boolean;
  drainDetectedDuringQuery?: boolean;
}
```

验证：`cd container/agent-runner && npx tsc --noEmit`

Commit: `重构: 提取 query-runner 模块（runQuery/processMessages/createIpcPoller）（Phase 2 Step 8）`

---

## Step 9: 瘦身 index.ts (~200 行)

index.ts 此时应该只包含：
- `main()` 函数
- 查询循环编排（在 loop 中调用 runQuery，处理查询间 IPC）
- 信号处理器（SIGTERM, SIGINT, EPIPE, uncaughtException, unhandledRejection）
- `loadUserMcpServers()`（读宿主机文件系统）
- stdin 解析 + OUTPUT_MARKER stdout 写入
- `writeOutput()` / `log()` 工具函数

清理步骤：
1. 删除所有已迁移但仍残留在 index.ts 中的代码
2. 删除所有模块级 `let` 变量——编译器会报错指出遗漏
3. 确保 sessionId / lastAssistantUuid / lastResumeUuid 是 main() 的局部变量
4. 验证最终行数 ~200 行

验证：
```bash
make typecheck && make build
wc -l container/agent-runner/src/index.ts  # 应该 ~200 行
```

Commit: `重构: 瘦身 index.ts 为纯入口 + protocol bridge（Phase 2 Step 9）`

---

## 完成信号

当满足以下条件时输出完成标记：
1. `make typecheck && make build` 都通过
2. `container/agent-runner/src/index.ts` 约 200 行
3. 所有 9 个 Step 的 commit 都存在

<promise>PHASE2_DONE</promise>
