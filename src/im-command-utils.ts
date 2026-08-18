/**
 * Pure utility functions for IM slash commands.
 * Extracted from index.ts to enable unit testing without DB/state dependencies.
 */

// ─── Types ──────────────────────────────────────────────────────

export interface AgentInfo {
  id: string;
  name: string;
  status: string;
}

export interface WorkspaceInfo {
  folder: string;
  name: string;
  agents: AgentInfo[];
}

export interface MessageForContext {
  sender: string;
  sender_name: string;
  content: string;
  is_from_me: boolean;
}

// ─── Context Formatting ─────────────────────────────────────────

/**
 * Format recent messages into a compact context summary.
 * Messages should be in chronological order (oldest first).
 *
 * @param messages  Array of messages (oldest first)
 * @param maxLen    Per-message truncation length
 * @returns         Formatted text block, or empty string if no displayable messages
 */
export function formatContextMessages(
  messages: MessageForContext[],
  maxLen = 80,
): string {
  if (messages.length === 0) return '';

  const lines: string[] = [];
  for (const msg of messages) {
    if (msg.sender === '__system__') continue;

    const who = msg.is_from_me ? '🤖' : `👤${msg.sender_name || ''}`;
    let text = msg.content || '';
    if (text.length > maxLen) text = text.slice(0, maxLen) + '…';
    text = text.replace(/\n/g, ' ');
    lines.push(`  ${who}: ${text}`);
  }

  return lines.length > 0 ? '\n\n📋 最近消息:\n' + lines.join('\n') : '';
}

// ─── List Formatting ────────────────────────────────────────────

/**
 * Format workspace list with current-position markers.
 */
export function formatWorkspaceList(
  workspaces: WorkspaceInfo[],
  currentFolder: string,
  currentAgentId: string | null,
): string {
  if (workspaces.length === 0) return '没有可用的工作区';

  const lines: string[] = ['📂 工作区列表：'];

  for (const ws of workspaces) {
    const isCurrent = ws.folder === currentFolder;
    const marker = isCurrent ? ' ▶' : '';
    lines.push(`${marker} ${ws.name} (${ws.folder})`);

    const mainMarker = isCurrent && !currentAgentId ? ' ← 当前' : '';
    lines.push(`  · 主会话${mainMarker}`);

    for (const agent of ws.agents) {
      const agentMarker =
        isCurrent && currentAgentId === agent.id ? ' ← 当前' : '';
      const statusIcon = agent.status === 'running' ? '🔄' : '';
      const shortId = agent.id.slice(0, 4);
      lines.push(`  · ${agent.name} [${shortId}] ${statusIcon}${agentMarker}`);
    }
  }

  lines.push('');
  lines.push('💡 使用 /recall 总结最近对话记录，/clear 重置上下文');
  return lines.join('\n');
}

// ─── Location Info ────────────────────────────────────────────

export interface LocationInfo {
  locationLine: string;
  folder: string;
  replyPolicy: string | null;
}

// ─── System Status Formatting ─────────────────────────────────

export interface QueueStatusInfo {
  activeRuntimes: number;
  maxRuntimes: number;
  waitingCount: number;
  waitingGroupJids: string[];
}

/**
 * Format system status output for /status command.
 */
export function formatSystemStatus(
  location: LocationInfo,
  queueStatus: QueueStatusInfo,
  isActive: boolean,
  queuePosition: number | null,
): string {
  const statusText = isActive
    ? '运行中'
    : queuePosition !== null
      ? `排队中 (#${queuePosition})`
      : '空闲';

  const lines = [
    '📊 系统状态',
    '━━━━━━━━━━',
    `📍 位置: ${location.locationLine}`,
    `⚡ 状态: ${statusText}`,
    `📦 负载: ${queueStatus.activeRuntimes}/${queueStatus.maxRuntimes} 个 Runtime`,
    '',
    '💡 /where 查看绑定 · /list 查看全部',
  ];

  return lines.join('\n');
}

// ─── Slash command parsing ──────────────────────────────────────

/**
 * Routing context a channel hands to the command dispatcher.
 *
 * `targetJid` matters because the runtime queue is keyed by the *effective*
 * session JID (bound workspace / Feishu topic), not by the source chat JID.
 * Commands that touch a runtime must act on the routed JID or they silently
 * hit nothing.
 */
export interface ImCommandContext {
  targetJid?: string;
  threadId?: string;
  chatType?: 'p2p' | 'group';
}

export type ImCommandHandler = (
  chatJid: string,
  command: string,
  context?: ImCommandContext,
) => Promise<string | null>;

export interface ParsedSlashCommand {
  /** Bare command token, e.g. `stop`. */
  cmd: string;
  /** `cmd` plus its arguments — the form the dispatcher parses. */
  body: string;
}

/**
 * Parse a leading `/command` out of a message.
 *
 * Also tolerates Telegram's `/cmd@BotName` suffix. Returns null when the text
 * does not start with a slash token at all.
 */
export function parseSlashCommand(text: string): ParsedSlashCommand | null {
  const match = text.trim().match(/^\/([^\s@]+)(?:@\S+)?([\s\S]*)$/);
  if (!match) return null;
  const cmd = match[1];
  const rest = (match[2] ?? '').trim();
  return { cmd, body: rest ? `${cmd} ${rest}` : cmd };
}

/**
 * Strip leading @mentions so a command survives being addressed to the bot.
 *
 * Feishu rewrites mention keys into `@{displayName}` before we see the text,
 * and display names may contain spaces or be empty — a naive `^@\S+\s+` regex
 * loses the command in both cases. Matching the known mention names first, and
 * only then falling back to a generic strip, keeps `@Happy Claw /status`
 * working.
 */
export function stripLeadingMentions(
  text: string,
  mentionNames: string[] = [],
): string {
  let out = (text ?? '').trim();
  const tokens = mentionNames
    .map((name) => `@${(name ?? '').trim()}`)
    .filter((token) => token.length > 1)
    .sort((a, b) => b.length - a.length);

  for (let guard = 0; guard < 8; guard += 1) {
    const before = out;
    for (const token of tokens) {
      if (out.startsWith(token)) {
        out = out.slice(token.length).trimStart();
        break;
      }
    }
    if (out !== before) continue;
    // Mentions with an unknown/empty display name collapse to a bare "@"
    // prefix; strip generically so the command still resolves.
    const generic = out.match(/^@\S*\s+/);
    if (!generic) break;
    out = out.slice(generic[0].length).trimStart();
  }
  return out.trim();
}

/**
 * Whether an unrecognized slash token looks like a mistyped command rather
 * than ordinary text that happens to start with a slash (`/tmp/a.log ...`).
 */
export function isLikelyCommandToken(cmd: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_-]{0,19}$/.test(cmd);
}

export const IM_SLASH_COMMANDS: Array<{ usage: string; desc: string }> = [
  { usage: '/help', desc: '显示这份命令表' },
  { usage: '/stop', desc: '中断当前会话正在执行的任务' },
  { usage: '/status', desc: '查看当前工作区运行状态' },
  { usage: '/where', desc: '查看当前绑定位置与回复策略' },
  { usage: '/list', desc: '列出全部工作区与对话（别名 /ls）' },
  { usage: '/bind <目标>', desc: '绑定到工作区或 Agent，如 /bind myws/a3b' },
  { usage: '/unbind', desc: '解绑回默认工作区' },
  { usage: '/new <名称>', desc: '新建工作区并绑定当前聊天' },
  { usage: '/recall', desc: 'AI 总结最近对话（别名 /rc）' },
  { usage: '/require_mention true|false', desc: '群聊是否需要 @机器人' },
  { usage: '/clear', desc: '清除会话上下文（仅 Web 端）' },
];

export function formatCommandHelp(): string {
  const width = Math.max(
    ...IM_SLASH_COMMANDS.map((entry) => entry.usage.length),
  );
  return [
    '可用命令：',
    ...IM_SLASH_COMMANDS.map(
      (entry) => `  ${entry.usage.padEnd(width)}  ${entry.desc}`,
    ),
  ].join('\n');
}
