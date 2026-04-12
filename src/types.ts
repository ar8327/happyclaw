import type { StreamEvent } from './stream-event.types.js';

export interface AdditionalMount {
  hostPath: string; // Absolute path on host (supports ~ for home)
  containerPath?: string; // Optional — defaults to basename of hostPath. Mounted at /workspace/extra/{value}
  readonly?: boolean; // Default: true for safety
}

/**
 * Mount Allowlist - Security configuration for additional mounts
 * Stored at config/mount-allowlist.json in the project root.
 */
export interface MountAllowlist {
  // Directories that can be mounted into containers
  allowedRoots: AllowedRoot[];
  // Glob patterns for paths that should never be mounted (e.g., ".ssh", ".gnupg")
  blockedPatterns: string[];
  // If true, non-admin-home groups can only mount read-only regardless of config
  nonMainReadOnly: boolean;
}

export interface AllowedRoot {
  // Absolute path or ~ for home (e.g., "~/projects", "/var/repos")
  path: string;
  // Whether read-write mounts are allowed under this root
  allowReadWrite: boolean;
  // Optional description for documentation
  description?: string;
}

export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number; // Default: 300000 (5 minutes)
}

export interface RegisteredGroup {
  name: string;
  folder: string;
  added_at: string;
  containerConfig?: ContainerConfig;
  executionMode?: 'local';
  customCwd?: string; // 本地 Runtime 的自定义工作目录
  initSourcePath?: string; // 初始化时复制来源的本机绝对路径
  initGitUrl?: string; // 初始化时 clone 来源的 Git URL
  created_by?: string;
  is_home?: boolean; // 用户主容器标记
  selected_skills?: string[] | null; // null = 全部启用
  target_agent_id?: string; // IM 消息路由到指定 conversation agent
  target_main_jid?: string; // IM 消息路由到指定工作区的主会话（web:{folder}）
  reply_policy?: 'source_only' | 'mirror'; // IM 绑定的回复策略
  require_mention?: boolean; // 群聊是否需要 @机器人 才响应（默认 false）
  activation_mode?: 'auto' | 'always' | 'when_mentioned' | 'disabled'; // 消息门控模式（默认 'auto'，兼容 require_mention）
  mcp_mode?: 'inherit' | 'custom'; // MCP 模式：继承全局或自定义（默认 'inherit'）
  selected_mcps?: string[] | null; // 自定义模式下选中的 MCP 列表（null = 使用全局全部）
  llm_provider?: 'claude' | 'openai'; // Legacy LLM 提供商兼容字段
  model?: string; // 模型标识符覆盖（如 'opus', 'sonnet', 'haiku'），空=使用全局配置
  thinking_effort?: 'low' | 'medium' | 'high'; // Thinking effort 级别（默认 null=provider 默认）
  context_compression?: 'off' | 'auto' | 'manual'; // 上下文压缩模式（默认 'off'）
  knowledge_extraction?: boolean; // 压缩时是否萃取知识到记忆系统（默认 false）
}

export interface GroupMember {
  user_id: string;
  role: 'owner' | 'member';
  added_at: string;
  added_by?: string;
  username: string;
  display_name: string;
}

export interface NewMessage {
  rowid?: number;
  id: string;
  chat_jid: string;
  source_jid?: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  attachments?: string;
  reply_to_id?: string;
}

/** NewMessage with guaranteed rowid — returned by DB query functions */
export type DbMessage = NewMessage & { rowid: number };

export interface MessageAttachment {
  type: 'image';
  data: string; // base64 编码的图片数据
  mimeType?: string; // 如 'image/png'、'image/jpeg'
}

export interface MessageCursor {
  rowid: number;
}

export interface ScheduledTask {
  id: string;
  session_id?: string;
  session_name?: string | null;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  execution_type: 'agent' | 'script';
  script_command: string | null;
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'completed';
  created_at: string;
  created_by?: string;
  model?: string; // 模型标识符覆盖，空=使用工作区或全局配置
}

export interface TaskRunLog {
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: 'success' | 'error';
  result: string | null;
  error: string | null;
}

// --- Auth types ---

export type UserRole = 'admin' | 'member';
export type UserStatus = 'active' | 'disabled' | 'deleted';

export interface AuthUser {
  id: string;
  username: string;
  role: UserRole;
  status: 'active' | 'disabled' | 'deleted';
  display_name: string;
  permissions: Permission[];
  must_change_password: boolean;
}

export type Permission =
  | 'manage_system_config'
  | 'manage_group_env'
  | 'manage_users'
  | 'manage_invites'
  | 'view_audit_log'
  | 'manage_billing';

export type PermissionTemplateKey =
  | 'admin_full'
  | 'member_basic'
  | 'ops_manager'
  | 'user_admin';

export interface User {
  id: string;
  username: string;
  password_hash: string;
  display_name: string;
  role: UserRole;
  status: UserStatus;
  permissions: Permission[];
  must_change_password: boolean;
  disable_reason: string | null;
  notes: string | null;
  avatar_emoji: string | null;
  avatar_color: string | null;
  ai_name: string | null;
  ai_avatar_emoji: string | null;
  ai_avatar_color: string | null;
  ai_avatar_url: string | null;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
  deleted_at: string | null;
}

export interface UserPublic {
  id: string;
  username: string;
  display_name: string;
  role: UserRole;
  status: UserStatus;
  permissions: Permission[];
  must_change_password: boolean;
  disable_reason: string | null;
  notes: string | null;
  avatar_emoji: string | null;
  avatar_color: string | null;
  ai_name: string | null;
  ai_avatar_emoji: string | null;
  ai_avatar_color: string | null;
  ai_avatar_url: string | null;
  created_at: string;
  last_login_at: string | null;
  last_active_at: string | null;
  deleted_at: string | null;
}

export interface UserSession {
  id: string;
  user_id: string;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
  expires_at: string;
  last_active_at: string;
}

export interface UserSessionWithUser extends UserSession {
  username: string;
  role: UserRole;
  status: UserStatus;
  display_name: string;
  permissions: Permission[];
  must_change_password: boolean;
}

export interface InviteCode {
  code: string;
  created_by: string;
  role: UserRole;
  permission_template: PermissionTemplateKey | null;
  permissions: Permission[];
  max_uses: number;
  used_count: number;
  expires_at: string | null;
  created_at: string;
}

export interface InviteCodeWithCreator extends InviteCode {
  creator_username: string;
}

export type AuthEventType =
  | 'login_success'
  | 'login_failed'
  | 'logout'
  | 'password_changed'
  | 'profile_updated'
  | 'user_created'
  | 'user_disabled'
  | 'user_enabled'
  | 'user_deleted'
  | 'user_restored'
  | 'user_updated'
  | 'role_changed'
  | 'session_revoked'
  | 'invite_created'
  | 'invite_deleted'
  | 'invite_used'
  | 'recovery_reset'
  | 'register_success';

export interface AuthAuditLog {
  id: number;
  event_type: AuthEventType;
  username: string;
  actor_username: string | null;
  ip_address: string | null;
  user_agent: string | null;
  details: Record<string, unknown> | null;
  created_at: string;
}

// --- Sub-Agent types ---

export type AgentStatus = 'idle' | 'running' | 'completed' | 'error';
export type AgentKind = 'task' | 'conversation';

export interface SubAgent {
  id: string;
  group_folder: string;
  chat_jid: string;
  name: string;
  prompt: string;
  status: AgentStatus;
  kind: AgentKind;
  created_by: string | null;
  created_at: string;
  completed_at: string | null;
  result_summary: string | null;
}

// --- Session workbench types ---

export type SessionKind = 'main' | 'workspace' | 'worker' | 'memory';
export type SessionRuntimeMode = 'local' | 'container' | 'host';
export type SessionBindingMode = 'direct' | 'source_only' | 'mirror';
export type RunnerId = string;
export type ResumeStrength = 'none' | 'weak' | 'strong';
export type InterruptStrength = 'none' | 'weak' | 'strong';
export type UsageQuality = 'none' | 'approx' | 'exact';
export type ToolStreamingMode = 'none' | 'coarse' | 'fine';
export type SubAgentMode = 'native' | 'tool-only' | 'none';
export type CustomToolsMode = 'native' | 'mcp' | 'none';
export type SkillsMode = 'native' | 'tool-loader';
export type McpTransport = 'stdio' | 'http' | 'sse';
export type TurnBoundaryMode = 'native' | 'simulated';
export type ArchivalTrigger =
  | 'pre_compact'
  | 'turn_threshold'
  | 'cleanup_only'
  | 'external';
export type ContextShrinkTriggerMode = 'native_event' | 'synthetic' | 'none';
export type BeforeToolExecutionGuardMode =
  | 'native_hook'
  | 'tool_wrapper'
  | 'sandbox_only'
  | 'none';
export type HookStreamingMode = 'none' | 'begin_end' | 'progress';
export type PostCompactRepairMode = 'native' | 'synthetic' | 'none';
export type PromptMode = 'append' | 'full_prompt' | 'instructions_file';
export type DynamicContextReloadMode = 'none' | 'turn' | 'mid_turn';

export interface SessionRecord {
  id: string;
  name: string;
  kind: SessionKind;
  parent_session_id: string | null;
  cwd: string;
  runner_id: RunnerId;
  runner_profile_id: string | null;
  runtime_mode: SessionRuntimeMode;
  model: string | null;
  thinking_effort: 'low' | 'medium' | 'high' | null;
  context_compression: 'off' | 'auto' | 'manual';
  knowledge_extraction: boolean;
  is_pinned: boolean;
  archived: boolean;
  owner_key: string | null;
  created_at: string;
  updated_at: string;
}

export interface SessionBindingRecord {
  channel_jid: string;
  session_id: string;
  binding_mode: SessionBindingMode;
  activation_mode: 'auto' | 'always' | 'when_mentioned' | 'disabled';
  require_mention: boolean;
  display_name: string | null;
  reply_policy: 'source_only' | 'mirror';
  created_at: string;
  updated_at: string;
}

export interface SessionRuntimeStateRecord {
  session_id: string;
  provider_session_id: string | null;
  resume_anchor: string | null;
  provider_state_json: string | null;
  recent_im_channels_json: string | null;
  im_channel_last_seen_json: string | null;
  current_permission_mode: string | null;
  last_message_cursor: string | null;
  updated_at: string;
}

export interface RuntimeStateSnapshot {
  providerSessionId?: string;
  resumeAnchor?: string;
  providerState?: Record<string, unknown>;
  recentImChannels: string[];
  imChannelLastSeen: Record<string, number>;
  currentPermissionMode: string;
  lastMessageCursor?: string | null;
}

export interface WorkerSessionRecord {
  session_id: string;
  parent_session_id: string;
  source_chat_jid: string;
  name: string;
  kind: AgentKind;
  prompt: string;
  status: AgentStatus;
  created_at: string;
  completed_at: string | null;
  result_summary: string | null;
}

export interface RunnerProfileRecord {
  id: string;
  runner_id: RunnerId;
  name: string;
  config_json: string;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

export interface RunnerCapabilities {
  sessionResume: ResumeStrength;
  interrupt: InterruptStrength;
  imageInput: boolean;
  usage: UsageQuality;
  midQueryPush: boolean;
  runtimeModeSwitch: boolean;
  toolStreaming: ToolStreamingMode;
  backgroundTasks: boolean;
  subAgent: SubAgentMode;
  customTools: CustomToolsMode;
  mcpTransport: McpTransport[];
  skills: SkillsMode[];
}

export interface RunnerLifecycleCapabilities {
  turnBoundary: TurnBoundaryMode;
  archivalTrigger: ArchivalTrigger[];
  contextShrinkTrigger: ContextShrinkTriggerMode;
  beforeToolExecutionGuard: BeforeToolExecutionGuardMode;
  hookStreaming: HookStreamingMode;
  postCompactRepair: PostCompactRepairMode;
}

export interface RunnerPromptContract {
  mode: PromptMode;
  dynamicContextReload: DynamicContextReloadMode;
}

export interface RunnerCompatibility {
  chat: 'full' | 'degraded' | 'unsupported';
  memory: 'full' | 'synthetic' | 'unsupported';
  im: 'full' | 'degraded' | 'unsupported';
  observability: 'full' | 'degraded' | 'unsupported';
}

export interface RunnerDescriptor {
  id: RunnerId;
  label: string;
  capabilities: RunnerCapabilities;
  lifecycle: RunnerLifecycleCapabilities;
  promptContract: RunnerPromptContract;
  compatibility: RunnerCompatibility;
  defaultProfileFactory?: () => object;
}

// WebSocket message types
export type WsMessageOut =
  | {
      type: 'new_message';
      chatJid: string;
      message: NewMessage & { is_from_me: boolean };
      agentId?: string;
    }
  | {
      type: 'agent_reply';
      chatJid: string;
      text: string;
      timestamp: string;
      agentId?: string;
    }
  | { type: 'typing'; chatJid: string; isTyping: boolean; agentId?: string }
  | {
      type: 'status_update';
      activeRuntimes: number;
      maxConcurrentRuntimes: number;
      queueLength: number;
    }
  | {
      type: 'stream_event';
      chatJid: string;
      event: StreamEvent;
      agentId?: string;
    }
  | {
      type: 'agent_status';
      chatJid: string;
      agentId: string;
      status: AgentStatus;
      kind?: AgentKind;
      name: string;
      prompt: string;
      resultSummary?: string;
    }
  | {
      type: 'runner_state';
      chatJid: string;
      state:
        | 'queued'
        | 'capacity_wait'
        | 'starting'
        | 'idle'
        | 'running'
        | 'interrupting'
        | 'interrupted'
        | 'closing'
        | 'error';
      agentId?: string;
      detail?: string;
    }
  | {
      type: 'task_state';
      chatJid: string;
      taskId: string;
      status: 'running' | 'completed' | 'error';
      name: string;
      prompt: string;
      resultSummary?: string;
      kind?: AgentKind;
    }
  | { type: 'terminal_output'; chatJid: string; data: string }
  | { type: 'terminal_started'; chatJid: string }
  | { type: 'terminal_stopped'; chatJid: string; reason?: string }
  | { type: 'terminal_error'; chatJid: string; error: string }
  | {
      type: 'billing_update';
      userId: string;
      usage: BillingAccessResult;
    };

export type WsMessageIn =
  | {
      type: 'send_message';
      chatJid: string;
      content: string;
      attachments?: MessageAttachment[];
      agentId?: string;
    }
  | { type: 'terminal_start'; chatJid: string; cols: number; rows: number }
  | { type: 'terminal_input'; chatJid: string; data: string }
  | { type: 'terminal_resize'; chatJid: string; cols: number; rows: number }
  | { type: 'terminal_stop'; chatJid: string };

// --- Streaming event types (canonical source: shared/stream-event.ts) ---
export type { StreamEventType } from './stream-event.types.js';
export type { StreamEvent };

// --- Billing types ---

export interface BillingPlan {
  id: string;
  name: string;
  description: string | null;
  tier: number; // 0=免费, 10=基础, 20=专业, 30=企业
  monthly_cost_usd: number;
  monthly_token_quota: number | null; // null=无限
  monthly_cost_quota: number | null; // null=无限
  daily_cost_quota: number | null; // null=无限
  weekly_cost_quota: number | null; // null=无限
  daily_token_quota: number | null; // null=无限
  weekly_token_quota: number | null; // null=无限
  rate_multiplier: number; // 费用倍率，默认 1.0
  trial_days: number | null; // 试用天数
  sort_order: number; // 排序权重
  display_price: string | null; // 展示价格文本（如 "¥99/月"）
  highlight: boolean; // 推荐标记
  max_groups: number | null;
  max_concurrent_containers: number | null;
  max_im_channels: number | null;
  max_mcp_servers: number | null;
  max_storage_mb: number | null;
  allow_overage: boolean;
  features: string[]; // JSON 特性标签
  is_default: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface UserSubscription {
  id: string;
  user_id: string;
  plan_id: string;
  status: 'active' | 'expired' | 'cancelled';
  started_at: string;
  expires_at: string | null;
  cancelled_at: string | null;
  trial_ends_at: string | null;
  notes: string | null;
  auto_renew: boolean;
  created_at: string;
}

export interface UserBalance {
  user_id: string;
  balance_usd: number;
  total_deposited_usd: number;
  total_consumed_usd: number;
  updated_at: string;
}

export type BalanceTransactionType =
  | 'deposit'
  | 'deduction'
  | 'refund'
  | 'adjustment'
  | 'redeem';
export type BalanceTransactionSource =
  | 'admin_manual_recharge'
  | 'admin_manual_deduct'
  | 'usage_charge'
  | 'redeem_code'
  | 'migration_opening'
  | 'refund'
  | 'subscription_renewal'
  | 'system_adjustment';
export type BalanceOperatorType = 'system' | 'admin' | 'user';
export type BalanceReferenceType =
  | 'message'
  | 'task'
  | 'subscription'
  | 'redeem_code'
  | 'admin_adjust';

export interface BalanceTransaction {
  id: number;
  user_id: string;
  type: BalanceTransactionType;
  amount_usd: number; // 正=入账, 负=扣除
  balance_after: number;
  description: string | null;
  reference_type: BalanceReferenceType | null;
  reference_id: string | null;
  actor_id: string | null;
  source: BalanceTransactionSource;
  operator_type: BalanceOperatorType;
  notes: string | null;
  idempotency_key: string | null;
  created_at: string;
}

export interface MonthlyUsage {
  user_id: string;
  month: string; // YYYY-MM
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd: number;
  message_count: number;
  updated_at: string;
}

export type RedeemCodeType = 'balance' | 'subscription' | 'trial';

export interface RedeemCode {
  code: string;
  type: RedeemCodeType;
  value_usd: number | null;
  plan_id: string | null;
  duration_days: number | null;
  max_uses: number;
  used_count: number;
  expires_at: string | null;
  created_by: string;
  notes: string | null;
  batch_id: string | null;
  created_at: string;
}

export interface RedeemCodeUsage {
  id: number;
  code: string;
  user_id: string;
  redeemed_at: string;
}

export type BillingAuditEventType =
  | 'plan_created'
  | 'plan_updated'
  | 'plan_deleted'
  | 'subscription_assigned'
  | 'subscription_cancelled'
  | 'subscription_expired'
  | 'balance_adjusted'
  | 'manual_recharge'
  | 'manual_deduct'
  | 'balance_deducted'
  | 'code_created'
  | 'code_redeemed'
  | 'code_deleted'
  | 'wallet_blocked'
  | 'wallet_unblocked'
  | 'quota_exceeded';

export interface BillingAuditLog {
  id: number;
  event_type: BillingAuditEventType;
  user_id: string;
  actor_id: string | null;
  details: Record<string, unknown> | null;
  created_at: string;
}

export interface DailyUsage {
  user_id: string;
  date: string; // YYYY-MM-DD
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd: number;
  message_count: number;
}

export interface QuotaWindowUsage {
  costUsed: number;
  costQuota: number | null;
  tokenUsed: number;
  tokenQuota: number | null;
}

export interface QuotaCheckResult {
  allowed: boolean;
  reason?: string;
  exceededWindow?: 'daily' | 'weekly' | 'monthly'; // 哪个窗口超限
  resetAt?: string; // 下次重置时间 ISO
  warningPercent?: number; // 当前用量百分比 (0-100+)
  usage?: QuotaWindowUsage & {
    daily?: QuotaWindowUsage;
    weekly?: QuotaWindowUsage;
  };
}

export type BillingBlockType =
  | 'insufficient_balance'
  | 'plan_inactive'
  | 'quota_exceeded'
  | 'resource_limit';

export interface BillingAccessResult {
  allowed: boolean;
  blockType?: BillingBlockType;
  reason?: string;
  balanceUsd: number;
  minBalanceUsd: number;
  balanceMissingUsd?: number;
  planId: string | null;
  planName: string | null;
  subscriptionStatus: 'active' | 'expired' | 'cancelled' | 'default' | null;
  warningPercent?: number;
  usage?: QuotaCheckResult['usage'];
  exceededWindow?: QuotaCheckResult['exceededWindow'];
  resetAt?: string;
}
