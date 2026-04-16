/**
 * HappyClaw Agent Runner — Entry Point
 *
 * Thin entry: reads ContainerInput from stdin, resolves the runner,
 * initializes it, and starts the query loop.
 *
 * All provider logic lives in providers/claude/ (and future providers/codex/).
 * The generic query loop lives in query-loop.ts.
 */

import fs from 'fs';
import path from 'path';
import type { ContainerInput, ContainerOutput } from './types.js';
export type { StreamEventType, StreamEvent } from './types.js';

import { normalizeHomeFlags } from 'happyclaw-agent-runner-core';
import { SessionState } from './session-state.js';
import {
  buildIpcPaths,
  drainIpcInput,
  isInterruptRelatedError,
} from './ipc-handler.js';
import { runQueryLoop } from './query-loop.js';
import { ClaudeRunner } from './providers/claude/claude-runner.js';
import { CodexRunner } from './providers/codex/codex-runner.js';
import type { AgentRunner } from './runner-interface.js';

type ContainerInputWire = Omit<ContainerInput, 'groupFolder'> & {
  groupFolder?: string;
};

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const WORKSPACE_GROUP = process.env.HAPPYCLAW_WORKSPACE_GROUP || '/workspace/group';
const WORKSPACE_GLOBAL = process.env.HAPPYCLAW_WORKSPACE_GLOBAL || '/workspace/global';
const WORKSPACE_MEMORY = process.env.HAPPYCLAW_WORKSPACE_MEMORY || '/workspace/memory';
const WORKSPACE_IPC = process.env.HAPPYCLAW_WORKSPACE_IPC || '/workspace/ipc';
const WORKSPACE_SKILLS = process.env.HAPPYCLAW_SKILLS_DIR || '/workspace/user-skills';

const CLAUDE_MODEL = process.env.HAPPYCLAW_MODEL || process.env.ANTHROPIC_MODEL || 'opus';
const THINKING_EFFORT = process.env.HAPPYCLAW_THINKING_EFFORT || undefined;

const ipcPaths = buildIpcPaths(WORKSPACE_IPC);
const IM_CHANNELS_FILE = path.join(WORKSPACE_IPC, '.recent-im-channels.json');

const state = new SessionState();

// ---------------------------------------------------------------------------
// Protocol helpers
// ---------------------------------------------------------------------------

const OUTPUT_START_MARKER = '---HAPPYCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---HAPPYCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  const line = JSON.stringify(output);
  process.stdout.write(`${OUTPUT_START_MARKER}\n${line}\n${OUTPUT_END_MARKER}\n`);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// User MCP servers loader
// ---------------------------------------------------------------------------

function loadUserMcpServers(): Record<string, unknown> {
  const candidateFiles = [
    process.env.HAPPYCLAW_WORKSPACE_SESSION
      ? path.join(process.env.HAPPYCLAW_WORKSPACE_SESSION, '.claude', 'settings.json')
      : null,
    process.env.CLAUDE_CONFIG_DIR
      ? path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json')
      : null,
  ].filter((value): value is string => !!value);

  for (const settingsFile of candidateFiles) {
    try {
      if (fs.existsSync(settingsFile)) {
        const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
        if (settings.mcpServers && typeof settings.mcpServers === 'object') {
          return settings.mcpServers;
        }
      }
    } catch {
      /* ignore parse errors */
    }
  }
  return {};
}

// ---------------------------------------------------------------------------
// Runner selection
// ---------------------------------------------------------------------------

type SupportedRunnerId = 'claude' | 'codex';

type RunnerFactoryContext = {
  containerInput: ContainerInput;
  state: SessionState;
  ipcPaths: typeof ipcPaths;
  log: typeof log;
  writeOutput: typeof writeOutput;
  imChannelsFile: string;
  groupDir: string;
  globalDir: string;
  memoryDir: string;
  thinkingEffort?: string;
  loadUserMcpServers: typeof loadUserMcpServers;
  skillsDir: string;
};

const RUNNER_FACTORIES: Record<
  SupportedRunnerId,
  (ctx: RunnerFactoryContext) => AgentRunner
> = {
  claude: (ctx) =>
    new ClaudeRunner({
      ...ctx,
      model: CLAUDE_MODEL,
    }),
  codex: (ctx) =>
    new CodexRunner({
      ...ctx,
      model:
        process.env.HAPPYCLAW_CODEX_MODEL || process.env.OPENAI_MODEL || 'gpt-5.4',
    }),
};

function resolveRunnerId(input: ContainerInput): SupportedRunnerId {
  const runnerId = input.runnerId?.trim().toLowerCase();
  if (!runnerId) {
    throw new Error('Missing runnerId in ContainerInput');
  }
  if (runnerId in RUNNER_FACTORIES) {
    return runnerId as SupportedRunnerId;
  }
  throw new Error(
    `Unsupported runnerId "${input.runnerId}". Supported runners: ${Object.keys(RUNNER_FACTORIES).join(', ')}`,
  );
}

function resolveWorkspaceFolder(input: {
  workspaceFolder?: string;
  groupFolder?: string;
}): string {
  const workspaceFolder = input.workspaceFolder?.trim() || input.groupFolder?.trim();
  if (!workspaceFolder) {
    throw new Error('Missing workspaceFolder in ContainerInput');
  }
  return workspaceFolder;
}

function buildSessionRecordId(containerInput: ContainerInput): string {
  const workspaceFolder = resolveWorkspaceFolder(containerInput);
  return containerInput.agentId
    ? `worker:${containerInput.agentId}`
    : `main:${workspaceFolder}`;
}

function validateDeclaredIpcCapabilities(
  runnerId: SupportedRunnerId,
  input: ContainerInput,
  runner: AgentRunner,
): void {
  const declared = input.declaredIpcCapabilities;
  if (!declared) return;

  const mismatches: string[] = [];
  if (declared.midQueryPush !== runner.ipcCapabilities.supportsMidQueryPush) {
    mismatches.push(
      `midQueryPush descriptor=${declared.midQueryPush} instance=${runner.ipcCapabilities.supportsMidQueryPush}`,
    );
  }
  if (
    declared.runtimeModeSwitch
    !== runner.ipcCapabilities.supportsRuntimeModeSwitch
  ) {
    mismatches.push(
      `runtimeModeSwitch descriptor=${declared.runtimeModeSwitch} instance=${runner.ipcCapabilities.supportsRuntimeModeSwitch}`,
    );
  }

  if (mismatches.length > 0) {
    throw new Error(
      `Runner "${runnerId}" ipcCapabilities mismatch: ${mismatches.join('; ')}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    const parsed = JSON.parse(stdinData) as ContainerInputWire;
    const workspaceFolder = resolveWorkspaceFolder(parsed);
    containerInput = {
      ...parsed,
      workspaceFolder,
      groupFolder: parsed.groupFolder || workspaceFolder,
    };
    log(`Received input for workspace: ${workspaceFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  const runnerId = resolveRunnerId(containerInput);
  const sessionRecordId = buildSessionRecordId(containerInput);
  log(`Runner: ${runnerId}`);

  // Initialize session state
  state.loadImChannels(IM_CHANNELS_FILE);
  state.hydrate(containerInput.bootstrapState);

  // Clean up stale sentinels
  fs.mkdirSync(ipcPaths.inputDir, { recursive: true });
  try { fs.unlinkSync(ipcPaths.closeSentinel); } catch { /* ignore */ }
  try { fs.unlinkSync(ipcPaths.drainSentinel); } catch { /* ignore */ }
  try { fs.unlinkSync(ipcPaths.interruptSentinel); } catch { /* ignore */ }

  // Build initial prompt (drain any pending IPC messages)
  let prompt = containerInput.prompt;
  let promptImages = containerInput.images;
  const pendingDrain = drainIpcInput(ipcPaths, log);
  if (pendingDrain.modeChange) {
    state.currentPermissionMode = pendingDrain.modeChange;
    log(`Initial mode change via IPC: ${pendingDrain.modeChange}`);
  }
  if (pendingDrain.messages.length > 0) {
    log(`Draining ${pendingDrain.messages.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pendingDrain.messages.map((m) => m.text).join('\n');
    const pendingImages = pendingDrain.messages.flatMap((m) => m.images || []);
    if (pendingImages.length > 0) {
      promptImages = [...(promptImages || []), ...pendingImages];
    }
  }

  const runner = RUNNER_FACTORIES[runnerId]({
    containerInput,
    state,
    ipcPaths,
    log,
    writeOutput,
    imChannelsFile: IM_CHANNELS_FILE,
    groupDir: WORKSPACE_GROUP,
    globalDir: WORKSPACE_GLOBAL,
    memoryDir: WORKSPACE_MEMORY,
    thinkingEffort: THINKING_EFFORT,
    loadUserMcpServers,
    skillsDir: WORKSPACE_SKILLS,
  });
  validateDeclaredIpcCapabilities(runnerId, containerInput, runner);
  await runner.initialize();

  await runQueryLoop({
    runner,
    initialPrompt: prompt,
    initialImages: promptImages,
    sessionRecordId,
    sessionId: containerInput.sessionId,
    initialResumeAnchor: containerInput.resumeAnchor,
    state,
    ipcPaths,
    imChannelsFile: IM_CHANNELS_FILE,
    log,
    writeOutput,
  });
}

// ---------------------------------------------------------------------------
// Process event handlers
// ---------------------------------------------------------------------------

(process.stdout as NodeJS.WriteStream & NodeJS.EventEmitter).on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
});
(process.stderr as NodeJS.WriteStream & NodeJS.EventEmitter).on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
});

process.on('SIGTERM', () => {
  log('Received SIGTERM, exiting gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  log('Received SIGINT, exiting gracefully');
  process.exit(0);
});

process.on('uncaughtException', (err: unknown) => {
  const errno = err as NodeJS.ErrnoException;
  if (errno?.code === 'EPIPE') {
    process.exit(0);
  }
  if (state.isWithinInterruptGraceWindow() && isInterruptRelatedError(err)) {
    console.error('Suppressing interrupt-related uncaught exception:', err);
    process.exit(0);
  }
  console.error('Uncaught exception:', err);
  writeOutput({ status: 'error', result: null, error: `Unexpected error: ${err}` });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  if (state.isWithinInterruptGraceWindow() && isInterruptRelatedError(reason)) {
    console.error('Suppressing interrupt-related unhandled rejection:', reason);
    return;
  }
  console.error('Unhandled rejection:', reason);
});

// Start
main().catch((err) => {
  const errorMessage = err instanceof Error ? err.message : String(err);
  log(`Agent error: ${errorMessage}`);
  if (err instanceof Error && err.stack) {
    log(`Agent error stack:\n${err.stack}`);
  }
  writeOutput({ status: 'error', result: null, error: errorMessage });
  process.exit(1);
});
