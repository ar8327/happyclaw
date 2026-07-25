export type RunnerId = string;
export type ResumeStrength = 'none' | 'weak' | 'strong';
export type InterruptStrength = 'none' | 'weak' | 'strong';
export type UsageQuality = 'none' | 'approx' | 'exact';
export type ToolStreamingMode = 'none' | 'coarse' | 'fine';
export type SubAgentMode = 'native' | 'tool-only' | 'none';
export type CustomToolsMode = 'native' | 'mcp' | 'none';
export type SkillsMode = 'native' | 'tool-loader';
export type McpTransport = 'stdio' | 'http' | 'sse';
export type TurnBoundaryMode = 'native' | 'simulated';
export type ArchivalTrigger =
  | 'pre_compact'
  | 'post_compact'
  | 'turn_threshold'
  | 'cleanup_only'
  | 'external';
export type ContextShrinkTriggerMode = 'native_event' | 'synthetic' | 'none';
export type BeforeToolExecutionGuardMode =
  | 'native_hook'
  | 'tool_wrapper'
  | 'sandbox_only'
  | 'none';
export type HookStreamingMode = 'none' | 'begin_end' | 'progress';
export type PostCompactRepairMode = 'native' | 'synthetic' | 'none';
export type PromptMode = 'append' | 'instructions_file';
export type DynamicContextReloadMode = 'none' | 'turn' | 'mid_turn';
export type NativeContextSectionId =
  | 'identity'
  | 'environment'
  | 'workspace-instructions'
  | 'global-instructions'
  | 'platform-guidelines'
  | 'context-summary'
  | 'channel-routing'
  | 'memory-index'
  | 'skills-catalog';
export type ToolInjectionMode =
  | 'mcp_stdio'
  | 'mcp_http'
  | 'native_adapter'
  | 'none';
export type UserMcpSource =
  | 'agentdock'
  | 'claude_settings'
  | 'codex_config'
  | 'profile';

export type RunnerAuthProbeType = 'none' | 'required_env' | 'json_file';

export interface RunnerAuthProbeJsonField {
  name: string;
  path: string[];
}

export interface RunnerAuthProbeFile {
  envPath?: string;
  relativeToEnv?: string;
  relativeToHome?: string;
  path?: string;
  requiredJsonPaths?: string[][];
  detailJsonFields?: RunnerAuthProbeJsonField[];
}

export interface RunnerAuthProbe {
  type: RunnerAuthProbeType;
  anyEnv?: string[];
  requiredEnv?: string[];
  files?: RunnerAuthProbeFile[];
}

export interface RunnerCapabilities {
  sessionResume: ResumeStrength;
  interrupt: InterruptStrength;
  imageInput: boolean;
  usage: UsageQuality;
  midQueryPush: boolean;
  runtimeModeSwitch: boolean;
  toolStreaming: ToolStreamingMode;
  backgroundTasks: boolean;
  subAgent: SubAgentMode;
  customTools: CustomToolsMode;
  mcpTransport: McpTransport[];
  skills: SkillsMode[];
  ephemeralSession: boolean;
  filesystemAccess: boolean;
  predefinedSubagents: boolean;
}

export interface RunnerLifecycleCapabilities {
  turnBoundary: TurnBoundaryMode;
  archivalTrigger: ArchivalTrigger[];
  contextShrinkTrigger: ContextShrinkTriggerMode;
  beforeToolExecutionGuard: BeforeToolExecutionGuardMode;
  hookStreaming: HookStreamingMode;
  postCompactRepair: PostCompactRepairMode;
}

export interface RunnerPromptContract {
  mode: PromptMode;
  dynamicContextReload: DynamicContextReloadMode;
}

export interface RunnerRuntimeContract {
  requiredNodePackages?: string[];
  requiredCommands?: string[];
  requiredEnv?: string[];
  configDirEnv?: string;
  modelEnv?: string[];
  modelCatalog?: RunnerModelCatalog;
  availabilityEnv?: string;
  auth?: 'none' | 'api_key' | 'oauth' | 'external_cli';
  authProbe?: RunnerAuthProbe;
  versionArgs?: string[];
}

export interface RunnerModelCatalog {
  type: 'codex_models_cache';
  envPath?: string;
  relativeToEnv?: string;
  extraRelativeToEnv?: string[];
  relativeToHome?: string;
  extraRelativeToHome?: string[];
  defaultModelProvider?: string;
  path?: string;
}

export interface RunnerToolContract {
  mode: ToolInjectionMode;
  supportsUserMcp: boolean;
  userMcpSources?: UserMcpSource[];
  builtinServerName?: string;
}

export interface RunnerCompatibility {
  chat: 'full' | 'degraded' | 'unsupported';
  im: 'full' | 'degraded' | 'unsupported';
  observability: 'full' | 'degraded' | 'unsupported';
}

export interface RunnerDescriptor {
  id: RunnerId;
  label: string;
  description?: string;
  defaultModel?: string;
  modelPatterns?: string[];
  capabilities: RunnerCapabilities;
  lifecycle: RunnerLifecycleCapabilities;
  promptContract: RunnerPromptContract;
  nativeProvides: NativeContextSectionId[];
  runtimeContract: RunnerRuntimeContract;
  toolContract: RunnerToolContract;
  profileSchema?: Record<string, unknown>;
  models?: RunnerModel[];
  compatibility: RunnerCompatibility;
  defaultProfileFactory?: () => Record<string, unknown>;
}

export interface RunnerHealth {
  runnerId: string;
  available: boolean;
  commandDetected?: boolean;
  authenticated?: boolean;
  version?: string;
  details?: Record<string, unknown>;
  missingReasons?: string[];
}

export interface RunnerModel {
  id: string;
  label?: string;
  description?: string;
  modelProvider?: string;
  supportedThinkingEfforts?: string[];
  backendVariants?: Array<{
    id: string;
    label?: string;
    contextWindow?: number;
  }>;
}

const HAPPYCLAW_PLUGIN_CAPABILITIES = [
  'messaging',
  'tasks',
  'groups',
  'skills',
  'memory',
  'invoke-agent',
];

export function nativePluginCapabilitiesForRunner(
  descriptor: RunnerDescriptor,
): string[] {
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
  return [...new Set(nativeCapabilities)];
}

export const RUNNER_DESCRIPTORS: Record<RunnerId, RunnerDescriptor> = {
  claude: {
    id: 'claude',
    label: 'Claude',
    description:
      'Claude Code CLI runner with native turn streaming and MCP tools.',
    defaultModel: 'opus',
    modelPatterns: ['^(opus|sonnet|haiku)$', '^claude-'],
    capabilities: {
      sessionResume: 'weak',
      interrupt: 'weak',
      imageInput: true,
      usage: 'exact',
      midQueryPush: true,
      runtimeModeSwitch: false,
      toolStreaming: 'fine',
      backgroundTasks: true,
      subAgent: 'tool-only',
      customTools: 'mcp',
      mcpTransport: ['stdio'],
      skills: ['native', 'tool-loader'],
      ephemeralSession: true,
      filesystemAccess: true,
      predefinedSubagents: true,
    },
    lifecycle: {
      turnBoundary: 'simulated',
      archivalTrigger: ['pre_compact', 'cleanup_only'],
      contextShrinkTrigger: 'native_event',
      beforeToolExecutionGuard: 'native_hook',
      hookStreaming: 'progress',
      postCompactRepair: 'native',
    },
    promptContract: {
      mode: 'append',
      dynamicContextReload: 'turn',
    },
    nativeProvides: [
      'identity',
      'environment',
      'workspace-instructions',
      'skills-catalog',
    ],
    runtimeContract: {
      requiredCommands: ['claude'],
      modelEnv: ['HAPPYCLAW_MODEL'],
      availabilityEnv: 'HAPPYCLAW_CLAUDE_AVAILABLE',
      auth: 'external_cli',
      authProbe: {
        type: 'json_file',
        anyEnv: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'],
        files: [
          {
            relativeToHome: '.claude/.credentials.json',
            requiredJsonPaths: [
              ['claudeAiOauth', 'accessToken'],
              ['claudeAiOauth', 'refreshToken'],
            ],
            detailJsonFields: [
              { name: 'expiresAt', path: ['claudeAiOauth', 'expiresAt'] },
            ],
          },
        ],
      },
      versionArgs: ['--version'],
    },
    toolContract: {
      mode: 'mcp_stdio',
      supportsUserMcp: true,
      userMcpSources: ['agentdock', 'claude_settings', 'profile'],
      builtinServerName: 'agentdock',
    },
    profileSchema: {
      type: 'object',
      properties: {
        model: {
          type: 'string',
          title: '模型',
          description: '覆盖 Claude Code 使用的模型别名或完整模型名',
        },
        thinkingEffort: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          title: '推理强度',
        },
        command: {
          type: 'string',
          title: '命令路径',
          description: '默认使用 PATH 中的 claude',
        },
      },
      additionalProperties: true,
    },
    models: [
      { id: 'haiku', label: 'Haiku' },
      { id: 'sonnet', label: 'Sonnet' },
      { id: 'opus', label: 'Opus' },
    ],
    compatibility: {
      chat: 'full',
      im: 'full',
      observability: 'full',
    },
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    description: 'Codex app-server runner with native compaction detection.',
    defaultModel: 'gpt-5.4',
    modelPatterns: ['^gpt-[a-z0-9._-]+$', '^o[1-9](?:$|[-._])'],
    capabilities: {
      sessionResume: 'weak',
      interrupt: 'weak',
      imageInput: true,
      usage: 'approx',
      midQueryPush: true,
      runtimeModeSwitch: false,
      toolStreaming: 'coarse',
      backgroundTasks: false,
      subAgent: 'tool-only',
      customTools: 'mcp',
      mcpTransport: ['stdio'],
      skills: ['tool-loader'],
      ephemeralSession: true,
      filesystemAccess: true,
      predefinedSubagents: false,
    },
    lifecycle: {
      turnBoundary: 'native',
      archivalTrigger: ['post_compact', 'cleanup_only'],
      contextShrinkTrigger: 'native_event',
      beforeToolExecutionGuard: 'sandbox_only',
      hookStreaming: 'none',
      postCompactRepair: 'native',
    },
    promptContract: {
      mode: 'instructions_file',
      dynamicContextReload: 'turn',
    },
    nativeProvides: [],
    runtimeContract: {
      requiredNodePackages: [],
      requiredCommands: ['codex'],
      configDirEnv: 'CODEX_CONFIG_DIR',
      modelEnv: ['HAPPYCLAW_CODEX_MODEL'],
      modelCatalog: {
        type: 'codex_models_cache',
        envPath: 'CODEX_HOME',
        relativeToEnv: 'models_cache.json',
        relativeToHome: '.codex/models_cache.json',
      },
      availabilityEnv: 'HAPPYCLAW_CODEX_AVAILABLE',
      auth: 'external_cli',
      authProbe: {
        type: 'json_file',
        anyEnv: ['OPENAI_API_KEY'],
        files: [
          {
            envPath: 'CODEX_HOME',
            relativeToEnv: 'auth.json',
            relativeToHome: '.codex/auth.json',
            requiredJsonPaths: [['tokens']],
            detailJsonFields: [
              { name: 'authMode', path: ['auth_mode'] },
              { name: 'accountId', path: ['tokens', 'account_id'] },
              { name: 'lastRefresh', path: ['last_refresh'] },
            ],
          },
        ],
      },
      versionArgs: ['--version'],
    },
    toolContract: {
      mode: 'mcp_stdio',
      supportsUserMcp: true,
      userMcpSources: ['agentdock', 'codex_config', 'profile'],
      builtinServerName: 'agentdock',
    },
    profileSchema: {
      type: 'object',
      properties: {
        model: {
          type: 'string',
          title: '模型',
          description: '覆盖 Codex CLI 使用的模型',
        },
        thinkingEffort: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          title: '推理强度',
        },
        command: {
          type: 'string',
          title: '命令路径',
          description: '默认使用 PATH 中的 codex',
        },
      },
      additionalProperties: true,
    },
    models: [{ id: 'gpt-5.4', label: 'GPT-5.4' }],
    compatibility: {
      chat: 'full',
      im: 'degraded',
      observability: 'full',
    },
  },
  traex: {
    id: 'traex',
    label: 'TraeX',
    description:
      'TraeX app-server runner with native HappyClaw tool injection.',
    modelPatterns: [
      '^c_[a-z0-9._-]+$',
      '^gpt-[a-z0-9._-]+$',
      '^o[1-9](?:$|[-._])',
    ],
    capabilities: {
      sessionResume: 'weak',
      interrupt: 'weak',
      imageInput: true,
      usage: 'approx',
      midQueryPush: false,
      runtimeModeSwitch: false,
      toolStreaming: 'coarse',
      backgroundTasks: false,
      subAgent: 'tool-only',
      customTools: 'native',
      mcpTransport: [],
      skills: ['tool-loader'],
      ephemeralSession: true,
      filesystemAccess: true,
      predefinedSubagents: false,
    },
    lifecycle: {
      turnBoundary: 'native',
      archivalTrigger: ['post_compact', 'cleanup_only'],
      contextShrinkTrigger: 'native_event',
      beforeToolExecutionGuard: 'sandbox_only',
      hookStreaming: 'none',
      postCompactRepair: 'native',
    },
    promptContract: {
      mode: 'instructions_file',
      dynamicContextReload: 'turn',
    },
    nativeProvides: [],
    runtimeContract: {
      requiredNodePackages: [],
      requiredCommands: ['traex'],
      configDirEnv: 'TRAE_HOME',
      modelEnv: ['HAPPYCLAW_TRAEX_MODEL'],
      modelCatalog: {
        type: 'codex_models_cache',
        envPath: 'TRAE_HOME',
        relativeToEnv: 'cli/models_cache.json',
        extraRelativeToEnv: [
          'model-provider/*/models_cache.json',
          'cli/model-catalog/*/models_cache.json',
        ],
        relativeToHome: '.trae/cli/models_cache.json',
        extraRelativeToHome: [
          '.trae/model-provider/*/models_cache.json',
          '.trae/cli/model-catalog/*/models_cache.json',
        ],
        defaultModelProvider: 'trae',
      },
      availabilityEnv: 'HAPPYCLAW_TRAEX_AVAILABLE',
      auth: 'external_cli',
      authProbe: {
        type: 'json_file',
        anyEnv: ['OPENAI_API_KEY'],
        files: [
          {
            envPath: 'TRAE_HOME',
            relativeToEnv: 'cli/auth.json',
            relativeToHome: '.trae/cli/auth.json',
            requiredJsonPaths: [['auth_mode']],
            detailJsonFields: [
              { name: 'authMode', path: ['auth_mode'] },
              { name: 'userId', path: ['trae', 'user_id'] },
              { name: 'lastRefresh', path: ['last_refresh'] },
            ],
          },
        ],
      },
      versionArgs: ['--version'],
    },
    toolContract: {
      mode: 'native_adapter',
      supportsUserMcp: false,
    },
    profileSchema: {
      type: 'object',
      properties: {
        model: {
          type: 'string',
          title: '模型',
          description: '覆盖 TraeX CLI 使用的模型；留空时使用 CLI 默认模型',
        },
        thinkingEffort: {
          type: 'string',
          enum: ['low', 'medium', 'high', 'xhigh'],
          title: '推理强度',
        },
        modelBackendVariant: {
          type: 'string',
          enum: ['standard', 'max'],
          title: '模型后端变体',
          description:
            'TraeX 模型后端变体；max 仅对模型缓存中声明 max_key 的模型有效。',
        },
        command: {
          type: 'string',
          title: '命令路径',
          description: '默认使用 PATH 中的 traex',
        },
      },
      additionalProperties: true,
    },
    compatibility: {
      chat: 'full',
      im: 'degraded',
      observability: 'degraded',
    },
  },
  agy: {
    id: 'agy',
    label: 'Antigravity',
    description:
      'Google Antigravity CLI (agy) runner，print 模式逐轮调用，会话级隔离 HOME。',
    defaultModel: 'Gemini 3.1 Pro (High)',
    modelPatterns: ['^(Gemini|Claude|GPT-OSS) .+\\(.+\\)$'],
    capabilities: {
      sessionResume: 'weak',
      interrupt: 'weak',
      imageInput: true,
      usage: 'none',
      midQueryPush: false,
      runtimeModeSwitch: false,
      toolStreaming: 'none',
      backgroundTasks: false,
      subAgent: 'none',
      customTools: 'mcp',
      mcpTransport: ['stdio', 'sse'],
      skills: ['tool-loader'],
      ephemeralSession: true,
      filesystemAccess: true,
      predefinedSubagents: false,
    },
    lifecycle: {
      turnBoundary: 'native',
      archivalTrigger: ['turn_threshold', 'cleanup_only'],
      contextShrinkTrigger: 'synthetic',
      beforeToolExecutionGuard: 'none',
      hookStreaming: 'none',
      postCompactRepair: 'synthetic',
    },
    promptContract: {
      mode: 'instructions_file',
      dynamicContextReload: 'turn',
    },
    nativeProvides: [],
    runtimeContract: {
      requiredCommands: ['agy'],
      configDirEnv: 'HAPPYCLAW_AGY_HOME',
      modelEnv: ['HAPPYCLAW_AGY_MODEL'],
      availabilityEnv: 'HAPPYCLAW_AGY_AVAILABLE',
      auth: 'external_cli',
      authProbe: {
        type: 'json_file',
        files: [
          {
            relativeToHome: '.gemini/google_accounts.json',
            requiredJsonPaths: [['active']],
          },
        ],
      },
      versionArgs: ['--version'],
    },
    toolContract: {
      mode: 'mcp_stdio',
      supportsUserMcp: true,
      userMcpSources: ['agentdock', 'profile'],
      builtinServerName: 'agentdock',
    },
    profileSchema: {
      type: 'object',
      properties: {
        model: {
          type: 'string',
          title: '模型',
          description: '覆盖 Antigravity CLI 使用的模型显示名（见 agy models）',
        },
        command: {
          type: 'string',
          title: '命令路径',
          description: '默认使用 PATH 中的 agy',
        },
        compactThresholdTokens: {
          type: 'number',
          title: '压缩阈值 (tokens)',
          description:
            '上下文估算超过该值时自动归档压缩并重开会话，0 关闭（默认 250000）',
        },
      },
      additionalProperties: true,
    },
    models: [
      { id: 'Gemini 3.1 Pro (High)', label: 'Gemini 3.1 Pro (High)' },
      { id: 'Gemini 3.1 Pro (Low)', label: 'Gemini 3.1 Pro (Low)' },
      { id: 'Gemini 3.5 Flash (High)', label: 'Gemini 3.5 Flash (High)' },
      { id: 'Gemini 3.5 Flash (Medium)', label: 'Gemini 3.5 Flash (Medium)' },
      { id: 'Gemini 3.5 Flash (Low)', label: 'Gemini 3.5 Flash (Low)' },
      {
        id: 'Claude Sonnet 4.6 (Thinking)',
        label: 'Claude Sonnet 4.6 (Thinking)',
      },
      {
        id: 'Claude Opus 4.6 (Thinking)',
        label: 'Claude Opus 4.6 (Thinking)',
      },
      { id: 'GPT-OSS 120B (Medium)', label: 'GPT-OSS 120B (Medium)' },
    ],
    compatibility: {
      chat: 'full',
      im: 'degraded',
      observability: 'degraded',
    },
  },
};
