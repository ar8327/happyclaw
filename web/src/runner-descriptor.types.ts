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
  | 'happyclaw'
  | 'claude_settings'
  | 'codex_config'
  | 'profile';

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
}

export interface RunnerRuntimeContract {
  requiredNodePackages?: string[];
  requiredCommands?: string[];
  requiredEnv?: string[];
  auth?: 'none' | 'api_key' | 'oauth' | 'external_cli';
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
  runtimeContract: RunnerRuntimeContract;
  toolContract: RunnerToolContract;
  profileSchema?: Record<string, unknown>;
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
}
