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
export type PromptMode =
  | 'append'
  | 'full_prompt'
  | 'instructions_file'
  | 'system_stdin'
  | 'env';
export type DynamicContextReloadMode = 'none' | 'turn' | 'mid_turn';
export type ToolInjectionMode =
  | 'mcp_stdio'
  | 'mcp_http'
  | 'native_adapter'
  | 'none';
export type UserMcpSource =
  | 'agentdock'
  | 'happyclaw'
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
  /**
   * Used when mode is "env". Runners can override the default system prompt
   * environment variable without adding host-side branches.
   */
  envVar?: string;
  /**
   * Optional environment variable for runners that want the system prompt
   * written to a file. Defaults to AGENTDOCK_SYSTEM_PROMPT_FILE for
   * instructions_file mode.
   */
  fileEnvVar?: string;
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
  relativeToHome?: string;
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

export interface RunnerContextArchiveView {
  statePath?: string;
  pendingFreshSessionPath?: string;
  tokenThresholdSetting?: 'codexArchiveThreshold';
}

export interface RunnerRuntimeStateViews {
  contextArchive?: RunnerContextArchiveView;
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
  runtimeContract: RunnerRuntimeContract;
  toolContract: RunnerToolContract;
  profileSchema?: Record<string, unknown>;
  models?: RunnerModel[];
  compatibility: RunnerCompatibility;
  runtimeStateViews?: RunnerRuntimeStateViews;
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
      midQueryPush: false,
      runtimeModeSwitch: false,
      toolStreaming: 'fine',
      backgroundTasks: true,
      subAgent: 'tool-only',
      customTools: 'mcp',
      mcpTransport: ['stdio'],
      skills: ['native', 'tool-loader'],
      ephemeralSession: true,
      filesystemAccess: true,
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
    description: 'Codex CLI runner with instruction-file prompt injection.',
    defaultModel: 'gpt-5.4',
    modelPatterns: ['^gpt-[a-z0-9._-]+$', '^o[1-9](?:$|[-._])'],
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
      customTools: 'mcp',
      mcpTransport: ['stdio'],
      skills: ['tool-loader'],
      ephemeralSession: true,
      filesystemAccess: true,
    },
    lifecycle: {
      turnBoundary: 'native',
      archivalTrigger: ['turn_threshold', 'cleanup_only'],
      contextShrinkTrigger: 'synthetic',
      beforeToolExecutionGuard: 'sandbox_only',
      hookStreaming: 'none',
      postCompactRepair: 'synthetic',
    },
    promptContract: {
      mode: 'instructions_file',
      dynamicContextReload: 'turn',
    },
    runtimeContract: {
      requiredNodePackages: ['@openai/codex-sdk'],
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
      observability: 'degraded',
    },
    runtimeStateViews: {
      contextArchive: {
        statePath: 'archiveState',
        pendingFreshSessionPath: 'startFreshOnNextTurn',
        tokenThresholdSetting: 'codexArchiveThreshold',
      },
    },
  },
};
