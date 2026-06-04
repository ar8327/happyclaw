import { create } from 'zustand';
import { api } from '../api/client';

export type WorkflowRunStatus = 'queued' | 'running' | 'success' | 'error' | 'cancelled';
export type WorkflowNodeStatus = 'pending' | 'running' | 'success' | 'error' | 'skipped' | 'cancelled';

export interface WorkflowDefinition {
  name?: string;
  description?: string;
  settings?: {
    max_concurrency?: number;
    node_timeout_ms?: number;
    provider?: string;
    model?: string;
    thinking_effort?: 'low' | 'medium' | 'high' | 'max';
    retry?: {
      max_attempts?: number;
      backoff_ms?: number;
    };
  };
  nodes: Array<{
    id: string;
    type: 'agent';
    prompt: string;
    provider?: string;
    model?: string;
    thinking_effort?: 'low' | 'medium' | 'high' | 'max';
    depends_on?: string[];
    timeout_ms?: number;
    max_turns?: number;
    retry?: {
      max_attempts?: number;
      backoff_ms?: number;
    };
  }>;
}

export interface WorkflowRecord {
  id: string;
  owner_key: string;
  name: string;
  description: string | null;
  version: number;
  definition_json: string;
  definition: WorkflowDefinition;
  workspace_folder: string | null;
  group_folder: string | null;
  created_by: string | null;
  status: 'active' | 'archived';
  created_at: string;
  updated_at: string;
}

export interface WorkflowNodeRun {
  id: string;
  run_id: string;
  workflow_id: string;
  node_id: string;
  status: WorkflowNodeStatus;
  provider: string | null;
  model: string | null;
  output_path?: string | null;
  transcript_path?: string | null;
  output_excerpt: string | null;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  created_at?: string;
  updated_at?: string;
}

export interface WorkflowRun {
  id: string;
  workflow_id: string;
  owner_key: string;
  version: number;
  status: WorkflowRunStatus;
  input_json: string | null;
  result_json: string | null;
  result_path: string | null;
  final_node_id: string | null;
  result_excerpt?: string | null;
  error: string | null;
  workspace_folder: string | null;
  group_folder: string | null;
  run_source: string | null;
  trigger_json: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
  nodes: WorkflowNodeRun[];
}

export interface WorkflowProvider {
  id: string;
  label: string;
  available: boolean;
  defaultModel?: string;
  description?: string;
}

interface WorkflowsState {
  workflows: WorkflowRecord[];
  runs: WorkflowRun[];
  providers: WorkflowProvider[];
  loading: boolean;
  error: string | null;
  load: () => Promise<void>;
  runWorkflow: (workflowId: string) => Promise<void>;
  cancelRun: (runId: string) => Promise<void>;
  importWorkflow: (definition: WorkflowDefinition, name?: string, description?: string | null) => Promise<void>;
  clearError: () => void;
}

export const useWorkflowsStore = create<WorkflowsState>((set, get) => ({
  workflows: [],
  runs: [],
  providers: [],
  loading: false,
  error: null,

  load: async () => {
    set({ loading: true });
    try {
      const [workflowsData, runsData, providersData] = await Promise.all([
        api.get<{ workflows: WorkflowRecord[] }>('/api/workflows'),
        api.get<{ runs: WorkflowRun[] }>('/api/workflows/runs?limit=100'),
        api.get<{ providers: WorkflowProvider[] }>('/api/workflows/providers'),
      ]);
      set({
        workflows: workflowsData.workflows,
        runs: runsData.runs,
        providers: providersData.providers,
        loading: false,
        error: null,
      });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  runWorkflow: async (workflowId: string) => {
    try {
      await api.post(`/api/workflows/${workflowId}/run`, { wait: false }, 20000);
      await get().load();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  importWorkflow: async (definition: WorkflowDefinition, name?: string, description?: string | null) => {
    try {
      await api.post('/api/workflows', {
        name: name || definition.name || 'Imported workflow',
        description: description ?? definition.description,
        definition,
      }, 20000);
      await get().load();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  cancelRun: async (runId: string) => {
    try {
      await api.post(`/api/workflows/runs/${runId}/cancel`);
      await get().load();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  clearError: () => set({ error: null }),
}));
