/**
 * AgentRunner interface — the core abstraction for multi-provider support.
 *
 * query-loop interacts with any provider (Claude, Codex, future) through
 * this interface. All SDK-specific logic stays inside provider implementations.
 */

import type { StreamEvent } from './types.js';

// ─── 归一化消息类型 ─────────────────────────────────────

/**
 * Provider SDK 消息归一化后的统一表示。
 * query-loop 只看这个类型，不看 Claude/Codex 原始消息。
 */
export type NormalizedMessage =
  | { kind: 'stream_event'; event: StreamEvent }
  | { kind: 'session_init'; sessionId: string }
  | { kind: 'result'; text: string | null; usage?: UsageInfo }
  | {
      kind: 'error';
      message: string;
      recoverable: boolean;
      errorType?: 'context_overflow' | 'unrecoverable_transcript' | 'session_resume_failed';
    }
  | { kind: 'resume_anchor'; anchor: string };

export interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD: number;
  durationMs: number;
  numTurns: number;
  modelUsage?: Record<string, { inputTokens: number; outputTokens: number; costUSD: number }>;
}

// ─── Query 配置 ─────────────────────────────────────────

export interface QueryConfig {
  prompt: string;
  sessionId?: string;
  resumeAt?: string;
  images?: Array<{ data: string; mimeType?: string }>;
  permissionMode?: string;
}

// ─── Query 结果 ─────────────────────────────────────────

export interface QueryResult {
  newSessionId?: string;
  /** Provider-specific 的 resume 锚点（Claude: uuid，Codex: threadId） */
  resumeAnchor?: string;
  closedDuringQuery: boolean;
  interruptedDuringQuery: boolean;
  drainDetectedDuringQuery: boolean;
  contextOverflow?: boolean;
  unrecoverableTranscriptError?: boolean;
  sessionResumeFailed?: boolean;
}

// ─── 活性报告（用于 query-loop 的看门狗）───────────────

/**
 * Provider 向 query-loop 报告当前活动状态。
 * query-loop 据此决定是否重置/跳过活性超时。
 */
export interface ActivityReport {
  /** 是否有活跃的工具调用正在执行 */
  hasActiveToolCall: boolean;
  /** 当前工具调用已持续时间 (ms)，无活跃调用时为 0 */
  activeToolDurationMs: number;
  /** 是否有后台任务仍在运行 */
  hasPendingBackgroundTasks: boolean;
}

// ─── IPC 交互能力 ───────────────────────────────────────

export interface IpcCapabilities {
  /** 能否向活跃 query 中推送消息？Claude: true, Codex: false */
  supportsMidQueryPush: boolean;
  /** 能否运行时切换权限模式？Claude: true, Codex: false */
  supportsRuntimeModeSwitch: boolean;
}

export interface RuntimePersistenceSnapshot {
  providerState?: Record<string, unknown>;
  lastMessageCursor?: string | null;
}

// ─── Runner 接口 ────────────────────────────────────────

export interface AgentRunner {
  /** 返回此 provider 的 IPC 能力声明 */
  readonly ipcCapabilities: IpcCapabilities;

  /**
   * 初始化 runner（创建 SDK 实例、MCP 配置等）。
   * 在 query loop 开始前调用一次。
   */
  initialize(): Promise<void>;

  /**
   * 执行一次查询。
   *
   * 实现须：
   * 1. 将 prompt 发给 LLM
   * 2. 将 SDK 事件转为 NormalizedMessage yield 出去
   * 3. 在内部处理 provider-specific 逻辑（如 Claude 的 compact_boundary routing reminder）
   * 4. yield { kind: 'resume_anchor', anchor } 每当 resume 点更新
   * 5. 最终通过 generator return 返回 QueryResult
   *
   * query-loop 负责：重试、overflow 恢复、drain/close 退出、活性看门狗。
   */
  runQuery(config: QueryConfig): AsyncGenerator<NormalizedMessage, QueryResult>;

  /**
   * 向活跃查询推送后续消息（仅 supportsMidQueryPush=true 时有效）。
   * Codex 实现应将消息累积到 pendingMessages。
   * @returns 被拒绝的图片原因列表（空 = 全部通过）
   */
  pushMessage(text: string, images?: Array<{ data: string; mimeType?: string }>): string[];

  /** 中断当前查询 */
  interrupt(): Promise<void>;

  /** 设置权限模式（仅 supportsRuntimeModeSwitch=true 时有效） */
  setPermissionMode?(mode: string): Promise<void>;

  /**
   * 报告当前活动状态，供 query-loop 的活性看门狗决策。
   * 每次看门狗超时检查时调用。
   *
   * 默认实现（不覆盖时）：返回 { hasActiveToolCall: false, activeToolDurationMs: 0, hasPendingBackgroundTasks: false }
   */
  getActivityReport?(): ActivityReport;

  /**
   * 返回需要写回 session_state 的 provider/runtime 状态。
   * query-loop 会在关键边界统一回写，避免状态继续散落在 provider 内部。
   */
  getRuntimePersistenceSnapshot?(): RuntimePersistenceSnapshot;

  /**
   * 两次查询之间的清理 / 重建（如 Claude 的 MCP server rebuild）。
   * 每轮 query 结束后、下一轮开始前调用。
   */
  betweenQueries?(): Promise<void>;

  /** runner 退出前的资源清理（如 Codex 的 forceArchive）。 */
  cleanup?(): Promise<void>;
}
