/**
 * Core types for HappyClaw Agent Runner protocol.
 *
 * These types define the contract between the host process and any agent runner.
 * Used by the Claude runner and shared infrastructure.
 */

// ─── StreamEvent (canonical, inline to avoid cross-project sync) ────

export type StreamEventType =
  | 'text_delta' | 'thinking_delta'
  | 'tool_use_start' | 'tool_use_end' | 'tool_progress'
  | 'hook_started' | 'hook_progress' | 'hook_response'
  | 'task_start' | 'task_notification'
  | 'todo_update'
  | 'mode_change'
  | 'usage'
  | 'status' | 'init'
  | 'turn_started' | 'turn_completed';

export interface StreamEvent {
  eventType: StreamEventType;
  text?: string;
  textDelta?: string;
  toolName?: string;
  toolUseId?: string;
  parentToolUseId?: string | null;
  isNested?: boolean;
  skillName?: string;
  toolInputSummary?: string;
  toolOutputSummary?: string;
  elapsedSeconds?: number;
  hookName?: string;
  hookEvent?: string;
  hookOutcome?: string;
  statusText?: string;
  taskDescription?: string;
  taskId?: string;
  taskStatus?: string;
  taskSummary?: string;
  taskAgentType?: string;
  taskAgentName?: string;
  isBackground?: boolean;
  isTeammate?: boolean;
  toolInput?: Record<string, unknown>;
  todos?: Array<{ id: string; content: string; status: 'pending' | 'in_progress' | 'completed' }>;
  permissionMode?: string;
  model?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    costUSD: number;
    durationMs: number;
    numTurns: number;
    modelUsage?: Record<string, { inputTokens: number; outputTokens: number; costUSD: number }>;
  };
  turnId?: string;
  turnStatus?: 'started' | 'completed' | 'interrupted' | 'error' | 'drained';
  turnChannel?: string;
  turnMessageCount?: number;
}

// ─── Container I/O Protocol ─────────────────────────────────

export interface ContainerInput {
  prompt: string;
  runnerId: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isHome?: boolean;
  isAdminHome?: boolean;
  images?: Array<{ data: string; mimeType?: string }>;
  agentId?: string;
  agentName?: string;
  userId?: string;
  turnId?: string;
}

export interface ContainerOutput {
  status: 'success' | 'error' | 'stream' | 'closed' | 'drained';
  result: string | null;
  newSessionId?: string;
  error?: string;
  streamEvent?: StreamEvent;
}
