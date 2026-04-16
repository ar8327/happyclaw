/**
 * Shared types for HappyClaw Agent Runner.
 *
 * These types are used across index.ts, stream-processor.ts, and mcp-tools.ts.
 */

// Streaming event types (canonical source: shared/stream-event.ts)
export type { StreamEventType, StreamEvent } from './stream-event.types.js';
import type { StreamEvent } from './stream-event.types.js';

export interface ContainerInput {
  prompt: string;
  runnerId: string;
  sessionId?: string;
  resumeAnchor?: string;
  workspaceFolder?: string;
  groupFolder: string;
  chatJid: string;
  /** Whether this is the user's home container (admin or member). */
  isHome?: boolean;
  /** Whether this is the admin's home container (full privileges). */
  isAdminHome?: boolean;
  images?: Array<{ data: string; mimeType?: string }>;
  agentId?: string;
  agentName?: string;
  /** Owner user ID. Used by memory tools to identify the user. */
  userId?: string;
  /** Turn ID for tracking this execution. */
  turnId?: string;
  /** Compressed conversation summary from previous session. */
  contextSummary?: string;
  bootstrapState?: {
    providerState?: Record<string, unknown>;
    recentImChannels?: string[];
    imChannelLastSeen?: Record<string, number>;
    currentPermissionMode?: string | null;
    lastMessageCursor?: string | null;
  };
}

export interface ContainerOutput {
  status: 'success' | 'error' | 'stream' | 'closed' | 'drained';
  result: string | null;
  newSessionId?: string;
  error?: string;
  streamEvent?: StreamEvent;
  runtimeState?: {
    providerSessionId?: string;
    resumeAnchor?: string;
    providerState?: Record<string, unknown>;
    recentImChannels: string[];
    imChannelLastSeen: Record<string, number>;
    currentPermissionMode: string;
    lastMessageCursor?: string | null;
  };
}

export interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

export interface SessionsIndex {
  entries: SessionEntry[];
}

export interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}
