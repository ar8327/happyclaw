import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { spawnSync, type ChildProcessWithoutNullStreams } from 'child_process';
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
import { DEFAULT_ALLOWED_TOOLS, DEFAULT_CLAUDE_BUILTIN_TOOLS } from './config.js';
import { PREDEFINED_AGENTS } from './agent-defs.js';
import { prepareClaudePromptWithImages } from './image-utils.js';
import { StreamEventProcessor } from './event-adapter.js';

export interface ClaudeRunnerOptions {
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
}

interface ClaudeRunnerProviderState extends Record<string, unknown> {
  currentSessionId?: unknown;
  currentTranscriptPath?: unknown;
}

function shellEscape(value: string): string {
  if (value.length === 0) return "''";
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function normalizeMcpToolPrefix(name: string): string {
  return name.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function listConfiguredMcpAllowedTools(mcpServers: Record<string, unknown>): string[] {
  return Object.keys(mcpServers).map((name) => `mcp__${normalizeMcpToolPrefix(name)}__*`);
}

function buildMcpConfig(
  opts: ClaudeRunnerOptions,
  mcpServerPath: string,
  mcpServerEnv: Record<string, string>,
  userMcpServers: Record<string, unknown>,
): Record<string, unknown> {
  const builtinName = opts.builtinMcpServerName || 'agentdock';
  const builtinServer = {
    type: 'stdio',
    command: process.execPath,
    args: [mcpServerPath],
    env: mcpServerEnv,
  };
  return {
    mcpServers: {
      ...userMcpServers,
      [builtinName]: builtinServer,
      ...(builtinName === 'happyclaw' ? {} : { happyclaw: builtinServer }),
    },
  };
}

function buildSettingsConfig(hookHandlerPath: string): Record<string, unknown> {
  return {
    hooks: {
      PreCompact: [
        {
          matcher: '*',
          hooks: [
            {
              type: 'command',
              command: `${shellEscape(process.execPath)} ${shellEscape(hookHandlerPath)} precompact`,
            },
          ],
        },
      ],
    },
  };
}

function resolveAdditionalDirectories(defaultDirs: string[]): string[] {
  const raw = process.env.HAPPYCLAW_ADDITIONAL_DIRECTORIES;
  if (!raw) return defaultDirs;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return defaultDirs;
    return parsed.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
  } catch {
    return defaultDirs;
  }
}

function findTranscriptPath(sessionId: string): string | null {
  const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(projectsRoot)) return null;

  const stack = [projectsRoot];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
      } else if (entry.isFile() && entry.name === `${sessionId}.jsonl`) {
        return entryPath;
      }
    }
  }
  return null;
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

function isImageMimeMismatchError(msg: string): boolean {
  return (
    /image\s+was\s+specified\s+using\s+the\s+image\/[a-z0-9.+-]+\s+media\s+type,\s+but\s+the\s+image\s+appears\s+to\s+be\s+(?:an?\s+)?image\/[a-z0-9.+-]+\s+image/i.test(msg) ||
    /image\/[a-z0-9.+-]+\s+media\s+type.*appears\s+to\s+be.*image\/[a-z0-9.+-]+/i.test(msg)
  );
}

function isUnrecoverableTranscriptError(msg: string): boolean {
  const isImageSizeError =
    /image.*dimensions?\s+exceed/i.test(msg) ||
    /max\s+allowed\s+size.*pixels/i.test(msg);
  const isMimeMismatch = isImageMimeMismatchError(msg);
  const isApiReject = /invalid_request_error/i.test(msg);
  return isApiReject && (isImageSizeError || isMimeMismatch);
}

function isSessionResumeFailedError(msg: string): boolean {
  return [
    /No conversation found with session ID/i,
    /conversation.*not found/i,
    /session.*not found/i,
    /invalid.*resume/i,
  ].some((pattern) => pattern.test(msg));
}

function extractResultText(message: Record<string, unknown>): string | null {
  const result = message.result;
  return typeof result === 'string' ? result : null;
}

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

class ClaudeCliAdapter implements CliRunnerAdapter {
  private readonly opts: ClaudeRunnerOptions;
  private readonly mcpServerPath: string;
  private readonly hookHandlerPath: string;
  private readonly mcpConfigPath: string;
  private readonly settingsPath: string;
  private readonly imagesDir: string;
  private readonly mcpServerEnv: Record<string, string>;
  private readonly streamEventQueue: NormalizedMessage[] = [];
  private readonly probedCommandPaths = new Set<string>();
  private processor: StreamEventProcessor | null = null;
  private currentSessionId: string | null = null;
  private currentTranscriptPath: string | null = null;
  private lastMessageCursor: string | null = null;
  private rejectedImages: string[] = [];
  private toolCallStartedAt: number | null = null;

  constructor(opts: ClaudeRunnerOptions, tmpDir: string) {
    this.opts = opts;
    const { containerInput, groupDir, globalDir, memoryDir } = opts;
    const { isHome, isAdminHome } = normalizeHomeFlags(containerInput);
    const projectSkillsDir =
      process.env.HAPPYCLAW_PROJECT_SKILLS_DIR || '/workspace/project-skills';
    this.mcpServerPath = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      '../../happyclaw-mcp-server.js',
    );
    this.hookHandlerPath = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      './hook-handler.js',
    );
    this.mcpConfigPath = path.join(tmpDir, 'mcp.json');
    this.settingsPath = path.join(tmpDir, 'settings.json');
    this.imagesDir = path.join(tmpDir, 'images');
    this.mcpServerEnv = {
      ...(process.env as Record<string, string>),
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
      HAPPYCLAW_PROJECT_SKILLS_DIR: projectSkillsDir,
    };

    const providerState = opts.state.getProviderState<ClaudeRunnerProviderState>();
    this.currentSessionId =
      typeof providerState?.currentSessionId === 'string'
        ? providerState.currentSessionId
        : null;
    this.currentTranscriptPath =
      typeof providerState?.currentTranscriptPath === 'string'
        ? providerState.currentTranscriptPath
        : null;
    this.lastMessageCursor = opts.state.getLastMessageCursor();
  }

  private probeCli(commandPath: string): void {
    if (this.probedCommandPaths.has(commandPath)) return;

    const versionResult = spawnSync(commandPath, ['--version'], { encoding: 'utf8' });
    if (versionResult.error) {
      throw new Error(`Claude CLI 不可用: ${versionResult.error.message}`);
    }
    if (versionResult.status !== 0) {
      throw new Error(`Claude CLI 版本探测失败: ${versionResult.stderr || versionResult.stdout}`);
    }

    const helpResult = spawnSync(commandPath, ['-p', '--help'], { encoding: 'utf8' });
    if (helpResult.error) {
      throw new Error(`Claude CLI 帮助探测失败: ${helpResult.error.message}`);
    }
    const helpText = `${helpResult.stdout}\n${helpResult.stderr}`;
    const requiredFlags = [
      '--input-format',
      '--output-format',
      '--verbose',
      '--include-partial-messages',
      '--include-hook-events',
      '--mcp-config',
      '--strict-mcp-config',
      '--agents',
      '--disable-slash-commands',
    ];
    const missingFlags = requiredFlags.filter((flag) => !helpText.includes(flag));
    if (missingFlags.length > 0) {
      throw new Error(`Claude CLI 缺少必需参数支持: ${missingFlags.join(', ')}`);
    }

    this.probedCommandPaths.add(commandPath);
  }

  private createProcessor(): StreamEventProcessor {
    const { state } = this.opts;
    return new StreamEventProcessor((output) => {
      if (output.streamEvent) {
        this.streamEventQueue.push({
          kind: 'stream_event',
          event: output.streamEvent,
        });
      }
    }, this.opts.log, (newMode) => {
      state.currentPermissionMode = newMode;
    });
  }

  private drainStreamEvents(): NormalizedMessage[] {
    const output = [...this.streamEventQueue];
    this.streamEventQueue.length = 0;
    return output;
  }

  private updateSessionFromEvent(event: Record<string, unknown>): NormalizedMessage[] {
    const messages: NormalizedMessage[] = [];
    const sessionId = typeof event.session_id === 'string'
      ? event.session_id
      : undefined;
    if (sessionId && sessionId !== this.currentSessionId) {
      this.currentSessionId = sessionId;
      this.currentTranscriptPath = findTranscriptPath(sessionId);
      messages.push({ kind: 'session_init', sessionId });
      messages.push({ kind: 'resume_anchor', anchor: sessionId });
    } else if (sessionId && !this.currentTranscriptPath) {
      this.currentTranscriptPath = findTranscriptPath(sessionId);
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

  private buildResumeTarget(query: QueryConfig): string | undefined {
    return query.sessionId || query.resumeAt || this.currentSessionId || undefined;
  }

  buildCommand(query: QueryConfig): CliCommand {
    this.processor = this.createProcessor();
    this.streamEventQueue.length = 0;
    this.rejectedImages = [];
    this.toolCallStartedAt = null;

    const commandPath = this.opts.command || 'claude';
    this.probeCli(commandPath);

    const userMcpServers = this.opts.loadUserMcpServers();
    const mergedMcpConfig = buildMcpConfig(
      this.opts,
      this.mcpServerPath,
      this.mcpServerEnv,
      userMcpServers,
    );
    fs.writeFileSync(this.mcpConfigPath, JSON.stringify(mergedMcpConfig, null, 2));
    fs.writeFileSync(
      this.settingsPath,
      JSON.stringify(buildSettingsConfig(this.hookHandlerPath), null, 2),
    );

    const allowedTools = Array.from(new Set([
      ...DEFAULT_ALLOWED_TOOLS,
      ...listConfiguredMcpAllowedTools(
        mergedMcpConfig.mcpServers as Record<string, unknown>,
      ),
    ]));
    const resumeTarget = this.buildResumeTarget(query);
    const args = [
      '-p',
      '--verbose',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--include-hook-events',
      '--mcp-config',
      this.mcpConfigPath,
      '--strict-mcp-config',
      '--settings',
      this.settingsPath,
      '--setting-sources',
      'project,user',
      '--tools',
      DEFAULT_CLAUDE_BUILTIN_TOOLS.join(','),
      '--allowedTools',
      allowedTools.join(','),
      '--agents',
      JSON.stringify(PREDEFINED_AGENTS),
      '--append-system-prompt',
      query.systemPrompt,
      '--permission-mode',
      (query.permissionMode ?? this.opts.state.currentPermissionMode) || 'bypassPermissions',
      '--allow-dangerously-skip-permissions',
      '--disable-slash-commands',
    ];
    if (resumeTarget) args.push('--resume', resumeTarget);
    if (this.opts.model) args.push('--model', this.opts.model);
    if (this.opts.thinkingEffort) args.push('--effort', this.opts.thinkingEffort);
    for (const dir of resolveAdditionalDirectories([
      this.opts.globalDir,
      this.opts.memoryDir,
    ])) {
      args.push('--add-dir', dir);
    }

    this.opts.log(
      `Spawning Claude CLI one-shot: ${shellEscape(commandPath)} ${args.map(shellEscape).join(' ')}`,
    );

    return {
      command: commandPath,
      args,
      cwd: this.opts.groupDir,
      env: {
        ...(process.env as Record<string, string>),
        ...this.mcpServerEnv,
        ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
      },
    };
  }

  buildInput(query: QueryConfig): CliInput {
    this.opts.state.extractSourceChannels(query.prompt, this.opts.imChannelsFile);
    const prepared = prepareClaudePromptWithImages(
      query.prompt,
      query.images,
      this.imagesDir,
      this.opts.log,
    );
    this.rejectedImages = prepared.rejected;
    return {
      stdin: `${JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: prepared.prompt,
        },
      })}\n`,
      endStdin: true,
    };
  }

  beforeRun(): NormalizedMessage[] {
    return this.rejectedImages.map((reason) => ({
      kind: 'stream_event',
      event: {
        eventType: 'status',
        statusText: `⚠️ ${reason}`,
      },
    }));
  }

  parseStdoutLine(line: string): NormalizedMessage[] {
    if (!line.trim()) return [];
    const messages: NormalizedMessage[] = [];
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch (err) {
      return [{
        kind: 'error',
        message: `Claude CLI JSON parse error: ${err instanceof Error ? err.message : String(err)}`,
        recoverable: false,
      }];
    }

    messages.push(...this.updateSessionFromEvent(event));
    const processor = this.processor;
    if (!processor) return messages;

    if (event.type === 'stream_event') {
      processor.processStreamEvent(event as any);
      this.updateToolActivity();
      messages.push(...this.drainStreamEvents());
      return messages;
    }
    if (event.type === 'tool_progress') {
      processor.processToolProgress(event as any);
      this.updateToolActivity();
      messages.push(...this.drainStreamEvents());
      return messages;
    }
    if (event.type === 'tool_use_summary') {
      processor.processToolUseSummary(event as any);
      this.updateToolActivity();
      messages.push(...this.drainStreamEvents());
      return messages;
    }
    if (event.type === 'system') {
      const subtype = typeof event.subtype === 'string' ? event.subtype : '';
      if (subtype === 'compact_boundary') {
        messages.push({
          kind: 'stream_event',
          event: {
            eventType: 'lifecycle',
            phase: 'compact_completed',
            repairHints: {
              recentImChannels: this.opts.state.getActiveImChannels(),
            },
          },
        });
        return messages;
      }
      if (subtype === 'task_notification') {
        processor.processTaskNotification(event as any);
        this.updateToolActivity();
        messages.push(...this.drainStreamEvents());
        return messages;
      }
      if (subtype === 'api_retry') {
        messages.push({
          kind: 'stream_event',
          event: {
            eventType: 'status',
            statusText: `api_retry:${event.attempt}/${event.max_retries}`,
          },
        });
        return messages;
      }
      if (processor.processSystemMessage(event as any)) {
        messages.push(...this.drainStreamEvents());
        if (
          subtype === 'hook_started' &&
          event.hook_event === 'PreCompact'
        ) {
          messages.push({
            kind: 'stream_event',
            event: {
              eventType: 'lifecycle',
              phase: 'archive_started',
            },
          });
        }
        if (
          subtype === 'hook_response' &&
          event.hook_event === 'PreCompact'
        ) {
          messages.push({
            kind: 'stream_event',
            event: {
              eventType: 'lifecycle',
              phase: 'archive_completed',
              archivedFolders: [this.opts.containerInput.groupFolder],
            },
          });
        }
        return messages;
      }
    }

    if (event.type === 'user' && !event.parent_tool_use_id) {
      const userContent = (event as any).message?.content;
      if (Array.isArray(userContent)) {
        for (const block of userContent) {
          if (
            block.type === 'tool_result' &&
            block.tool_use_id &&
            Array.isArray(block.content)
          ) {
            const text = block.content
              .map((entry: { text?: string }) => entry.text || '')
              .join('');
            const agentIdMatch = text.match(/agentId:\s*([a-f0-9]+)/);
            if (agentIdMatch && processor.isBackgroundTask(block.tool_use_id)) {
              processor.registerSdkTaskId(agentIdMatch[1], block.tool_use_id);
            }
          }
        }
      }
    }

    if (processor.processSubAgentMessage(event as any)) {
      messages.push(...this.drainStreamEvents());
      return messages;
    }

    if (event.type === 'assistant') {
      if (typeof event.uuid === 'string') {
        this.lastMessageCursor = event.uuid;
      }
      processor.processAssistantMessage(event as any);
      this.updateToolActivity();
      messages.push(...this.drainStreamEvents());
      return messages;
    }

    if (event.type === 'user' && typeof event.uuid === 'string') {
      this.lastMessageCursor = event.uuid;
      return messages;
    }

    if (event.type === 'result') {
      const textResult = extractResultText(event);
      const resultSubtype = typeof event.subtype === 'string'
        ? event.subtype
        : undefined;
      const isCliError =
        event.is_error === true ||
        !!(resultSubtype && resultSubtype.startsWith('error'));
      if (isCliError) {
        const detail =
          textResult?.trim() ||
          `Claude Code execution failed (${resultSubtype || 'unknown'})`;
        processor.resetFullTextAccumulator();
        processor.cleanup();
        messages.push(...this.drainStreamEvents());
        messages.push({
          kind: 'error',
          message: detail,
          recoverable: isContextOverflowError(detail),
          errorType: isContextOverflowError(detail)
            ? 'context_overflow'
            : isUnrecoverableTranscriptError(detail)
              ? 'unrecoverable_transcript'
              : isSessionResumeFailedError(detail)
                ? 'session_resume_failed'
                : undefined,
        });
        return messages;
      }
      if (textResult && isContextOverflowError(textResult)) {
        processor.resetFullTextAccumulator();
        processor.cleanup();
        messages.push(...this.drainStreamEvents());
        messages.push({
          kind: 'error',
          message: textResult,
          recoverable: true,
          errorType: 'context_overflow',
        });
        return messages;
      }
      if (textResult && isUnrecoverableTranscriptError(textResult)) {
        processor.resetFullTextAccumulator();
        processor.cleanup();
        messages.push(...this.drainStreamEvents());
        messages.push({
          kind: 'error',
          message: textResult,
          recoverable: false,
          errorType: 'unrecoverable_transcript',
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
    if (text) this.opts.log(`[claude stderr] ${text}`);
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
    if (isUnrecoverableTranscriptError(text)) {
      return {
        message: text.trim(),
        recoverable: false,
        errorType: 'unrecoverable_transcript' as const,
      };
    }
    if (isSessionResumeFailedError(text)) {
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
      providerState: {
        currentSessionId: this.currentSessionId,
        currentTranscriptPath: this.currentTranscriptPath,
      },
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

export class ClaudeRunner extends BaseCliRunner {
  readonly ipcCapabilities: IpcCapabilities = {
    supportsMidQueryPush: false,
    supportsRuntimeModeSwitch: false,
  };

  protected readonly adapter: ClaudeCliAdapter;
  private readonly tmpDir: string;

  constructor(opts: ClaudeRunnerOptions) {
    super();
    this.tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `agentdock-claude-${randomUUID()}-`));
    this.adapter = new ClaudeCliAdapter(opts, this.tmpDir);
  }

  pushMessage(): string[] {
    return ['当前 Claude runner 已降级为单 turn 进程，不支持运行中追加消息'];
  }

  getRuntimePersistenceSnapshot(): RuntimePersistenceSnapshot {
    return this.adapter.getRuntimePersistenceSnapshot();
  }

  getActivityReport(): ActivityReport {
    const adapterReport = this.adapter.getActivityReport();
    if (adapterReport.hasActiveToolCall || adapterReport.hasPendingBackgroundTasks) {
      return adapterReport;
    }
    return super.getActivityReport();
  }

  async cleanup(): Promise<void> {
    this.adapter.cleanup();
    fs.rmSync(this.tmpDir, { recursive: true, force: true });
  }
}
