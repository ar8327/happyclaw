/**
 * ContextManager — central orchestrator for plugins, tools, and system prompt assembly.
 *
 * Provides two-level prompt API:
 * - buildAppendPrompt(): for Claude (appends to preset)
 * - buildFullPrompt() / writeFullPromptToFile(): for Codex etc.
 * - buildSystemPrompt(): legacy API (calls buildFullPrompt internally)
 */

import fs from 'fs';
import type { ContainerInput } from './types.js';
import type {
  ContextPlugin,
  PluginContext,
  ToolDefinition,
  ToolResult,
} from './plugin.js';
import {
  buildBasePrompt,
  buildAppendPrompt as buildAppendPromptImpl,
  buildContextBundle as buildContextBundleImpl,
  buildFullPrompt as buildFullPromptImpl,
} from './prompt-builder.js';
import {
  renderContextBundle,
  type ContextBundle,
  type RenderContextBundleOptions,
} from './context-bundle.js';

export class ContextManager {
  private plugins: ContextPlugin[] = [];
  private toolMap = new Map<string, ToolDefinition>();
  private readonly ctx: PluginContext;
  private readonly nativeCapabilities: Set<string>;

  constructor(ctx: PluginContext, nativeCapabilities?: string[]) {
    this.ctx = ctx;
    this.nativeCapabilities = new Set(nativeCapabilities ?? []);
  }

  /** Register a plugin. Order matters for system prompt assembly. Returns this for chaining.
   *  Plugins whose name matches a native capability are silently skipped. */
  register(plugin: ContextPlugin): this {
    if (this.nativeCapabilities.has(plugin.name)) {
      return this;
    }
    this.plugins.push(plugin);
    // Rebuild tool map
    if (plugin.isEnabled(this.ctx)) {
      for (const tool of plugin.getTools(this.ctx)) {
        this.toolMap.set(tool.name, tool);
      }
    }
    return this;
  }

  /** Get all active tool definitions across all enabled plugins. */
  getActiveTools(): ToolDefinition[] {
    return Array.from(this.toolMap.values());
  }

  /** Route a tool call to the correct plugin's execute(). */
  async executeTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const tool = this.toolMap.get(name);
    if (!tool) {
      return { content: `Unknown tool: ${name}`, isError: true };
    }
    return tool.execute(args);
  }

  /**
   * Update dynamic context fields before each query.
   * These values may change between queries (e.g., new IM channels discovered).
   */
  updateDynamicContext(updates: {
    recentImChannels?: Set<string>;
    currentSourceChannel?: string;
    contextSummary?: string;
    providerInfo?: string;
  }): void {
    if (updates.recentImChannels !== undefined) {
      this.ctx.recentImChannels = updates.recentImChannels;
    }
    if (updates.currentSourceChannel !== undefined) {
      this.ctx.currentSourceChannel = updates.currentSourceChannel;
    }
    if (updates.contextSummary !== undefined) {
      this.ctx.contextSummary = updates.contextSummary;
    }
    if (updates.providerInfo !== undefined) {
      this.ctx.providerInfo = updates.providerInfo;
    }
  }

  /**
   * Build the append prompt — all guideline segments + plugin contributions.
   * Used by Claude (appends to the claude_code preset).
   */
  buildAppendPrompt(): string {
    return buildAppendPromptImpl(this.ctx, this.plugins);
  }

  /**
   * Build the full prompt = base + append.
   * Used by Codex and other providers without a preset.
   */
  buildFullPrompt(): string {
    return buildFullPromptImpl(this.ctx, this.plugins);
  }

  buildContextBundle(): ContextBundle {
    return buildContextBundleImpl(this.ctx, this.plugins);
  }

  renderContext(options?: RenderContextBundleOptions): string {
    return renderContextBundle(this.buildContextBundle(), options);
  }

  /**
   * Write the full prompt to a file (convenience for Codex's model_instructions_file).
   */
  writeFullPromptToFile(filePath: string): void {
    fs.writeFileSync(filePath, this.buildFullPrompt(), 'utf-8');
  }

  /**
   * Build the full system prompt from base sections + plugin contributions.
   * @deprecated Use buildAppendPrompt() or buildFullPrompt() instead.
   */
  buildSystemPrompt(_input: ContainerInput, providerInfo?: string): string {
    if (providerInfo) {
      this.ctx.providerInfo = providerInfo;
    }
    return this.buildFullPrompt();
  }

  /** Get the plugin context (read-only). */
  getContext(): Readonly<PluginContext> {
    return this.ctx;
  }

  /** Get a specific plugin by name. */
  getPlugin<T extends ContextPlugin>(name: string): T | undefined {
    return this.plugins.find((p) => p.name === name) as T | undefined;
  }
}
