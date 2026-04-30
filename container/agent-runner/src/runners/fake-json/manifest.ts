import type { NormalizedMessage } from '../../runner-interface.js';
import type { RunnerDescriptor } from '../../runner-descriptor.types.js';
import { BaseCliRunner, type CliRunnerAdapter } from '../base-cli-runner.js';
import type { RunnerManifest } from '../types.js';

const fakeDescriptor: RunnerDescriptor = {
  id: 'fake-json-runner',
  label: 'Fake JSON Runner',
  description:
    'Contract-test runner that emits normalized events from JSON lines.',
  defaultModel: 'fake-model',
  modelPatterns: ['^fake-'],
  capabilities: {
    sessionResume: 'weak',
    interrupt: 'weak',
    imageInput: false,
    usage: 'exact',
    midQueryPush: false,
    runtimeModeSwitch: false,
    toolStreaming: 'fine',
    backgroundTasks: false,
    subAgent: 'none',
    customTools: 'none',
    mcpTransport: [],
    skills: ['tool-loader'],
    ephemeralSession: true,
    filesystemAccess: false,
  },
  lifecycle: {
    turnBoundary: 'simulated',
    archivalTrigger: ['external'],
    contextShrinkTrigger: 'none',
    beforeToolExecutionGuard: 'none',
    hookStreaming: 'begin_end',
    postCompactRepair: 'none',
  },
  promptContract: {
    mode: 'system_stdin',
    dynamicContextReload: 'turn',
  },
  runtimeContract: {
    requiredCommands: [process.execPath],
    auth: 'none',
    versionArgs: ['--version'],
  },
  toolContract: {
    mode: 'none',
    supportsUserMcp: false,
  },
  profileSchema: {
    type: 'object',
    properties: {
      model: { type: 'string', title: '模型' },
      command: { type: 'string', title: '命令路径' },
    },
    additionalProperties: true,
  },
  models: [{ id: 'fake-model', label: 'Fake Model' }],
  compatibility: {
    chat: 'degraded',
    im: 'unsupported',
    observability: 'full',
  },
};

function fakeCliScript(): string {
  return [
    'const fs = require("fs");',
    'const emit = (value) => console.log(JSON.stringify(value));',
    'const readPromptFile = () => {',
    '  const file = process.env.AGENTDOCK_SYSTEM_PROMPT_FILE;',
    '  if (!file) return "";',
    '  try { return fs.readFileSync(file, "utf8"); } catch { return ""; }',
    '};',
    'let raw = "";',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", (chunk) => { raw += chunk; });',
    'process.stdin.on("end", () => {',
    '  const input = raw ? JSON.parse(raw) : {};',
    '  if (String(input.prompt || "").includes("context-overflow")) {',
    '    console.error("CONTEXT_OVERFLOW: fake context overflow");',
    '    process.exit(42);',
    '  }',
    '  if (String(input.prompt || "").includes("generic-error")) {',
    '    emit({ kind: "error", message: "GENERIC_ERROR: fake provider error", recoverable: false });',
    '    process.exit(1);',
    '  }',
    '  emit({ kind: "session_init", sessionId: "fake-session" });',
    '  emit({ kind: "stream_event", event: { eventType: "init", statusText: "fake init" } });',
    '  emit({ kind: "stream_event", event: { eventType: "text_delta", text: process.env.AGENTDOCK_SYSTEM_PROMPT || readPromptFile() || input.systemPrompt || "hello" } });',
    '  emit({ kind: "stream_event", event: { eventType: "thinking_delta", text: "thinking" } });',
    '  emit({ kind: "stream_event", event: { eventType: "tool_use_start", toolName: "fake_tool", toolUseId: "tool-1" } });',
    '  emit({ kind: "stream_event", event: { eventType: "tool_progress", toolName: "fake_tool", toolUseId: "tool-1", text: "half" } });',
    '  emit({ kind: "stream_event", event: { eventType: "tool_use_end", toolName: "fake_tool", toolUseId: "tool-1", text: "done" } });',
    '  emit({ kind: "resume_anchor", anchor: "fake-anchor" });',
    '  emit({ kind: "result", text: "fake result", usage: { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0, durationMs: 3, numTurns: 1 } });',
    '});',
  ].join('\n');
}

function parseNormalizedLine(line: string): NormalizedMessage[] {
  if (!line.trim()) return [];
  const parsed = JSON.parse(line) as NormalizedMessage;
  return [parsed];
}

function detectFakeRecoverableError(text: unknown) {
  const value = String(text || '');
  if (!value.includes('CONTEXT_OVERFLOW')) return null;
  return {
    message: value.trim(),
    recoverable: true,
    errorType: 'context_overflow' as const,
  };
}

class FakeJsonRunner extends BaseCliRunner {
  readonly ipcCapabilities = {
    supportsMidQueryPush: false,
    supportsRuntimeModeSwitch: false,
  };

  protected readonly adapter: CliRunnerAdapter = {
    buildCommand: () => ({
      command: process.execPath,
      args: ['-e', fakeCliScript()],
    }),
    buildInput: (query) => ({
      stdin: JSON.stringify({
        prompt: query.prompt,
        systemPrompt: query.systemPrompt,
        resumeAt: query.resumeAt,
      }),
    }),
    parseStdoutLine: parseNormalizedLine,
    detectRecoverableError: detectFakeRecoverableError,
  };
}

export const fakeJsonManifest: RunnerManifest = {
  descriptor: fakeDescriptor,
  production: false,
  createRunner: () => new FakeJsonRunner(),
};
