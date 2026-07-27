import {
  normalizeHomeFlags,
  renderContextBundle,
  type ContextSection,
  type SectionId,
} from 'agentdock-agent-runner-core';

import { createContextManager } from './context-manager-factory.js';
import type { SessionState } from './session-state.js';
import type { ContainerInput } from './types.js';
import {
  nativePluginCapabilitiesForRunner,
  type RunnerDescriptor,
} from './runner-descriptor.types.js';
import type { RenderedRunnerContext } from './runner-interface.js';

export function nativeCapabilitiesForRunner(
  descriptor: RunnerDescriptor,
): string[] | undefined {
  const nativeCapabilities = nativePluginCapabilitiesForRunner(descriptor);
  return nativeCapabilities.length > 0
    ? [...new Set(nativeCapabilities)]
    : undefined;
}

export function createContextBuilder(params: {
  descriptor: RunnerDescriptor;
  containerInput: ContainerInput;
  state: SessionState;
  workspaceIpc: string;
  imChannelsFile: string;
  groupDir: string;
  globalDir: string;
  memoryDir: string;
  skillsDir: string;
}): (prompt: string) => RenderedRunnerContext {
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
  state.setContextSummary(containerInput.contextSummary);
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
      currentSourceChannel: state.getCurrentSourceChannel(),
    },
    { nativeCapabilities: nativeCapabilitiesForRunner(descriptor) },
  );

  return (prompt: string) => {
    state.extractSourceChannels(prompt, imChannelsFile);
    ctxMgr.updateDynamicContext({
      recentImChannels: state.recentImChannels,
      currentSourceChannel: state.getCurrentSourceChannel(),
      contextSummary: state.getContextSummary(),
    });
    const nativeProvides = new Set<SectionId>(
      descriptor.nativeProvides as SectionId[],
    );
    const sections = ctxMgr
      .buildContextBundle()
      .sections.filter((section) => !nativeProvides.has(section.id));
    const sessionSections = sections.filter(
      (section) =>
        section.stability === 'static' || section.stability === 'session',
    );
    const turnSections = sections.filter(
      (section) => section.stability === 'turn',
    );
    const render = (selected: ContextSection[]) =>
      renderContextBundle({ sections: selected });
    return {
      sessionStatic: render(sessionSections),
      turnDynamic: render(turnSections),
      sections,
    };
  };
}

export function createSystemPromptBuilder(
  params: Parameters<typeof createContextBuilder>[0],
): (prompt: string) => string {
  const buildContext = createContextBuilder(params);
  return (prompt: string) => {
    const context = buildContext(prompt);
    return [context.sessionStatic, context.turnDynamic]
      .filter(Boolean)
      .join('\n');
  };
}
