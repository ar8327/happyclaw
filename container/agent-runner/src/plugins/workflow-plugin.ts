import type {
  ContextPlugin,
  PluginContext,
  ToolDefinition,
  ToolResult,
} from 'agentdock-agent-runner-core';

function apiUrl(): string {
  return process.env.HAPPYCLAW_API_URL || 'http://localhost:3000';
}

function apiToken(): string {
  return process.env.HAPPYCLAW_INTERNAL_TOKEN || '';
}

async function callWorkflowApi(ctx: PluginContext, action: string, payload: Record<string, unknown>): Promise<ToolResult> {
  const token = apiToken();
  if (!token) {
    return { content: 'Workflow API is unavailable: missing internal token.', isError: true };
  }
  const res = await fetch(`${apiUrl()}/api/workflows/internal/tool`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      action,
      userId: ctx.userId,
      groupFolder: ctx.groupFolder,
      workspaceFolder: ctx.workspaceGroup,
      chatJid: ctx.chatJid,
      createdBy: ctx.groupFolder,
      ...payload,
    }),
  });
  const data = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok) {
    return { content: String(data.error || res.statusText), isError: true };
  }
  return { content: JSON.stringify(data, null, 2) };
}

export class WorkflowPlugin implements ContextPlugin {
  readonly name = 'workflow';

  isEnabled(ctx: PluginContext): boolean {
    return !!ctx.userId && !process.env.HAPPYCLAW_WORKFLOW_NODE && !process.env.HAPPYCLAW_INVOKE_DEPTH;
  }

  getTools(ctx: PluginContext): ToolDefinition[] {
    const definitionSchema = {
      type: 'object',
      description: 'Workflow definition. MVP supports DAGs with agent nodes only.',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        settings: {
          type: 'object',
          properties: {
            max_concurrency: { type: 'number' },
            node_timeout_ms: { type: 'number' },
            provider: { type: 'string', description: 'Default provider, e.g. codex, claude, echo' },
            model: { type: 'string' },
            thinking_effort: { type: 'string', enum: ['low', 'medium', 'high', 'max'] },
            retry: {
              type: 'object',
              properties: {
                max_attempts: { type: 'number' },
                backoff_ms: { type: 'number' },
              },
            },
          },
        },
        nodes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              type: { type: 'string', enum: ['agent'] },
              prompt: { type: 'string' },
              provider: { type: 'string' },
              model: { type: 'string' },
              thinking_effort: { type: 'string', enum: ['low', 'medium', 'high', 'max'] },
              depends_on: { type: 'array', items: { type: 'string' } },
              timeout_ms: { type: 'number' },
              max_turns: { type: 'number' },
              retry: {
                type: 'object',
                properties: {
                  max_attempts: { type: 'number' },
                  backoff_ms: { type: 'number' },
                },
              },
            },
            required: ['id', 'type', 'prompt'],
          },
        },
      },
      required: ['nodes'],
    };

    return [
      {
        name: 'workflow_providers',
        description: 'List available bare CLI providers that dynamic workflow nodes can execute.',
        parameters: { type: 'object' as const, properties: {} },
        execute: async () => callWorkflowApi(ctx, 'providers', {}),
      },
      {
        name: 'workflow_create',
        description:
          'Create and persist a dynamic workflow. Workflows are executed by AgentDock host; node agents have no AgentDock tools.',
        parameters: {
          type: 'object' as const,
          properties: {
            name: { type: 'string' },
            description: { type: 'string' },
            definition: definitionSchema,
          },
          required: ['definition'],
        },
        execute: async (args) => callWorkflowApi(ctx, 'create', {
          name: args.name,
          description: args.description,
          definition: args.definition,
          workspaceFolder: ctx.workspaceGroup,
          groupFolder: ctx.groupFolder,
        }),
      },
      {
        name: 'workflow_update',
        description: 'Update a saved workflow. Updating definition increments its version.',
        parameters: {
          type: 'object' as const,
          properties: {
            workflow_id: { type: 'string' },
            name: { type: 'string' },
            description: { type: 'string' },
            definition: definitionSchema,
          },
          required: ['workflow_id'],
        },
        execute: async (args) => callWorkflowApi(ctx, 'update', {
          workflowId: args.workflow_id,
          name: args.name,
          description: args.description,
          definition: args.definition,
          workspaceFolder: ctx.workspaceGroup,
          groupFolder: ctx.groupFolder,
        }),
      },
      {
        name: 'workflow_list',
        description: 'List saved dynamic workflows for the current user.',
        parameters: { type: 'object' as const, properties: {} },
        execute: async () => callWorkflowApi(ctx, 'list', {}),
      },
      {
        name: 'workflow_get',
        description: 'Get a saved workflow definition by id.',
        parameters: {
          type: 'object' as const,
          properties: { workflow_id: { type: 'string' } },
          required: ['workflow_id'],
        },
        execute: async (args) => callWorkflowApi(ctx, 'get', { workflowId: args.workflow_id }),
      },
      {
        name: 'workflow_run',
        description:
          'Start a saved dynamic workflow asynchronously. Returns immediately with run id and initial node statuses; use workflow_run_status to poll.',
        parameters: {
          type: 'object' as const,
          properties: {
            workflow_id: { type: 'string' },
            input: { type: 'object' },
          },
          required: ['workflow_id'],
        },
        execute: async (args) => callWorkflowApi(ctx, 'run', {
          workflowId: args.workflow_id,
          input: args.input,
          workspaceFolder: ctx.workspaceGroup,
        }),
      },
      {
        name: 'workflow_run_status',
        description: 'Get lightweight current status for a workflow run. By default excludes large result payloads.',
        parameters: {
          type: 'object' as const,
          properties: {
            run_id: { type: 'string' },
            include_result: { type: 'boolean' },
            excerpt_length: { type: 'number' },
          },
          required: ['run_id'],
        },
        execute: async (args) => callWorkflowApi(ctx, 'status', {
          runId: args.run_id,
          include_result: args.include_result === true,
          excerpt_length: args.excerpt_length,
        }),
      },
      {
        name: 'workflow_cancel',
        description: 'Cancel a running workflow run.',
        parameters: {
          type: 'object' as const,
          properties: { run_id: { type: 'string' } },
          required: ['run_id'],
        },
        execute: async (args) => callWorkflowApi(ctx, 'cancel', { runId: args.run_id }),
      },
      {
        name: 'workflow_read_node_output',
        description: 'Read the persisted business-text output for a completed workflow node. Debug metadata/log transcript is optional.',
        parameters: {
          type: 'object' as const,
          properties: {
            run_id: { type: 'string' },
            node_id: { type: 'string' },
            include_metadata: { type: 'boolean' },
            include_logs: { type: 'boolean' },
          },
          required: ['run_id', 'node_id'],
        },
        execute: async (args) => callWorkflowApi(ctx, 'read_node_output', {
          runId: args.run_id,
          nodeId: args.node_id,
          include_metadata: args.include_metadata === true,
          include_logs: args.include_logs === true,
        }),
      },
    ];
  }

  getSystemPromptSection(_ctx: PluginContext): string {
    return [
      '## Dynamic Workflows',
      '',
      'You can create, save, run, and monitor dynamic workflows using workflow_* tools.',
      'workflow_run is asynchronous and returns quickly. Poll workflow_run_status for long-running workflows; do not wait in a tool call for workflow completion.',
      'Workflow execution is handled by AgentDock host. Workflow node agents are bare CLI agents and do not receive AgentDock tools such as send_message, memory, tasks, or workflow tools.',
      'The MVP supports DAG workflows with agent nodes. Use depends_on to express dependencies; independent nodes may run concurrently.',
      'Dependency outputs are automatically appended to a dependent node prompt when the prompt does not explicitly reference dependency placeholders such as {{research}} or {{research.output}}.',
    ].join('\n');
  }
}
