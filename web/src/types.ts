export interface SessionInfo {
  id?: string;
  name: string;
  folder: string;
  added_at: string;
  kind?: 'home' | 'main' | 'workspace' | 'worker' | 'memory' | 'feishu' | 'web';
  is_home?: boolean;
  is_my_home?: boolean;
  is_shared?: boolean;
  member_role?: 'owner' | 'member';
  member_count?: number;
  editable?: boolean;
  deletable?: boolean;
  lastMessage?: string;
  lastMessageTime?: string;
  runtime_mode?: 'local';
  execution_mode?: 'local';
  custom_cwd?: string;
  created_by?: string;
  selected_skills?: string[] | null;
  pinned_at?: string;
  activation_mode?: 'auto' | 'always' | 'when_mentioned' | 'disabled';
  llm_provider?: 'claude' | 'openai';
  runner_id?: string;
  runner_profile_id?: string | null;
  runner_label?: string;
  model?: string;
  thinking_effort?: 'low' | 'medium' | 'high' | null;
  context_compression?: 'off' | 'auto' | 'manual';
  knowledge_extraction?: boolean;
  session_kind?: 'main' | 'workspace' | 'worker' | 'memory';
  cwd?: string;
  owner_key?: string | null;
  binding_count?: number;
  binding_summary?: string;
  bound_channels?: string[];
  backing_jid?: string | null;
  degradation_reasons?: string[];
}

export type GroupInfo = SessionInfo;

export interface AgentInfo {
  id: string;
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
  binding_mode?: 'direct' | 'source_only' | 'mirror';
  bound_agent_id: string | null;
  bound_main_jid: string | null;
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

export interface SessionMember {
  user_id: string;
  role: 'owner' | 'member';
  added_at: string;
  added_by?: string;
  username: string;
  display_name: string;
}

export type GroupMember = SessionMember;
