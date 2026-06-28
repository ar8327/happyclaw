import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { Worker } from 'worker_threads';

import { DATA_DIR } from './config.js';
import {
  createWorkflow,
  createWorkflowNodeRun,
  createWorkflowRun,
  getWorkflow,
  getWorkflowRun,
  listWorkflowNodeRuns,
  listWorkflowRuns,
  listWorkflows,
  updateWorkflow,
  updateWorkflowNodeRun,
  updateWorkflowRun,
} from './db.js';
import { logger } from './logger.js';
import { getSystemSettings } from './runtime-config.js';
import type {
  WorkflowAgentNode,
  WorkflowDefinition,
  WorkflowKind,
  WorkflowNodeRunRecord,
  WorkflowRecord,
  WorkflowRunRecord,
  WorkflowRunStatus,
} from './types.js';
import { invokeWorkflowNode, listWorkflowProviders } from './workflow-invokers.js';

interface CreateWorkflowInput {
  ownerKey: string;
  name?: string;
  description?: string;
  definition: WorkflowDefinition;
  workspaceFolder?: string | null;
  groupFolder?: string | null;
  createdBy?: string | null;
}

interface RunWorkflowInput {
  ownerKey: string;
  workflowId: string;
  input?: Record<string, unknown> | null;
  workspaceFolder?: string | null;
  wait?: boolean;
  runSource?: string | null;
  trigger?: Record<string, unknown> | null;
}

interface RunScriptWorkflowInput {
  ownerKey: string;
  script: string;
  name?: string;
  description?: string | null;
  settings?: WorkflowDefinition['settings'];
  input?: Record<string, unknown> | null;
  workspaceFolder?: string | null;
  groupFolder?: string | null;
  createdBy?: string | null;
  wait?: boolean;
  runSource?: string | null;
  trigger?: Record<string, unknown> | null;
}

interface WorkflowRunStatusOptions {
  includeResult?: boolean;
  includeTrigger?: boolean;
  excerptLength?: number;
}

interface ReadNodeOutputOptions {
  includeMetadata?: boolean;
  includeLogs?: boolean;
}

interface NodeAttemptRecord {
  attempt: number;
  status: 'success' | 'error';
  provider: string;
  model: string | null;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  error?: string;
  stdout?: string;
  stderr?: string;
}

interface NodeExecutionContext {
  run: WorkflowRunRecord;
  definition: WorkflowDefinition;
  workflow: WorkflowRecord;
  workspaceFolder: string;
  input: Record<string, unknown>;
  outputs: Map<string, string>;
  nodeRunIds: Map<string, string>;
  abortController: AbortController;
}

interface ScriptExecutionContext {
  run: WorkflowRunRecord;
  definition: WorkflowDefinition;
  workflow: WorkflowRecord;
  workspaceFolder: string;
  input: Record<string, unknown>;
  abortController: AbortController;
  currentPhase: string | null;
  phases: Set<string>;
  agentCount: number;
  maxAgents: number;
  timedOut: boolean;
}

interface ScriptAgentInput {
  id?: string;
  name?: string;
  prompt: string;
  input?: unknown;
  provider?: string;
  model?: string;
  thinking_effort?: 'low' | 'medium' | 'high' | 'max';
  timeout_ms?: number;
  max_turns?: number;
  retry?: {
    max_attempts?: number;
    backoff_ms?: number;
  };
}

interface GlobalNodeSlotWaiter {
  resolve: (release: () => void) => void;
  reject: (err: Error) => void;
  signal?: AbortSignal;
  abortHandler: () => void;
}

function nowIso(): string {
  return new Date().toISOString();
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, '_').slice(0, 120) || 'unknown';
}

function parseDefinition(raw: string): WorkflowDefinition {
  return JSON.parse(raw) as WorkflowDefinition;
}

function workflowKind(definition: WorkflowDefinition): WorkflowKind {
  if (definition.kind && definition.kind !== 'dag' && definition.kind !== 'script') {
    throw new Error(`unsupported workflow kind "${String(definition.kind)}"`);
  }
  if (definition.kind === 'script' || typeof definition.script === 'string' || typeof definition.script_path === 'string') {
    return 'script';
  }
  return 'dag';
}

function extractScriptMeta(script: string): { name?: string; description?: string; phases?: string[] } {
  const metaBlock = script.match(/^\s*export\s+const\s+meta\s*=\s*\{([\s\S]*?)\}\s*;?/);
  if (!metaBlock) return {};
  const body = metaBlock[1] || '';
  const name = body.match(/\bname\s*:\s*(['"`])([^'"`]+)\1/)?.[2];
  const description = body.match(/\bdescription\s*:\s*(['"`])([^'"`]+)\1/)?.[2];
  const phasesRaw = body.match(/\bphases\s*:\s*\[([\s\S]*?)\]/)?.[1];
  const phases = phasesRaw
    ? [...phasesRaw.matchAll(/(['"`])([^'"`]+)\1/g)].map((match) => match[2]).filter(Boolean)
    : undefined;
  return { name, description, phases };
}

function buildExecutableWorkflowScript(script: string): string {
  const trimmed = script.trim();
  if (!trimmed.startsWith('export const meta =')) {
    throw new Error('script workflow must start with: export const meta = { name, description }');
  }
  if (/(^|[^\w$])require\s*\(/.test(trimmed)) throw new Error('workflow script cannot call require()');
  if (/(^|[^\w$])import\s*(?:\(|[\w{"'*])/.test(trimmed)) throw new Error('workflow script cannot import modules');
  if (/(^|[^\w$])process\s*\./.test(trimmed)) throw new Error('workflow script cannot access process');
  if (/(^|[^\w$])globalThis\s*\./.test(trimmed)) throw new Error('workflow script cannot access globalThis');
  if (/(^|[^\w$])(?:eval|Function)\s*\(/.test(trimmed)) throw new Error('workflow script cannot generate code dynamically');

  let body = trimmed.replace(/^export\s+const\s+meta\s*=/, 'const meta =');
  body = body.replace(/\bexport\s+default\s+/g, '__workflowResult = ');
  if (/^\s*export\s+/m.test(body)) throw new Error('workflow script only supports export const meta and export default');

  return `
(async () => {
  "use strict";
  let __workflowResult;
${body}
  return {
    meta: typeof meta === 'undefined' ? null : meta,
    result: __workflowResult,
  };
})()
`;
}

function validateScriptDefinition(definition: WorkflowDefinition): void {
  const script = definition.script || safeReadWorkflowFile(definition.script_path);
  if (!script || typeof script !== 'string') {
    throw new Error('script workflow definition requires script or readable script_path');
  }
  if (script.length > 200_000) throw new Error('script workflow exceeds 200000 characters');
  const wrapped = buildExecutableWorkflowScript(script);
  new vm.Script(wrapped, { filename: 'workflow.js' });
  const maxAgents = definition.settings?.max_agents;
  if (maxAgents !== undefined && (!Number.isFinite(maxAgents) || maxAgents < 1 || maxAgents > 1000)) {
    throw new Error('workflow settings.max_agents must be between 1 and 1000');
  }
}

function normalizeDependsOn(node: WorkflowAgentNode): string[] {
  return node.depends_on || [];
}

function assertPlainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function validateDefinition(definition: WorkflowDefinition): void {
  assertPlainObject(definition, 'workflow definition');
  const kind = workflowKind(definition);
  if (kind === 'script') {
    validateScriptDefinition(definition);
    return;
  }

  const nodes = definition.nodes || [];
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new Error('workflow definition must include at least one node');
  }
  if (nodes.length > 100) {
    throw new Error('workflow definition supports at most 100 nodes');
  }

  const seen = new Set<string>();
  for (const node of nodes) {
    assertPlainObject(node, 'workflow node');
    const workflowNode = node as unknown as WorkflowAgentNode;
    if (!workflowNode.id || typeof workflowNode.id !== 'string') {
      throw new Error('workflow node id is required');
    }
    if (!/^[a-zA-Z0-9_.-]+$/.test(workflowNode.id)) {
      throw new Error(`workflow node id "${workflowNode.id}" may only contain letters, numbers, underscore, dot and dash`);
    }
    if (seen.has(workflowNode.id)) throw new Error(`duplicate workflow node id "${workflowNode.id}"`);
    seen.add(workflowNode.id);
    if (workflowNode.type !== 'agent') throw new Error(`unsupported workflow node type "${String(workflowNode.type)}"`);
    if (!workflowNode.prompt || typeof workflowNode.prompt !== 'string') {
      throw new Error(`workflow node "${workflowNode.id}" requires prompt`);
    }
    for (const dep of normalizeDependsOn(workflowNode)) {
      if (!seen.has(dep) && !nodes.some((candidate) => candidate.id === dep)) {
        throw new Error(`workflow node "${workflowNode.id}" depends on unknown node "${dep}"`);
      }
    }
  }

  // Kahn cycle detection.
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const node of nodes) {
    incoming.set(node.id, normalizeDependsOn(node).length);
    for (const dep of normalizeDependsOn(node)) {
      outgoing.set(dep, [...(outgoing.get(dep) || []), node.id]);
    }
  }
  const queue = [...incoming.entries()].filter(([, count]) => count === 0).map(([id]) => id);
  let visited = 0;
  while (queue.length) {
    const id = queue.shift()!;
    visited += 1;
    for (const child of outgoing.get(id) || []) {
      const next = (incoming.get(child) || 0) - 1;
      incoming.set(child, next);
      if (next === 0) queue.push(child);
    }
  }
  if (visited !== nodes.length) throw new Error('workflow definition contains a dependency cycle');
}

function excerpt(output: string, max = 2000): string {
  const trimmed = output.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

function clampExcerptLength(value: number | undefined, fallback = 2000): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(20000, Math.floor(value || 0)));
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function hashPrompt(prompt: string): string {
  return crypto.createHash('sha256').update(prompt).digest('hex');
}

function stringifyWorkflowValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function renderScriptAgentPrompt(input: ScriptAgentInput): string {
  if (input.input === undefined) return input.prompt;
  const renderedInput = stringifyWorkflowValue(input.input);
  const trimmed = renderedInput.length > 20000 ? `${renderedInput.slice(0, 20000)}\n...[truncated]` : renderedInput;
  return `${input.prompt}\n\n## Agent input\n\n${trimmed}`;
}

function renderTemplate(template: string, ctx: NodeExecutionContext): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, key: string) => {
    if (key.startsWith('input.')) {
      const value = key.slice('input.'.length).split('.').reduce<unknown>((acc, part) => {
        if (!acc || typeof acc !== 'object') return undefined;
        return (acc as Record<string, unknown>)[part];
      }, ctx.input);
      return value == null ? '' : String(value);
    }
    const output = ctx.outputs.get(key) || (key.endsWith('.output') ? ctx.outputs.get(key.slice(0, -'.output'.length)) : undefined);
    if (!output) return '';
    return output.length > 12000 ? `${output.slice(0, 12000)}\n...[truncated]` : output;
  });
}

function hasDependencyOutputPlaceholder(template: string, dependencies: string[]): boolean {
  return dependencies.some((dep) => {
    const escaped = dep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\{\\{\\s*${escaped}(?:\\.output)?\\s*\\}\\}`).test(template);
  });
}

function renderNodePrompt(node: WorkflowAgentNode, ctx: NodeExecutionContext): string {
  const rendered = renderTemplate(node.prompt, ctx);
  const dependencies = normalizeDependsOn(node);
  if (dependencies.length === 0 || hasDependencyOutputPlaceholder(node.prompt, dependencies)) {
    return rendered;
  }

  const upstream = dependencies
    .map((dep) => {
      const output = ctx.outputs.get(dep) || '';
      const trimmed = output.trim();
      return [
        `### ${dep}`,
        trimmed.length > 12000 ? `${trimmed.slice(0, 12000)}\n...[truncated]` : trimmed || '(no output)',
      ].join('\n\n');
    })
    .join('\n\n');

  return [
    rendered.trimEnd(),
    '',
    '## Upstream node outputs',
    '',
    'The following sections are the completed outputs of this node’s direct dependencies. Use them as primary source material unless the task explicitly says otherwise.',
    '',
    upstream,
  ].join('\n');
}

function retryConfig(node: WorkflowAgentNode, definition: WorkflowDefinition): { maxAttempts: number; backoffMs: number } {
  const retry = node.retry || definition.settings?.retry;
  const maxAttempts = Math.max(1, Math.min(5, Math.floor(retry?.max_attempts || 1)));
  const backoffMs = Math.max(0, Math.min(60000, Math.floor(retry?.backoff_ms || 3000)));
  return { maxAttempts, backoffMs };
}

function buildRunResult(runId: string): {
  run: WorkflowRunRecord | undefined;
  nodes: WorkflowNodeRunRecord[];
} {
  return {
    run: getWorkflowRun(runId),
    nodes: listWorkflowNodeRuns(runId),
  };
}

function parseRunResult(resultJson: string | null): Record<string, unknown> | null {
  if (!resultJson) return null;
  try {
    return JSON.parse(resultJson) as Record<string, unknown>;
  } catch {
    return { raw: resultJson };
  }
}

function lightweightRun(run: WorkflowRunRecord, options: WorkflowRunStatusOptions = {}) {
  const excerptLength = clampExcerptLength(options.excerptLength);
  const parsedResult = parseRunResult(run.result_json);
  const summary = typeof parsedResult?.summary === 'string' ? parsedResult.summary : '';
  return {
    ...run,
    result_json: options.includeResult ? run.result_json : null,
    trigger_json: options.includeTrigger ? run.trigger_json : null,
    result_excerpt: summary ? excerpt(summary, excerptLength) : null,
  };
}

function lightweightNode(node: WorkflowNodeRunRecord, excerptLength: number): WorkflowNodeRunRecord {
  return {
    ...node,
    output_excerpt: node.output_excerpt ? excerpt(node.output_excerpt, excerptLength) : node.output_excerpt,
  };
}

function safeReadWorkflowFile(filePath: string | null | undefined): string | null {
  if (!filePath) return null;
  const root = path.join(DATA_DIR, 'workflows');
  const resolved = path.resolve(filePath);
  const relative = path.relative(path.resolve(root), resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  if (!fs.existsSync(resolved)) return null;
  return fs.readFileSync(resolved, 'utf8');
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  if (signal?.aborted) throw new Error('Workflow node cancelled');
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abortHandler);
      resolve();
    }, ms);
    timer.unref();
    const abortHandler = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abortHandler);
      reject(new Error('Workflow node cancelled'));
    };
    signal?.addEventListener('abort', abortHandler, { once: true });
  });
}

class WorkflowService {
  private activeRuns = new Map<string, AbortController>();
  private runPromises = new Map<string, Promise<void>>();
  private activeGlobalNodeSlots = 0;
  private globalNodeSlotWaiters: GlobalNodeSlotWaiter[] = [];

  providers() {
    return listWorkflowProviders();
  }

  private globalNodeConcurrencyLimit(): number {
    const configured = getSystemSettings().maxConcurrentWorkflowNodes;
    if (!Number.isFinite(configured)) return 10;
    return Math.max(1, Math.min(50, Math.floor(configured)));
  }

  private readonly releaseGlobalNodeSlot = () => {
    this.activeGlobalNodeSlots = Math.max(0, this.activeGlobalNodeSlots - 1);
    this.drainGlobalNodeSlotWaiters();
  };

  private drainGlobalNodeSlotWaiters() {
    while (
      this.activeGlobalNodeSlots < this.globalNodeConcurrencyLimit() &&
      this.globalNodeSlotWaiters.length > 0
    ) {
      const waiter = this.globalNodeSlotWaiters.shift()!;
      if (waiter.signal?.aborted) {
        waiter.reject(new Error('Workflow node cancelled'));
        continue;
      }
      waiter.signal?.removeEventListener('abort', waiter.abortHandler);
      this.activeGlobalNodeSlots += 1;
      waiter.resolve(this.releaseGlobalNodeSlot);
    }
  }

  private acquireGlobalNodeSlot(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      return Promise.reject(new Error('Workflow node cancelled'));
    }
    if (this.activeGlobalNodeSlots < this.globalNodeConcurrencyLimit()) {
      this.activeGlobalNodeSlots += 1;
      return Promise.resolve(this.releaseGlobalNodeSlot);
    }
    return new Promise((resolve, reject) => {
      const waiter: GlobalNodeSlotWaiter = {
        resolve,
        reject,
        signal,
        abortHandler: () => {
          this.globalNodeSlotWaiters = this.globalNodeSlotWaiters.filter((item) => item !== waiter);
          reject(new Error('Workflow node cancelled'));
        },
      };
      signal?.addEventListener('abort', waiter.abortHandler, { once: true });
      this.globalNodeSlotWaiters.push(waiter);
      this.drainGlobalNodeSlotWaiters();
    });
  }

  list(ownerKey: string) {
    return listWorkflows(ownerKey).map((workflow) => ({
      ...workflow,
      definition: parseDefinition(workflow.definition_json),
    }));
  }

  get(ownerKey: string, id: string) {
    const workflow = getWorkflow(id, ownerKey);
    if (!workflow) return null;
    return { ...workflow, definition: parseDefinition(workflow.definition_json) };
  }

  create(input: CreateWorkflowInput) {
    const kind = workflowKind(input.definition);
    const definition: WorkflowDefinition = { ...input.definition, kind };
    validateDefinition(definition);
    const meta = kind === 'script' && definition.script ? extractScriptMeta(definition.script) : {};
    const now = nowIso();
    const id = crypto.randomUUID();
    const name = input.name || definition.name || meta.name || `Workflow ${id.slice(0, 8)}`;
    const description = input.description || definition.description || meta.description || null;
    const record: WorkflowRecord = {
      id,
      owner_key: input.ownerKey,
      name,
      description,
      kind,
      version: 1,
      definition_json: JSON.stringify(definition, null, 2),
      workspace_folder: input.workspaceFolder || null,
      group_folder: input.groupFolder || null,
      created_by: input.createdBy || null,
      status: 'active',
      created_at: now,
      updated_at: now,
    };
    createWorkflow(record);
    return { ...record, definition };
  }

  update(ownerKey: string, id: string, patch: Partial<CreateWorkflowInput>) {
    const existing = getWorkflow(id, ownerKey);
    if (!existing) return null;
    const rawDefinition = patch.definition || parseDefinition(existing.definition_json);
    const kind = workflowKind(rawDefinition);
    const definition: WorkflowDefinition = { ...rawDefinition, kind };
    validateDefinition(definition);
    const nextVersion = existing.version + (patch.definition ? 1 : 0);
    const now = nowIso();
    updateWorkflow(id, ownerKey, {
      name: patch.name || definition.name || existing.name,
      description: patch.description ?? definition.description ?? existing.description,
      kind,
      version: nextVersion,
      definition_json: JSON.stringify(definition, null, 2),
      workspace_folder: patch.workspaceFolder !== undefined ? patch.workspaceFolder : existing.workspace_folder,
      group_folder: patch.groupFolder !== undefined ? patch.groupFolder : existing.group_folder,
      updated_at: now,
    });
    return this.get(ownerKey, id);
  }

  archive(ownerKey: string, id: string): boolean {
    const workflow = getWorkflow(id, ownerKey);
    if (!workflow) return false;
    updateWorkflow(id, ownerKey, { status: 'archived', updated_at: nowIso() });
    return true;
  }

  runs(ownerKey: string, workflowId?: string, limit?: number, options: WorkflowRunStatusOptions = {}) {
    const excerptLength = clampExcerptLength(options.excerptLength);
    return listWorkflowRuns(ownerKey, workflowId, limit).map((run) => ({
      ...lightweightRun(run, options),
      nodes: listWorkflowNodeRuns(run.id).map((node) => lightweightNode(node, excerptLength)),
    }));
  }

  runStatus(ownerKey: string, runId: string, options: WorkflowRunStatusOptions = {}) {
    const run = getWorkflowRun(runId, ownerKey);
    if (!run) return null;
    const excerptLength = clampExcerptLength(options.excerptLength);
    return {
      ...lightweightRun(run, options),
      nodes: listWorkflowNodeRuns(runId).map((node) => lightweightNode(node, excerptLength)),
    };
  }

  async startRun(input: RunWorkflowInput) {
    const workflow = getWorkflow(input.workflowId, input.ownerKey);
    if (!workflow) throw new Error('Workflow not found');
    if (workflow.status === 'archived') throw new Error('Workflow is archived');
    const definition = parseDefinition(workflow.definition_json);
    validateDefinition(definition);
    const kind = workflow.kind || workflowKind(definition);
    const workspaceFolder = input.workspaceFolder || workflow.workspace_folder;
    if (!workspaceFolder) throw new Error('workspaceFolder is required to run workflow');
    const now = nowIso();
    const run: WorkflowRunRecord = {
      id: crypto.randomUUID(),
      workflow_id: workflow.id,
      owner_key: workflow.owner_key,
      version: workflow.version,
      status: 'queued',
      input_json: input.input ? JSON.stringify(input.input, null, 2) : null,
      result_json: null,
      result_path: null,
      final_node_id: null,
      script_path: null,
      runtime_state_json: null,
      error: null,
      workspace_folder: workspaceFolder,
      group_folder: workflow.group_folder,
      run_source: input.runSource || null,
      trigger_json: input.trigger ? JSON.stringify(input.trigger, null, 2) : null,
      started_at: null,
      finished_at: null,
      created_at: now,
      updated_at: now,
    };
    createWorkflowRun(run);
    logger.info(
      {
        runId: run.id,
        workflowId: workflow.id,
        ownerKey: workflow.owner_key,
        runSource: run.run_source,
        trigger: input.trigger || null,
      },
      'Dynamic workflow run started',
    );

    if (kind === 'dag') {
      for (const node of definition.nodes || []) {
        createWorkflowNodeRun({
          id: crypto.randomUUID(),
          run_id: run.id,
          workflow_id: workflow.id,
          owner_key: workflow.owner_key,
          node_id: node.id,
          status: 'pending',
          provider: node.provider || definition.settings?.provider || null,
          model: node.model || definition.settings?.model || null,
          phase_id: null,
          prompt_hash: null,
          input_hash: null,
          output_path: null,
          transcript_path: null,
          output_excerpt: null,
          error: null,
          started_at: null,
          finished_at: null,
          duration_ms: null,
          created_at: now,
          updated_at: now,
        });
      }
    }

    const promise = (kind === 'script'
      ? this.executeScriptRun(workflow, run, definition, workspaceFolder, input.input || {})
      : this.executeRun(workflow, run, definition, workspaceFolder, input.input || {}))
      .catch((err) => logger.error({ err, runId: run.id }, 'Workflow run failed'))
      .finally(() => {
        this.activeRuns.delete(run.id);
        this.runPromises.delete(run.id);
      });
    this.runPromises.set(run.id, promise);
    if (input.wait) await promise;
    return buildRunResult(run.id);
  }

  async startScriptRun(input: RunScriptWorkflowInput) {
    const definition: WorkflowDefinition = {
      kind: 'script',
      name: input.name,
      description: input.description || undefined,
      script: input.script,
      settings: input.settings,
    };
    const workflow = this.create({
      ownerKey: input.ownerKey,
      name: input.name,
      description: input.description || undefined,
      definition,
      workspaceFolder: input.workspaceFolder || null,
      groupFolder: input.groupFolder || null,
      createdBy: input.createdBy || null,
    });
    return this.startRun({
      ownerKey: input.ownerKey,
      workflowId: workflow.id,
      input: input.input || null,
      workspaceFolder: input.workspaceFolder || null,
      wait: input.wait,
      runSource: input.runSource || 'agent-tool-script',
      trigger: {
        ...(input.trigger || {}),
        inline_script: true,
        workflow_id: workflow.id,
      },
    });
  }

  async waitForRun(runId: string) {
    const promise = this.runPromises.get(runId);
    if (promise) await promise;
    return buildRunResult(runId);
  }

  cancel(ownerKey: string, runId: string): boolean {
    const run = getWorkflowRun(runId, ownerKey);
    if (!run) return false;
    if (run.status === 'success' || run.status === 'error' || run.status === 'cancelled') {
      return true;
    }
    const controller = this.activeRuns.get(runId);
    controller?.abort();
    const now = nowIso();
    updateWorkflowRun(runId, {
      status: 'cancelled',
      finished_at: now,
      updated_at: now,
      error: run.error || 'Cancelled by user',
    });
    return true;
  }

  readNodeOutput(ownerKey: string, runId: string, nodeId: string, options: ReadNodeOutputOptions = {}) {
    const run = getWorkflowRun(runId, ownerKey);
    if (!run) return null;
    const node = listWorkflowNodeRuns(runId).find((item) => item.node_id === nodeId);
    if (!node) return null;
    let output: string | null = null;
    if (node.output_path?.endsWith('.json')) {
      const legacy = safeReadWorkflowFile(node.output_path);
      if (legacy) {
        try {
          const parsed = JSON.parse(legacy) as { output?: unknown };
          if (typeof parsed.output === 'string') output = parsed.output;
        } catch {
          output = legacy;
        }
      }
    } else {
      output = safeReadWorkflowFile(node.output_path);
    }
    if (output == null) return null;
    const response: Record<string, unknown> = {
      node_id: node.node_id,
      output,
    };
    if (options.includeMetadata || options.includeLogs) {
      response.provider = node.provider;
      response.model = node.model;
      response.status = node.status;
      response.started_at = node.started_at;
      response.finished_at = node.finished_at;
      response.duration_ms = node.duration_ms;
      response.output_path = node.output_path;
      response.transcript_path = node.transcript_path;
    }
    if (options.includeLogs) {
      const transcript = safeReadWorkflowFile(node.transcript_path);
      if (transcript) {
        try {
          response.transcript = JSON.parse(transcript);
        } catch {
          response.transcript = transcript;
        }
      } else {
        response.transcript = null;
      }
    }
    return response;
  }

  private async executeScriptRun(
    workflow: WorkflowRecord,
    run: WorkflowRunRecord,
    definition: WorkflowDefinition,
    workspaceFolder: string,
    input: Record<string, unknown>,
  ): Promise<void> {
    const controller = new AbortController();
    this.activeRuns.set(run.id, controller);
    const now = nowIso();
    const runDir = path.join(
      DATA_DIR,
      'workflows',
      safeSegment(workflow.owner_key),
      safeSegment(workflow.id),
      'runs',
      safeSegment(run.id),
    );
    const scriptPath = path.join(runDir, 'workflow.script.js');
    const script = definition.script || safeReadWorkflowFile(definition.script_path) || '';
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(scriptPath, script, 'utf8');
    updateWorkflowRun(run.id, {
      status: 'running',
      script_path: scriptPath,
      runtime_state_json: JSON.stringify({ current_phase: null, phases: [], logs: [] }, null, 2),
      started_at: now,
      updated_at: now,
    });

    const ctx: ScriptExecutionContext = {
      run,
      definition,
      workflow,
      workspaceFolder,
      input,
      abortController: controller,
      currentPhase: null,
      phases: new Set<string>(),
      agentCount: 0,
      maxAgents: clampInteger(definition.settings?.max_agents, 100, 1, 1000),
      timedOut: false,
    };

    try {
      const timeoutMs = clampInteger(definition.settings?.script_timeout_ms, 60 * 60 * 1000, 1000, 24 * 60 * 60 * 1000);
      const output = await this.runScriptInSandbox(ctx, script, timeoutMs);
      const finished = nowIso();
      const summary = typeof output.result === 'string' ? output.result : JSON.stringify(output.result ?? null, null, 2);
      const resultPath = path.join(runDir, 'result.output.txt');
      fs.writeFileSync(resultPath, summary || '', 'utf8');
      updateWorkflowRun(run.id, {
        status: 'success',
        result_json: JSON.stringify({
          summary,
          meta: output.meta || null,
          script_path: scriptPath,
        }, null, 2),
        result_path: resultPath,
        final_node_id: null,
        runtime_state_json: JSON.stringify({
          current_phase: null,
          phases: [...ctx.phases],
          agent_count: ctx.agentCount,
          finished_at: finished,
        }, null, 2),
        finished_at: finished,
        updated_at: finished,
      });
    } catch (err) {
      const finished = nowIso();
      const status: WorkflowRunStatus = controller.signal.aborted && !ctx.timedOut ? 'cancelled' : 'error';
      updateWorkflowRun(run.id, {
        status,
        error: err instanceof Error ? err.message : String(err),
        runtime_state_json: JSON.stringify({
          current_phase: ctx.currentPhase,
          phases: [...ctx.phases],
          agent_count: ctx.agentCount,
          error: err instanceof Error ? err.message : String(err),
          finished_at: finished,
        }, null, 2),
        finished_at: finished,
        updated_at: finished,
      });
      for (const node of listWorkflowNodeRuns(run.id)) {
        if (node.status === 'pending' || node.status === 'running') {
          updateWorkflowNodeRun(node.id, {
            status: status === 'cancelled' ? 'cancelled' : 'skipped',
            error: status === 'cancelled' ? 'Workflow run cancelled' : 'Workflow script failed',
            finished_at: finished,
            updated_at: finished,
          });
        }
      }
    }
  }

  private async runScriptInSandbox(
    ctx: ScriptExecutionContext,
    script: string,
    timeoutMs: number,
  ): Promise<{ meta: unknown; result: unknown }> {
    const executable = buildExecutableWorkflowScript(script);
    const workerSource = `
const { parentPort, workerData } = require('worker_threads');
const vm = require('vm');
let nextRpcId = 1;
const pending = new Map();
function rpc(kind, payload) {
  const id = String(nextRpcId++);
  parentPort.postMessage({ type: 'rpc', id, kind, payload });
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
parentPort.on('message', (message) => {
  const pendingCall = pending.get(message.id);
  if (!pendingCall) return;
  pending.delete(message.id);
  if (message.type === 'resolve') pendingCall.resolve(message.value);
  else pendingCall.reject(new Error(message.error || 'Workflow runtime RPC failed'));
});
async function agent(input) {
  return await rpc('agent', input);
}
async function phase(name, fn) {
  await rpc('phase_start', { name });
  try {
    const value = await fn();
    await rpc('phase_end', { name });
    return value;
  } catch (err) {
    await rpc('phase_error', { name, error: err instanceof Error ? err.message : String(err) }).catch(() => undefined);
    throw err;
  }
}
async function parallel(items, options) {
  const isArray = Array.isArray(items);
  if (!isArray && (!items || typeof items !== 'object')) throw new Error('parallel() expects an array or object');
  const entries = isArray ? items.map((item, index) => [index, item]) : Object.entries(items);
  const concurrency = Math.max(1, Math.min(100, Math.floor((options && options.concurrency) || workerData.defaultConcurrency || 3)));
  const results = isArray ? new Array(entries.length) : {};
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, entries.length) }, async () => {
    while (next < entries.length) {
      const index = next++;
      const [key, item] = entries[index];
      results[key] = typeof item === 'function' ? await item() : await item;
    }
  });
  await Promise.all(workers);
  return results;
}
async function pipeline(steps) {
  if (!Array.isArray(steps)) throw new Error('pipeline() expects an array');
  let value;
  for (const step of steps) {
    value = typeof step === 'function' ? await step(value) : await step;
  }
  return value;
}
function log(message) {
  return rpc('log', { message: String(message) });
}
function checkpoint(key, value) {
  return rpc('checkpoint', { key, value });
}
(async () => {
  const sandbox = vm.createContext({
    args: workerData.args,
    agent,
    parallel,
    pipeline,
    phase,
    log,
    checkpoint,
    console: { log, warn: log, error: log },
  }, { codeGeneration: { strings: false, wasm: false } });
  const compiled = new vm.Script(workerData.executable, { filename: workerData.filename });
  const result = await compiled.runInContext(sandbox, { timeout: 1000 });
  parentPort.postMessage({ type: 'result', value: result });
})().catch((err) => {
  parentPort.postMessage({ type: 'error', error: err instanceof Error ? err.message : String(err) });
});
`;
    const worker = new Worker(workerSource, {
      eval: true,
      workerData: {
        executable,
        args: ctx.input,
        defaultConcurrency: clampInteger(ctx.definition.settings?.max_concurrency, 3, 1, 100),
        filename: `workflow-${ctx.run.id}.js`,
      },
    });
    return await new Promise((resolve, reject) => {
      let settled = false;
      const settleResolve = (value: { meta: unknown; result: unknown }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ctx.abortController.signal.removeEventListener('abort', abortHandler);
        void worker.terminate();
        resolve(value);
      };
      const settleReject = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ctx.abortController.signal.removeEventListener('abort', abortHandler);
        void worker.terminate();
        reject(err);
      };
      const timer = setTimeout(() => {
        ctx.timedOut = true;
        settleReject(new Error(`Workflow script timed out after ${timeoutMs}ms`));
        ctx.abortController.abort();
      }, timeoutMs);
      timer.unref();
      const abortHandler = () => {
        settleReject(new Error('Workflow run cancelled'));
      };
      ctx.abortController.signal.addEventListener('abort', abortHandler, { once: true });
      worker.on('message', (message: {
        type: string;
        id?: string;
        kind?: string;
        payload?: Record<string, unknown>;
        value?: { meta: unknown; result: unknown } | string;
        error?: string;
      }) => {
        if (message.type === 'result') {
          settleResolve(message.value as { meta: unknown; result: unknown });
          return;
        }
        if (message.type === 'error') {
          settleReject(new Error(message.error || 'Workflow script failed'));
          return;
        }
        if (message.type !== 'rpc' || !message.id || !message.kind) return;
        void this.handleScriptWorkerRpc(ctx, worker, message.id, message.kind, message.payload || {})
          .catch((err) => {
            worker.postMessage({
              type: 'reject',
              id: message.id,
              error: err instanceof Error ? err.message : String(err),
            });
          });
      });
      worker.on('error', (err) => settleReject(err));
      worker.on('exit', (code) => {
        if (!settled && code !== 0) settleReject(new Error(`Workflow script worker exited with ${code}`));
      });
    });
  }

  private async handleScriptWorkerRpc(
    ctx: ScriptExecutionContext,
    worker: Worker,
    id: string,
    kind: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const resolve = (value: unknown = null) => worker.postMessage({ type: 'resolve', id, value });
    const reject = (err: unknown) => worker.postMessage({
      type: 'reject',
      id,
      error: err instanceof Error ? err.message : String(err),
    });
    try {
      if (kind === 'agent') {
        resolve(await this.executeScriptAgent(ctx, payload as unknown as ScriptAgentInput));
        return;
      }
      if (kind === 'phase_start') {
        ctx.currentPhase = safeSegment(String(payload.name || 'phase'));
        ctx.phases.add(ctx.currentPhase);
        updateWorkflowRun(ctx.run.id, {
          runtime_state_json: JSON.stringify({
            current_phase: ctx.currentPhase,
            phases: [...ctx.phases],
            agent_count: ctx.agentCount,
            event: 'phase_start',
          }, null, 2),
          updated_at: nowIso(),
        });
        resolve();
        return;
      }
      if (kind === 'phase_end' || kind === 'phase_error') {
        const endedPhase = ctx.currentPhase;
        updateWorkflowRun(ctx.run.id, {
          runtime_state_json: JSON.stringify({
            current_phase: endedPhase,
            phases: [...ctx.phases],
            agent_count: ctx.agentCount,
            event: kind,
            error: typeof payload.error === 'string' ? payload.error : undefined,
          }, null, 2),
          updated_at: nowIso(),
        });
        ctx.currentPhase = null;
        resolve();
        return;
      }
      if (kind === 'log') {
        updateWorkflowRun(ctx.run.id, {
          runtime_state_json: JSON.stringify({
            current_phase: ctx.currentPhase,
            phases: [...ctx.phases],
            agent_count: ctx.agentCount,
            log: String(payload.message || ''),
          }, null, 2),
          updated_at: nowIso(),
        });
        resolve();
        return;
      }
      if (kind === 'checkpoint') {
        updateWorkflowRun(ctx.run.id, {
          runtime_state_json: JSON.stringify({
            current_phase: ctx.currentPhase,
            phases: [...ctx.phases],
            agent_count: ctx.agentCount,
            checkpoint: { key: String(payload.key || ''), value: payload.value },
          }, null, 2),
          updated_at: nowIso(),
        });
        resolve();
        return;
      }
      throw new Error(`Unknown workflow runtime RPC "${kind}"`);
    } catch (err) {
      reject(err);
    }
  }

  private async executeScriptAgent(ctx: ScriptExecutionContext, input: ScriptAgentInput): Promise<string> {
    assertPlainObject(input, 'agent input');
    if (!input.prompt || typeof input.prompt !== 'string') throw new Error('agent() requires prompt');
    ctx.agentCount += 1;
    if (ctx.agentCount > ctx.maxAgents) throw new Error(`workflow exceeded max_agents (${ctx.maxAgents})`);

    const rawNodeId = input.id || input.name || `agent-${ctx.agentCount}`;
    const nodeId = safeSegment(rawNodeId);
    const provider = input.provider || ctx.definition.settings?.provider || undefined;
    const model = input.model || ctx.definition.settings?.model || undefined;
    const thinkingEffort = input.thinking_effort || ctx.definition.settings?.thinking_effort;
    const renderedPrompt = renderScriptAgentPrompt(input);
    const inputHash = hashPrompt(JSON.stringify({
      prompt: renderedPrompt,
      input: input.input ?? null,
      provider,
      model,
      thinkingEffort,
      timeout_ms: input.timeout_ms || ctx.definition.settings?.node_timeout_ms || null,
      max_turns: input.max_turns || null,
    }));
    const existing = listWorkflowNodeRuns(ctx.run.id).find((node) => node.node_id === nodeId);
    if (existing?.status === 'success' && existing.input_hash === inputHash) {
      const cached = safeReadWorkflowFile(existing.output_path);
      if (cached != null) return cached;
    }
    if (existing && existing.input_hash !== inputHash) {
      throw new Error(`agent id "${nodeId}" was reused with different input`);
    }
    if (existing && (existing.status === 'pending' || existing.status === 'running')) {
      throw new Error(`agent id "${nodeId}" is already in flight`);
    }

    const now = nowIso();
    const nodeRunId = existing?.id || crypto.randomUUID();
    if (!existing) {
      createWorkflowNodeRun({
        id: nodeRunId,
        run_id: ctx.run.id,
        workflow_id: ctx.workflow.id,
        owner_key: ctx.workflow.owner_key,
        node_id: nodeId,
        status: 'pending',
        provider: provider || null,
        model: model || null,
        phase_id: ctx.currentPhase,
        prompt_hash: null,
        input_hash: inputHash,
        output_path: null,
        transcript_path: null,
        output_excerpt: null,
        error: null,
        started_at: null,
        finished_at: null,
        duration_ms: null,
        created_at: now,
        updated_at: now,
      });
    }

    const runDir = path.join(
      DATA_DIR,
      'workflows',
      safeSegment(ctx.workflow.owner_key),
      safeSegment(ctx.workflow.id),
      'runs',
      safeSegment(ctx.run.id),
    );
    const transcriptPath = path.join(runDir, `${safeSegment(nodeId)}.transcript.json`);
    const outputPath = path.join(runDir, `${safeSegment(nodeId)}.output.txt`);
    const nodeStart = Date.now();
    let releaseGlobalSlot: (() => void) | null = null;
    const retry = input.retry || ctx.definition.settings?.retry;
    const maxAttempts = Math.max(1, Math.min(5, Math.floor(retry?.max_attempts || 1)));
    const backoffMs = Math.max(0, Math.min(60000, Math.floor(retry?.backoff_ms || 3000)));
    const attempts: NodeAttemptRecord[] = [];

    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        releaseGlobalSlot = await this.acquireGlobalNodeSlot(ctx.abortController.signal);
        const attemptStartMs = Date.now();
        const startedAt = nowIso();
        updateWorkflowNodeRun(nodeRunId, {
          status: 'running',
          provider: provider || null,
          model: model || null,
          phase_id: ctx.currentPhase,
          prompt_hash: hashPrompt(renderedPrompt),
          input_hash: inputHash,
          transcript_path: transcriptPath,
          started_at: startedAt,
          updated_at: startedAt,
        });
        try {
          const result = await invokeWorkflowNode({
            prompt: renderedPrompt,
            cwd: ctx.workspaceFolder,
            provider,
            model,
            thinkingEffort,
            timeoutMs: clampInteger(input.timeout_ms ?? ctx.definition.settings?.node_timeout_ms, 10 * 60 * 1000, 1000, 24 * 60 * 60 * 1000),
            maxTurns: input.max_turns,
            signal: ctx.abortController.signal,
          });
          const finishedAt = nowIso();
          attempts.push({
            attempt,
            status: 'success',
            provider: result.provider,
            model: result.model,
            started_at: startedAt,
            finished_at: finishedAt,
            duration_ms: Date.now() - attemptStartMs,
            stdout: result.stdout,
            stderr: result.stderr,
          });
          fs.mkdirSync(runDir, { recursive: true });
          fs.writeFileSync(outputPath, result.output, 'utf8');
          fs.writeFileSync(transcriptPath, JSON.stringify({
            node_id: nodeId,
            phase_id: ctx.currentPhase,
            provider: result.provider,
            model: result.model,
            prompt: renderedPrompt,
            raw_prompt: input.prompt,
            input: input.input,
            output_path: outputPath,
            output: result.output,
            stdout: result.stdout,
            stderr: result.stderr,
            attempts,
            started_at: startedAt,
            finished_at: finishedAt,
          }, null, 2), 'utf8');
          updateWorkflowNodeRun(nodeRunId, {
            status: 'success',
            provider: result.provider,
            model: result.model,
            output_path: outputPath,
            transcript_path: transcriptPath,
            output_excerpt: excerpt(result.output),
            finished_at: finishedAt,
            duration_ms: Date.now() - nodeStart,
            updated_at: finishedAt,
          });
          return result.output;
        } catch (err) {
          const finishedAt = nowIso();
          const message = err instanceof Error ? err.message : String(err);
          attempts.push({
            attempt,
            status: 'error',
            provider: provider || 'default',
            model: model || null,
            started_at: startedAt,
            finished_at: finishedAt,
            duration_ms: Date.now() - attemptStartMs,
            error: message,
          });
          releaseGlobalSlot?.();
          releaseGlobalSlot = null;
          if (ctx.abortController.signal.aborted || attempt >= maxAttempts) throw err;
          updateWorkflowNodeRun(nodeRunId, {
            error: `Attempt ${attempt}/${maxAttempts} failed: ${message}; retrying`,
            updated_at: finishedAt,
          });
          await sleep(backoffMs, ctx.abortController.signal);
        } finally {
          releaseGlobalSlot?.();
          releaseGlobalSlot = null;
        }
      }
      throw new Error('Workflow script agent retry loop ended unexpectedly');
    } catch (err) {
      const finishedAt = nowIso();
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(transcriptPath, JSON.stringify({
        node_id: nodeId,
        phase_id: ctx.currentPhase,
        provider: provider || null,
        model: model || null,
        prompt: renderedPrompt,
        raw_prompt: input.prompt,
        input: input.input,
        attempts,
        error: err instanceof Error ? err.message : String(err),
        finished_at: finishedAt,
      }, null, 2), 'utf8');
      updateWorkflowNodeRun(nodeRunId, {
        status: ctx.abortController.signal.aborted ? 'cancelled' : 'error',
        transcript_path: transcriptPath,
        error: err instanceof Error ? err.message : String(err),
        finished_at: finishedAt,
        duration_ms: Date.now() - nodeStart,
        updated_at: finishedAt,
      });
      throw err;
    } finally {
      releaseGlobalSlot?.();
    }
  }

  private async executeRun(
    workflow: WorkflowRecord,
    run: WorkflowRunRecord,
    definition: WorkflowDefinition,
    workspaceFolder: string,
    input: Record<string, unknown>,
  ): Promise<void> {
    const controller = new AbortController();
    this.activeRuns.set(run.id, controller);
    const now = nowIso();
    updateWorkflowRun(run.id, { status: 'running', started_at: now, updated_at: now });

    const nodeRuns = listWorkflowNodeRuns(run.id);
    const nodeRunIds = new Map(nodeRuns.map((nodeRun) => [nodeRun.node_id, nodeRun.id]));
    const outputs = new Map<string, string>();
    const completed = new Set<string>();
    const running = new Set<string>();
    const failed = new Set<string>();
    const skipped = new Set<string>();
    const nodes = definition.nodes || [];
    const maxConcurrency = clampInteger(definition.settings?.max_concurrency, 3, 1, 100);
    const ctx: NodeExecutionContext = {
      run,
      definition,
      workflow,
      workspaceFolder,
      input,
      outputs,
      nodeRunIds,
      abortController: controller,
    };

    try {
      await new Promise<void>((resolve, reject) => {
        const markBlockedNodesSkipped = () => {
          let changed = false;
          do {
            changed = false;
            for (const node of nodes) {
              if (
                completed.has(node.id) ||
                failed.has(node.id) ||
                skipped.has(node.id) ||
                running.has(node.id)
              ) {
                continue;
              }
              const blockedDependency = normalizeDependsOn(node).find((dep) => failed.has(dep) || skipped.has(dep));
              if (!blockedDependency) continue;
              skipped.add(node.id);
              const nodeRunId = nodeRunIds.get(node.id);
              if (nodeRunId) {
                const skippedAt = nowIso();
                updateWorkflowNodeRun(nodeRunId, {
                  status: 'skipped',
                  error: `Skipped because dependency "${blockedDependency}" failed or was skipped`,
                  finished_at: skippedAt,
                  updated_at: skippedAt,
                });
              }
              changed = true;
            }
          } while (changed);
        };

        const schedule = () => {
          if (controller.signal.aborted) {
            reject(new Error('Workflow run cancelled'));
            return;
          }
          markBlockedNodesSkipped();
          if (completed.size + failed.size + skipped.size === nodes.length) {
            failed.size > 0 || skipped.size > 0
              ? reject(new Error(`${failed.size} workflow node(s) failed; ${skipped.size} workflow node(s) skipped`))
              : resolve();
            return;
          }

          const ready = nodes.filter((node) => {
            if (completed.has(node.id) || failed.has(node.id) || skipped.has(node.id) || running.has(node.id)) return false;
            return normalizeDependsOn(node).every((dep) => completed.has(dep));
          });

          while (running.size < maxConcurrency && ready.length > 0) {
            const node = ready.shift()!;
            running.add(node.id);
            void this.executeNode(ctx, node)
              .then((output) => {
                outputs.set(node.id, output);
                completed.add(node.id);
              })
              .catch((err) => {
                failed.add(node.id);
                logger.warn({ err, runId: run.id, nodeId: node.id }, 'Workflow node failed');
              })
              .finally(() => {
                running.delete(node.id);
                schedule();
              });
          }
        };
        schedule();
      });

      const finished = nowIso();
      const finalNodes = nodes.filter((node) => !nodes.some((other) => normalizeDependsOn(other).includes(node.id)));
      const summary = finalNodes.map((node) => `## ${node.id}\n${outputs.get(node.id) || ''}`).join('\n\n');
      const resultPath = path.join(
        DATA_DIR,
        'workflows',
        safeSegment(workflow.owner_key),
        safeSegment(workflow.id),
        'runs',
        safeSegment(run.id),
        'result.output.txt',
      );
      fs.mkdirSync(path.dirname(resultPath), { recursive: true });
      fs.writeFileSync(resultPath, summary, 'utf8');
      const result = {
        summary,
        outputs: Object.fromEntries([...outputs.entries()].map(([id, value]) => [id, excerpt(value, 4000)])),
      };
      updateWorkflowRun(run.id, {
        status: 'success',
        result_json: JSON.stringify(result, null, 2),
        result_path: resultPath,
        final_node_id: finalNodes.length === 1 ? finalNodes[0].id : null,
        finished_at: finished,
        updated_at: finished,
      });
    } catch (err) {
      const finished = nowIso();
      const status: WorkflowRunStatus = controller.signal.aborted ? 'cancelled' : 'error';
      updateWorkflowRun(run.id, {
        status,
        error: err instanceof Error ? err.message : String(err),
        finished_at: finished,
        updated_at: finished,
      });
      for (const node of nodes) {
        if (!completed.has(node.id) && !failed.has(node.id) && !skipped.has(node.id)) {
          const nodeRunId = nodeRunIds.get(node.id);
          if (nodeRunId) updateWorkflowNodeRun(nodeRunId, { status: status === 'cancelled' ? 'cancelled' : 'skipped', updated_at: finished });
        }
      }
    }
  }

  private async executeNode(ctx: NodeExecutionContext, node: WorkflowAgentNode): Promise<string> {
    const nodeRunId = ctx.nodeRunIds.get(node.id);
    if (!nodeRunId) throw new Error(`Missing node run for ${node.id}`);
    const renderedPrompt = renderNodePrompt(node, ctx);
    const provider = node.provider || ctx.definition.settings?.provider || undefined;
    const model = node.model || ctx.definition.settings?.model || undefined;
    const { maxAttempts, backoffMs } = retryConfig(node, ctx.definition);
    const nodeStart = Date.now();
    let startedAt: string | null = null;
    let releaseGlobalSlot: (() => void) | null = null;
    const attempts: NodeAttemptRecord[] = [];
    const transcriptPath = path.join(
      DATA_DIR,
      'workflows',
      safeSegment(ctx.workflow.owner_key),
      safeSegment(ctx.workflow.id),
      'runs',
      safeSegment(ctx.run.id),
      `${safeSegment(node.id)}.transcript.json`,
    );
    const outputPath = path.join(
      DATA_DIR,
      'workflows',
      safeSegment(ctx.workflow.owner_key),
      safeSegment(ctx.workflow.id),
      'runs',
      safeSegment(ctx.run.id),
      `${safeSegment(node.id)}.output.txt`,
    );

    const writeTranscript = (payload: Record<string, unknown>) => {
      fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
      fs.writeFileSync(transcriptPath, JSON.stringify(payload, null, 2), 'utf8');
    };

    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        releaseGlobalSlot = await this.acquireGlobalNodeSlot(ctx.abortController.signal);
        const attemptStartMs = Date.now();
        const attemptStartedAt = nowIso();
        if (!startedAt) {
          startedAt = attemptStartedAt;
          updateWorkflowNodeRun(nodeRunId, {
            status: 'running',
            provider: provider || null,
            model: model || null,
            prompt_hash: hashPrompt(renderedPrompt),
            transcript_path: transcriptPath,
            started_at: startedAt,
            updated_at: startedAt,
          });
        }

        try {
          const result = await invokeWorkflowNode({
            prompt: renderedPrompt,
            cwd: ctx.workspaceFolder,
            provider,
            model,
            thinkingEffort: node.thinking_effort || ctx.definition.settings?.thinking_effort,
            timeoutMs: clampInteger(node.timeout_ms ?? ctx.definition.settings?.node_timeout_ms, 10 * 60 * 1000, 1000, 24 * 60 * 60 * 1000),
            maxTurns: node.max_turns,
            signal: ctx.abortController.signal,
          });
          const finishedAt = nowIso();
          attempts.push({
            attempt,
            status: 'success',
            provider: result.provider,
            model: result.model,
            started_at: attemptStartedAt,
            finished_at: finishedAt,
            duration_ms: Date.now() - attemptStartMs,
            stdout: result.stdout,
            stderr: result.stderr,
          });

          fs.mkdirSync(path.dirname(outputPath), { recursive: true });
          fs.writeFileSync(outputPath, result.output, 'utf8');
          writeTranscript({
            node_id: node.id,
            provider: result.provider,
            model: result.model,
            prompt: renderedPrompt,
            output_path: outputPath,
            output: result.output,
            stdout: result.stdout,
            stderr: result.stderr,
            attempts,
            started_at: startedAt,
            finished_at: finishedAt,
          });
          updateWorkflowNodeRun(nodeRunId, {
            status: 'success',
            provider: result.provider,
            model: result.model,
            output_path: outputPath,
            transcript_path: transcriptPath,
            output_excerpt: excerpt(result.output),
            finished_at: finishedAt,
            duration_ms: Date.now() - nodeStart,
            updated_at: finishedAt,
          });
          return result.output;
        } catch (err) {
          const finishedAt = nowIso();
          const message = err instanceof Error ? err.message : String(err);
          attempts.push({
            attempt,
            status: 'error',
            provider: provider || 'default',
            model: model || null,
            started_at: attemptStartedAt,
            finished_at: finishedAt,
            duration_ms: Date.now() - attemptStartMs,
            error: message,
          });
          releaseGlobalSlot?.();
          releaseGlobalSlot = null;
          if (ctx.abortController.signal.aborted || attempt >= maxAttempts) {
            throw err;
          }
          updateWorkflowNodeRun(nodeRunId, {
            error: `Attempt ${attempt}/${maxAttempts} failed: ${message}; retrying`,
            updated_at: finishedAt,
          });
          await sleep(backoffMs, ctx.abortController.signal);
        } finally {
          releaseGlobalSlot?.();
          releaseGlobalSlot = null;
        }
      }
      throw new Error('Workflow node retry loop ended unexpectedly');
    } catch (err) {
      const finishedAt = nowIso();
      writeTranscript({
        node_id: node.id,
        provider: provider || null,
        model: model || null,
        prompt: renderedPrompt,
        attempts,
        error: err instanceof Error ? err.message : String(err),
        started_at: startedAt,
        finished_at: finishedAt,
      });
      updateWorkflowNodeRun(nodeRunId, {
        status: ctx.abortController.signal.aborted ? 'cancelled' : 'error',
        transcript_path: transcriptPath,
        error: err instanceof Error ? err.message : String(err),
        finished_at: finishedAt,
        duration_ms: Date.now() - nodeStart,
        updated_at: finishedAt,
      });
      throw err;
    } finally {
      releaseGlobalSlot?.();
    }
  }
}

export const workflowService = new WorkflowService();
