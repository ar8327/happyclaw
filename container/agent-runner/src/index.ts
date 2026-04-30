/**
 * AgentDock Agent Runner — Entry Point
 *
 * Thin entry: reads ContainerInput from stdin, resolves the runner,
 * initializes it, and starts the query loop.
 *
 * Runner-specific logic lives in runners/{runnerId}/.
 * The generic query loop lives in query-loop.ts.
 */

import './env-compat.js';
import fs from 'fs';
import path from 'path';
import type { ContainerInput, ContainerOutput } from './types.js';
export type { StreamEventType, StreamEvent } from './types.js';

import { normalizeHomeFlags } from 'agentdock-agent-runner-core';
import { SessionState } from './session-state.js';
import {
  buildIpcPaths,
  drainIpcInput,
  isInterruptRelatedError,
} from './ipc-handler.js';
import { runQueryLoop } from './query-loop.js';
import { createSystemPromptBuilder } from './system-prompt.js';
import type { AgentRunner } from './runner-interface.js';
import { getRunnerManifest, getSupportedRunnerIds } from './runners/index.js';
import type { RunnerManifest } from './runners/types.js';
import type {
  RunnerDescriptor,
  UserMcpSource,
} from './runner-descriptor.types.js';

type ContainerInputWire = Omit<ContainerInput, 'groupFolder'> & {
  groupFolder?: string;
};

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const WORKSPACE_GROUP =
  process.env.HAPPYCLAW_WORKSPACE_GROUP || '/workspace/group';
const WORKSPACE_GLOBAL =
  process.env.HAPPYCLAW_WORKSPACE_GLOBAL || '/workspace/global';
const WORKSPACE_MEMORY =
  process.env.HAPPYCLAW_WORKSPACE_MEMORY || '/workspace/memory';
const WORKSPACE_IPC = process.env.HAPPYCLAW_WORKSPACE_IPC || '/workspace/ipc';
const WORKSPACE_SKILLS =
  process.env.HAPPYCLAW_SKILLS_DIR || '/workspace/user-skills';

const THINKING_EFFORT = process.env.HAPPYCLAW_THINKING_EFFORT || undefined;

function isEnabledEnv(value: string | undefined): boolean {
  return value === '1' || value === 'true';
}

const EPHEMERAL_SESSION = isEnabledEnv(process.env.HAPPYCLAW_EPHEMERAL_SESSION);
const DISABLE_SYNTHETIC_ARCHIVE = isEnabledEnv(
  process.env.HAPPYCLAW_DISABLE_SYNTHETIC_ARCHIVE,
);

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
  process.stdout.write(
    `${OUTPUT_START_MARKER}\n${line}\n${OUTPUT_END_MARKER}\n`,
  );
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// User MCP servers loader
// ---------------------------------------------------------------------------

function readMcpServersFromJsonFile(filePath: string): Record<string, unknown> {
  try {
    if (!fs.existsSync(filePath)) return {};
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const servers =
      parsed?.mcpServers && typeof parsed.mcpServers === 'object'
        ? parsed.mcpServers
        : parsed?.servers && typeof parsed.servers === 'object'
          ? parsed.servers
          : null;
    return servers && !Array.isArray(servers)
      ? (servers as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function readMcpServersFromEnv(name: string): Record<string, unknown> {
  const raw = process.env[name];
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function readProfileMcpServers(input: ContainerInput): Record<string, unknown> {
  const value = input.runnerConfig?.config?.mcpServers;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function loadMcpServersFromSource(
  source: UserMcpSource,
  input: ContainerInput,
): Record<string, unknown> {
  if (source === 'agentdock' || source === 'happyclaw') {
    return readMcpServersFromEnv('HAPPYCLAW_USER_MCP_SERVERS');
  }
  if (source === 'profile') {
    return readProfileMcpServers(input);
  }
  if (source === 'claude_settings') {
    const candidateFiles = [
      process.env.HAPPYCLAW_WORKSPACE_SESSION
        ? path.join(
            process.env.HAPPYCLAW_WORKSPACE_SESSION,
            '.claude',
            'settings.json',
          )
        : null,
      process.env.CLAUDE_CONFIG_DIR
        ? path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json')
        : null,
    ].filter((value): value is string => !!value);
    return Object.assign({}, ...candidateFiles.map(readMcpServersFromJsonFile));
  }
  if (source === 'codex_config') {
    const candidateFiles = [
      process.env.CODEX_CONFIG_DIR
        ? path.join(process.env.CODEX_CONFIG_DIR, 'config.json')
        : null,
      process.env.HAPPYCLAW_WORKSPACE_SESSION
        ? path.join(
            process.env.HAPPYCLAW_WORKSPACE_SESSION,
            '.codex',
            'config.json',
          )
        : null,
    ].filter((value): value is string => !!value);
    return Object.assign({}, ...candidateFiles.map(readMcpServersFromJsonFile));
  }
  return {};
}

function loadUserMcpServers(
  descriptor: RunnerDescriptor,
  input: ContainerInput,
): Record<string, unknown> {
  if (
    descriptor.toolContract.mode === 'none' ||
    !descriptor.toolContract.supportsUserMcp
  ) {
    return {};
  }
  const sources = descriptor.toolContract.userMcpSources || [];
  return Object.assign(
    {},
    ...sources.map((source) => loadMcpServersFromSource(source, input)),
  );
}

function createUserMcpServerLoader(
  descriptor: RunnerDescriptor,
  input: ContainerInput,
): () => Record<string, unknown> {
  return () => loadUserMcpServers(descriptor, input);
}

function resolveRunnerManifest(input: ContainerInput): RunnerManifest {
  const runnerId = input.runnerId?.trim().toLowerCase();
  if (!runnerId) {
    throw new Error('Missing runnerId in ContainerInput');
  }
  const manifest = getRunnerManifest(runnerId);
  if (manifest) {
    return manifest;
  }
  throw new Error(
    `Unsupported runnerId "${input.runnerId}". Supported runners: ${getSupportedRunnerIds().join(', ')}`,
  );
}

function resolveWorkspaceFolder(input: {
  workspaceFolder?: string;
  groupFolder?: string;
}): string {
  const workspaceFolder =
    input.workspaceFolder?.trim() || input.groupFolder?.trim();
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

function buildInitialSessionSnapshot(
  containerInput: ContainerInput,
): ContainerInput['bootstrapState'] {
  if (!EPHEMERAL_SESSION) {
    return containerInput.bootstrapState;
  }
  const bootstrapState = containerInput.bootstrapState;
  if (!bootstrapState) return undefined;
  return {
    recentImChannels: bootstrapState.recentImChannels,
    imChannelLastSeen: bootstrapState.imChannelLastSeen,
    currentPermissionMode: bootstrapState.currentPermissionMode,
  };
}

function validateDeclaredIpcCapabilities(
  runnerId: string,
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
    declared.runtimeModeSwitch !==
    runner.ipcCapabilities.supportsRuntimeModeSwitch
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

function validateDeclaredRunnerDescriptor(
  manifest: RunnerManifest,
  input: ContainerInput,
): void {
  const declared = input.declaredRunnerDescriptor;
  if (!declared) return;
  const actual = manifest.descriptor;
  const keys = [
    'id',
    'capabilities',
    'lifecycle',
    'promptContract',
    'runtimeContract',
    'toolContract',
    'profileSchema',
    'models',
    'compatibility',
  ] as const;
  const mismatches = keys.filter(
    (key) => JSON.stringify(declared[key]) !== JSON.stringify(actual[key]),
  );
  if (mismatches.length > 0) {
    throw new Error(
      `Runner "${actual.id}" descriptor mismatch: ${mismatches.join(', ')}`,
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
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
  }

  const runnerManifest = resolveRunnerManifest(containerInput);
  const runnerId = runnerManifest.descriptor.id;
  const sessionRecordId = buildSessionRecordId(containerInput);
  log(`Runner: ${runnerId}`);
  validateDeclaredRunnerDescriptor(runnerManifest, containerInput);

  // Initialize session state
  state.loadImChannels(IM_CHANNELS_FILE);
  state.hydrate(buildInitialSessionSnapshot(containerInput));

  // Clean up stale sentinels
  fs.mkdirSync(ipcPaths.inputDir, { recursive: true });
  try {
    fs.unlinkSync(ipcPaths.closeSentinel);
  } catch {
    /* ignore */
  }
  try {
    fs.unlinkSync(ipcPaths.drainSentinel);
  } catch {
    /* ignore */
  }
  try {
    fs.unlinkSync(ipcPaths.interruptSentinel);
  } catch {
    /* ignore */
  }

  // Build initial prompt (drain any pending IPC messages)
  let prompt = containerInput.prompt;
  let promptImages = containerInput.images;
  const pendingDrain = drainIpcInput(ipcPaths, log);
  if (pendingDrain.modeChange) {
    state.currentPermissionMode = pendingDrain.modeChange;
    log(`Initial mode change via IPC: ${pendingDrain.modeChange}`);
  }
  if (pendingDrain.messages.length > 0) {
    log(
      `Draining ${pendingDrain.messages.length} pending IPC messages into initial prompt`,
    );
    prompt += '\n' + pendingDrain.messages.map((m) => m.text).join('\n');
    const pendingImages = pendingDrain.messages.flatMap((m) => m.images || []);
    if (pendingImages.length > 0) {
      promptImages = [...(promptImages || []), ...pendingImages];
    }
  }

  const runner = await runnerManifest.createRunner({
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
    loadUserMcpServers: createUserMcpServerLoader(
      runnerManifest.descriptor,
      containerInput,
    ),
    skillsDir: WORKSPACE_SKILLS,
    disableSyntheticArchive: DISABLE_SYNTHETIC_ARCHIVE,
  });
  validateDeclaredIpcCapabilities(runnerId, containerInput, runner);
  await runner.initialize();

  await runQueryLoop({
    runner,
    buildSystemPrompt: createSystemPromptBuilder({
      descriptor: runnerManifest.descriptor,
      containerInput,
      state,
      workspaceIpc: WORKSPACE_IPC,
      imChannelsFile: IM_CHANNELS_FILE,
      groupDir: WORKSPACE_GROUP,
      globalDir: WORKSPACE_GLOBAL,
      memoryDir: WORKSPACE_MEMORY,
      skillsDir: WORKSPACE_SKILLS,
    }),
    promptContract: runnerManifest.descriptor.promptContract,
    initialPrompt: prompt,
    initialImages: promptImages,
    sessionRecordId,
    sessionId: containerInput.sessionId,
    initialResumeAnchor: containerInput.resumeAnchor,
    ephemeralSession: EPHEMERAL_SESSION,
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

(process.stdout as NodeJS.WriteStream & NodeJS.EventEmitter).on(
  'error',
  (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') process.exit(0);
  },
);
(process.stderr as NodeJS.WriteStream & NodeJS.EventEmitter).on(
  'error',
  (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') process.exit(0);
  },
);

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
  writeOutput({
    status: 'error',
    result: null,
    error: `Unexpected error: ${err}`,
  });
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
