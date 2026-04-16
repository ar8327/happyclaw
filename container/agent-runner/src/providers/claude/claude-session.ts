import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'child_process';

import { PREDEFINED_AGENTS } from './claude-agent-defs.js';
import { prepareClaudePromptWithImages } from './claude-image-utils.js';

export type ClaudePermissionMode =
  | 'acceptEdits'
  | 'auto'
  | 'bypassPermissions'
  | 'default'
  | 'dontAsk'
  | 'plan';

interface ImageInput {
  data: string;
  mimeType?: string;
}

interface HookConfig {
  type: 'command';
  command: string;
}

interface HookMatcherConfig {
  matcher?: string;
  hooks: HookConfig[];
}

type ClaudeCliEvent = Record<string, unknown>;

class ClaudeSessionExitError extends Error {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;

  constructor(message: string, code: number | null, signal: NodeJS.Signals | null) {
    super(message);
    this.name = 'ClaudeSessionExitError';
    this.code = code;
    this.signal = signal;
  }
}

class AsyncEventQueue<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<{ resolve: () => void; reject: (err: unknown) => void }> = [];
  private closed = false;
  private failure: unknown = null;

  push(item: T): void {
    if (this.closed || this.failure) return;
    this.items.push(item);
    this.waiters.shift()?.resolve();
  }

  close(): void {
    this.closed = true;
    this.waiters.shift()?.resolve();
  }

  fail(err: unknown): void {
    this.failure = err;
    this.waiters.shift()?.reject(err);
  }

  async *iterate(): AsyncGenerator<T> {
    while (true) {
      while (this.items.length > 0) {
        yield this.items.shift()!;
      }
      if (this.failure) throw this.failure;
      if (this.closed) return;
      await new Promise<void>((resolve, reject) => {
        this.waiters.push({ resolve, reject });
      });
    }
  }
}

interface ActiveTurn {
  queue: AsyncEventQueue<ClaudeCliEvent>;
  completed: boolean;
}

interface SpawnState {
  signature: string;
  args: string[];
  env: Record<string, string>;
  config: ClaudeSessionConfig;
  mcpServers: Record<string, unknown>;
}

export interface ClaudeSessionConfig {
  sessionId?: string;
  resumeAt?: string;
  cwd: string;
  additionalDirectories?: string[];
  model?: string;
  thinkingEffort?: string;
  permissionMode?: ClaudePermissionMode;
  builtinTools: string[];
  allowedTools: string[];
  systemPromptAppend: string;
  isHostMode: boolean;
  isHome: boolean;
  isAdminHome: boolean;
  groupFolder: string;
  userId?: string;
  mcpServerPath: string;
  mcpServerEnv: Record<string, string>;
  disableSlashCommands?: boolean;
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
  config: ClaudeSessionConfig,
  mcpServers: Record<string, unknown>,
): Record<string, unknown> {
  return {
    mcpServers: {
      ...mcpServers,
      happyclaw: {
        type: 'stdio',
        command: process.execPath,
        args: [config.mcpServerPath],
        env: config.mcpServerEnv,
      },
    },
  };
}

function buildSettingsConfig(
  config: ClaudeSessionConfig,
  hookHandlerPath: string,
): Record<string, unknown> {
  const hooks: Record<string, HookMatcherConfig[]> = {
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
  };

  if (config.isHostMode) {
    hooks.PreToolUse = [
      {
        matcher: 'Bash',
        hooks: [
          {
            type: 'command',
            command: `${shellEscape(process.execPath)} ${shellEscape(hookHandlerPath)} safety-lite`,
          },
        ],
      },
    ];
  }

  return { hooks };
}

function replaceSessionIdDeep(value: unknown, nextSessionId: string): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => replaceSessionIdDeep(item, nextSessionId));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'sessionId') {
      output[key] = nextSessionId;
      continue;
    }
    output[key] = replaceSessionIdDeep(entry, nextSessionId);
  }
  return output;
}

function extractUserPromptFromTranscriptEntry(entry: Record<string, unknown>): string | null {
  if (entry.type !== 'user') return null;
  const message = entry.message;
  if (!message || typeof message !== 'object') return null;
  const content = (message as Record<string, unknown>).content;
  if (typeof content === 'string') return content;
  return null;
}

function isSupportedResumeAnchor(entry: Record<string, unknown>, anchor: string): boolean {
  if (entry.uuid !== anchor) return false;

  if (entry.type === 'assistant') {
    const content = (entry.message as Record<string, unknown> | undefined)?.content;
    return Array.isArray(content)
      ? content.some((block) => typeof block === 'object' && block !== null && (block as Record<string, unknown>).type === 'text')
      : typeof content === 'string';
  }

  if (entry.type === 'user') {
    const content = (entry.message as Record<string, unknown> | undefined)?.content;
    return Array.isArray(content)
      && content.some((block) => typeof block === 'object' && block !== null && (block as Record<string, unknown>).type === 'tool_result');
  }

  return false;
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
        continue;
      }
      if (entry.isFile() && entry.name === `${sessionId}.jsonl`) {
        return entryPath;
      }
    }
  }

  return null;
}

function forkTranscriptAtAnchor(
  sessionId: string,
  resumeAt: string,
  log: (message: string) => void,
): string | null {
  const transcriptPath = findTranscriptPath(sessionId);
  if (!transcriptPath) {
    log(`Transcript not found for session ${sessionId}`);
    return null;
  }

  const raw = fs.readFileSync(transcriptPath, 'utf-8');
  const lines = raw.split('\n').filter(Boolean);
  const forkSessionId = randomUUID();
  const keptLines: string[] = [];
  let lastPrompt = '';
  let foundAnchor = false;

  for (const line of lines) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      log(`Skipping unparsable transcript line in ${transcriptPath}`);
      continue;
    }

    if (entry.type === 'last-prompt') {
      const prompt = entry.lastPrompt;
      if (typeof prompt === 'string') {
        lastPrompt = prompt;
      }
      if (!foundAnchor) continue;
      break;
    }

    const extractedPrompt = extractUserPromptFromTranscriptEntry(entry);
    if (typeof extractedPrompt === 'string') {
      lastPrompt = extractedPrompt;
    }

    keptLines.push(JSON.stringify(replaceSessionIdDeep(entry, forkSessionId)));

    if (isSupportedResumeAnchor(entry, resumeAt)) {
      foundAnchor = true;
      break;
    }
  }

  if (!foundAnchor) {
    log(`Resume anchor ${resumeAt} not found in transcript ${transcriptPath}`);
    return null;
  }

  if (lastPrompt) {
    keptLines.push(JSON.stringify({
      type: 'last-prompt',
      lastPrompt: lastPrompt,
      sessionId: forkSessionId,
    }));
  }

  const forkPath = path.join(path.dirname(transcriptPath), `${forkSessionId}.jsonl`);
  fs.writeFileSync(forkPath, `${keptLines.join('\n')}\n`);
  return forkSessionId;
}

export class ClaudeSession {
  private child: ChildProcessWithoutNullStreams | null = null;
  private activeTurn: ActiveTurn | null = null;
  private currentSpawnState: SpawnState | null = null;
  private currentSessionId: string | undefined;
  private currentTranscriptPath: string | null = null;
  private readonly tmpDir: string;
  private readonly imagesDir: string;
  private readonly mcpConfigPath: string;
  private readonly settingsPath: string;
  private readonly hookHandlerPath: string;
  private stdoutBuffer = '';
  private capabilityProbed = false;
  private forceForkResume = false;
  private interruptedCurrentTurn = false;
  private startupPromise: Promise<void> | null = null;
  private readonly pendingInputPayloads: string[] = [];
  private log: (msg: string) => void;

  constructor(log: (msg: string) => void) {
    this.log = log;
    this.tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-claude-'));
    this.imagesDir = path.join(this.tmpDir, 'images');
    this.mcpConfigPath = path.join(this.tmpDir, 'mcp-config.json');
    this.settingsPath = path.join(this.tmpDir, 'settings.json');
    this.hookHandlerPath = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      'claude-hook-handler.js',
    );
  }

  private probeCli(): void {
    if (this.capabilityProbed) return;

    const versionResult = spawnSync('claude', ['--version'], { encoding: 'utf8' });
    if (versionResult.error) {
      throw new Error(`Claude CLI 不可用: ${versionResult.error.message}`);
    }
    if (versionResult.status !== 0) {
      throw new Error(`Claude CLI 版本探测失败: ${versionResult.stderr || versionResult.stdout}`);
    }

    const helpResult = spawnSync('claude', ['-p', '--help'], { encoding: 'utf8' });
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

    this.capabilityProbed = true;
  }

  private buildSpawnSignature(
    config: ClaudeSessionConfig,
    mcpServers: Record<string, unknown>,
  ): string {
    const resumeTarget = this.resolveResumeTarget(config);
    return JSON.stringify({
      cwd: config.cwd,
      additionalDirectories: config.additionalDirectories || [],
      model: config.model || 'opus',
      thinkingEffort: config.thinkingEffort || null,
      permissionMode: config.permissionMode || 'bypassPermissions',
      builtinTools: config.builtinTools,
      allowedTools: config.allowedTools,
      systemPromptAppend: config.systemPromptAppend,
      mcpServers,
      agents: PREDEFINED_AGENTS,
      disableSlashCommands: config.disableSlashCommands !== false,
      resumeTarget: resumeTarget || null,
    });
  }

  private resolveResumeTarget(config: ClaudeSessionConfig): string | undefined {
    if (config.sessionId) {
      return config.sessionId;
    }
    if (config.resumeAt && this.currentSessionId) {
      return this.currentSessionId;
    }
    return undefined;
  }

  private canWriteToChild(child: ChildProcessWithoutNullStreams | null = this.child): child is ChildProcessWithoutNullStreams {
    return !!child
      && !child.killed
      && !child.stdin.destroyed
      && !child.stdin.writableEnded;
  }

  private async stopProcess(): Promise<void> {
    const child = this.child;
    if (!child) return;

    const exitPromise = new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
    });

    try {
      child.stdin.end();
    } catch {
    }
    child.kill('SIGTERM');

    const timer = setTimeout(() => {
      if (!child.killed) child.kill('SIGKILL');
    }, 1500);

    await exitPromise.catch(() => {});
    clearTimeout(timer);
    this.child = null;
    this.currentSpawnState = null;
    this.stdoutBuffer = '';
    this.startupPromise = null;
    this.pendingInputPayloads.length = 0;
  }

  private createTurn(): ActiveTurn {
    if (this.activeTurn) {
      throw new Error('ClaudeSession: another turn is already active');
    }
    const turn: ActiveTurn = {
      queue: new AsyncEventQueue<ClaudeCliEvent>(),
      completed: false,
    };
    this.activeTurn = turn;
    this.interruptedCurrentTurn = false;
    return turn;
  }

  private finalizeActiveTurn(err?: unknown): void {
    if (!this.activeTurn) return;
    if (err) {
      this.activeTurn.queue.fail(err);
    } else {
      this.activeTurn.queue.close();
    }
    this.activeTurn.completed = true;
    this.activeTurn = null;
  }

  private handleCliLine(line: string): void {
    if (!line.trim()) return;
    let event: ClaudeCliEvent;
    try {
      event = JSON.parse(line) as ClaudeCliEvent;
    } catch (err) {
      this.log(`Failed to parse Claude CLI line: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    const sessionId = typeof event.session_id === 'string' ? event.session_id : undefined;
    if (sessionId) {
      if (sessionId !== this.currentSessionId) {
        this.currentSessionId = sessionId;
        this.currentTranscriptPath = findTranscriptPath(sessionId);
      } else if (!this.currentTranscriptPath) {
        this.currentTranscriptPath = findTranscriptPath(sessionId);
      }
    }

    if (!this.activeTurn) {
      this.log(`Dropping Claude CLI event outside active turn: ${JSON.stringify(event)}`);
      return;
    }

    this.activeTurn.queue.push(event);
    if (event.type === 'result') {
      this.finalizeActiveTurn();
    }
  }

  private async ensureProcess(
    config: ClaudeSessionConfig,
    mcpServers: Record<string, unknown>,
  ): Promise<void> {
    this.probeCli();

    const signature = this.buildSpawnSignature(config, mcpServers);
    if (this.child && this.currentSpawnState?.signature === signature) {
      return;
    }

    await this.stopProcess();

    const mergedMcpConfig = buildMcpConfig(config, mcpServers);
    const settingsConfig = buildSettingsConfig(config, this.hookHandlerPath);
    fs.writeFileSync(this.mcpConfigPath, JSON.stringify(mergedMcpConfig, null, 2));
    fs.writeFileSync(this.settingsPath, JSON.stringify(settingsConfig, null, 2));

    let resumeSessionId = this.resolveResumeTarget(config);
    if (this.forceForkResume && config.sessionId && config.resumeAt) {
      const forkedSessionId = forkTranscriptAtAnchor(config.sessionId, config.resumeAt, this.log);
      if (forkedSessionId) {
        this.log(`Forked transcript ${config.sessionId} at anchor ${config.resumeAt} -> ${forkedSessionId}`);
        resumeSessionId = forkedSessionId;
      } else {
        this.log(`Transcript fork failed for ${config.sessionId}, falling back to plain resume`);
      }
    }
    this.forceForkResume = false;

    const allowedTools = Array.from(new Set([
      ...config.allowedTools,
      ...listConfiguredMcpAllowedTools(mergedMcpConfig.mcpServers as Record<string, unknown>),
    ]));

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
      config.builtinTools.join(','),
      '--allowedTools',
      allowedTools.join(','),
      '--agents',
      JSON.stringify(PREDEFINED_AGENTS),
      '--append-system-prompt',
      config.systemPromptAppend,
      '--permission-mode',
      config.permissionMode || 'bypassPermissions',
      '--allow-dangerously-skip-permissions',
    ];

    if (config.disableSlashCommands !== false) {
      args.push('--disable-slash-commands');
    }
    if (resumeSessionId) {
      args.push('--resume', resumeSessionId);
    }
    if (config.model) {
      args.push('--model', config.model);
    }
    if (config.thinkingEffort) {
      args.push('--effort', config.thinkingEffort);
    }
    for (const dir of config.additionalDirectories || []) {
      args.push('--add-dir', dir);
    }

    const env = {
      ...process.env as Record<string, string>,
      ...config.mcpServerEnv,
      ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
      HAPPYCLAW_IS_HOME: config.isHome ? '1' : '0',
      HAPPYCLAW_IS_ADMIN_HOME: config.isAdminHome ? '1' : '0',
      HAPPYCLAW_GROUP_FOLDER: config.groupFolder,
      HAPPYCLAW_USER_ID: config.userId || '',
    };

    this.log(`Spawning Claude CLI: claude ${args.map(shellEscape).join(' ')}`);
    const child = spawn('claude', args, {
      cwd: config.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.stdoutBuffer += chunk;
      let newlineIndex = this.stdoutBuffer.indexOf('\n');
      while (newlineIndex >= 0) {
        const line = this.stdoutBuffer.slice(0, newlineIndex);
        this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
        this.handleCliLine(line);
        newlineIndex = this.stdoutBuffer.indexOf('\n');
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      const text = chunk.trim();
      if (text) this.log(`[claude stderr] ${text}`);
    });

    child.on('exit', (code, signal) => {
      const message = `Claude CLI exited with code=${code ?? 'null'} signal=${signal ?? 'null'}`;
      this.log(message);
      this.child = null;
      this.currentSpawnState = null;
      this.stdoutBuffer = '';
      if (this.activeTurn) {
        this.forceForkResume = true;
        this.finalizeActiveTurn(new ClaudeSessionExitError(message, code, signal));
      }
    });

    child.on('error', (err) => {
      this.log(`Claude CLI process error: ${err.message}`);
      if (this.activeTurn) {
        this.forceForkResume = true;
        this.finalizeActiveTurn(err);
      }
    });

    this.child = child;
    this.currentSpawnState = {
      signature,
      args,
      env,
      config,
      mcpServers,
    };
  }

  private flushPendingInputPayloads(): void {
    if (!this.canWriteToChild()) {
      if (this.pendingInputPayloads.length === 0) return;
      throw new Error('Claude CLI stdin is not writable after startup');
    }
    const child = this.child!;
    while (this.pendingInputPayloads.length > 0) {
      child.stdin.write(this.pendingInputPayloads.shift()!);
    }
  }

  run(
    config: ClaudeSessionConfig,
    mcpServers: Record<string, unknown>,
  ): AsyncGenerator<ClaudeCliEvent> {
    const turn = this.createTurn();
    const startupPromise = this.ensureProcess(config, mcpServers)
      .then(() => {
        this.flushPendingInputPayloads();
      })
      .catch((err) => {
        this.finalizeActiveTurn(err);
        throw err;
      });
    this.startupPromise = startupPromise;

    const self = this;
    async function* iterate(): AsyncGenerator<ClaudeCliEvent> {
      await startupPromise;
      self.startupPromise = null;
      for await (const event of turn.queue.iterate()) {
        yield event;
      }
    }

    return iterate();
  }

  pushMessage(text: string, images?: ImageInput[]): string[] {
    if (!this.activeTurn) {
      throw new Error('ClaudeSession.run() not called');
    }

    const prepared = prepareClaudePromptWithImages(text, images, this.imagesDir, this.log);
    const payload = `${JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: prepared.prompt,
      },
    })}\n`;
    if (this.startupPromise) {
      this.pendingInputPayloads.push(payload);
    } else if (this.canWriteToChild()) {
      const child = this.child!;
      child.stdin.write(payload);
    } else if (this.child) {
      throw new Error('Claude CLI stdin is not writable');
    } else {
      throw new Error('ClaudeSession.run() not called');
    }
    return prepared.rejected;
  }

  async interrupt(): Promise<void> {
    if (!this.child) return;
    this.interruptedCurrentTurn = true;
    this.child.kill('SIGINT');
  }

  async compact(): Promise<ClaudeCliEvent[]> {
    if (!this.child) {
      throw new Error('ClaudeSession.compact() called before session start');
    }
    const turn = this.createTurn();
    this.child.stdin.write(`${JSON.stringify({
      type: 'user',
      message: { role: 'user', content: '/compact' },
    })}\n`);

    const events: ClaudeCliEvent[] = [];
    for await (const event of turn.queue.iterate()) {
      events.push(event);
    }
    return events;
  }

  markProcessLost(): void {
    this.forceForkResume = true;
  }

  wasInterrupted(): boolean {
    return this.interruptedCurrentTurn;
  }

  getCurrentSessionId(): string | undefined {
    return this.currentSessionId;
  }

  getCurrentTranscriptPath(): string | null {
    return this.currentTranscriptPath;
  }

  end(): void {
    void this.stopProcess();
  }
}
