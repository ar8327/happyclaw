/**
 * ContextPlugin interface and ToolDefinition types.
 *
 * Plugins provide tools and system prompt sections to the ContextManager.
 * Each runner adapts ToolDefinition to its provider's native format.
 */

// ─── Plugin Context ─────────────────────────────────────────

export interface PluginContext {
  chatJid: string;
  groupFolder: string;
  isHome: boolean;
  isAdminHome: boolean;
  workspaceIpc: string;
  workspaceGroup: string;
  workspaceGlobal: string;
  workspaceMemory: string;
  userId?: string;
  /** Directories containing skills (SKILL.md files). */
  skillsDirs?: string[];

  // 动态上下文（每轮 query 前可更新）
  recentImChannels?: Set<string>;
  /** Source channel that delivered the latest current user input. */
  currentSourceChannel?: string;
  contextSummary?: string;
  providerInfo?: string; // 如 "Claude Opus 4.6" / "Codex o3-pro"
}

// ─── Tool Types ─────────────────────────────────────────────

export interface ToolResult {
  content: string;
  isError?: boolean;
}

export interface ToolDefinition {
  /** Tool name (e.g. 'send_message', 'memory_query') */
  name: string;
  /** Human-readable description for the LLM */
  description: string;
  /** JSON Schema for the tool's parameters */
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  /** Execute the tool and return a result string */
  execute: (args: Record<string, unknown>) => Promise<ToolResult>;
}

// ─── Plugin Interface ───────────────────────────────────────

export interface ContextPlugin {
  /** Unique plugin name (e.g. 'memory', 'messaging') */
  readonly name: string;

  /** Whether this plugin is active for the given context. */
  isEnabled(ctx: PluginContext): boolean;

  /** Return tool definitions provided by this plugin. */
  getTools(ctx: PluginContext): ToolDefinition[];

  /** Return a system prompt section (empty string if none). */
  getSystemPromptSection(ctx: PluginContext): string;
}
