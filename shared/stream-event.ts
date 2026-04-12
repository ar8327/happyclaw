/**
 * Canonical StreamEvent type definitions.
 *
 * This is the single source of truth. Build step copies this file to:
 *   - container/agent-runner/src/stream-event.types.ts
 *   - src/stream-event.types.ts
 *   - web/src/stream-event.types.ts
 *
 * DO NOT edit the copies directly -- edit this file and run `make build`.
 */

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
  toolName?: string;
  toolUseId?: string;
  parentToolUseId?: string | null;
  isNested?: boolean;
  skillName?: string;
  toolInputSummary?: string;
  elapsedSeconds?: number;
  hookName?: string;
  hookEvent?: string;
  hookOutcome?: string;
  statusText?: string;
  taskDescription?: string;
  taskId?: string;
  taskStatus?: string;
  taskSummary?: string;
  /** Sub-agent type (e.g. "Explore", "code-reviewer", "web-researcher") */
  taskAgentType?: string;
  /** Sub-agent name (user-assigned name for addressing via SendMessage) */
  taskAgentName?: string;
  isBackground?: boolean;
  isTeammate?: boolean;
  toolInput?: Record<string, unknown>;
  todos?: Array<{ id: string; content: string; status: 'pending' | 'in_progress' | 'completed' }>;
  /** Permission mode change (e.g. agent called ExitPlanMode/EnterPlanMode) */
  permissionMode?: string;
  /** Token usage data emitted at query completion */
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
  /** IPC delivery acknowledgement metadata emitted by agent-runner */
  ipcAckSessionId?: string;
  ipcAckTargets?: string[];
  ipcAckSources?: string[];
  ipcAckMessageCount?: number;
  /** Turn lifecycle fields (emitted by host process, not agent-runner) */
  turnId?: string;
  turnStatus?: 'started' | 'completed' | 'interrupted' | 'error' | 'drained';
  turnChannel?: string;
  turnMessageCount?: number;
}
