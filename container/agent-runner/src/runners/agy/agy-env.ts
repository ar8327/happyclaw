/**
 * Antigravity CLI (agy) 环境辅助。
 *
 * agy 没有 config-dir 环境变量，所有状态都挂在 $HOME 下：
 *   $HOME/.gemini/antigravity-cli/   CLI 状态（conversations、cache、log）
 *   $HOME/.gemini/config/mcp_config.json   全局 MCP 配置
 *   $HOME/.gemini/GEMINI.md          全局规则（print 模式每次运行重新读取）
 *
 * 会话隔离方案：每个会话一个独立 HOME 目录。macOS 上认证 token 存在
 * login keychain（service=gemini），而 keychain 路径也从 HOME 推导，
 * 因此需要把 Library/Keychains 软链回真实 HOME。
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

const AUTH_SEED_FILES = [
  'oauth_creds.json',
  'google_accounts.json',
  'installation_id',
];

/** 准备一个可用的会话级 agy HOME（幂等）。 */
export function prepareAgyHome(homeDir: string): void {
  fs.mkdirSync(homeDir, { recursive: true, mode: 0o700 });

  // macOS：keychain 目录按 $HOME 推导，软链回真实 keychain 才能完成静默认证
  if (process.platform === 'darwin') {
    const linkDir = path.join(homeDir, 'Library');
    const link = path.join(linkDir, 'Keychains');
    const target = path.join(os.homedir(), 'Library', 'Keychains');
    fs.mkdirSync(linkDir, { recursive: true });
    if (!fs.existsSync(link) && fs.existsSync(target)) {
      fs.symlinkSync(target, link);
    }
  }

  // best-effort 同步认证种子文件（Linux 无 keychain 时可能走文件后备）
  const geminiDir = path.join(homeDir, '.gemini');
  fs.mkdirSync(path.join(geminiDir, 'config'), {
    recursive: true,
    mode: 0o700,
  });
  const realGemini = path.join(os.homedir(), '.gemini');
  for (const file of AUTH_SEED_FILES) {
    const src = path.join(realGemini, file);
    const dst = path.join(geminiDir, file);
    try {
      if (fs.existsSync(src) && !fs.existsSync(dst)) {
        fs.copyFileSync(src, dst);
        fs.chmodSync(dst, 0o600);
      }
    } catch {
      /* non-critical */
    }
  }
}

/** 把通用 MCP server 配置映射为 agy mcp_config.json 支持的形态。 */
export function toAgyMcpServer(entry: unknown): Record<string, unknown> | null {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const value = entry as Record<string, unknown>;
  const serverUrl = value.serverUrl || value.url;
  if (typeof serverUrl === 'string' && serverUrl.length > 0) {
    return { serverUrl };
  }
  if (typeof value.command === 'string' && value.command.length > 0) {
    const server: Record<string, unknown> = { command: value.command };
    if (Array.isArray(value.args)) server.args = value.args;
    if (value.env && typeof value.env === 'object') server.env = value.env;
    return server;
  }
  return null;
}

/** 写入会话 HOME 的全局 MCP 配置。 */
export function writeAgyMcpConfig(
  homeDir: string,
  servers: Record<string, unknown>,
): string {
  const file = path.join(homeDir, '.gemini', 'config', 'mcp_config.json');
  fs.writeFileSync(file, JSON.stringify({ mcpServers: servers }, null, 2), {
    encoding: 'utf-8',
    mode: 0o600,
  });
  return file;
}

/** 写入会话 HOME 的全局规则（等价于每轮重建的系统提示词）。 */
export function writeAgyRules(homeDir: string, content: string): string {
  const file = path.join(homeDir, '.gemini', 'GEMINI.md');
  fs.writeFileSync(file, content, 'utf-8');
  return file;
}

const CONVERSATION_LOG_PATTERNS = [
  /Print mode: conversation=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/,
  /Created conversation ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/,
];

/**
 * 从本轮 --log-file 或 CLI cache 中提取会话 ID（resume 锚点）。
 * 日志缓冲可能在异常退出时丢失，因此保留 last_conversations.json 兜底。
 */
export function readAgyConversationId(
  logFile: string,
  homeDir: string,
  workspaceDir: string,
): string | null {
  try {
    const log = fs.readFileSync(logFile, 'utf-8');
    for (const pattern of CONVERSATION_LOG_PATTERNS) {
      const match = log.match(pattern);
      if (match) return match[1];
    }
  } catch {
    /* fall through */
  }
  try {
    const cacheFile = path.join(
      homeDir,
      '.gemini',
      'antigravity-cli',
      'cache',
      'last_conversations.json',
    );
    const parsed = JSON.parse(fs.readFileSync(cacheFile, 'utf-8')) as Record<
      string,
      unknown
    >;
    const keys = [workspaceDir];
    try {
      keys.push(fs.realpathSync(workspaceDir));
    } catch {
      /* ignore */
    }
    for (const key of keys) {
      const value = parsed[key];
      if (typeof value === 'string' && value.length > 0) return value;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** agy CLI 状态目录（用于活性探测）。 */
export function agyStateDir(homeDir: string): string {
  return path.join(homeDir, '.gemini', 'antigravity-cli');
}

/**
 * 活性信号：日志文件与 conversations 目录（SQLite WAL 随对话推进持续写入）
 * 的最近修改时间。用于识别 agy 偶发的启动期死挂。
 */
export function latestAgyActivityMs(
  logFile: string,
  homeDir: string,
): number {
  let latest = 0;
  const consider = (file: string) => {
    try {
      const stat = fs.statSync(file);
      if (stat.mtimeMs > latest) latest = stat.mtimeMs;
    } catch {
      /* ignore */
    }
  };
  consider(logFile);
  const conversationsDir = path.join(agyStateDir(homeDir), 'conversations');
  try {
    for (const entry of fs.readdirSync(conversationsDir)) {
      consider(path.join(conversationsDir, entry));
    }
  } catch {
    /* ignore */
  }
  return latest;
}
