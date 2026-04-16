import {
  normalizeHomeFlags,
} from 'happyclaw-agent-runner-core';

import { createContextManager } from './context-manager-factory.js';
import type { SessionState } from './session-state.js';
import type { ContainerInput } from './types.js';

type SupportedRunnerId = 'claude' | 'codex';

export function createSystemPromptBuilder(params: {
  runnerId: SupportedRunnerId;
  containerInput: ContainerInput;
  state: SessionState;
  workspaceIpc: string;
  imChannelsFile: string;
  groupDir: string;
  globalDir: string;
  memoryDir: string;
  skillsDir: string;
}): (prompt: string) => string {
  const {
    runnerId,
    containerInput,
    state,
    workspaceIpc,
    imChannelsFile,
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
      workspaceIpc,
      workspaceGroup: groupDir,
      workspaceGlobal: globalDir,
      workspaceMemory: memoryDir,
      userId: containerInput.userId,
      skillsDirs: [projectSkillsDir, skillsDir].filter(Boolean),
    },
    runnerId === 'claude' ? { nativeCapabilities: ['skills'] } : undefined,
  );

  return (prompt: string) => {
    state.extractSourceChannels(prompt, imChannelsFile);
    ctxMgr.updateDynamicContext({
      recentImChannels: state.recentImChannels,
      contextSummary: containerInput.contextSummary,
    });
    return runnerId === 'claude'
      ? ctxMgr.buildAppendPrompt()
      : ctxMgr.buildFullPrompt();
  };
}
