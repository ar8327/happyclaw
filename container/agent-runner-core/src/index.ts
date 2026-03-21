/**
 * happyclaw-agent-runner-core — shared infrastructure for all HappyClaw agent runners.
 *
 * Zero runtime dependencies. Provides:
 * - Protocol types (ContainerInput/Output, StreamEvent)
 * - IPC utilities (read/write/poll)
 * - Plugin system (ContextPlugin, ToolDefinition, ContextManager)
 * - Tool format adapters (OpenAI, Codex, Claude SDK)
 * - System prompt builder
 * - Built-in plugins (Messaging, Tasks, Groups, Memory, FeishuDocs)
 * - Utility functions
 */

// Types
export type {
  ContainerInput,
  ContainerOutput,
  StreamEvent,
  StreamEventType,
} from './types.js';

// Protocol (stdin/stdout/stream events)
export {
  readStdin,
  writeOutput,
  emitStreamEvent,
  createLogger,
  OUTPUT_START_MARKER,
  OUTPUT_END_MARKER,
} from './protocol.js';

// IPC
export type { IpcConfig, IpcMessage } from './ipc.js';
export {
  createIpcConfig,
  shouldClose,
  shouldDrain,
  shouldInterrupt,
  writeIpcFile,
  drainIpcInput,
  waitForIpcMessage,
} from './ipc.js';

// Plugin system
export type {
  PluginContext,
  ToolResult,
  ToolDefinition,
  ContextPlugin,
} from './plugin.js';
export { ContextManager } from './context.js';

// Tool adapters
export type { OpenAIFunctionTool, CodexToolDef } from './tool-adapters.js';
export { toOpenAITools, toCodexTools } from './tool-adapters.js';

// Prompt builder
export { buildBaseSystemPrompt } from './prompt-builder.js';

// Built-in plugins
export { MessagingPlugin } from './plugins/messaging.js';
export { TasksPlugin } from './plugins/tasks.js';
export { GroupsPlugin } from './plugins/groups.js';
export { MemoryPlugin } from './plugins/memory.js';
export type { MemoryPluginOptions } from './plugins/memory.js';
export { FeishuDocsPlugin } from './plugins/feishu-docs.js';
export type { FeishuDocsPluginOptions } from './plugins/feishu-docs.js';
export { CrossModelPlugin } from './plugins/cross-model.js';
export type { CrossModelPluginOptions } from './plugins/cross-model.js';

// Utilities
export {
  shorten,
  redactSensitive,
  summarizeToolInput,
  sanitizeFilename,
  generateFallbackName,
} from './utils.js';
