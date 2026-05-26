/**
 * Codex app-server session.
 *
 * The TypeScript SDK wraps `codex exec --json`, which does not expose native
 * context compaction. The app-server protocol does, so this runner talks to
 * `codex app-server --listen stdio://` directly over newline-delimited JSON-RPC.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import fs from 'fs';
import path from 'path';
import { createInterface, type Interface as ReadlineInterface } from 'readline';

export interface CodexSessionConfig {
  model?: string;
  thinkingEffort?: string;
  workingDirectory: string;
  additionalDirectories?: string[];
  /** Path to MCP server entry point for HappyClaw tools. */
  mcpServerPath?: string;
  /** Environment variables for the MCP server process. */
  mcpServerEnv?: Record<string, string>;
  /** Path to model instructions file. Kept for compatibility with existing config wiring. */
  modelInstructionsFile?: string;
  /** Built-in AgentDock MCP server name. A happyclaw alias is kept for old prompts. */
  builtinMcpServerName?: string;
  /** User-configured MCP servers from settings.json (stdio format only). */
  userMcpServers?: Record<string, unknown>;
}

export interface CodexSessionOptions {
  codexPathOverride?: string;
  apiKey?: string;
  config?: Record<string, unknown>;
}

const DEFAULT_BUILTIN_MCP_STARTUP_TIMEOUT_SEC = 30;
const DEFAULT_MEMORY_QUERY_TIMEOUT_MS = 60_000;
const DEFAULT_MEMORY_SEND_TIMEOUT_MS = 120_000;
const BUILTIN_MCP_TOOL_TIMEOUT_BUFFER_SEC = 30;

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function readEnvNumber(
  env: Record<string, string> | undefined,
  key: string,
): number | undefined {
  return parsePositiveInteger(env?.[key] || process.env[key]);
}

function buildBuiltinMcpTimeoutConfig(env: Record<string, string> | undefined): {
  startup_timeout_sec: number;
  tool_timeout_sec: number;
} {
  const queryTimeoutMs =
    readEnvNumber(env, 'HAPPYCLAW_MEMORY_QUERY_TIMEOUT') ||
    DEFAULT_MEMORY_QUERY_TIMEOUT_MS;
  const sendTimeoutMs =
    readEnvNumber(env, 'HAPPYCLAW_MEMORY_SEND_TIMEOUT') ||
    DEFAULT_MEMORY_SEND_TIMEOUT_MS;
  const explicitToolTimeoutSec = readEnvNumber(
    env,
    'HAPPYCLAW_MCP_TOOL_TIMEOUT_SEC',
  );
  const derivedToolTimeoutSec =
    Math.ceil(Math.max(queryTimeoutMs, sendTimeoutMs) / 1000) +
    BUILTIN_MCP_TOOL_TIMEOUT_BUFFER_SEC;

  return {
    startup_timeout_sec:
      readEnvNumber(env, 'HAPPYCLAW_MCP_STARTUP_TIMEOUT_SEC') ||
      DEFAULT_BUILTIN_MCP_STARTUP_TIMEOUT_SEC,
    tool_timeout_sec: explicitToolTimeoutSec || derivedToolTimeoutSec,
  };
}

export type CodexItemType =
  | 'agent_message'
  | 'reasoning'
  | 'command_execution'
  | 'file_change'
  | 'mcp_tool_call'
  | 'web_search'
  | 'todo_list'
  | 'error'
  | 'context_compaction';

export type CodexThreadItem =
  | { id: string; type: 'agent_message'; text: string }
  | { id: string; type: 'reasoning'; text: string }
  | {
      id: string;
      type: 'command_execution';
      command: string;
      aggregated_output: string;
      exit_code?: number;
      status: 'in_progress' | 'completed' | 'failed';
    }
  | {
      id: string;
      type: 'file_change';
      changes: Array<{ path: string; kind: 'add' | 'delete' | 'update' }>;
      status: 'completed' | 'failed';
    }
  | {
      id: string;
      type: 'mcp_tool_call';
      server: string;
      tool: string;
      arguments: unknown;
      result?: unknown;
      error?: { message: string };
      status: 'in_progress' | 'completed' | 'failed';
    }
  | { id: string; type: 'web_search'; query: string }
  | {
      id: string;
      type: 'todo_list';
      items: Array<{ text: string; completed: boolean }>;
    }
  | { id: string; type: 'error'; message: string }
  | { id: string; type: 'context_compaction' };

export interface CodexUsage {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
}

export type CodexThreadEvent =
  | { type: 'thread.started'; thread_id: string }
  | { type: 'turn.started'; turn_id?: string; thread_id?: string }
  | { type: 'turn.completed'; usage: CodexUsage; turn_id?: string; thread_id?: string }
  | { type: 'turn.failed'; error: { message: string }; turn_id?: string; thread_id?: string }
  | { type: 'item.started'; item: CodexThreadItem; turn_id?: string; thread_id?: string }
  | { type: 'item.updated'; item: CodexThreadItem; turn_id?: string; thread_id?: string }
  | { type: 'item.completed'; item: CodexThreadItem; turn_id?: string; thread_id?: string }
  | { type: 'compact.completed'; thread_id: string; turn_id: string; item_id?: string; source: 'item' | 'thread' }
  | { type: 'token_count'; usage: CodexUsage; turn_id?: string; thread_id?: string }
  | { type: 'error'; message: string };

interface JsonRpcMessage {
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: string; code?: number; data?: unknown };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface AppNotification {
  method: string;
  params: unknown;
}

export interface PostCompactContextInjection {
  continuationSummary?: string;
  activeChannels?: string[];
}

interface Waiter<T> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

class AsyncQueue<T> {
  private values: T[] = [];
  private waiters: Array<Waiter<T | null>> = [];
  private closed = false;
  private closeError: Error | null = null;

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve(value);
      return;
    }
    this.values.push(value);
  }

  close(error?: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.closeError = error || null;
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) {
      if (this.closeError) {
        waiter.reject(this.closeError);
      } else {
        waiter.resolve(null);
      }
    }
  }

  async next(): Promise<T | null> {
    const value = this.values.shift();
    if (value) return value;
    if (this.closed) {
      if (this.closeError) throw this.closeError;
      return null;
    }
    return new Promise<T | null>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function mapCommandStatus(value: unknown): 'in_progress' | 'completed' | 'failed' {
  if (value === 'completed') return 'completed';
  if (value === 'failed' || value === 'declined') return 'failed';
  return 'in_progress';
}

function mapPatchStatus(value: unknown): 'completed' | 'failed' {
  return value === 'failed' ? 'failed' : 'completed';
}

function mapPatchKind(value: unknown): 'add' | 'delete' | 'update' {
  if (value === 'add' || value === 'delete') return value;
  return 'update';
}

function mapAppItem(item: unknown): CodexThreadItem | null {
  if (!isObject(item)) return null;
  const id = stringValue(item.id) || 'unknown';
  switch (item.type) {
    case 'agentMessage':
      return { id, type: 'agent_message', text: stringValue(item.text) || '' };
    case 'reasoning': {
      const summary = Array.isArray(item.summary) ? item.summary : [];
      const content = Array.isArray(item.content) ? item.content : [];
      const text = [...summary, ...content]
        .filter((part): part is string => typeof part === 'string')
        .join('\n');
      return { id, type: 'reasoning', text };
    }
    case 'commandExecution':
      return {
        id,
        type: 'command_execution',
        command: stringValue(item.command) || '',
        aggregated_output: stringValue(item.aggregatedOutput) || '',
        ...(typeof item.exitCode === 'number' ? { exit_code: item.exitCode } : {}),
        status: mapCommandStatus(item.status),
      };
    case 'fileChange': {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      return {
        id,
        type: 'file_change',
        changes: changes.filter(isObject).map((change) => ({
          path: stringValue(change.path) || '',
          kind: mapPatchKind(change.kind),
        })),
        status: mapPatchStatus(item.status),
      };
    }
    case 'mcpToolCall': {
      const error = isObject(item.error)
        ? { message: stringValue(item.error.message) || 'MCP tool call failed' }
        : undefined;
      return {
        id,
        type: 'mcp_tool_call',
        server: stringValue(item.server) || '',
        tool: stringValue(item.tool) || '',
        arguments: item.arguments,
        ...(item.result === null || item.result === undefined ? {} : { result: item.result }),
        ...(error ? { error } : {}),
        status: mapCommandStatus(item.status),
      };
    }
    case 'webSearch':
      return { id, type: 'web_search', query: stringValue(item.query) || '' };
    case 'plan':
      return {
        id,
        type: 'todo_list',
        items: stringValue(item.text)
          ? [{ text: stringValue(item.text) || '', completed: false }]
          : [],
      };
    case 'contextCompaction':
      return { id, type: 'context_compaction' };
    default:
      return null;
  }
}

function usageFromTokenUsage(value: unknown): CodexUsage | null {
  if (!isObject(value)) return null;
  const last = isObject(value.last) ? value.last : value;
  return {
    input_tokens: numberValue(last.inputTokens) || 0,
    cached_input_tokens: numberValue(last.cachedInputTokens) || 0,
    output_tokens: numberValue(last.outputTokens) || 0,
    reasoning_output_tokens: numberValue(last.reasoningOutputTokens) || 0,
  };
}

function threadIdFromResponse(result: unknown): string | null {
  if (!isObject(result) || !isObject(result.thread)) return null;
  return stringValue(result.thread.id) || null;
}

function turnIdFromResponse(result: unknown): string | null {
  if (!isObject(result) || !isObject(result.turn)) return null;
  return stringValue(result.turn.id) || null;
}

function readMemoryIndex(): { filePath: string; content: string } | null {
  const memoryIndexRoot =
    process.env.HAPPYCLAW_WORKSPACE_MEMORY_INDEX || '/workspace/memory-index';
  const filePath = path.join(memoryIndexRoot, 'index.md');
  try {
    if (!fs.existsSync(filePath)) return null;
    return {
      filePath,
      content: fs.readFileSync(filePath, 'utf-8'),
    };
  } catch {
    return null;
  }
}

function buildInvariantReminder(activeChannels: string[]): string {
  return [
    '## HappyClaw post-compact invariant reminder',
    '',
    '- Codex 已完成 native compact。Codex 自己保留下来的 compact 上下文是主上下文，本消息是 HappyClaw 平台补充上下文。',
    '- stdout 只会显示在 Web UI。回复飞书、Telegram、QQ 等 IM 用户时，必须使用 send_message，并使用最新消息 source 属性里的 channel。',
    activeChannels.length > 0
      ? `- 最近活跃 IM channels: ${activeChannels.join(', ')}。完成任务后需要主动向相关 channel 汇报。`
      : '- 当前没有记录到最近活跃 IM channel。若最新消息带 source 属性，以最新消息 source 为准。',
    '- memory-index 是快速索引，不是权威事实来源。涉及日期、数字、决策结论、用户偏好等具体事实时，优先调用 memory_query 确认。',
    '- continuation summary 和 transcript 行号引用描述的是已经处理过的历史，不要重复回复历史消息。只处理 compact 后新到达的用户消息。',
  ].join('\n');
}

function buildPostCompactContextItem(
  input: PostCompactContextInjection,
): Record<string, unknown> {
  const memoryIndex = readMemoryIndex();
  const activeChannels = Array.from(new Set(input.activeChannels || []));
  const summary = input.continuationSummary?.trim();
  const sections = [
    '[HappyClaw post-compact supplemental context]',
    '这条 developer message 由 HappyClaw 在 Codex native compact 后注入，用于补足平台不变量、最新 memory index 和外部 transcript continuation summary。',
    '不要单独回复这条消息。',
    '',
    buildInvariantReminder(activeChannels),
    '',
    '## 最新完整 memory index.md',
    '',
    memoryIndex
      ? [
          `path: ${memoryIndex.filePath}`,
          '',
          '<memory-index>',
          memoryIndex.content,
          '</memory-index>',
        ].join('\n')
      : 'index.md 当前不可读或不存在。本次不注入 memory index。',
    '',
    '## Continuation summary',
    '',
    summary || '本次 session_wrapup 没有返回 continuation summary。',
  ];

  return {
    type: 'message',
    role: 'developer',
    content: [
      {
        type: 'input_text',
        text: sections.join('\n'),
      },
    ],
  };
}

export class CodexSession {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutRl: ReadlineInterface | null = null;
  private stderrRl: ReadlineInterface | null = null;
  private nextRequestId = 1;
  private pending = new Map<string | number, PendingRequest>();
  private notifications = new AsyncQueue<AppNotification>();
  private initialized = false;
  private threadId: string | null = null;
  private activeTurnId: string | null = null;
  private lastUsageByTurn = new Map<string, CodexUsage>();
  private config: CodexSessionConfig;
  private options: CodexSessionOptions;

  constructor(config: CodexSessionConfig, options?: CodexSessionOptions) {
    this.config = config;
    this.options = options || {};
  }

  /**
   * Start a new thread or resume an existing one.
   */
  async startOrResume(threadId?: string): Promise<void> {
    await this.ensureServer();

    if (threadId && threadId === this.threadId) {
      return;
    }

    const params = this.buildThreadParams();
    const result = threadId
      ? await this.request('thread/resume', {
          ...params,
          threadId,
          excludeTurns: true,
        })
      : await this.request('thread/start', params);

    const resolvedThreadId = threadIdFromResponse(result) || threadId || null;
    if (!resolvedThreadId) {
      throw new Error('Codex app-server did not return a thread id');
    }
    this.threadId = resolvedThreadId;
  }

  /**
   * Run a turn and yield normalized Codex events.
   */
  async *runTurn(
    prompt: string,
    imagePaths?: string[],
  ): AsyncGenerator<CodexThreadEvent> {
    if (!this.threadId) {
      throw new Error('CodexSession: thread not started');
    }

    yield { type: 'thread.started', thread_id: this.threadId };

    const result = await this.request('turn/start', {
      threadId: this.threadId,
      input: this.buildInput(prompt, imagePaths),
      cwd: this.config.workingDirectory,
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' },
      model: this.config.model,
      ...(this.config.thinkingEffort ? { effort: this.config.thinkingEffort } : {}),
    });

    const turnId = turnIdFromResponse(result);
    if (!turnId) {
      throw new Error('Codex app-server did not return a turn id');
    }
    this.activeTurnId = turnId;

    while (true) {
      const notification = await this.notifications.next();
      if (!notification) break;
      const events = this.mapNotification(notification, this.threadId, turnId);
      for (const event of events) {
        yield event;
        if (
          (event.type === 'turn.completed' || event.type === 'turn.failed') &&
          event.turn_id === turnId
        ) {
          this.activeTurnId = null;
          return;
        }
      }
    }
  }

  async *runCompact(): AsyncGenerator<CodexThreadEvent> {
    if (!this.threadId) {
      throw new Error('CodexSession: thread not started');
    }

    yield { type: 'thread.started', thread_id: this.threadId };
    await this.request('thread/compact/start', { threadId: this.threadId });

    let compactTurnId: string | undefined;
    while (true) {
      const notification = await this.notifications.next();
      if (!notification) break;
      const events = this.mapNotification(notification, this.threadId, compactTurnId);
      for (const event of events) {
        if (event.type === 'turn.started' && event.turn_id) {
          compactTurnId = event.turn_id;
          this.activeTurnId = event.turn_id;
        }
        yield event;
        if (event.type === 'compact.completed') {
          this.activeTurnId = null;
          return;
        }
        if (
          (event.type === 'turn.completed' || event.type === 'turn.failed') &&
          (!compactTurnId || event.turn_id === compactTurnId)
        ) {
          this.activeTurnId = null;
          return;
        }
      }
    }
  }

  getThreadId(): string | null {
    return this.threadId;
  }

  resetThread(): void {
    this.threadId = null;
    this.activeTurnId = null;
  }

  async injectPostCompactContext(
    input: PostCompactContextInjection,
  ): Promise<void> {
    if (!this.threadId) {
      throw new Error('CodexSession: thread not started');
    }
    await this.request('thread/inject_items', {
      threadId: this.threadId,
      items: [buildPostCompactContextItem(input)],
    });
  }

  async interrupt(): Promise<void> {
    if (!this.threadId || !this.activeTurnId) return;
    try {
      await this.request('turn/interrupt', {
        threadId: this.threadId,
        turnId: this.activeTurnId,
      });
    } catch {
      /* ignore */
    }
  }

  async close(): Promise<void> {
    this.notifications.close();
    for (const pending of this.pending.values()) {
      pending.reject(new Error('Codex app-server closed'));
    }
    this.pending.clear();
    this.stdoutRl?.close();
    this.stderrRl?.close();
    if (this.child && !this.child.killed) {
      this.child.kill('SIGTERM');
    }
    this.child = null;
    this.initialized = false;
  }

  private async ensureServer(): Promise<void> {
    if (this.initialized) return;
    const command = this.options.codexPathOverride || 'codex';
    const child = spawn(command, ['app-server'], {
      env: {
        ...(process.env as Record<string, string>),
        ...(this.options.apiKey ? { OPENAI_API_KEY: this.options.apiKey } : {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;

    child.on('error', (error) => this.failAll(error));
    child.on('exit', (code, signal) => {
      this.failAll(new Error(`Codex app-server exited (${code ?? signal ?? 'unknown'})`));
    });

    this.stdoutRl = createInterface({ input: child.stdout });
    this.stdoutRl.on('line', (line) => this.handleLine(line));

    this.stderrRl = createInterface({ input: child.stderr });
    this.stderrRl.on('line', (line) => {
      if (line.trim().length > 0) {
        console.error(`[codex-app-server] ${line}`);
      }
    });

    await this.request('initialize', {
      clientInfo: {
        name: 'happyclaw',
        title: 'HappyClaw',
        version: '0.0.0',
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    this.notify('initialized');
    this.initialized = true;
  }

  private buildThreadParams(): Record<string, unknown> {
    const builtinName = this.config.builtinMcpServerName || 'agentdock';
    const builtinServer = this.config.mcpServerPath
      ? {
          command: 'node',
          args: [this.config.mcpServerPath],
          env: this.config.mcpServerEnv || {},
          ...buildBuiltinMcpTimeoutConfig(this.config.mcpServerEnv),
        }
      : null;
    const mcpServers = {
      ...(this.config.userMcpServers || {}),
      ...(builtinServer
        ? {
            [builtinName]: builtinServer,
            ...(builtinName === 'happyclaw' ? {} : { happyclaw: builtinServer }),
          }
        : {}),
    };

    return {
      model: this.config.model,
      cwd: this.config.workingDirectory,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      serviceName: 'happyclaw',
      experimentalRawEvents: false,
      persistExtendedHistory: true,
      config: {
        ...(this.options.config || {}),
        ...(this.config.modelInstructionsFile
          ? { model_instructions_file: this.config.modelInstructionsFile }
          : {}),
        ...(this.config.thinkingEffort
          ? { model_reasoning_effort: this.config.thinkingEffort }
          : {}),
        web_search_mode: 'live',
        ...(Object.keys(mcpServers).length > 0 ? { mcp_servers: mcpServers } : {}),
      },
    };
  }

  private buildInput(prompt: string, imagePaths?: string[]): Array<Record<string, unknown>> {
    const input: Array<Record<string, unknown>> = [
      { type: 'text', text: prompt, text_elements: [] },
    ];
    for (const imagePath of imagePaths || []) {
      input.push({ type: 'localImage', path: imagePath });
    }
    return input;
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (!this.child) {
      return Promise.reject(new Error('Codex app-server is not running'));
    }
    const id = this.nextRequestId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child?.stdin.write(`${payload}\n`, (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  private notify(method: string, params?: unknown): void {
    const payload = params === undefined ? { method } : { method, params };
    this.child?.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(trimmed) as JsonRpcMessage;
    } catch {
      console.error(`[codex-app-server] Non-JSON stdout: ${trimmed}`);
      return;
    }

    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        this.handleServerRequest(message);
        return;
      }
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message || `JSON-RPC error ${message.error.code ?? ''}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (typeof message.method === 'string') {
      this.notifications.push({
        method: message.method,
        params: message.params,
      });
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
    this.notifications.close(error);
  }

  private handleServerRequest(message: JsonRpcMessage): void {
    if (message.id === undefined || typeof message.method !== 'string') return;
    switch (message.method) {
      case 'item/commandExecution/requestApproval':
        this.respond(message.id, { decision: 'decline' });
        return;
      case 'item/fileChange/requestApproval':
        this.respond(message.id, { decision: 'decline' });
        return;
      case 'item/tool/requestUserInput':
        this.respond(message.id, { answers: {} });
        return;
      case 'mcpServer/elicitation/request':
        this.respond(message.id, { action: 'decline', content: null, _meta: null });
        return;
      case 'applyPatchApproval':
      case 'execCommandApproval':
        this.respond(message.id, { decision: 'denied' });
        return;
      default:
        this.respondError(message.id, `Unsupported Codex server request: ${message.method}`);
    }
  }

  private respond(id: string | number, result: unknown): void {
    this.child?.stdin.write(`${JSON.stringify({ id, result })}\n`);
  }

  private respondError(id: string | number, message: string): void {
    this.child?.stdin.write(`${JSON.stringify({
      id,
      error: {
        code: -32601,
        message,
      },
    })}\n`);
  }

  private mapNotification(
    notification: AppNotification,
    expectedThreadId: string,
    expectedTurnId?: string,
  ): CodexThreadEvent[] {
    const params = isObject(notification.params) ? notification.params : {};
    const threadId = stringValue(params.threadId);
    if (threadId && threadId !== expectedThreadId) return [];

    switch (notification.method) {
      case 'turn/started': {
        const turn = isObject(params.turn) ? params.turn : {};
        const turnId = stringValue(turn.id);
        if (expectedTurnId && turnId && turnId !== expectedTurnId) return [];
        return [{ type: 'turn.started', thread_id: threadId, turn_id: turnId }];
      }
      case 'thread/tokenUsage/updated': {
        const turnId = stringValue(params.turnId);
        if (expectedTurnId && turnId && turnId !== expectedTurnId) return [];
        const usage = usageFromTokenUsage(params.tokenUsage);
        if (!usage) return [];
        if (turnId) this.lastUsageByTurn.set(turnId, usage);
        return [{ type: 'token_count', usage, thread_id: threadId, turn_id: turnId }];
      }
      case 'item/started':
      case 'item/completed': {
        const turnId = stringValue(params.turnId);
        if (expectedTurnId && turnId && turnId !== expectedTurnId) return [];
        const item = mapAppItem(params.item);
        if (!item) return [];
        const eventType = notification.method === 'item/started' ? 'item.started' : 'item.completed';
        const events: CodexThreadEvent[] = [
          { type: eventType, item, thread_id: threadId, turn_id: turnId } as CodexThreadEvent,
        ];
        if (eventType === 'item.completed' && item.type === 'context_compaction' && threadId && turnId) {
          events.push({
            type: 'compact.completed',
            thread_id: threadId,
            turn_id: turnId,
            item_id: item.id,
            source: 'item',
          });
        }
        return events;
      }
      case 'thread/compacted': {
        const turnId = stringValue(params.turnId);
        if (!threadId || !turnId) return [];
        if (expectedTurnId && turnId !== expectedTurnId) return [];
        return [{
          type: 'compact.completed',
          thread_id: threadId,
          turn_id: turnId,
          source: 'thread',
        }];
      }
      case 'turn/completed': {
        const turn = isObject(params.turn) ? params.turn : {};
        const turnId = stringValue(turn.id);
        if (expectedTurnId && turnId && turnId !== expectedTurnId) return [];
        if (turn.status === 'failed') {
          const error = isObject(turn.error)
            ? stringValue(turn.error.message) || 'Codex turn failed'
            : 'Codex turn failed';
          return [{ type: 'turn.failed', error: { message: error }, thread_id: threadId, turn_id: turnId }];
        }
        const usageKey = turnId || expectedTurnId;
        return [{
          type: 'turn.completed',
          usage: (usageKey ? this.lastUsageByTurn.get(usageKey) : undefined) || {
            input_tokens: 0,
            cached_input_tokens: 0,
            output_tokens: 0,
            reasoning_output_tokens: 0,
          },
          thread_id: threadId,
          turn_id: turnId,
        }];
      }
      case 'error': {
        const message = stringValue(params.message) || 'Codex app-server error';
        return [{ type: 'error', message }];
      }
      default:
        return [];
    }
  }
}
