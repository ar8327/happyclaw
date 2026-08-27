import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { type ChildProcessWithoutNullStreams } from 'child_process';
import { normalizeHomeFlags } from 'agentdock-agent-runner-core';

import type {
  ActivityReport,
  IpcCapabilities,
  NormalizedMessage,
  QueryConfig,
  RuntimePersistenceSnapshot,
  UsageInfo,
} from '../../runner-interface.js';
import type { ContainerInput, ContainerOutput } from '../../types.js';
import type { SessionState } from '../../session-state.js';
import type { IpcPaths } from '../../ipc-handler.js';
import {
  BaseCliRunner,
  type CliCommand,
  type CliInput,
  type CliRunnerAdapter,
} from '../base-cli-runner.js';
import { StreamEventProcessor } from '../claude/event-adapter.js';
import type { RunnerPromptContract } from '../../runner-descriptor.types.js';
import {
  filterOversizedImages,
  resolveImageMimeType,
} from '../../image-utils.js';
import { GrokEventNormalizer } from './event-adapter.js';
import {
  prepareGrokHome,
  writeGrokConfig,
  type GrokHookSpec,
} from './grok-env.js';
import { GROK_SHELL_TOOL_MATCHER } from './tool-names.js';

export interface GrokRunnerOptions {
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
  thinkingEffort?: string;
  command?: string;
  loadUserMcpServers: () => Record<string, unknown>;
  skillsDir: string;
  builtinMcpServerName?: string;
  toolScope?: 'default' | 'isolated' | 'read-only';
}

interface GrokRunnerProviderState extends Record<string, unknown> {
  currentSessionId?: unknown;
}

/** grok 支持的权限模式；happyclaw 传来的 claude 模式名不在表内时退回 bypass。 */
const GROK_PERMISSION_MODES = new Set([
  'default',
  'acceptEdits',
  'auto',
  'dontAsk',
  'bypassPermissions',
  'plan',
]);

/** 只读场景下允许的 grok 内建工具。 */
const READ_ONLY_TOOLS = ['read_file', 'grep', 'list_dir'];

/**
 * prompt 与 system prompt 都走命令行参数时会撞 ARG_MAX（macOS 约 1MB，
 * 含环境变量）。prompt 一律落文件；system prompt 没有文件通道，只能记日志
 * 提示，超长时由上游的上下文预算负责收敛。
 */
const SYSTEM_PROMPT_WARN_BYTES = 128 * 1024;
/** 内联图片超过这个体量就退回"落盘 + 文本引用"，避免命令行爆掉。 */
const INLINE_IMAGE_LIMIT_BYTES = 256 * 1024;

const MIME_EXTENSION_MAP: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
};

function stripDataUrlPrefix(base64Data: string): string {
  const match = base64Data.match(/^data:[^;]+;base64,(.+)$/);
  return match ? match[1] : base64Data;
}

function isContextOverflowError(msg: string): boolean {
  return [
    /prompt is too long/i,
    /maximum context length/i,
    /context.*too large/i,
    /exceeds.*token limit/i,
    /context window.*exceeded/i,
  ].some((pattern) => pattern.test(msg));
}

export function isGrokSessionResumeFailedError(msg: string): boolean {
  return [
    /session .*not found/i,
    /no session found/i,
    /conversation.*not found/i,
    /is already in use/i,
    /invalid.*resume/i,
  ].some((pattern) => pattern.test(msg));
}

function extractResultText(message: Record<string, unknown>): string | null {
  const result = message.result;
  return typeof result === 'string' ? result : null;
}

/**
 * grok 的 result.usage 与 Claude Code 同构（snake_case），modelUsage 内层是
 * camelCase，字段名逐一对齐后可直接复用 happyclaw 的用量口径。
 */
function usageFromResult(
  resultMessage: Record<string, unknown>,
  model: string,
): UsageInfo | undefined {
  const cliUsage = resultMessage.usage as Record<string, number> | undefined;
  if (!cliUsage) return undefined;

  const cliModelUsage = resultMessage.modelUsage as
    | Record<string, Record<string, number>>
    | undefined;
  const modelUsageSummary: Record<
    string,
    { inputTokens: number; outputTokens: number; costUSD: number }
  > = {};
  if (cliModelUsage && Object.keys(cliModelUsage).length > 0) {
    for (const [modelName, usage] of Object.entries(cliModelUsage)) {
      modelUsageSummary[modelName] = {
        inputTokens: usage.inputTokens || 0,
        outputTokens: usage.outputTokens || 0,
        costUSD: usage.costUSD || 0,
      };
    }
  } else {
    modelUsageSummary[model] = {
      inputTokens: cliUsage.input_tokens || 0,
      outputTokens: cliUsage.output_tokens || 0,
      costUSD: (resultMessage.total_cost_usd as number) || 0,
    };
  }

  return {
    inputTokens: cliUsage.input_tokens || 0,
    outputTokens: cliUsage.output_tokens || 0,
    cacheReadInputTokens: cliUsage.cache_read_input_tokens || 0,
    cacheCreationInputTokens: cliUsage.cache_creation_input_tokens || 0,
    costUSD: (resultMessage.total_cost_usd as number) || 0,
    durationMs: (resultMessage.duration_ms as number) || 0,
    numTurns: (resultMessage.num_turns as number) || 0,
    modelUsage:
      Object.keys(modelUsageSummary).length > 0 ? modelUsageSummary : undefined,
  };
}

class GrokCliAdapter implements CliRunnerAdapter {
  private readonly opts: GrokRunnerOptions;
  private readonly homeDir: string;
  private readonly tmpDir: string;
  private readonly imagesDir: string;
  private readonly mcpServerPath: string;
  private readonly hookHandlerPath: string;
  private readonly mcpServerEnv: Record<string, string>;
  private readonly streamEventQueue: NormalizedMessage[] = [];
  private processor: StreamEventProcessor | null = null;
  private normalizer = new GrokEventNormalizer();
  private currentSessionId: string | null = null;
  private lastMessageCursor: string | null = null;
  private rejectedImages: string[] = [];
  private toolCallStartedAt: number | null = null;
  private turnCounter = 0;

  constructor(opts: GrokRunnerOptions, tmpDir: string) {
    this.opts = opts;
    const { containerInput, groupDir, globalDir, memoryDir } = opts;
    const { isHome, isAdminHome } = normalizeHomeFlags(containerInput);

    this.tmpDir = tmpDir;
    this.imagesDir = path.join(tmpDir, 'images');
    // 宿主按 descriptor.runtimeContract.configDirEnv 为每个会话分配
    // sessions/{folder}/.grok，这里只需接住；缺失时退到临时目录。
    this.homeDir =
      process.env.GROK_HOME ||
      fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-grok-home-'));
    prepareGrokHome(this.homeDir);

    const runnerDir = path.dirname(new URL(import.meta.url).pathname);
    this.mcpServerPath = path.resolve(
      runnerDir,
      '../../happyclaw-mcp-server.js',
    );
    this.hookHandlerPath = path.resolve(runnerDir, './hook-handler.js');

    this.mcpServerEnv = {
      HAPPYCLAW_WORKSPACE_GROUP: groupDir,
      HAPPYCLAW_WORKSPACE_GLOBAL: globalDir,
      HAPPYCLAW_WORKSPACE_MEMORY: memoryDir,
      HAPPYCLAW_WORKSPACE_IPC: opts.ipcPaths.inputDir.replace('/input', ''),
      HAPPYCLAW_GROUP_FOLDER: containerInput.groupFolder,
      HAPPYCLAW_CHAT_JID: containerInput.chatJid,
      HAPPYCLAW_USER_ID: containerInput.userId || '',
      HAPPYCLAW_IS_HOME: isHome ? '1' : '0',
      HAPPYCLAW_IS_ADMIN_HOME: isAdminHome ? '1' : '0',
      HAPPYCLAW_SKILLS_DIR: opts.skillsDir,
      HAPPYCLAW_PROJECT_SKILLS_DIR:
        process.env.HAPPYCLAW_PROJECT_SKILLS_DIR || '/workspace/project-skills',
    };

    const providerState =
      opts.state.getProviderState<GrokRunnerProviderState>();
    this.currentSessionId =
      typeof providerState?.currentSessionId === 'string'
        ? providerState.currentSessionId
        : null;
    this.lastMessageCursor = opts.state.getLastMessageCursor();
  }

  private createProcessor(): StreamEventProcessor {
    this.normalizer = new GrokEventNormalizer();
    const { state } = this.opts;
    return new StreamEventProcessor(
      (output) => {
        if (output.streamEvent) {
          this.streamEventQueue.push({
            kind: 'stream_event',
            event: output.streamEvent,
          });
        }
      },
      this.opts.log,
      (newMode) => {
        state.currentPermissionMode = newMode;
      },
    );
  }

  private drainStreamEvents(): NormalizedMessage[] {
    const output = [...this.streamEventQueue];
    this.streamEventQueue.length = 0;
    return output;
  }

  private updateSessionFromEvent(
    event: Record<string, unknown>,
  ): NormalizedMessage[] {
    const messages: NormalizedMessage[] = [];
    const sessionId =
      typeof event.session_id === 'string' ? event.session_id : undefined;
    if (sessionId && sessionId !== this.currentSessionId) {
      this.currentSessionId = sessionId;
      messages.push({ kind: 'session_init', sessionId });
      messages.push({ kind: 'resume_anchor', anchor: sessionId });
    }
    return messages;
  }

  private updateToolActivity(): void {
    const hasActiveToolCall = this.processor?.hasActiveToolCall ?? false;
    if (hasActiveToolCall && this.toolCallStartedAt === null) {
      this.toolCallStartedAt = Date.now();
    } else if (!hasActiveToolCall) {
      this.toolCallStartedAt = null;
    }
  }

  /**
   * grok 的 `-s/--session-id` 只能开新会话（重复使用会报 "already in use"），
   * 续接一律走 `--resume`。好处是 session id 跨轮不变，直接就是 resume 锚点。
   */
  private buildResumeTarget(query: QueryConfig): string | undefined {
    return (
      query.sessionId || query.resumeAt || this.currentSessionId || undefined
    );
  }

  private buildHooks(): GrokHookSpec[] {
    return [
      {
        event: 'PreToolUse',
        matcher: GROK_SHELL_TOOL_MATCHER,
        command: `${process.execPath} ${this.hookHandlerPath} safety-lite`,
        timeoutSec: 10,
      },
    ];
  }

  /**
   * 写入会话 GROK_HOME 的用户级 config.toml。
   *
   * 必须是用户级：repo-local 的 `.mcp.json` 在未信任目录下会被 grok 静默跳过
   * （`mcp doctor` 报 "folder untrusted"），而用户级 MCP 不受 folder trust 限制。
   */
  private writeConfig(): void {
    const builtinName = this.opts.builtinMcpServerName || 'agentdock';
    const builtinServer = {
      command: process.execPath,
      args: [this.mcpServerPath],
      env: this.mcpServerEnv,
    };
    // 只读查询（memory read-only 车道）走 --tools 白名单，MCP 工具本就取不到，
    // 再拉起 happyclaw MCP server 只是白白连一次 IPC 目录。
    const mcpServers: Record<string, unknown> =
      this.opts.toolScope === 'read-only'
        ? {}
        : {
            ...this.opts.loadUserMcpServers(),
            [builtinName]: builtinServer,
            ...(builtinName === 'happyclaw'
              ? {}
              : { happyclaw: builtinServer }),
          };

    writeGrokConfig(this.homeDir, {
      mcpServers,
      hooks: this.buildHooks(),
      // grok 原生只扫 .grok/skills 与 ~/.claude/skills，把 happyclaw 的用户级
      // skills 目录挂进来，descriptor 里声明的 skills:'native' 才成立。
      skillsPaths: [this.opts.skillsDir],
    });
  }

  private resolvePermissionMode(query: QueryConfig): string {
    const requested =
      query.permissionMode ?? this.opts.state.currentPermissionMode ?? '';
    return GROK_PERMISSION_MODES.has(requested)
      ? requested
      : 'bypassPermissions';
  }

  /**
   * grok 的 `--prompt-json` 收 ACP content blocks（`{type,data,mimeType}`），
   * 不是 Anthropic 的 `source.data` 形态。图片体量过大时退回落盘引用，
   * 避免整个 base64 塞进 argv。
   */
  private buildPromptArgs(query: QueryConfig): string[] {
    const promptFile = path.join(
      this.tmpDir,
      `prompt-${++this.turnCounter}.txt`,
    );
    const images = query.images || [];
    if (images.length === 0) {
      fs.writeFileSync(promptFile, query.prompt, 'utf-8');
      return ['--prompt-file', promptFile];
    }

    const { valid, rejected } = filterOversizedImages(images, this.opts.log);
    this.rejectedImages = rejected;
    if (valid.length === 0) {
      fs.writeFileSync(promptFile, query.prompt, 'utf-8');
      return ['--prompt-file', promptFile];
    }

    const blocks = valid.map((image) => ({
      type: 'image',
      data: stripDataUrlPrefix(image.data),
      mimeType: resolveImageMimeType(image, this.opts.log),
    }));
    const payload = JSON.stringify([
      ...blocks,
      { type: 'text', text: query.prompt },
    ]);

    if (payload.length <= INLINE_IMAGE_LIMIT_BYTES) {
      return ['--prompt-json', payload];
    }

    // 太大：落盘并在正文里给出路径，让模型用 read_file 自取
    fs.mkdirSync(this.imagesDir, { recursive: true });
    const paths: string[] = [];
    for (let i = 0; i < valid.length; i++) {
      const image = valid[i];
      const mimeType = resolveImageMimeType(image, this.opts.log);
      const ext = MIME_EXTENSION_MAP[mimeType] || 'jpg';
      const filePath = path.join(
        this.imagesDir,
        `image-${Date.now()}-${i}.${ext}`,
      );
      fs.writeFileSync(
        filePath,
        Buffer.from(stripDataUrlPrefix(image.data), 'base64'),
      );
      paths.push(filePath);
    }
    this.opts.log(
      `Grok inline image payload ${payload.length}B exceeds limit; falling back to ${paths.length} file reference(s)`,
    );
    fs.writeFileSync(
      promptFile,
      `${query.prompt}\n\nAttached images:\n${paths.map((p) => `- ${p}`).join('\n')}`,
      'utf-8',
    );
    return ['--prompt-file', promptFile];
  }

  buildCommand(query: QueryConfig): CliCommand {
    this.processor = this.createProcessor();
    this.streamEventQueue.length = 0;
    this.rejectedImages = [];
    this.toolCallStartedAt = null;
    this.writeConfig();

    const commandPath = this.opts.command || 'grok';
    const args = [
      ...this.buildPromptArgs(query),
      '--output-format',
      'streaming-messages-json',
      '--include-partial-messages',
      '--permission-mode',
      this.resolvePermissionMode(query),
      // headless 下没有回传答案的通道，放任 ask_user_question 会把这一轮挂死
      '--no-ask-user',
    ];

    if (query.systemPrompt) {
      if (Buffer.byteLength(query.systemPrompt) > SYSTEM_PROMPT_WARN_BYTES) {
        this.opts.log(
          `Grok system prompt is ${Buffer.byteLength(query.systemPrompt)}B — approaching ARG_MAX`,
        );
      }
      args.push('--rules', query.systemPrompt);
    }

    if (this.opts.toolScope === 'read-only') {
      args.push('--tools', READ_ONLY_TOOLS.join(','));
    }

    const resumeTarget = this.buildResumeTarget(query);
    if (resumeTarget) args.push('--resume', resumeTarget);
    if (this.opts.model) args.push('--model', this.opts.model);
    if (this.opts.thinkingEffort) {
      args.push('--effort', this.opts.thinkingEffort);
    }

    this.opts.log(
      `Spawning Grok CLI one-shot: ${commandPath} (home=${this.homeDir}, model=${this.opts.model}, resume=${resumeTarget || 'none'})`,
    );

    return {
      command: commandPath,
      args,
      cwd: this.opts.groupDir,
      env: {
        ...(process.env as Record<string, string>),
        ...this.mcpServerEnv,
        GROK_HOME: this.homeDir,
      },
    };
  }

  buildInput(query: QueryConfig): CliInput {
    this.opts.state.extractSourceChannels(
      query.prompt,
      this.opts.imChannelsFile,
    );
    // prompt 走 --prompt-file / --prompt-json，stdin 立即关闭：留着不关，grok
    // 会把它当成待读入的管道上下文而迟迟不开工。
    return { endStdin: true };
  }

  beforeRun(): NormalizedMessage[] {
    if (this.rejectedImages.length === 0) return [];
    return [
      {
        kind: 'stream_event',
        event: {
          eventType: 'status',
          statusText: `image_rejected:${this.rejectedImages.length}`,
        },
      },
    ];
  }

  parseStdoutLine(line: string): NormalizedMessage[] {
    if (!line.trim()) return [];
    const messages: NormalizedMessage[] = [];
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(line) as Record<string, unknown>;
    } catch (err) {
      return [
        {
          kind: 'error',
          message: `Grok CLI JSON parse error: ${err instanceof Error ? err.message : String(err)}`,
          recoverable: false,
        },
      ];
    }

    // grok CLI 自身的错误行（未登录、会话不存在等）不带 type
    if (
      raw.type === 'error' ||
      (!raw.type && typeof raw.message === 'string')
    ) {
      const detail = String(raw.message || 'Grok CLI error');
      return [
        {
          kind: 'error',
          message: detail,
          recoverable: isGrokSessionResumeFailedError(detail),
          errorType: isGrokSessionResumeFailedError(detail)
            ? 'session_resume_failed'
            : undefined,
        },
      ];
    }

    for (const event of this.normalizer.normalize(raw)) {
      messages.push(...this.processEvent(event));
    }
    return messages;
  }

  private processEvent(event: Record<string, unknown>): NormalizedMessage[] {
    const messages: NormalizedMessage[] = [];
    messages.push(...this.updateSessionFromEvent(event));
    const processor = this.processor;
    if (!processor) return messages;

    if (event.type === 'stream_event') {
      processor.processStreamEvent(event as never);
      this.updateToolActivity();
      messages.push(...this.drainStreamEvents());
      return messages;
    }

    if (event.type === 'system') {
      if (processor.processSystemMessage(event as never)) {
        messages.push(...this.drainStreamEvents());
      }
      return messages;
    }

    if (processor.processSubAgentMessage(event as never)) {
      messages.push(...this.drainStreamEvents());
      return messages;
    }

    if (event.type === 'assistant') {
      if (typeof event.uuid === 'string') this.lastMessageCursor = event.uuid;
      processor.processAssistantMessage(event as never);
      this.updateToolActivity();
      messages.push(...this.drainStreamEvents());
      return messages;
    }

    if (event.type === 'user') {
      if (typeof event.uuid === 'string') this.lastMessageCursor = event.uuid;
      return messages;
    }

    if (event.type === 'result') {
      const textResult = extractResultText(event);
      const resultSubtype =
        typeof event.subtype === 'string' ? event.subtype : undefined;
      const isCliError =
        event.is_error === true ||
        !!(resultSubtype && resultSubtype.startsWith('error'));

      if (isCliError || (textResult && isContextOverflowError(textResult))) {
        const detail =
          textResult?.trim() ||
          `Grok execution failed (${resultSubtype || 'unknown'})`;
        processor.resetFullTextAccumulator();
        processor.cleanup();
        messages.push(...this.drainStreamEvents());
        messages.push({
          kind: 'error',
          message: detail,
          recoverable:
            isContextOverflowError(detail) ||
            isGrokSessionResumeFailedError(detail),
          errorType: isContextOverflowError(detail)
            ? 'context_overflow'
            : isGrokSessionResumeFailedError(detail)
              ? 'session_resume_failed'
              : undefined,
        });
        return messages;
      }

      const { effectiveResult } = processor.processResult(textResult);
      processor.cleanup();
      this.updateToolActivity();
      messages.push(...this.drainStreamEvents());
      messages.push({
        kind: 'result',
        text: effectiveResult,
        usage: usageFromResult(event, this.opts.model),
      });
    }

    return messages;
  }

  parseStderrChunk(chunk: string): NormalizedMessage[] {
    const text = chunk.trim();
    if (text) this.opts.log(`[grok stderr] ${text}`);
    return [];
  }

  detectRecoverableError(eventOrText: unknown) {
    const text = String(eventOrText || '');
    if (isContextOverflowError(text)) {
      return {
        message: text.trim(),
        recoverable: true,
        errorType: 'context_overflow' as const,
      };
    }
    if (isGrokSessionResumeFailedError(text)) {
      return {
        message: text.trim(),
        recoverable: true,
        errorType: 'session_resume_failed' as const,
      };
    }
    return null;
  }

  async interrupt(proc: ChildProcessWithoutNullStreams): Promise<void> {
    proc.kill('SIGINT');
    setTimeout(() => {
      if (!proc.killed) proc.kill('SIGKILL');
    }, 1500);
  }

  getRuntimePersistenceSnapshot(): RuntimePersistenceSnapshot {
    return {
      providerState: { currentSessionId: this.currentSessionId },
      lastMessageCursor: this.lastMessageCursor,
    };
  }

  getActivityReport(): ActivityReport {
    const hasActiveToolCall = this.processor?.hasActiveToolCall ?? false;
    return {
      hasActiveToolCall,
      activeToolDurationMs:
        hasActiveToolCall && this.toolCallStartedAt
          ? Date.now() - this.toolCallStartedAt
          : 0,
      hasPendingBackgroundTasks:
        (this.processor?.pendingBackgroundTaskCount ?? 0) > 0,
    };
  }

  cleanup(): void {
    this.processor?.cleanup();
    this.processor = null;
    this.streamEventQueue.length = 0;
    this.toolCallStartedAt = null;
  }
}

/**
 * grok 的 prompt 契约：`--rules` 追加到 CLI 原生 preset 之后，
 * turn section 走用户消息前缀（保持 system 前缀逐轮稳定、可命中 prompt cache）。
 */
export const GROK_PROMPT_CONTRACT: RunnerPromptContract = {
  mode: 'append',
  dynamicContextReload: 'turn',
  turnContextDelivery: 'user_prefix',
};

export class GrokRunner extends BaseCliRunner {
  readonly ipcCapabilities: IpcCapabilities = {
    // headless 每轮一个进程，没有 stream-json 输入通道，运行中来的消息只能缓冲
    supportsMidQueryPush: false,
    supportsRuntimeModeSwitch: false,
  };
  readonly promptContract: RunnerPromptContract = GROK_PROMPT_CONTRACT;

  protected readonly adapter: GrokCliAdapter;
  private readonly tmpDir: string;

  constructor(opts: GrokRunnerOptions) {
    super();
    this.tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), `happyclaw-grok-${randomUUID()}-`),
    );
    this.adapter = new GrokCliAdapter(opts, this.tmpDir);
  }

  getRuntimePersistenceSnapshot(): RuntimePersistenceSnapshot {
    return this.adapter.getRuntimePersistenceSnapshot();
  }

  getActivityReport(): ActivityReport {
    const adapterReport = this.adapter.getActivityReport();
    if (
      adapterReport.hasActiveToolCall ||
      adapterReport.hasPendingBackgroundTasks
    ) {
      return adapterReport;
    }
    return super.getActivityReport();
  }

  async cleanup(): Promise<void> {
    this.adapter.cleanup();
    fs.rmSync(this.tmpDir, { recursive: true, force: true });
  }
}
