#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createContextManager } from './context-manager-factory.js';

const WORKSPACE_GROUP = process.env.HAPPYCLAW_WORKSPACE_GROUP || '/workspace/group';
const WORKSPACE_GLOBAL = process.env.HAPPYCLAW_WORKSPACE_GLOBAL || '/workspace/global';
const WORKSPACE_MEMORY = process.env.HAPPYCLAW_WORKSPACE_MEMORY || '/workspace/memory';
const WORKSPACE_IPC = process.env.HAPPYCLAW_WORKSPACE_IPC || '/workspace/ipc';
const GROUP_FOLDER = process.env.HAPPYCLAW_GROUP_FOLDER || 'default';
const CHAT_JID = process.env.HAPPYCLAW_CHAT_JID || '';
const USER_ID = process.env.HAPPYCLAW_USER_ID || '';
const IS_HOME = process.env.HAPPYCLAW_IS_HOME === '1';
const IS_ADMIN_HOME = process.env.HAPPYCLAW_IS_ADMIN_HOME === '1';

function createMcpContextManager() {
  const projectSkillsDir = process.env.HAPPYCLAW_PROJECT_SKILLS_DIR || '/workspace/project-skills';
  const userSkillsDir = process.env.HAPPYCLAW_SKILLS_DIR || '/workspace/user-skills';
  const skillsDirs = [projectSkillsDir, userSkillsDir].filter(Boolean);

  return createContextManager({
    chatJid: CHAT_JID,
    groupFolder: GROUP_FOLDER,
    isHome: IS_HOME,
    isAdminHome: IS_ADMIN_HOME,
    workspaceIpc: WORKSPACE_IPC,
    workspaceGroup: WORKSPACE_GROUP,
    workspaceGlobal: WORKSPACE_GLOBAL,
    workspaceMemory: WORKSPACE_MEMORY,
    userId: USER_ID || undefined,
    skillsDirs,
  });
}

function convertJsonSchemaToZod(schema: Record<string, unknown>): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  const properties = schema.properties as Record<string, unknown> | undefined;
  const required = schema.required as string[] | undefined;

  if (properties) {
    for (const [key] of Object.entries(properties)) {
      const isRequired = required?.includes(key);
      shape[key] = isRequired ? z.any() : z.any().optional();
    }
  }

  return z.object(shape);
}

async function main(): Promise<void> {
  const ctxMgr = createMcpContextManager();
  const tools = ctxMgr.getActiveTools();

  const server = new McpServer({
    name: 'happyclaw',
    version: '1.0.0',
  });

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

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('[happyclaw-mcp-server] Fatal error:', err);
  process.exit(1);
});
