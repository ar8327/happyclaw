import path from 'path';

import { DATA_DIR, GROUPS_DIR } from './config.js';
import type { RegisteredGroup, SessionRecord } from './types.js';

export interface MemoryProfile {
  runtimeKey: string;
  primaryFolder: string;
  groupDir: string;
  globalDir: string;
  memoryDir: string;
  allowedDirectories: string[];
  toolProfile: 'memory';
  disableUserMcpServers: boolean;
  registeredGroup: RegisteredGroup;
}

export function buildMemoryProfile(params: {
  userId: string;
  runtimeKey: string;
  primaryFolder: string;
  groupDir: string;
  memorySession: SessionRecord;
}): MemoryProfile {
  const { userId, runtimeKey, primaryFolder, groupDir, memorySession } = params;
  const memoryDir = path.join(DATA_DIR, 'memory', userId);
  const globalDir = path.join(GROUPS_DIR, 'user-global', userId);
  return {
    runtimeKey,
    primaryFolder,
    groupDir,
    globalDir,
    memoryDir,
    allowedDirectories: [globalDir, memoryDir],
    toolProfile: 'memory',
    disableUserMcpServers: true,
    registeredGroup: {
      name: memorySession.name,
      folder: primaryFolder,
      added_at: memorySession.created_at,
      created_by: userId,
      is_home: false,
      customCwd: groupDir,
      selected_skills: [],
      mcp_mode: 'custom',
      selected_mcps: [],
      llm_provider:
        memorySession.runner_id === 'codex'
          ? 'openai'
          : (memorySession.runner_id === 'claude' ? 'claude' : undefined),
      model: memorySession.model || undefined,
      thinking_effort: memorySession.thinking_effort || undefined,
      context_compression: memorySession.context_compression,
      knowledge_extraction: memorySession.knowledge_extraction,
    },
  };
}
