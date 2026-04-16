import {
  normalizeHomeFlags,
} from 'happyclaw-agent-runner-core';

import { createContextManager } from './context-manager-factory.js';
import type { IpcPaths } from './ipc-handler.js';
import type { SessionState } from './session-state.js';
import type { ContainerInput } from './types.js';

type SupportedRunnerId = 'claude' | 'codex';

export function createSystemPromptBuilder(params: {
  runnerId: SupportedRunnerId;
  containerInput: ContainerInput;
  state: SessionState;
  ipcPaths: IpcPaths;
  groupDir: string;
  globalDir: string;
  memoryDir: string;
  skillsDir: string;
}): () => string {
  const {
    runnerId,
    containerInput,
    state,
    ipcPaths,
    groupDir,
    globalDir,
    memoryDir,
    skillsDir,
  } = params;
  const { isHome, isAdminHome } = normalizeHomeFlags(containerInput);
  const projectSkillsDir =
    process.env.HAPPYCLAW_PROJECT_SKILLS_DIR || '/workspace/project-skills';
  const ctxMgr = createContextManager(
    {
      chatJid: containerInput.chatJid,
      groupFolder: containerInput.groupFolder,
      isHome,
      isAdminHome,
      workspaceIpc: ipcPaths.inputDir.replace('/input', ''),
      workspaceGroup: groupDir,
      workspaceGlobal: globalDir,
      workspaceMemory: memoryDir,
      userId: containerInput.userId,
      skillsDirs: [projectSkillsDir, skillsDir].filter(Boolean),
    },
    runnerId === 'claude' ? { nativeCapabilities: ['skills'] } : undefined,
  );

  return () => {
    ctxMgr.updateDynamicContext({
      recentImChannels: state.recentImChannels,
      contextSummary: containerInput.contextSummary,
    });
    return runnerId === 'claude'
      ? ctxMgr.buildAppendPrompt()
      : ctxMgr.buildFullPrompt();
  };
}
