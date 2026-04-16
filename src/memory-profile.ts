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
  ownerKey: string;
  runtimeKey: string;
  primaryFolder: string;
  groupDir: string;
  memorySession: SessionRecord;
}): MemoryProfile {
  const { ownerKey, runtimeKey, primaryFolder, groupDir, memorySession } = params;
  const memoryDir = path.join(DATA_DIR, 'memory', ownerKey);
  const globalDir = path.join(GROUPS_DIR, 'user-global', ownerKey);
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
      is_home: false,
      customCwd: groupDir,
      selected_skills: [],
      mcp_mode: 'custom',
      selected_mcps: [],
      model: memorySession.model || undefined,
      thinking_effort: memorySession.thinking_effort || undefined,
      context_compression: memorySession.context_compression,
      knowledge_extraction: memorySession.knowledge_extraction,
    },
  };
}
