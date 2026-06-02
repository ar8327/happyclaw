import { useEffect } from 'react';
import { GitBranch, Play, RefreshCw, Square, Workflow, X } from 'lucide-react';
import { PageHeader } from '@/components/common/PageHeader';
import { EmptyState } from '@/components/common/EmptyState';
import { SkeletonCardList } from '@/components/common/Skeletons';
import { Button } from '@/components/ui/button';
import { useWorkflowsStore, type WorkflowRunStatus } from '../stores/workflows';

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
    default:
      return 'bg-slate-100 text-slate-600';
  }
}

function fmtDate(value: string | null | undefined) {
  if (!value) return '-';
  return new Date(value).toLocaleString();
}

export function WorkflowsPage() {
  const { workflows, runs, providers, loading, error, load, runWorkflow, cancelRun, clearError } = useWorkflowsStore();

  useEffect(() => {
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [load]);

  const runningRuns = runs.filter((run) => run.status === 'running' || run.status === 'queued');
  const recentRuns = runs.slice(0, 20);

  return (
    <div className="min-h-full bg-background p-4 lg:p-8">
      <div className="max-w-7xl mx-auto space-y-6">
        <PageHeader
          title="Dynamic Workflows"
          subtitle={`共 ${workflows.length} 个工作流 · ${runningRuns.length} 个运行中 · 5秒自动刷新`}
          actions={
            <Button variant="outline" onClick={load} disabled={loading}>
              <RefreshCw className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} />
              刷新
            </Button>
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
          <EmptyState icon={Workflow} title="还没有保存 Dynamic Workflow" description="主 Agent 可以通过 workflow_create 工具创建并保存工作流。" />
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {workflows.map((workflow) => (
              <div key={workflow.id} className="bg-card border border-border rounded-xl p-5">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2">
                      <GitBranch size={18} className="text-blue-500" />
                      <h2 className="font-semibold text-foreground">{workflow.name}</h2>
                      <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">v{workflow.version}</span>
                    </div>
                    {workflow.description && <p className="text-sm text-muted-foreground mt-2">{workflow.description}</p>}
                    <p className="text-xs text-muted-foreground mt-2">{workflow.definition.nodes.length} nodes · updated {fmtDate(workflow.updated_at)}</p>
                  </div>
                  <Button size="sm" onClick={() => runWorkflow(workflow.id)}>
                    <Play size={16} />
                    Run
                  </Button>
                </div>
                <div className="mt-4 space-y-2">
                  {workflow.definition.nodes.map((node) => (
                    <div key={node.id} className="text-xs rounded-lg border border-border bg-muted/30 p-2">
                      <span className="font-mono text-foreground">{node.id}</span>
                      <span className="ml-2 text-muted-foreground">{node.provider || workflow.definition.settings?.provider || 'default'}</span>
                      {node.depends_on && node.depends_on.length > 0 && (
                        <span className="ml-2 text-muted-foreground">← {node.depends_on.join(', ')}</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="bg-card rounded-xl border border-border p-4 lg:p-6">
          <h2 className="text-lg font-semibold text-foreground mb-4">Recent Runs</h2>
          {recentRuns.length === 0 ? (
            <p className="text-sm text-muted-foreground">暂无运行记录。</p>
          ) : (
            <div className="space-y-3">
              {recentRuns.map((run) => {
                const workflow = workflows.find((item) => item.id === run.workflow_id);
                return (
                  <div key={run.id} className="border border-border rounded-xl p-4">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-foreground">{workflow?.name || run.workflow_id}</span>
                          <span className={`text-xs px-2 py-0.5 rounded-full ${statusClass(run.status)}`}>{run.status}</span>
                        </div>
                        <div className="text-xs text-muted-foreground mt-1 font-mono">{run.id}</div>
                        <div className="text-xs text-muted-foreground mt-1">{fmtDate(run.started_at || run.created_at)} → {fmtDate(run.finished_at)}</div>
                      </div>
                      {(run.status === 'running' || run.status === 'queued') && (
                        <Button variant="outline" size="sm" onClick={() => cancelRun(run.id)}>
                          <Square size={14} />
                          Cancel
                        </Button>
                      )}
                    </div>
                    {run.error && <div className="mt-3 text-xs text-red-600">{run.error}</div>}
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
