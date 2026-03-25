#!/usr/bin/env node
/**
 * Codex MCP Server — independent stdio entry point.
 *
 * Spawned by Codex as an external MCP server process.
 * Bridges agent-runner-core tools to MCP protocol over stdio.
 *
 * Usage: node codex-mcp-server.js
 * (environment variables provide context: HAPPYCLAW_WORKSPACE_*, etc.)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  ContextManager,
  MessagingPlugin,
  TasksPlugin,
  GroupsPlugin,
  MemoryPlugin,
  FeishuDocsPlugin,
  type PluginContext,
  type ToolDefinition,
} from 'happyclaw-agent-runner-core';

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const WORKSPACE_GROUP = process.env.HAPPYCLAW_WORKSPACE_GROUP || '/workspace/group';
const WORKSPACE_GLOBAL = process.env.HAPPYCLAW_WORKSPACE_GLOBAL || '/workspace/global';
const WORKSPACE_MEMORY = process.env.HAPPYCLAW_WORKSPACE_MEMORY || '/workspace/memory';
const WORKSPACE_IPC = process.env.HAPPYCLAW_WORKSPACE_IPC || '/workspace/ipc';
const GROUP_FOLDER = process.env.HAPPYCLAW_GROUP_FOLDER || 'default';
const CHAT_JID = process.env.HAPPYCLAW_CHAT_JID || '';
const USER_ID = process.env.HAPPYCLAW_USER_ID || '';
const IS_HOME = process.env.HAPPYCLAW_IS_HOME === '1';
const IS_ADMIN_HOME = process.env.HAPPYCLAW_IS_ADMIN_HOME === '1';
const API_URL = process.env.HAPPYCLAW_API_URL || 'http://localhost:3000';
const API_TOKEN = process.env.HAPPYCLAW_API_TOKEN || '';

// ---------------------------------------------------------------------------
// Create ContextManager with all plugins
// ---------------------------------------------------------------------------

function createMcpContextManager(): ContextManager {
  const pluginCtx: PluginContext = {
    chatJid: CHAT_JID,
    groupFolder: GROUP_FOLDER,
    isHome: IS_HOME,
    isAdminHome: IS_ADMIN_HOME,
    workspaceIpc: WORKSPACE_IPC,
    workspaceGroup: WORKSPACE_GROUP,
    workspaceGlobal: WORKSPACE_GLOBAL,
    workspaceMemory: WORKSPACE_MEMORY,
    userId: USER_ID || undefined,
  };

  const ctxMgr = new ContextManager(pluginCtx);

  // Register plugins (same set as Claude runner)
  ctxMgr.register(new MessagingPlugin());
  ctxMgr.register(new TasksPlugin());
  ctxMgr.register(new GroupsPlugin());

  if (USER_ID) {
    ctxMgr.register(new MemoryPlugin({
      apiUrl: API_URL,
      apiToken: API_TOKEN,
      queryTimeoutMs: parseInt(process.env.HAPPYCLAW_MEMORY_QUERY_TIMEOUT || '60000', 10),
      sendTimeoutMs: parseInt(process.env.HAPPYCLAW_MEMORY_SEND_TIMEOUT || '120000', 10),
    }));
  }

  if (API_URL && API_TOKEN) {
    ctxMgr.register(new FeishuDocsPlugin({
      apiUrl: API_URL,
      apiToken: API_TOKEN,
    }));
  }

  return ctxMgr;
}

// ---------------------------------------------------------------------------
// Convert core ToolDefinition to MCP tool registration
// ---------------------------------------------------------------------------

function convertJsonSchemaToZod(schema: Record<string, unknown>): z.ZodObject<Record<string, z.ZodTypeAny>> {
  // Simplified conversion: wrap all params as z.any() since the core tools
  // handle their own validation. The MCP protocol just passes through.
  const shape: Record<string, z.ZodTypeAny> = {};
  const properties = schema.properties as Record<string, unknown> | undefined;
  const required = schema.required as string[] | undefined;

  if (properties) {
    for (const [key, _prop] of Object.entries(properties)) {
      const isRequired = required?.includes(key);
      shape[key] = isRequired ? z.any() : z.any().optional();
    }
  }

  return z.object(shape);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const ctxMgr = createMcpContextManager();
  const tools = ctxMgr.getActiveTools();

  const server = new McpServer({
    name: 'happyclaw',
    version: '1.0.0',
  });

  // Register each core tool as an MCP tool
  for (const tool of tools) {
    const zodSchema = convertJsonSchemaToZod(tool.parameters);
    server.tool(
      tool.name,
      tool.description,
      zodSchema.shape,
      async (args: Record<string, unknown>) => {
        const result = await tool.execute(args);
        return {
          content: [{ type: 'text' as const, text: result.content }],
          isError: result.isError,
        };
      },
    );
  }

  // Connect via stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('[codex-mcp-server] Fatal error:', err);
  process.exit(1);
});
