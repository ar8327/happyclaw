export interface SessionInfo {
  id?: string;
  name: string;
  folder: string;
  created_at: string;
  kind?: 'home' | 'main' | 'workspace' | 'worker' | 'memory' | 'feishu' | 'web';
  editable?: boolean;
  deletable?: boolean;
  lastMessage?: string;
  lastMessageTime?: string;
  selected_skills?: string[] | null;
  pinned_at?: string;
  activation_mode?: 'auto' | 'always' | 'when_mentioned' | 'disabled';
  runner_id?: string;
  runner_profile_id?: string | null;
  runner_label?: string;
  model?: string;
  thinking_effort?: 'low' | 'medium' | 'high' | null;
  context_compression?: 'off' | 'auto' | 'manual';
  cwd?: string;
  owner_key?: string | null;
  binding_count?: number;
  binding_summary?: string;
  bound_channels?: string[];
  backing_jid?: string | null;
  degradation_reasons?: string[];
  codex_compact?: {
    current_tokens: number;
    current_input_tokens: number;
    current_output_tokens: number;
    threshold_tokens: number;
    remaining_tokens: number;
    progress: number;
    turn_count: number;
    start_fresh_on_next_turn: boolean;
    last_compacted_at: string | null;
    state_updated_at: string | null;
  } | null;
}

export interface AgentInfo {
  id: string;
  session_id?: string;
  name: string;
  prompt: string;
  status: 'idle' | 'running' | 'completed' | 'error';
  kind: 'task' | 'conversation';
  created_at: string;
  completed_at?: string;
  result_summary?: string;
  linked_im_groups?: Array<{ jid: string; name: string }>;
}

export interface AvailableImChannel {
  jid: string;
  name: string;
  bound_session_id: string | null;
  bound_session_kind?: 'main' | 'workspace' | 'worker' | 'memory' | null;
  binding_mode?: 'direct' | 'source_only' | 'mirror';
  bound_target_name: string | null;
  bound_workspace_name: string | null;
  reply_policy?: 'source_only' | 'mirror';
  activation_mode?: 'auto' | 'always' | 'when_mentioned' | 'disabled';
  require_mention?: boolean;
  avatar?: string;
  member_count?: number;
  channel_type: string;
}

export type AvailableImGroup = AvailableImChannel;
