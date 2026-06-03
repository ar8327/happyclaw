import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

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
  if (!Array.isArray(definition.nodes) || definition.nodes.length === 0) {
    throw new Error('workflow definition must include at least one node');
  }
  if (definition.nodes.length > 100) {
    throw new Error('workflow definition supports at most 100 nodes');
  }

  const seen = new Set<string>();
  for (const node of definition.nodes) {
    assertPlainObject(node, 'workflow node');
    if (!node.id || typeof node.id !== 'string') {
      throw new Error('workflow node id is required');
    }
    if (!/^[a-zA-Z0-9_.-]+$/.test(node.id)) {
      throw new Error(`workflow node id "${node.id}" may only contain letters, numbers, underscore, dot and dash`);
    }
    if (seen.has(node.id)) throw new Error(`duplicate workflow node id "${node.id}"`);
    seen.add(node.id);
    if (node.type !== 'agent') throw new Error(`unsupported workflow node type "${String(node.type)}"`);
    if (!node.prompt || typeof node.prompt !== 'string') {
      throw new Error(`workflow node "${node.id}" requires prompt`);
    }
    for (const dep of normalizeDependsOn(node)) {
      if (!seen.has(dep) && !definition.nodes.some((candidate) => candidate.id === dep)) {
        throw new Error(`workflow node "${node.id}" depends on unknown node "${dep}"`);
      }
    }
  }

  // Kahn cycle detection.
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const node of definition.nodes) {
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
  if (visited !== definition.nodes.length) throw new Error('workflow definition contains a dependency cycle');
}

function excerpt(output: string, max = 2000): string {
  const trimmed = output.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

function clampExcerptLength(value: number | undefined, fallback = 2000): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(20000, Math.floor(value || 0)));
}

function hashPrompt(prompt: string): string {
  return crypto.createHash('sha256').update(prompt).digest('hex');
}

function renderTemplate(template: string, ctx: NodeExecutionContext): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)(?:\.output)?\s*\}\}/g, (_match, key: string) => {
    if (key.startsWith('input.')) {
      const value = key.slice('input.'.length).split('.').reduce<unknown>((acc, part) => {
        if (!acc || typeof acc !== 'object') return undefined;
        return (acc as Record<string, unknown>)[part];
      }, ctx.input);
      return value == null ? '' : String(value);
    }
    const output = ctx.outputs.get(key);
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
  if (!resolved.startsWith(path.resolve(root))) return null;
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
    validateDefinition(input.definition);
    const now = nowIso();
    const id = crypto.randomUUID();
    const name = input.name || input.definition.name || `Workflow ${id.slice(0, 8)}`;
    const description = input.description || input.definition.description || null;
    const record: WorkflowRecord = {
      id,
      owner_key: input.ownerKey,
      name,
      description,
      version: 1,
      definition_json: JSON.stringify(input.definition, null, 2),
      workspace_folder: input.workspaceFolder || null,
      group_folder: input.groupFolder || null,
      created_by: input.createdBy || null,
      status: 'active',
      created_at: now,
      updated_at: now,
    };
    createWorkflow(record);
    return { ...record, definition: input.definition };
  }

  update(ownerKey: string, id: string, patch: Partial<CreateWorkflowInput>) {
    const existing = getWorkflow(id, ownerKey);
    if (!existing) return null;
    const definition = patch.definition || parseDefinition(existing.definition_json);
    validateDefinition(definition);
    const nextVersion = existing.version + (patch.definition ? 1 : 0);
    const now = nowIso();
    updateWorkflow(id, ownerKey, {
      name: patch.name || definition.name || existing.name,
      description: patch.description ?? definition.description ?? existing.description,
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
    const definition = parseDefinition(workflow.definition_json);
    validateDefinition(definition);
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

    for (const node of definition.nodes) {
      createWorkflowNodeRun({
        id: crypto.randomUUID(),
        run_id: run.id,
        workflow_id: workflow.id,
        owner_key: workflow.owner_key,
        node_id: node.id,
        status: 'pending',
        provider: node.provider || definition.settings?.provider || null,
        model: node.model || definition.settings?.model || null,
        prompt_hash: null,
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

    const promise = this.executeRun(workflow, run, definition, workspaceFolder, input.input || {})
      .catch((err) => logger.error({ err, runId: run.id }, 'Workflow run failed'))
      .finally(() => {
        this.activeRuns.delete(run.id);
        this.runPromises.delete(run.id);
      });
    this.runPromises.set(run.id, promise);
    if (input.wait) await promise;
    return buildRunResult(run.id);
  }

  async waitForRun(runId: string) {
    const promise = this.runPromises.get(runId);
    if (promise) await promise;
    return buildRunResult(runId);
  }

  cancel(ownerKey: string, runId: string): boolean {
    const run = getWorkflowRun(runId, ownerKey);
    if (!run) return false;
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
    const maxConcurrency = Math.max(1, Math.min(100, definition.settings?.max_concurrency || 3));
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
            for (const node of definition.nodes) {
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
          if (completed.size + failed.size + skipped.size === definition.nodes.length) {
            failed.size > 0 || skipped.size > 0
              ? reject(new Error(`${failed.size} workflow node(s) failed; ${skipped.size} workflow node(s) skipped`))
              : resolve();
            return;
          }

          const ready = definition.nodes.filter((node) => {
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
      const finalNodes = definition.nodes.filter((node) => !definition.nodes.some((other) => normalizeDependsOn(other).includes(node.id)));
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
      for (const node of definition.nodes) {
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
            timeoutMs: node.timeout_ms || ctx.definition.settings?.node_timeout_ms || 10 * 60 * 1000,
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
