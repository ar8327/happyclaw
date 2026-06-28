import { ChangeEvent, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Download, FileUp, GitBranch, Play, RefreshCw, Square, Workflow, X } from 'lucide-react';
import { PageHeader } from '@/components/common/PageHeader';
import { EmptyState } from '@/components/common/EmptyState';
import { SkeletonCardList } from '@/components/common/Skeletons';
import { Button } from '@/components/ui/button';
import {
  useWorkflowsStore,
  type WorkflowDefinition,
  type WorkflowNodeRun,
  type WorkflowRecord,
  type WorkflowRun,
  type WorkflowRunStatus,
} from '../stores/workflows';

function statusClass(status: WorkflowRunStatus | string) {
  switch (status) {
    case 'success':
      return 'bg-green-100 text-green-700';
    case 'running':
      return 'bg-blue-100 text-blue-700';
    case 'queued':
      return 'bg-amber-100 text-amber-700';
    case 'error':
      return 'bg-red-100 text-red-700';
    case 'cancelled':
      return 'bg-slate-100 text-slate-600';
    case 'skipped':
      return 'bg-zinc-100 text-zinc-600';
    case 'pending':
      return 'bg-slate-100 text-slate-500';
    default:
      return 'bg-slate-100 text-slate-600';
  }
}

function ganttColor(status: string) {
  switch (status) {
    case 'success':
      return 'bg-green-500';
    case 'running':
      return 'bg-blue-500 animate-pulse';
    case 'queued':
      return 'bg-amber-400';
    case 'error':
      return 'bg-red-500';
    case 'cancelled':
      return 'bg-slate-400';
    case 'skipped':
      return 'bg-zinc-300';
    default:
      return 'bg-slate-300';
  }
}

function fmtDate(value: string | null | undefined) {
  if (!value) return '-';
  return new Date(value).toLocaleString();
}

function fmtDuration(ms: number | null | undefined) {
  if (!ms || ms < 0) return '-';
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return `${minutes}m${rest ? ` ${rest}s` : ''}`;
  const hours = Math.floor(minutes / 60);
  const min = minutes % 60;
  return `${hours}h${min ? ` ${min}m` : ''}`;
}

function safeJson(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function downloadJson(filename: string, payload: unknown) {
  const blob = new Blob([safeJson(payload)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function parseImportPayload(raw: unknown): { name?: string; description?: string | null; definition: WorkflowDefinition } {
  if (!raw || typeof raw !== 'object') throw new Error('导入文件必须是 JSON object');
  const obj = raw as Record<string, unknown>;
  const definition = (obj.definition || obj) as WorkflowDefinition;
  const hasDagNodes = Array.isArray(definition.nodes);
  const hasScript = typeof definition.script === 'string' && definition.script.trim().length > 0;
  if (!definition || typeof definition !== 'object' || (!hasDagNodes && !hasScript)) {
    throw new Error('没有找到 workflow definition.nodes 或 definition.script');
  }
  return {
    name: typeof obj.name === 'string' ? obj.name : definition.name,
    description: typeof obj.description === 'string' || obj.description === null ? obj.description : definition.description,
    definition,
  };
}

function workflowExportPayload(workflow: WorkflowRecord) {
  return {
    name: workflow.name,
    description: workflow.description,
    definition: workflow.definition,
    exported_from: 'AgentDock Dynamic Workflows',
    exported_at: new Date().toISOString(),
    source_workflow_id: workflow.id,
    source_version: workflow.version,
  };
}

function workflowNodes(workflow: WorkflowRecord | undefined) {
  return workflow?.definition.nodes || [];
}

function isScriptWorkflow(workflow: WorkflowRecord | undefined) {
  return workflow?.kind === 'script' || workflow?.definition.kind === 'script' || !!workflow?.definition.script;
}

function NodeConfigCard({ workflow, nodeId }: { workflow: WorkflowRecord; nodeId: string }) {
  const node = workflowNodes(workflow).find((item) => item.id === nodeId);
  if (!node) return null;
  const settings = workflow.definition.settings || {};
  const effective = {
    provider: node.provider || settings.provider || 'default',
    model: node.model || settings.model || 'default',
    thinking_effort: node.thinking_effort || settings.thinking_effort || 'default',
    timeout_ms: node.timeout_ms || settings.node_timeout_ms || 10 * 60 * 1000,
    retry: node.retry || settings.retry || null,
    depends_on: node.depends_on || [],
  };

  return (
    <div className="rounded-lg border border-border bg-muted/20 p-3 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm text-foreground">{node.id}</span>
        <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${statusClass('pending')}`}>{node.type}</span>
        {(node.depends_on || []).length > 0 && <span className="text-xs text-muted-foreground">depends on: {node.depends_on?.join(', ')}</span>}
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 text-xs">
        <div><span className="text-muted-foreground">provider</span><div className="font-mono text-foreground">{effective.provider}</div></div>
        <div><span className="text-muted-foreground">model</span><div className="font-mono text-foreground">{effective.model}</div></div>
        <div><span className="text-muted-foreground">thinking</span><div className="font-mono text-foreground">{effective.thinking_effort}</div></div>
        <div><span className="text-muted-foreground">timeout</span><div className="font-mono text-foreground">{fmtDuration(effective.timeout_ms)}</div></div>
      </div>
      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Prompt</summary>
        <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded-md bg-background border border-border p-3 text-foreground">{node.prompt}</pre>
      </details>
      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground hover:text-foreground">完整节点配置 JSON</summary>
        <pre className="mt-2 max-h-72 overflow-auto rounded-md bg-background border border-border p-3 text-foreground">{safeJson({ node, effective })}</pre>
      </details>
    </div>
  );
}

function WorkflowCard({ workflow }: { workflow: WorkflowRecord }) {
  const { runWorkflow } = useWorkflowsStore();
  const [expanded, setExpanded] = useState(false);
  const nodes = workflowNodes(workflow);
  const scriptWorkflow = isScriptWorkflow(workflow);

  return (
    <div className="bg-card border border-border rounded-xl p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <GitBranch size={18} className="text-blue-500" />
            <h2 className="font-semibold text-foreground truncate">{workflow.name}</h2>
            <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">v{workflow.version}</span>
          </div>
          {workflow.description && <p className="text-sm text-muted-foreground mt-2">{workflow.description}</p>}
          <p className="text-xs text-muted-foreground mt-2">
            {scriptWorkflow ? 'script workflow' : `${nodes.length} nodes`} · updated {fmtDate(workflow.updated_at)}
          </p>
          <div className="text-xs text-muted-foreground mt-1 font-mono truncate">{workflow.id}</div>
        </div>
        <div className="flex flex-wrap items-center gap-2 justify-end">
          <Button variant="outline" size="sm" onClick={() => downloadJson(`${workflow.name || workflow.id}.workflow.json`, workflowExportPayload(workflow))}>
            <Download size={14} />
            Export
          </Button>
          <Button size="sm" onClick={() => runWorkflow(workflow.id)}>
            <Play size={16} />
            Run
          </Button>
        </div>
      </div>

      <div className="mt-4 space-y-2">
        <button
          type="button"
          className="w-full text-left flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          节点配置详情
        </button>
        {expanded ? (
          <div className="space-y-3">
            {workflow.definition.settings && (
              <details className="rounded-lg border border-border bg-muted/20 p-3 text-xs">
                <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Workflow settings</summary>
                <pre className="mt-2 max-h-72 overflow-auto rounded-md bg-background border border-border p-3 text-foreground">{safeJson(workflow.definition.settings)}</pre>
              </details>
            )}
            {scriptWorkflow && workflow.definition.script && (
              <details className="rounded-lg border border-border bg-muted/20 p-3 text-xs">
                <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Workflow script</summary>
                <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded-md bg-background border border-border p-3 text-foreground">{workflow.definition.script}</pre>
              </details>
            )}
            {nodes.map((node) => <NodeConfigCard key={node.id} workflow={workflow} nodeId={node.id} />)}
          </div>
        ) : (
          <div className="space-y-2">
            {scriptWorkflow && (
              <div className="text-xs rounded-lg border border-border bg-muted/30 p-2">
                <span className="font-mono text-foreground">script</span>
                <span className="ml-2 text-muted-foreground">{workflow.definition.settings?.provider || 'default'}</span>
              </div>
            )}
            {nodes.map((node) => (
              <div key={node.id} className="text-xs rounded-lg border border-border bg-muted/30 p-2">
                <span className="font-mono text-foreground">{node.id}</span>
                <span className="ml-2 text-muted-foreground">{node.provider || workflow.definition.settings?.provider || 'default'}</span>
                {node.depends_on && node.depends_on.length > 0 && <span className="ml-2 text-muted-foreground">← {node.depends_on.join(', ')}</span>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function nodeStartMs(node: WorkflowNodeRun, nowMs: number) {
  if (node.started_at) return new Date(node.started_at).getTime();
  if (node.status === 'running') return nowMs;
  return null;
}

function nodeEndMs(node: WorkflowNodeRun, nowMs: number) {
  if (node.finished_at) return new Date(node.finished_at).getTime();
  if (node.status === 'running') return nowMs;
  return null;
}

function RunGantt({ run, workflow }: { run: WorkflowRun; workflow?: WorkflowRecord }) {
  const nowMs = Date.now();
  const startedValues = run.nodes.map((node) => nodeStartMs(node, nowMs)).filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const endedValues = run.nodes.map((node) => nodeEndMs(node, nowMs)).filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const runStart = run.started_at ? new Date(run.started_at).getTime() : new Date(run.created_at).getTime();
  const base = Math.min(runStart, ...startedValues);
  const end = Math.max(base + 1000, ...endedValues, run.finished_at ? new Date(run.finished_at).getTime() : nowMs);
  const span = Math.max(1000, end - base);
  const nodesByDefinition = workflowNodes(workflow).map((def) => run.nodes.find((node) => node.node_id === def.id)).filter(Boolean) as WorkflowNodeRun[] | undefined;
  const nodes = nodesByDefinition && nodesByDefinition.length === run.nodes.length ? nodesByDefinition : run.nodes;

  return (
    <div className="mt-3 rounded-xl border border-border bg-muted/20 p-3">
      <div className="flex items-center justify-between text-xs text-muted-foreground mb-3">
        <span>Gantt · {fmtDate(new Date(base).toISOString())}</span>
        <span>total {fmtDuration(span)}</span>
      </div>
      <div className="space-y-2">
        {nodes.map((node) => {
          const start = nodeStartMs(node, nowMs);
          const endMs = nodeEndMs(node, nowMs);
          const left = start == null ? 0 : Math.max(0, Math.min(96, ((start - base) / span) * 100));
          const rawWidth = start == null || endMs == null ? 2 : ((Math.max(endMs, start + 1000) - start) / span) * 100;
          const width = Math.max(2, Math.min(100 - left, rawWidth));
          const definition = workflowNodes(workflow).find((item) => item.id === node.node_id);
          return (
            <div key={node.id} className="grid grid-cols-[minmax(120px,220px)_1fr] gap-3 items-center text-xs">
              <div className="min-w-0">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-mono text-foreground truncate">{node.node_id}</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full shrink-0 ${statusClass(node.status)}`}>{node.status}</span>
                </div>
                <div className="text-[10px] text-muted-foreground truncate">
                  {definition?.depends_on?.length ? `← ${definition.depends_on.join(', ')}` : fmtDuration(node.duration_ms)}
                </div>
              </div>
              <div className="relative h-7 rounded-md bg-background border border-border overflow-hidden">
                <div
                  className={`absolute top-1 bottom-1 rounded ${ganttColor(node.status)}`}
                  style={{ left: `${left}%`, width: `${width}%` }}
                  title={`${node.node_id}: ${node.status} · ${fmtDuration(node.duration_ms)}`}
                />
                {node.status === 'pending' && <span className="absolute left-2 top-1.5 text-[10px] text-muted-foreground">waiting</span>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ImportWorkflowButton() {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const { importWorkflow } = useWorkflowsStore();

  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const raw = JSON.parse(await file.text()) as unknown;
      const payload = parseImportPayload(raw);
      await importWorkflow(payload.definition, payload.name, payload.description ?? undefined);
    } catch (err) {
      useWorkflowsStore.setState({ error: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <>
      <input ref={inputRef} type="file" accept="application/json,.json" className="hidden" onChange={onFile} />
      <Button variant="outline" onClick={() => inputRef.current?.click()}>
        <FileUp className="w-5 h-5" />
        Import
      </Button>
    </>
  );
}

export function WorkflowsPage() {
  const { workflows, runs, providers, loading, error, load, cancelRun, clearError } = useWorkflowsStore();

  useEffect(() => {
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [load]);

  const runningRuns = runs.filter((run) => run.status === 'running' || run.status === 'queued');
  const recentRuns = runs.slice(0, 20);
  const workflowById = useMemo(() => new Map(workflows.map((workflow) => [workflow.id, workflow])), [workflows]);

  return (
    <div className="min-h-full bg-background p-4 lg:p-8">
      <div className="max-w-7xl mx-auto space-y-6">
        <PageHeader
          title="Dynamic Workflows"
          subtitle={`共 ${workflows.length} 个工作流 · ${runningRuns.length} 个运行中 · 5秒自动刷新`}
          actions={
            <div className="flex items-center gap-2">
              <ImportWorkflowButton />
              <Button variant="outline" onClick={load} disabled={loading}>
                <RefreshCw className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} />
                刷新
              </Button>
            </div>
          }
        />

        {error && (
          <div className="p-3 rounded-lg bg-red-50 border border-red-200 flex items-center justify-between">
            <span className="text-sm text-red-700">{error}</span>
            <button onClick={clearError} className="p-1 text-red-400 hover:text-red-600 rounded transition-colors">
              <X size={16} />
            </button>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {providers.map((provider) => (
            <div key={provider.id} className="bg-card border border-border rounded-xl p-4">
              <div className="flex items-center justify-between mb-2">
                <div className="font-semibold text-foreground">{provider.label}</div>
                <span className={`text-xs px-2 py-0.5 rounded-full ${provider.available ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-500'}`}>
                  {provider.available ? 'available' : 'unavailable'}
                </span>
              </div>
              <div className="text-xs text-muted-foreground">{provider.defaultModel || '-'}</div>
              <div className="text-xs text-muted-foreground mt-2 line-clamp-2">{provider.description}</div>
            </div>
          ))}
        </div>

        {loading && workflows.length === 0 ? (
          <SkeletonCardList count={3} />
        ) : workflows.length === 0 ? (
          <EmptyState icon={Workflow} title="还没有保存 Dynamic Workflow" description="主 Agent 可以通过 workflow_create 工具创建并保存工作流，也可以在这里导入 .workflow.json。" />
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {workflows.map((workflow) => <WorkflowCard key={workflow.id} workflow={workflow} />)}
          </div>
        )}

        <div className="bg-card rounded-xl border border-border p-4 lg:p-6">
          <h2 className="text-lg font-semibold text-foreground mb-4">Recent Runs</h2>
          {recentRuns.length === 0 ? (
            <p className="text-sm text-muted-foreground">暂无运行记录。</p>
          ) : (
            <div className="space-y-3">
              {recentRuns.map((run) => {
                const workflow = workflowById.get(run.workflow_id);
                return (
                  <div key={run.id} className="border border-border rounded-xl p-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium text-foreground">{workflow?.name || run.workflow_id}</span>
                          <span className={`text-xs px-2 py-0.5 rounded-full ${statusClass(run.status)}`}>{run.status}</span>
                        </div>
                        <div className="text-xs text-muted-foreground mt-1 font-mono truncate">{run.id}</div>
                        <div className="text-xs text-muted-foreground mt-1">{fmtDate(run.started_at || run.created_at)} → {fmtDate(run.finished_at)}</div>
                        {run.run_source && <div className="text-xs text-muted-foreground mt-1">source: {run.run_source}</div>}
                        {run.result_path && <div className="text-xs text-muted-foreground mt-1 font-mono truncate">result: {run.result_path}</div>}
                      </div>
                      {(run.status === 'running' || run.status === 'queued') && (
                        <Button variant="outline" size="sm" onClick={() => cancelRun(run.id)}>
                          <Square size={14} />
                          Cancel
                        </Button>
                      )}
                    </div>
                    {run.error && <div className="mt-3 text-xs text-red-600">{run.error}</div>}
                    <RunGantt run={run} workflow={workflow} />
                    <details className="mt-3 text-xs">
                      <summary className="cursor-pointer text-muted-foreground hover:text-foreground">节点输出节选</summary>
                      <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-2">
                        {run.nodes.map((node) => (
                          <div key={node.id} className="rounded-lg bg-muted/40 border border-border p-2">
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-xs font-mono text-foreground">{node.node_id}</span>
                              <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${statusClass(node.status)}`}>{node.status}</span>
                            </div>
                            {node.output_excerpt && <p className="mt-2 text-xs text-muted-foreground line-clamp-3 whitespace-pre-wrap">{node.output_excerpt}</p>}
                            {node.error && <p className="mt-2 text-xs text-red-600 line-clamp-2">{node.error}</p>}
                          </div>
                        ))}
                      </div>
                    </details>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
