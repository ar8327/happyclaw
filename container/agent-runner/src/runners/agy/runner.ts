/**
 * AgyRunner — Antigravity CLI (agy) 的 AgentRunner 实现。
 *
 * 特性与约束：
 * - print 模式逐轮调用：每轮 spawn 一次 `agy --print=...`，用
 *   `--conversation <uuid>` 续接（resume 锚点 = 会话 UUID）
 * - stdout 只有助手文本（无结构化事件流）→ 只产生 text_delta
 * - 系统提示词写入会话 HOME 的 ~/.gemini/GEMINI.md（全局规则，
 *   每次运行重新读取，不膨胀会话历史）
 * - 工具经全局 mcp_config.json 注入（stdio MCP，内含 happyclaw 内置 server）
 * - agy 偶发启动期死挂（无任何输出/日志）：内置活性看门狗，
 *   未产生任何输出且未创建会话时自动重试一次
 */

import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { normalizeHomeFlags } from 'agentdock-agent-runner-core';

import type {
  ActivityReport,
  AgentRunner,
  IpcCapabilities,
  NormalizedMessage,
  QueryConfig,
  QueryResult,
  RenderedRunnerContext,
  RuntimePersistenceSnapshot,
  PushMessageResult,
} from '../../runner-interface.js';
import { combineRenderedContext } from '../../runner-interface.js';
import type { ContainerInput, ContainerOutput } from '../../types.js';
import type { SessionState } from '../../session-state.js';
import type { IpcPaths } from '../../ipc-handler.js';
import { saveImagesToTempFiles } from '../codex/image-utils.js';
import {
  latestAgyActivityMs,
  prepareAgyHome,
  readAgyConversationId,
  toAgyMcpServer,
  writeAgyMcpConfig,
  writeAgyRules,
} from './agy-env.js';
import { AgyArchiveManager } from './archive.js';
import { estimateAgyContextTokens } from './context-tracker.js';

export interface AgyRunnerOptions {
  containerInput: ContainerInput;
  state: SessionState;
  ipcPaths: IpcPaths;
  log: (msg: string) => void;
  writeOutput: (output: ContainerOutput) => void;
  imChannelsFile: string;
  groupDir: string;
  globalDir: string;
  memoryDir: string;
  model: string;
  command?: string;
  loadUserMcpServers: () => Record<string, unknown>;
  skillsDir: string;
  builtinMcpServerName?: string;
  /** 上下文估算超过该 tokens 数即触发合成压缩；0 = 关闭 */
  compactThresholdTokens?: number;
  disableSyntheticArchive?: boolean;
}

/** 单轮结束后的内部结论。 */
interface TurnOutcome {
  conversationId: string | null;
  finalText: string | null;
  gotOutput: boolean;
  stalled: boolean;
  interrupted: boolean;
  exitCode: number | null;
  errorText: string;
}

class MessageQueue {
  private readonly items: NormalizedMessage[] = [];
  private waiter: ((value: IteratorResult<NormalizedMessage>) => void) | null =
    null;
  private closed = false;

  push(item: NormalizedMessage): void {
    if (this.closed) return;
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve({ done: false, value: item });
      return;
    }
    this.items.push(item);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve({ done: true, value: undefined });
    }
  }

  next(): Promise<IteratorResult<NormalizedMessage>> {
    if (this.items.length > 0) {
      return Promise.resolve({ done: false, value: this.items.shift()! });
    }
    if (this.closed) {
      return Promise.resolve({ done: true, value: undefined });
    }
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }
}

const DEFAULT_STALL_TIMEOUT_MS = 180_000;
const DEFAULT_PRINT_IDLE_TIMEOUT = '30m';
const STDERR_TAIL_LIMIT = 64 * 1024;
export const DEFAULT_COMPACT_THRESHOLD_TOKENS = 250_000;

function stallTimeoutMs(): number {
  const raw = Number(process.env.HAPPYCLAW_AGY_STALL_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_STALL_TIMEOUT_MS;
}

function looksLikeResumeFailure(text: string): boolean {
  return /conversation\s+\S+\s+not found|failed to (?:get|load|resume) conversation|unknown (?:base )?trajectory/i.test(
    text,
  );
}

function looksLikeAuthFailure(text: string): boolean {
  return /authentication failed|not logged in(?:to)? antigravity/i.test(text);
}

/**
 * agy print 模式无法直接附带图片（内部协议支持 media，但 CLI 无入口）。
 * 退路：图片落盘为本地文件，提示词里给出绝对路径，由 agent 用自带的
 * 文件查看工具读取（实测可正确识别图片内容，含工作区外绝对路径）。
 */
function appendImageAttachmentNote(prompt: string, paths: string[]): string {
  return [
    prompt,
    '',
    `[系统附注] 本条消息附带 ${paths.length} 张图片，已保存为本地文件。请先用你的文件查看工具逐一查看图片内容，再回答本条消息：`,
    ...paths.map((p, i) => `${i + 1}. ${p}`),
  ].join('\n');
}

export class AgyRunner implements AgentRunner {
  readonly ipcCapabilities: IpcCapabilities = {
    supportsMidQueryPush: false,
    supportsRuntimeModeSwitch: false,
  };

  private readonly opts: AgyRunnerOptions;
  private homeDir!: string;
  private tmpDir!: string;
  private activeChild: ChildProcess | null = null;
  private activeStartedAt = 0;
  private interrupted = false;
  private renderedContext: RenderedRunnerContext | null = null;
  private turnCounter = 0;
  private attachmentBatch = 0;
  private lastConversationId: string | null = null;
  private readonly archiveMgr = new AgyArchiveManager();
  private pendingContinuationSummary: string | null = null;
  private pendingSessionReset = false;
  private pendingWrapup = false;

  constructor(opts: AgyRunnerOptions) {
    this.opts = opts;
  }

  async initialize(): Promise<void> {
    const { containerInput, groupDir, globalDir, memoryDir } = this.opts;
    const { isHome, isAdminHome } = normalizeHomeFlags(containerInput);

    this.homeDir =
      process.env.HAPPYCLAW_AGY_HOME ||
      fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-agy-home-'));
    prepareAgyHome(this.homeDir);
    this.tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-agy-'));

    const persisted = this.opts.state.getProviderState<{
      activeConversationId?: unknown;
      archiveState?: Record<string, unknown>;
      pendingContinuationSummary?: unknown;
    }>();
    if (typeof persisted?.activeConversationId === 'string') {
      this.lastConversationId = persisted.activeConversationId;
    }
    if (!this.opts.disableSyntheticArchive) {
      this.archiveMgr.hydrate(persisted?.archiveState);
      if (
        typeof persisted?.pendingContinuationSummary === 'string' &&
        persisted.pendingContinuationSummary.trim().length > 0
      ) {
        this.pendingContinuationSummary = persisted.pendingContinuationSummary;
      }
    }

    const mcpServerPath = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      '../../happyclaw-mcp-server.js',
    );
    const mcpEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === 'string') mcpEnv[key] = value;
    }
    Object.assign(mcpEnv, {
      HAPPYCLAW_WORKSPACE_GROUP: groupDir,
      HAPPYCLAW_WORKSPACE_GLOBAL: globalDir,
      HAPPYCLAW_WORKSPACE_MEMORY: memoryDir,
      HAPPYCLAW_WORKSPACE_IPC: this.opts.ipcPaths.inputDir.replace(
        '/input',
        '',
      ),
      HAPPYCLAW_GROUP_FOLDER: containerInput.groupFolder,
      HAPPYCLAW_CHAT_JID: containerInput.chatJid,
      HAPPYCLAW_USER_ID: containerInput.userId || '',
      HAPPYCLAW_IS_HOME: isHome ? '1' : '0',
      HAPPYCLAW_IS_ADMIN_HOME: isAdminHome ? '1' : '0',
    });

    const servers: Record<string, unknown> = {
      [this.opts.builtinMcpServerName || 'agentdock']: {
        command: process.execPath,
        args: [mcpServerPath],
        env: mcpEnv,
      },
    };
    for (const [name, entry] of Object.entries(
      this.opts.loadUserMcpServers(),
    )) {
      if (servers[name]) continue;
      const mapped = toAgyMcpServer(entry);
      if (mapped) {
        servers[name] = mapped;
      } else {
        this.opts.log(`Agy: 跳过不支持的用户 MCP server 配置 ${name}`);
      }
    }
    writeAgyMcpConfig(this.homeDir, servers);
    this.opts.log(
      `Agy runner 初始化完成: home=${this.homeDir}, mcpServers=${Object.keys(servers).join(',')}`,
    );
  }

  async applyContext(context: RenderedRunnerContext): Promise<void> {
    this.renderedContext = context;
  }

  async *runQuery(
    config: QueryConfig,
  ): AsyncGenerator<NormalizedMessage, QueryResult> {
    writeAgyRules(
      this.homeDir,
      this.renderedContext
        ? combineRenderedContext(this.renderedContext)
        : config.systemPrompt,
    );
    const resumeTarget = config.resumeAt || config.sessionId || undefined;
    let effectivePrompt = config.prompt;
    if (!resumeTarget && this.pendingContinuationSummary) {
      effectivePrompt = [
        '[系统附注] 前一段对话因上下文过长已自动归档压缩，以下是延续摘要，请基于它继续：',
        this.pendingContinuationSummary,
        '',
        '---',
        '',
        effectivePrompt,
      ].join('\n');
      this.opts.log(
        `Agy: 新会话注入延续摘要 (${this.pendingContinuationSummary.length} chars)`,
      );
    }
    if (config.images && config.images.length > 0) {
      const imagesDir = path.join(
        this.tmpDir,
        `images-${++this.attachmentBatch}`,
      );
      fs.mkdirSync(imagesDir, { recursive: true });
      const imagePaths = saveImagesToTempFiles(config.images, imagesDir);
      effectivePrompt = appendImageAttachmentNote(config.prompt, imagePaths);
      this.opts.log(
        `Agy: ${imagePaths.length} 张图片已落盘为本地文件，提示词转交 agent 查看`,
      );
    }

    const maxAttempts = 2;
    let outcome: TurnOutcome | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      outcome = yield* this.runTurn(effectivePrompt, resumeTarget);
      const retriable =
        outcome.stalled &&
        !outcome.gotOutput &&
        !outcome.conversationId &&
        !outcome.interrupted;
      if (retriable && attempt < maxAttempts) {
        this.opts.log(
          `Agy 启动期死挂（无输出无会话），重试 ${attempt}/${maxAttempts - 1}`,
        );
        yield {
          kind: 'stream_event',
          event: {
            eventType: 'status',
            statusText: 'Antigravity CLI 无响应，正在重试…',
          },
        };
        continue;
      }
      break;
    }

    const result: QueryResult = {
      closedDuringQuery: false,
      interruptedDuringQuery: outcome!.interrupted,
      drainDetectedDuringQuery: false,
    };
    const conversationId = outcome!.conversationId;
    if (conversationId) {
      this.lastConversationId = conversationId;
      yield { kind: 'session_init', sessionId: conversationId };
      yield { kind: 'resume_anchor', anchor: conversationId };
      result.newSessionId = conversationId;
      result.resumeAnchor = conversationId;
      // agy 对未知 --conversation 会静默新建会话（不报错），
      // 这里显式提示上下文已重置，避免用户无感知丢失历史
      if (resumeTarget && conversationId !== resumeTarget) {
        this.opts.log(
          `Agy 会话 ${resumeTarget} 不存在，已静默重建为 ${conversationId}`,
        );
        yield {
          kind: 'stream_event',
          event: {
            eventType: 'status',
            statusText:
              'Antigravity 原会话不存在，已重新开始新会话（上下文已重置）',
          },
        };
      }
    }

    if (!outcome!.interrupted) {
      const failureText = outcome!.errorText;
      if (outcome!.stalled) {
        const message = `Antigravity CLI 卡死（${Math.round(stallTimeoutMs() / 1000)}s 无任何活动），已终止本轮`;
        yield { kind: 'error', message, recoverable: false };
        result.genericError = message;
      } else if (outcome!.exitCode !== 0) {
        if (resumeTarget && looksLikeResumeFailure(failureText)) {
          yield {
            kind: 'error',
            message: `Agy 会话 ${resumeTarget} 恢复失败，将重建会话`,
            recoverable: true,
            errorType: 'session_resume_failed',
          };
          result.sessionResumeFailed = true;
        } else {
          const message = looksLikeAuthFailure(failureText)
            ? 'Antigravity CLI 未登录或认证过期，请在宿主机运行 agy 完成登录'
            : `Antigravity CLI 退出异常 (code=${outcome!.exitCode})${failureText ? `: ${failureText.slice(0, 500)}` : ''}`;
          yield { kind: 'error', message, recoverable: false };
          result.genericError = message;
        }
      } else {
        yield { kind: 'result', text: outcome!.finalText };
        if (
          !resumeTarget &&
          conversationId &&
          this.pendingContinuationSummary
        ) {
          // 摘要已随首条消息进入新会话历史，后续轮次无需重复注入
          this.pendingContinuationSummary = null;
        }
        if (!this.opts.disableSyntheticArchive) {
          yield* this.maybeCompact(conversationId);
        }
      }
    }
    return result;
  }

  /**
   * 成功轮次后的合成压缩检查：估算上下文，超阈值则 session_wrapup 归档，
   * 成功后丢弃 resume 锚点（query-loop 经 sessionControl 清除），
   * 下一轮开新会话并注入延续摘要。
   */
  private async *maybeCompact(
    conversationId: string | null,
  ): AsyncGenerator<NormalizedMessage> {
    const threshold =
      this.opts.compactThresholdTokens ?? DEFAULT_COMPACT_THRESHOLD_TOKENS;
    const estimate = conversationId
      ? await estimateAgyContextTokens(
          this.homeDir,
          conversationId,
          this.tmpDir,
        )
      : null;
    this.archiveMgr.recordTurn(estimate?.tokens);
    if (estimate) {
      this.opts.log(
        `Agy 上下文估算: ~${estimate.tokens} tokens (${estimate.method}), 压缩阈值 ${threshold > 0 ? threshold : '关闭'}`,
      );
    }
    if (threshold <= 0 || !estimate || estimate.tokens < threshold) return;
    yield {
      kind: 'stream_event',
      event: {
        eventType: 'lifecycle',
        phase: 'compact_started',
        trigger: 'synthetic_threshold',
        statusText: `context ~${estimate.tokens} tokens >= ${threshold}`,
      },
    };
    yield {
      kind: 'stream_event',
      event: { eventType: 'lifecycle', phase: 'archive_started' },
    };

    this.pendingWrapup = true;
    let response;
    try {
      response = await this.archiveMgr.archiveForCompact(
        this.opts.containerInput.groupFolder,
        this.opts.containerInput.userId || undefined,
      );
    } finally {
      this.pendingWrapup = false;
    }

    this.pendingContinuationSummary =
      response?.continuationSummary?.trim() ||
      this.opts.state.getContextSummary()?.trim() ||
      null;
    this.opts.state.setContextSummary(this.pendingContinuationSummary);
    this.pendingSessionReset = true;
    this.lastConversationId = null;
    yield {
      kind: 'stream_event',
      event: {
        eventType: 'lifecycle',
        phase: 'compact_completed',
        repairHints: {
          recentImChannels: this.opts.state.getActiveImChannels(),
        },
      },
    };
    yield {
      kind: 'stream_event',
      event: {
        eventType: 'lifecycle',
        phase: 'archive_completed',
        statusText: response?.success
          ? this.pendingContinuationSummary
            ? 'agy_synthetic_compact_completed'
            : 'agy_synthetic_compact_completed_no_summary'
          : 'agy_synthetic_compact_completed_wrapup_deferred',
        archivedFolders: response?.success
          ? [this.opts.containerInput.groupFolder]
          : undefined,
        transcriptFiles: [
          response?.conversationArchiveFile,
          response?.transcriptFile,
        ].filter(
          (file): file is string =>
            typeof file === 'string' && file.trim().length > 0,
        ),
      },
    };
    this.opts.log(
      `Agy 合成压缩完成: 下一轮将开启新会话${response?.success ? '' : '，归档继续由后台补偿'}`,
    );
  }

  /** 跑一轮 agy print，流式产出 text_delta，返回内部结论。 */
  private async *runTurn(
    prompt: string,
    resumeTarget: string | undefined,
  ): AsyncGenerator<NormalizedMessage, TurnOutcome> {
    const logFile = path.join(this.tmpDir, `turn-${++this.turnCounter}.log`);
    const args = [
      `--print=${prompt}`,
      '--dangerously-skip-permissions',
      '--print-timeout',
      DEFAULT_PRINT_IDLE_TIMEOUT,
      '--log-file',
      logFile,
      '--add-dir',
      this.opts.globalDir,
      '--add-dir',
      this.opts.memoryDir,
    ];
    if (this.opts.model) args.push('--model', this.opts.model);
    if (resumeTarget) args.push('--conversation', resumeTarget);

    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === 'string') env[key] = value;
    }
    env.HOME = this.homeDir;

    const child = spawn(this.opts.command || 'agy', args, {
      cwd: this.opts.groupDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.activeChild = child;
    this.activeStartedAt = Date.now();
    this.interrupted = false;

    const queue = new MessageQueue();
    let finalText = '';
    let stderrTail = '';
    let gotOutput = false;
    let stalled = false;
    let exitCode: number | null = null;
    let spawnError: string | null = null;
    let lastActivity = Date.now();

    child.stdout!.setEncoding('utf-8');
    child.stdout!.on('data', (chunk: string) => {
      gotOutput = true;
      lastActivity = Date.now();
      finalText += chunk;
      queue.push({
        kind: 'stream_event',
        event: { eventType: 'text_delta', text: chunk },
      });
    });
    child.stderr!.setEncoding('utf-8');
    child.stderr!.on('data', (chunk: string) => {
      lastActivity = Date.now();
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
    });
    child.once('error', (err) => {
      spawnError = err.message;
      queue.close();
    });
    child.once('close', (code) => {
      exitCode = code;
      queue.close();
    });

    const timeoutMs = stallTimeoutMs();
    const watchdog = setInterval(() => {
      const external = latestAgyActivityMs(logFile, this.homeDir);
      if (external > lastActivity) lastActivity = external;
      if (Date.now() - lastActivity > timeoutMs) {
        stalled = true;
        clearInterval(watchdog);
        this.opts.log(
          `Agy watchdog: ${Math.round(timeoutMs / 1000)}s 无活动，SIGKILL`,
        );
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }
    }, 5_000);

    try {
      while (true) {
        const next = await queue.next();
        if (next.done) break;
        yield next.value;
      }
    } finally {
      clearInterval(watchdog);
      this.activeChild = null;
      this.activeStartedAt = 0;
    }

    const conversationId = readAgyConversationId(
      logFile,
      this.homeDir,
      this.opts.groupDir,
    );
    const trimmedText = finalText.trim();
    const errorText = [
      spawnError,
      stderrTail.trim(),
      exitCode !== 0 ? trimmedText : '',
    ]
      .filter(Boolean)
      .join('\n');

    return {
      conversationId,
      finalText: trimmedText.length > 0 ? trimmedText : null,
      gotOutput,
      stalled,
      interrupted: this.interrupted,
      exitCode: spawnError ? (exitCode ?? 1) : exitCode,
      errorText,
    };
  }

  async pushMessage(): Promise<PushMessageResult> {
    return {
      status: 'buffer',
      reason: 'agy print 模式不支持运行中追加消息，消息将在下一轮送达',
    };
  }

  async interrupt(): Promise<void> {
    const child = this.activeChild;
    if (!child) return;
    this.interrupted = true;
    try {
      child.kill('SIGINT');
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      try {
        if (child.exitCode === null && !child.killed) child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, 3_000).unref();
  }

  getActivityReport(): ActivityReport {
    return {
      hasActiveToolCall: false,
      activeToolDurationMs:
        this.activeStartedAt > 0 ? Date.now() - this.activeStartedAt : 0,
      hasPendingBackgroundTasks:
        this.activeChild !== null || this.pendingWrapup,
    };
  }

  getRuntimePersistenceSnapshot(): RuntimePersistenceSnapshot {
    const providerState: Record<string, unknown> = {
      activeConversationId: this.lastConversationId,
    };
    if (!this.opts.disableSyntheticArchive) {
      providerState.archiveState = this.archiveMgr.snapshot();
      if (this.pendingContinuationSummary) {
        providerState.pendingContinuationSummary =
          this.pendingContinuationSummary;
      }
    }
    return {
      providerState,
      lastMessageCursor: this.lastConversationId,
      ...(this.pendingSessionReset
        ? {
            sessionControl: {
              clearProviderSession: true,
              clearResumeAnchor: true,
            },
          }
        : {}),
    };
  }

  async betweenQueries(): Promise<void> {
    // sessionControl 的 clear 标记只对本轮 turn 边界生效一次
    this.pendingSessionReset = false;
  }

  async cleanup(): Promise<void> {
    if (!this.opts.disableSyntheticArchive) {
      await this.archiveMgr.forceArchive(
        this.opts.containerInput.groupFolder,
        this.opts.containerInput.userId || undefined,
      );
    }
    const child = this.activeChild;
    if (child) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      this.activeChild = null;
    }
    try {
      fs.rmSync(this.tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}
