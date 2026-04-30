import {
  normalizeHomeFlags,
} from 'agentdock-agent-runner-core';

import { createContextManager } from './context-manager-factory.js';
import type { SessionState } from './session-state.js';
import type { ContainerInput } from './types.js';
import type { RunnerDescriptor } from './runner-descriptor.types.js';

const HAPPYCLAW_PLUGIN_CAPABILITIES = [
  'messaging',
  'tasks',
  'groups',
  'skills',
  'memory',
  'invoke-agent',
];

function nativeCapabilitiesForRunner(
  descriptor: RunnerDescriptor,
): string[] | undefined {
  const nativeCapabilities: string[] = [];
  if (
    descriptor.toolContract.mode === 'none' ||
    descriptor.capabilities.customTools === 'none'
  ) {
    nativeCapabilities.push(...HAPPYCLAW_PLUGIN_CAPABILITIES);
  }
  if (descriptor.capabilities.skills.includes('native')) {
    nativeCapabilities.push('skills');
  }
  return nativeCapabilities.length > 0
    ? [...new Set(nativeCapabilities)]
    : undefined;
}

function buildPromptForContract(
  descriptor: RunnerDescriptor,
  ctxMgr: ReturnType<typeof createContextManager>,
): string {
  switch (descriptor.promptContract.mode) {
    case 'append':
      return ctxMgr.buildAppendPrompt();
    case 'full_prompt':
    case 'instructions_file':
    case 'system_stdin':
    case 'env':
      return ctxMgr.buildFullPrompt();
    default:
      return ctxMgr.buildFullPrompt();
  }
}

export function createSystemPromptBuilder(params: {
  descriptor: RunnerDescriptor;
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
    descriptor,
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
    { nativeCapabilities: nativeCapabilitiesForRunner(descriptor) },
  );

  return (prompt: string) => {
    state.extractSourceChannels(prompt, imChannelsFile);
    ctxMgr.updateDynamicContext({
      recentImChannels: state.recentImChannels,
      contextSummary: containerInput.contextSummary,
    });
    return buildPromptForContract(descriptor, ctxMgr);
  };
}
