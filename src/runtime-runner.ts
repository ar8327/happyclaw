/**
 * Session runtime launcher for happyclaw.
 * Unified local runtime launcher for happyclaw sessions.
 */
import {
  ChildProcess,
  execFileSync,
  spawn,
} from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from './config.js';
import { logger } from './logger.js';
import { getDefaultRunnerId } from './runner-registry.js';
import {
  loadMountAllowlist,
} from './mount-security.js';
import {
  buildRuntimeEnvLines,
  getClaudeProviderConfig,
  getRuntimeEnvConfig,
  getSessionRuntimeEnvConfig,
  getCodexProviderConfig,
  getSystemSettings,
  mergeRuntimeEnvConfig,
  mergeClaudeEnvConfig,
  parseRunnerProfileRuntimeOverride,
  writeCredentialsFile,
} from './runtime-config.js';
import { resolveGroupMcpServers } from './mcp-utils.js';
import { getInternalToken } from './routes/memory-agent.js';
import { RegisteredGroup, StreamEvent } from './types.js';
import {
  attachStderrHandler,
  attachStdoutHandler,
  createStderrState,
  createStdoutParserState,
  handleNonZeroExit,
  handleSuccessClose,
  handleTimeoutClose,
  writeRunLog,
  type CloseHandlerContext,
} from './agent-output-parser.js';
import { getPrimarySessionForOwner, getRunnerProfile, getSessionRecord } from './db.js';

/**
 * Required env flags for settings.json — 每次 Runtime 启动时强制写入，不可被用户覆盖。
 * 合并模式：仅覆盖这些 key，保留用户自定义的其他 key。
 */
const REQUIRED_SETTINGS_ENV: Record<string, string> = {
  CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
  CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
};

/** Read existing settings.json, deep-merge required env keys and mcpServers, write only if changed */
function ensureSettingsJson(
  settingsFile: string,
  mcpServers?: Record<string, Record<string, unknown>>,
): void {
  let existing: Record<string, unknown> = {};
  try {
    if (fs.existsSync(settingsFile)) {
      existing = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    }
  } catch {
    /* ignore parse errors, overwrite */
  }

  const existingEnv = (existing.env as Record<string, string>) || {};
  const mergedEnv = { ...existingEnv, ...REQUIRED_SETTINGS_ENV };
  const merged: Record<string, unknown> = { ...existing, env: mergedEnv };

  // Merge user-configured MCP servers into settings
  if (mcpServers && Object.keys(mcpServers).length > 0) {
    const existingMcp = (existing.mcpServers as Record<string, unknown>) || {};
    merged.mcpServers = { ...existingMcp, ...mcpServers };
  }

  const newContent = JSON.stringify(merged, null, 2) + '\n';

  // Only write when content actually changed
  try {
    if (fs.existsSync(settingsFile)) {
      const current = fs.readFileSync(settingsFile, 'utf8');
      if (current === newContent) return;
    }
  } catch {
    /* write anyway */
  }

  fs.writeFileSync(settingsFile, newContent, { mode: 0o644 });
}

export interface RuntimeInput {
  prompt: string;
  sessionId?: string;
  resumeAnchor?: string;
  sessionRecordId?: string;
  groupFolder: string;
  chatJid: string;
  isHome: boolean;
  isAdminHome: boolean;
  images?: Array<{ data: string; mimeType?: string }>;
  agentId?: string;
  agentName?: string;
  userId?: string;
  turnId?: string;
  contextSummary?: string;
  bootstrapState?: {
    providerState?: Record<string, unknown>;
    recentImChannels?: string[];
    imChannelLastSeen?: Record<string, number>;
    currentPermissionMode?: string | null;
    lastMessageCursor?: string | null;
  };
}

export interface RuntimeLaunchProfile {
  toolProfile?: 'memory';
  additionalDirectories?: string[];
  disableUserMcpServers?: boolean;
}

export interface RuntimeOutput {
  status: 'success' | 'error' | 'stream' | 'closed' | 'drained';
  result: string | null;
  newSessionId?: string;
  error?: string;
  streamEvent?: StreamEvent;
  runtimeState?: {
    providerSessionId?: string;
    resumeAnchor?: string;
    providerState?: Record<string, unknown>;
    recentImChannels: string[];
    imChannelLastSeen: Record<string, number>;
    currentPermissionMode: string;
    lastMessageCursor?: string | null;
  };
}

export type ContainerInput = RuntimeInput;
export type ContainerOutput = RuntimeOutput;

export function writeTasksSnapshot(
  groupFolder: string,
  isAdminHome: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  // Write filtered tasks to the group's IPC directory
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Admin home sees all tasks, others only see their own
  const filteredTasks = isAdminHome
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  // 删除后重建：容器创建的文件归属 node(1000) 用户，宿主机进程无法覆写
  try {
    fs.unlinkSync(tasksFile);
  } catch {
    /* ignore */
  }
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

/**
 * Write available groups snapshot for the runtime to read.
 * Only the primary Session workspace gets the full activation target list.
 * Other workspaces see nothing because they cannot activate arbitrary groups.
 */
export function writeGroupsSnapshot(
  groupFolder: string,
  isAdminHome: boolean,
  groups: AvailableGroup[],
  registeredJids: Set<string>,
): void {
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // The primary Session workspace sees all groups; others see nothing.
  const visibleGroups = isAdminHome ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  try {
    fs.unlinkSync(groupsFile);
  } catch {
    /* ignore */
  }
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}

/**
 * 杀死进程及其所有子进程。
 * 如果进程以 detached 模式启动（独立进程组），使用负 PID 杀整个进程组。
 */
export function killProcessTree(
  proc: ChildProcess,
  signal: NodeJS.Signals = 'SIGTERM',
): boolean {
  try {
    if (proc.pid) {
      process.kill(-proc.pid, signal);
      return true;
    }
  } catch {
    try {
      proc.kill(signal);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Run agent directly as a local subprocess.
 * This is the unified runtime path for sessions after dual-mode removal.
 */
function resolvePrimarySessionFolderForOwner(ownerKey: string | null): string | null {
  if (!ownerKey) return null;
  const primary = getPrimarySessionForOwner(ownerKey);
  if (!primary?.id.startsWith('main:')) return null;
  return primary.id.slice('main:'.length);
}

export async function runHostAgent(
  group: RegisteredGroup,
  input: RuntimeInput,
  onProcess: (proc: ChildProcess, identifier: string) => void,
  onOutput?: (output: RuntimeOutput) => Promise<void>,
  ownerPrimarySessionFolder?: string,
  launchProfile?: RuntimeLaunchProfile,
): Promise<RuntimeOutput> {
  const startTime = Date.now();
  const localRuntimeSetupError = (message: string): RuntimeOutput => ({
    status: 'error',
    result: `本地 Runtime 启动失败：${message}`,
    error: message,
  });

  // 1. 确定工作目录
  const defaultGroupDir = path.join(GROUPS_DIR, group.folder);
  if (!group.customCwd) {
    fs.mkdirSync(defaultGroupDir, { recursive: true });
    // 确保 group 目录是独立 git root，防止 Claude Code 向上找到父项目的 .git
    const gitDir = path.join(defaultGroupDir, '.git');
    if (!fs.existsSync(gitDir)) {
      try {
        execFileSync('git', ['init'], {
          cwd: defaultGroupDir,
          stdio: 'ignore',
        });
        logger.info(
          { folder: group.folder },
          'Initialized git repository for group',
        );
      } catch (err) {
        // Non-fatal: agent still works, just reports wrong working directory
        logger.warn(
          { folder: group.folder, err },
          'Failed to initialize git repository',
        );
      }
    }
  }
  let groupDir = group.customCwd || defaultGroupDir;
  if (!path.isAbsolute(groupDir)) {
    return localRuntimeSetupError(`工作目录必须是绝对路径：${groupDir}`);
  }
  // Resolve symlinks to prevent TOCTOU attacks
  try {
    groupDir = fs.realpathSync(groupDir);
  } catch {
    return localRuntimeSetupError(`工作目录不存在或无法解析：${groupDir}`);
  }
  if (!fs.statSync(groupDir).isDirectory()) {
    return localRuntimeSetupError(`工作目录不是目录：${groupDir}`);
  }

  // Runtime allowlist validation for custom CWD (defense-in-depth: web.ts validates at creation,
  // but re-check here in case allowlist was tightened or path was injected via DB)
  if (group.customCwd) {
    const allowlist = loadMountAllowlist();
    if (
      allowlist &&
      allowlist.allowedRoots &&
      allowlist.allowedRoots.length > 0
    ) {
      let allowed = false;
      for (const root of allowlist.allowedRoots) {
        const expandedRoot = root.path.startsWith('~')
          ? path.join(
              process.env.HOME || '/Users/user',
              root.path.slice(root.path.startsWith('~/') ? 2 : 1),
            )
          : path.resolve(root.path);

        let realRoot: string;
        try {
          realRoot = fs.realpathSync(expandedRoot);
        } catch {
          continue;
        }

        const relative = path.relative(realRoot, groupDir);
        if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
          allowed = true;
          break;
        }
      }

      if (!allowed) {
        return localRuntimeSetupError(
          `工作目录 ${groupDir} 不在允许的根目录下，请检查 mount-allowlist.json`,
        );
      }
    }
  }

  const stableSessionId =
    input.sessionRecordId ||
    (input.agentId ? `worker:${input.agentId}` : `main:${input.groupFolder}`);
  const sessionRecord = getSessionRecord(stableSessionId);
  const folderSession = getSessionRecord(`main:${input.groupFolder}`);
  const sessionOwnerKey =
    sessionRecord?.owner_key ||
    folderSession?.owner_key ||
    null;
  if (!sessionOwnerKey) {
    return localRuntimeSetupError(
      `Session ${stableSessionId} 缺少 owner_key，无法初始化本地 Runtime`,
    );
  }
  const sharedPrimarySessionFolder =
    ownerPrimarySessionFolder ||
    resolvePrimarySessionFolderForOwner(sessionOwnerKey) ||
    group.folder;
  const runtimeMemoryDir = path.join(
    DATA_DIR,
    'memory',
    sessionOwnerKey,
  );

  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });
  fs.mkdirSync(runtimeMemoryDir, { recursive: true });

  // 2. 确保目录结构
  // Sub-agents get their own IPC and session directories
  const groupIpcDir = input.agentId
    ? path.join(DATA_DIR, 'ipc', group.folder, 'agents', input.agentId)
    : path.join(DATA_DIR, 'ipc', group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), {
    recursive: true,
    mode: 0o700,
  });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), {
    recursive: true,
    mode: 0o700,
  });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), {
    recursive: true,
    mode: 0o700,
  });
  // All agents (main + sub/conversation) get agents/ subdir for spawn/message IPC
  fs.mkdirSync(path.join(groupIpcDir, 'agents'), {
    recursive: true,
    mode: 0o700,
  });

  const groupSessionsDir = input.agentId
    ? path.join(
        DATA_DIR,
        'sessions',
        group.folder,
        'agents',
        input.agentId,
        '.claude',
      )
    : path.join(DATA_DIR, 'sessions', group.folder, '.claude');
  fs.mkdirSync(groupSessionsDir, { recursive: true });

  // 3. 写入 settings.json（合并模式，不覆盖已有用户配置）
  // Resolve MCP servers based on group's mcp_mode for the unified local runtime.
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  const hostMcpServers = launchProfile?.disableUserMcpServers
    ? {}
    : resolveGroupMcpServers(group, sessionOwnerKey);
  ensureSettingsJson(settingsFile, hostMcpServers);

  // 4. Skills 自动链接到 session 目录
  // 链接顺序：项目级 → 宿主机级(admin only, 覆盖同名项目级) → 用户级(覆盖同名)
  // selected_skills 过滤：仅链接选中的 skills
  try {
    const skillsDir = path.join(groupSessionsDir, 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });
    // 清空已有符号链接
    for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      const entryPath = path.join(skillsDir, entry.name);
      try {
        if (entry.isSymbolicLink() || entry.isDirectory()) {
          fs.rmSync(entryPath, { recursive: true, force: true });
        }
      } catch {
        /* ignore */
      }
    }

    const selectedSkills = group.selected_skills ?? null;
    const selectedSet = selectedSkills ? new Set(selectedSkills) : null;

    const linkSkillEntries = (sourceDir: string) => {
      if (!fs.existsSync(sourceDir)) return;
      for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        if (selectedSet && !selectedSet.has(entry.name)) continue;
        const linkPath = path.join(skillsDir, entry.name);
        try {
          // 移除已有符号链接（高优先级覆盖低优先级）
          if (fs.existsSync(linkPath)) {
            fs.rmSync(linkPath, { recursive: true, force: true });
          }
          fs.symlinkSync(path.join(sourceDir, entry.name), linkPath);
        } catch {
          /* ignore */
        }
      }
    };

    // 项目级 skills
    const projectRoot = process.cwd();
    linkSkillEntries(path.join(projectRoot, 'container', 'skills'));
    // 用户级 skills（覆盖同名项目级）
    const ownerId = sessionOwnerKey;
    if (ownerId) {
      linkSkillEntries(path.join(DATA_DIR, 'skills', ownerId));
    }
  } catch (err) {
    logger.warn(
      { folder: group.folder, err },
      '本地 Runtime skills 符号链接失败',
    );
  }

  // 5. 构建环境变量
  const hostEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
  };
  const settings = getSystemSettings();

  const effectiveRunnerId = sessionRecord?.runner_id || getDefaultRunnerId();
  const effectiveModel = sessionRecord?.model ?? group.model;
  const effectiveThinkingEffort =
    sessionRecord?.thinking_effort ?? group.thinking_effort;
  const runnerProfile =
    sessionRecord?.runner_profile_id
      ? getRunnerProfile(sessionRecord.runner_profile_id)
      : undefined;
  const profileOverride =
    runnerProfile && runnerProfile.runner_id === effectiveRunnerId
      ? parseRunnerProfileRuntimeOverride(runnerProfile.runner_id, runnerProfile.config_json)
      : {};

  // 配置层环境变量
  const runtimeEnvConfig =
    sessionRecord?.kind === 'memory'
      ? getSessionRuntimeEnvConfig(stableSessionId)
      : getRuntimeEnvConfig(group.folder);
  const globalConfig = getClaudeProviderConfig();
  const containerOverride = mergeRuntimeEnvConfig(
    runtimeEnvConfig,
    profileOverride.claudeEnv || {},
  );
  const envLines = buildRuntimeEnvLines(globalConfig, containerOverride);
  for (const line of envLines) {
    const eqIdx = line.indexOf('=');
    if (eqIdx > 0) {
      hostEnv[line.slice(0, eqIdx)] = line.slice(eqIdx + 1);
    }
  }

  // Per-workspace model override takes priority over global and runtime-env config
  if (effectiveModel) {
    hostEnv['HAPPYCLAW_MODEL'] = effectiveModel;
  }

  // LLM provider selection for local runtime
  const hostLlmProvider = effectiveRunnerId;
  hostEnv['HAPPYCLAW_LLM_PROVIDER'] = hostLlmProvider;

  // Codex provider config for local runtime
  const hostCodexConfig = getCodexProviderConfig();
  const hostCodexProfile = hostCodexConfig.mode === 'api_key' ? hostCodexConfig.activeProfile : null;
  const workspaceRuntimeConfig = runtimeEnvConfig;
  const hostCodexBaseUrl =
    workspaceRuntimeConfig.codexBaseUrl ||
    profileOverride.codex?.baseUrl ||
    hostCodexProfile?.baseUrl ||
    '';
  const hostCodexDefaultModel =
    workspaceRuntimeConfig.codexDefaultModel ||
    profileOverride.codex?.defaultModel ||
    hostCodexProfile?.defaultModel ||
    '';
  const hostCodexCustomEnv = {
    ...(hostCodexProfile?.customEnv || {}),
    ...(profileOverride.codex?.customEnv || {}),
    ...(workspaceRuntimeConfig.codexCustomEnv || {}),
  };
  const hostOpenaiKey = hostCodexProfile?.openaiApiKey || process.env.OPENAI_API_KEY || '';
  if (hostOpenaiKey) hostEnv['OPENAI_API_KEY'] = hostOpenaiKey;
  if (hostCodexBaseUrl) hostEnv['OPENAI_BASE_URL'] = hostCodexBaseUrl;

  if (hostLlmProvider === 'codex') {
    // Pass workspace model as Codex model (separate from HAPPYCLAW_MODEL used by Claude)
    if (effectiveModel) {
      hostEnv['HAPPYCLAW_CODEX_MODEL'] = effectiveModel;
    } else if (hostCodexDefaultModel) {
      hostEnv['HAPPYCLAW_CODEX_MODEL'] = hostCodexDefaultModel;
    }
    // Local runtime: SDK reads ~/.codex/auth.json directly, no sync needed
  }

  // Inject Codex profile customEnv (already sanitized at save time)
  if (Object.keys(hostCodexCustomEnv).length > 0) {
    for (const [k, v] of Object.entries(hostCodexCustomEnv)) {
      hostEnv[k] = v;
    }
  }

  // Cross-provider invoke_agent: mark Claude as available so Codex can call it
  const hostClaudeConfig = getClaudeProviderConfig();
  const hostClaudeConfigured = !!(hostClaudeConfig.anthropicApiKey || hostClaudeConfig.claudeCodeOauthToken || hostClaudeConfig.claudeOAuthCredentials);
  if (hostClaudeConfigured) {
    hostEnv['HAPPYCLAW_CLAUDE_AVAILABLE'] = '1';
  }

  // Cross-provider invoke_agent: mark Codex as available so Claude can call it
  const hostCodexAvailable = !!(hostCodexConfig.hasCliAuth || hostCodexProfile?.openaiApiKey || process.env.OPENAI_API_KEY);
  if (hostCodexAvailable) {
    hostEnv['HAPPYCLAW_CODEX_AVAILABLE'] = '1';
  }

  // Thinking effort for local runtime
  if (effectiveThinkingEffort) {
    hostEnv['HAPPYCLAW_THINKING_EFFORT'] = effectiveThinkingEffort;
  }

  // Write .credentials.json for OAuth credentials
  const mergedConfig = mergeClaudeEnvConfig(globalConfig, containerOverride);
  if (mergedConfig.claudeOAuthCredentials) {
    try {
      writeCredentialsFile(groupSessionsDir, mergedConfig);
    } catch (err) {
      logger.warn(
        { folder: group.folder, err },
        'Failed to write .credentials.json for local runtime agent',
      );
    }
    // Also write to home session dir for cross-provider invoke_agent
    if (sharedPrimarySessionFolder !== group.folder) {
      const homeClaudeDir = path.join(
        DATA_DIR,
        'sessions',
        sharedPrimarySessionFolder,
        '.claude',
      );
      try {
        writeCredentialsFile(homeClaudeDir, mergedConfig);
      } catch { /* non-critical */ }
    }
  }

  // 路径映射
  hostEnv['HAPPYCLAW_WORKSPACE_GROUP'] = groupDir;
  // Per-user global memory
  const ownerId = sessionOwnerKey;
  const userGlobalDir = path.join(GROUPS_DIR, 'user-global', ownerId);
  fs.mkdirSync(userGlobalDir, { recursive: true });
  hostEnv['HAPPYCLAW_WORKSPACE_GLOBAL'] = userGlobalDir;
  hostEnv['HAPPYCLAW_WORKSPACE_MEMORY'] = runtimeMemoryDir;
  hostEnv['HAPPYCLAW_WORKSPACE_IPC'] = groupIpcDir;
  if (ownerId) {
    hostEnv['HAPPYCLAW_SKILLS_DIR'] = path.join(DATA_DIR, 'skills', ownerId);
  }
  if (launchProfile?.toolProfile) {
    hostEnv['HAPPYCLAW_TOOL_PROFILE'] = launchProfile.toolProfile;
  }
  if (
    launchProfile?.additionalDirectories &&
    launchProfile.additionalDirectories.length > 0
  ) {
    hostEnv['HAPPYCLAW_ADDITIONAL_DIRECTORIES'] = JSON.stringify(
      launchProfile.additionalDirectories,
    );
  }
  hostEnv['HAPPYCLAW_PROJECT_SKILLS_DIR'] = path.join(process.cwd(), 'container', 'skills');
  hostEnv['CLAUDE_CONFIG_DIR'] = groupSessionsDir;
  hostEnv['HAPPYCLAW_WORKSPACE_SESSION'] = path.dirname(groupSessionsDir);
  // Cross-provider invoke_agent: share home session dir for fresh OAuth tokens
  // (same pattern as memory-agent.ts — avoids stale refresh tokens)
  const homeClaudeDir = path.join(
    DATA_DIR,
    'sessions',
    sharedPrimarySessionFolder,
    '.claude',
  );
  hostEnv['HAPPYCLAW_CLAUDE_CREDENTIALS_DIR'] = homeClaudeDir;
  hostEnv['HAPPYCLAW_QUERY_ACTIVITY_TIMEOUT_MS'] = String(
    settings.queryActivityTimeoutMs,
  );
  hostEnv['HAPPYCLAW_TOOL_CALL_HARD_TIMEOUT_MS'] = String(
    settings.toolCallHardTimeoutMs,
  );
  hostEnv['HAPPYCLAW_CODEX_ARCHIVE_THRESHOLD'] = String(
    settings.codexArchiveThreshold,
  );
  hostEnv['HAPPYCLAW_MEMORY_SEND_TIMEOUT'] = String(
    settings.memorySendTimeout,
  );

  // Memory Agent env vars
  if (ownerId) {
    hostEnv['HAPPYCLAW_USER_ID'] = ownerId;
    const token = getInternalToken();
    if (token) hostEnv['HAPPYCLAW_INTERNAL_TOKEN'] = token;
    hostEnv['HAPPYCLAW_API_URL'] =
      `http://localhost:${process.env.WEB_PORT || '3000'}`;
    hostEnv['HAPPYCLAW_WORKSPACE_MEMORY_INDEX'] = path.join(
      DATA_DIR,
      'memory',
      ownerId,
    );
    hostEnv['HAPPYCLAW_MEMORY_QUERY_TIMEOUT'] = String(
      settings.memoryQueryTimeout,
    );
  }

  // Agent-browser isolation: each workspace gets its own browser session + profile
  hostEnv['AGENT_BROWSER_SESSION'] = group.folder;
  hostEnv['AGENT_BROWSER_PROFILE'] = path.join(groupDir, '.agent-browser-profile');

  // 让 SDK 捕获 CLI 的 stderr 输出，便于排查启动失败
  hostEnv['DEBUG_CLAUDE_AGENT_SDK'] = '1';
  // CLI 禁止 root 用户使用 --dangerously-skip-permissions，
  // 通过 IS_SANDBOX 标记告知 CLI 当前运行在受控环境中以绕过此限制
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    hostEnv['IS_SANDBOX'] = '1';
  }

  // 6. 编译检查
  const projectRoot = process.cwd();
  // runner_id='codex' uses the Codex provider path

  const runnerSubdir = 'agent-runner';
  const agentRunnerRoot = path.join(projectRoot, 'container', runnerSubdir);
  const agentRunnerNodeModules = path.join(agentRunnerRoot, 'node_modules');
  const agentRunnerDist = path.join(agentRunnerRoot, 'dist', 'index.js');

  const requiredDeps = ['@modelcontextprotocol/sdk', '@openai/codex-sdk'];
  const installHint = `npm --prefix container/${runnerSubdir} install`;
  const buildHint = `npm --prefix container/${runnerSubdir} run build`;

  const missingDeps = requiredDeps.filter((dep) => {
    const depJson = path.join(
      agentRunnerNodeModules,
      ...dep.split('/'),
      'package.json',
    );
    return !fs.existsSync(depJson);
  });
  if (missingDeps.length > 0) {
    const missing = missingDeps.join(', ');
      logger.error(
        { group: group.name, missingDeps },
        'Local runtime preflight failed: dependencies missing',
      );
    return localRuntimeSetupError(
      `缺少 ${runnerSubdir} 依赖（${missing}）。请先执行：${installHint}`,
    );
  }
  if (!fs.existsSync(agentRunnerDist)) {
    logger.error(
      { group: group.name, agentRunnerDist },
      'Local runtime preflight failed: dist not found',
    );
    return localRuntimeSetupError(
      `${runnerSubdir} 未编译。请先执行：${buildHint}`,
    );
  }

  // Warn if dist may be stale (src newer than dist)
  try {
    const distMtime = fs.statSync(agentRunnerDist).mtimeMs;
    const srcDir = path.join(agentRunnerRoot, 'src');
    const srcFiles = fs.readdirSync(srcDir);
    const newestSrc = Math.max(
      ...srcFiles.map((f) => fs.statSync(path.join(srcDir, f)).mtimeMs),
    );
    if (newestSrc > distMtime) {
      logger.warn(
        { group: group.name },
        `${runnerSubdir} dist 可能已过期（src 比 dist 新）。建议执行：${buildHint}`,
      );
    }
  } catch {
    // Best effort, don't block execution
  }

  logger.info(
    {
      group: group.name,
      workingDir: groupDir,
      isAdminHome: input.isAdminHome,
    },
    'Spawning local runtime agent',
  );

  const logsDir = path.join(groupDir, 'logs');

  return new Promise((resolve) => {
    let settled = false;
    const resolveOnce = (output: RuntimeOutput): void => {
      if (settled) return;
      settled = true;
      resolve(output);
    };

    // 7. 启动进程
    const proc = spawn('node', [agentRunnerDist], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: hostEnv,
      cwd: groupDir,
      detached: true,
    });

    const processId = `local-${group.folder}-${Date.now()}`;
    onProcess(proc, processId);

    const stdoutState = createStdoutParserState();
    const stderrState = createStderrState();

    // 8. stdin 输入
    proc.stdin.on('error', (err) => {
      logger.error({ group: group.name, err }, 'Local runtime stdin write failed');
      killProcessTree(proc);
    });
    proc.stdin.write(JSON.stringify(input));
    proc.stdin.end();

    // 9. 超时管理
    let timedOut = false;
    const timeoutMs =
      group.containerConfig?.timeout || getSystemSettings().runtimeTimeout;

    let killTimer: ReturnType<typeof setTimeout> | null = null;

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: group.name, processId },
        'Local runtime timeout, killing',
      );
      killProcessTree(proc, 'SIGTERM');
      killTimer = setTimeout(() => {
        if (proc.exitCode === null && proc.signalCode === null) {
          killProcessTree(proc, 'SIGKILL');
        }
      }, 5000);
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    // 10. stdout/stderr 解析
    attachStdoutHandler(proc.stdout, stdoutState, {
      groupName: group.name,
      label: 'Local runtime',
      onOutput,
      resetTimeout,
    });
    attachStderrHandler(proc.stderr, stderrState, group.name, {
      host: group.folder,
    });

    // 11. close 事件处理
    proc.on('close', (code, signal) => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      const duration = Date.now() - startTime;

      const closeCtx: CloseHandlerContext = {
        groupName: group.name,
        label: 'Local Runtime',
        filePrefix: 'local',
        identifier: processId,
        logsDir,
        input,
        stdoutState,
        stderrState,
        onOutput,
        resolvePromise: resolveOnce,
        startTime,
        timeoutMs,
        extraSummaryLines: [`Working Directory: ${groupDir}`],
        enrichError: (stderrContent, exitLabel) => {
          const missingPackageMatch = stderrContent.match(
            /Cannot find package '([^']+)' imported from/u,
          );
          const userFacingError = missingPackageMatch
            ? `本地 Runtime 启动失败：缺少依赖 ${missingPackageMatch[1]}。请先执行：${installHint}`
            : null;
          return {
            result: userFacingError,
            error: `Local runtime exited with ${exitLabel}: ${stderrContent.slice(-200)}`,
          };
        },
      };

      if (handleTimeoutClose(closeCtx, code, duration, timedOut)) return;
      const logFile = writeRunLog(closeCtx, code, duration);
      if (handleNonZeroExit(closeCtx, code, signal, duration, logFile)) return;
      handleSuccessClose(closeCtx, duration);
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      logger.error(
        { group: group.name, processId, error: err },
        'Local runtime spawn error',
      );
      resolveOnce({
        status: 'error',
        result: null,
        error: `Local runtime spawn error: ${err.message}`,
      });
    });
  });
}

export const runLocalAgent = runHostAgent;
