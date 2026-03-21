/**
 * MCP Adapter — thin bridge from agent-runner-core ToolDefinition[] to SDK tool() format.
 *
 * Uses the SDK's `tool()` helper and Zod from the existing dependencies.
 * This replaces the 650+ line mcp-tools.ts with ~80 lines.
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  ContextManager,
  MessagingPlugin,
  TasksPlugin,
  GroupsPlugin,
  MemoryPlugin,
  FeishuDocsPlugin,
  CrossModelPlugin,
  type PluginContext,
} from 'happyclaw-agent-runner-core';

// ─── Context Manager Factory ─────────────────────────────────

export function createContextManager(ctx: PluginContext): ContextManager {
  const API_URL = process.env.HAPPYCLAW_API_URL || 'http://localhost:3000';
  const API_TOKEN = process.env.HAPPYCLAW_INTERNAL_TOKEN || '';

  return new ContextManager(ctx)
    .register(new MessagingPlugin())
    .register(new TasksPlugin())
    .register(new GroupsPlugin())
    .register(new MemoryPlugin({
      apiUrl: API_URL,
      apiToken: API_TOKEN,
      queryTimeoutMs: parseInt(process.env.HAPPYCLAW_MEMORY_QUERY_TIMEOUT || '60000', 10),
      sendTimeoutMs: parseInt(process.env.HAPPYCLAW_MEMORY_SEND_TIMEOUT || '120000', 10),
    }))
    .register(new FeishuDocsPlugin({
      apiUrl: API_URL,
      apiToken: API_TOKEN,
    }))
    .register(new CrossModelPlugin());
}

// ─── SDK Tool Conversion ─────────────────────────────────────

interface ZodChainable {
  optional: () => ZodChainable;
  describe: (desc: string) => ZodChainable;
}

/**
 * Convert a JSON Schema property to a Zod type.
 * Supports simple types used by HappyClaw tools.
 */
function jsonSchemaPropertyToZod(
  prop: { type?: string; description?: string; enum?: string[] },
): ZodChainable {
  if (prop.enum && Array.isArray(prop.enum) && prop.enum.length > 0) {
    return z.enum(prop.enum as [string, ...string[]]) as unknown as ZodChainable;
  }
  switch (prop.type) {
    case 'number':
    case 'integer':
      return z.number() as unknown as ZodChainable;
    case 'boolean':
      return z.boolean() as unknown as ZodChainable;
    default:
      return z.string() as unknown as ZodChainable;
  }
}

/**
 * Convert ContextManager's active tools to SDK SdkMcpToolDefinition[].
 * This is the core of the adapter — replaces the entire mcp-tools.ts.
 */
export function coreToolsToSdkTools(ctxMgr: ContextManager): SdkMcpToolDefinition<any>[] {
  const tools = ctxMgr.getActiveTools();

  return tools.map((t) => {
    // Build Zod shape from JSON Schema parameters
    const schema = t.parameters;
    const requiredSet = new Set(schema.required || []);
    const zodShape: Record<string, unknown> = {};

    for (const [key, propSchema] of Object.entries(schema.properties)) {
      const prop = propSchema as { type?: string; description?: string; enum?: string[] };
      let zodType = jsonSchemaPropertyToZod(prop);

      if (!requiredSet.has(key)) {
        zodType = zodType.optional();
      }
      if (prop.description) {
        zodType = zodType.describe(prop.description);
      }
      zodShape[key] = zodType;
    }

    return tool(
      t.name,
      t.description,
      zodShape as any,
      async (args: Record<string, unknown>) => {
        const result = await t.execute(args);
        return {
          content: [{ type: 'text' as const, text: result.content }],
          isError: result.isError,
        };
      },
    );
  });
}
