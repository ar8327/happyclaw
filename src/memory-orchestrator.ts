import {
  MemoryAgentManager,
  exportTranscriptsForUser,
  type MemoryAgentResponse,
} from './memory-agent.js';

export interface MemoryQueryRequest {
  query: string;
  context?: string;
  chatJid?: string;
  groupFolder?: string;
  channelLabel?: string;
}

export type MemoryTypedRequest =
  | { type: 'remember'; content: string; source?: string }
  | { type: 'session_wrapup'; groupFolder: string }
  | { type: 'global_sleep' };

export class MemoryOrchestrator {
  constructor(private readonly manager: MemoryAgentManager) {}

  start(): void {
    this.manager.startIdleChecks();
  }

  stop(): void {
    this.manager.stopIdleChecks();
  }

  query(userId: string, request: MemoryQueryRequest): Promise<MemoryAgentResponse> {
    return this.manager.query(userId, request);
  }

  remember(
    userId: string,
    content: string,
    source?: string,
  ): Promise<MemoryAgentResponse> {
    return this.manager.send(userId, {
      type: 'remember',
      content,
      source,
    });
  }

  sessionWrapup(
    userId: string,
    groupFolder: string,
  ): Promise<MemoryAgentResponse> {
    return this.manager.send(userId, {
      type: 'session_wrapup',
      groupFolder,
    });
  }

  globalSleep(userId: string): Promise<MemoryAgentResponse> {
    return this.manager.send(userId, { type: 'global_sleep' });
  }

  send(userId: string, request: MemoryTypedRequest): Promise<MemoryAgentResponse> {
    return this.manager.send(userId, request as Record<string, unknown>);
  }

  shutdownAll(): Promise<void> {
    return this.manager.shutdownAll();
  }

  exportSessionTranscripts(
    userId: string,
    groupFolder: string,
    chatJid: string,
  ): Promise<MemoryAgentResponse | null> {
    return this.exportTranscripts(userId, groupFolder, [chatJid]);
  }

  exportTranscripts(
    userId: string,
    groupFolder: string,
    chatJids: string[],
  ): Promise<MemoryAgentResponse | null> {
    return exportTranscriptsForUser(
      userId,
      groupFolder,
      chatJids,
      this.manager,
    );
  }
}
