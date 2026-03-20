/**
 * HappyClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF, like before)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per agent teams result).
 *   Final marker after loop ends signals completion.
 */

import fs from 'fs';
import path from 'path';
import { query, HookCallback, PreCompactHookInput, createSdkMcpServer, PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import { detectImageMimeTypeFromBase64Strict } from './image-detector.js';

import type {
  ContainerInput,
  ContainerOutput,
  SessionsIndex,
  SDKUserMessage,
  ParsedMessage,
} from './types.js';
export type { StreamEventType, StreamEvent } from './types.js';

import { sanitizeFilename, generateFallbackName } from './utils.js';
import { StreamEventProcessor } from './stream-processor.js';
import { PREDEFINED_AGENTS } from './agent-definitions.js';
import { createContextManager, coreToolsToSdkTools } from './mcp-adapter.js';
import { writeIpcFile } from 'happyclaw-agent-runner-core';

// 路径解析：优先读取环境变量，降级到容器内默认路径（保持向后兼容）
const WORKSPACE_GROUP = process.env.HAPPYCLAW_WORKSPACE_GROUP || '/workspace/group';
const WORKSPACE_GLOBAL = process.env.HAPPYCLAW_WORKSPACE_GLOBAL || '/workspace/global';
const WORKSPACE_MEMORY = process.env.HAPPYCLAW_WORKSPACE_MEMORY || '/workspace/memory';
const WORKSPACE_IPC = process.env.HAPPYCLAW_WORKSPACE_IPC || '/workspace/ipc';
const WORKSPACE_SKILLS = process.env.HAPPYCLAW_SKILLS_DIR || '/workspace/user-skills';

// 模型配置：支持别名（opus/sonnet/haiku）或完整模型 ID
// 别名自动解析为最新版本，如 opus → Opus 4.6
const CLAUDE_MODEL = process.env.HAPPYCLAW_MODEL || process.env.ANTHROPIC_MODEL || 'opus';

const IPC_INPUT_DIR = path.join(WORKSPACE_IPC, 'input');
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_INPUT_DRAIN_SENTINEL = path.join(IPC_INPUT_DIR, '_drain');
const IPC_POLL_MS = 500;

// Track recently seen IM channels from IPC messages (non-web sources)
// Used to inject a routing reminder after context compaction
const recentImChannels = new Set<string>();

function extractSourceChannels(text: string): void {
  const matches = text.matchAll(/source="([^"]+)"/g);
  for (const m of matches) {
    const source = m[1];
    if (!source.startsWith('web:')) {
      recentImChannels.add(source);
    }
  }
}

let currentPermissionMode: PermissionMode = 'bypassPermissions';

const DEFAULT_ALLOWED_TOOLS = [
  'Bash',
  'Read', 'Write', 'Edit', 'Glob', 'Grep',
  'WebSearch', 'WebFetch',
  'Task', 'TaskOutput', 'TaskStop',
  'TeamCreate', 'TeamDelete', 'SendMessage',
  'TodoWrite', 'ToolSearch', 'Skill',
  'NotebookEdit',
  'mcp__happyclaw__*'
];

const IMAGE_MAX_DIMENSION = 8000; // Anthropic API 限制

/**
 * 规范化图片 MIME：
 * - 优先使用声明值（若合法且与内容一致）
 * - 若声明缺失或与内容不一致，使用内容识别值
 * - 最后兜底 image/jpeg
 */
function resolveImageMimeType(img: { data: string; mimeType?: string }): string {
  const declared =
    typeof img.mimeType === 'string' && img.mimeType.startsWith('image/')
      ? img.mimeType.toLowerCase()
      : undefined;
  const detected = detectImageMimeTypeFromBase64Strict(img.data);

  if (declared && detected && declared !== detected) {
    log(`Image MIME mismatch: declared=${declared}, detected=${detected}, using detected`);
    return detected;
  }

  return declared || detected || 'image/jpeg';
}

/**
 * 从 base64 编码的图片数据中提取宽高（支持 PNG / JPEG / GIF / WebP / BMP）。
 * 仅解析头部字节，不需要完整解码图片。
 * 返回 null 表示无法识别格式。
 */
function getImageDimensions(base64Data: string): { width: number; height: number } | null {
  try {
    const headerB64 = base64Data.slice(0, 400);
    const buf = Buffer.from(headerB64, 'base64');

    // PNG: 固定位置 (bytes 16-23)
    if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }

    // JPEG: 扫描 SOF marker（SOF 可能在大 EXIF/ICC 之后，需要 ~30KB）
    if (buf.length >= 4 && buf[0] === 0xFF && buf[1] === 0xD8) {
      const JPEG_SCAN_B64_LEN = 40000; // ~30KB binary，覆盖大多数 EXIF/ICC 场景
      const fullHeader = Buffer.from(base64Data.slice(0, JPEG_SCAN_B64_LEN), 'base64');
      for (let i = 2; i < fullHeader.length - 9; i++) {
        if (fullHeader[i] !== 0xFF) continue;
        const marker = fullHeader[i + 1];
        if (marker >= 0xC0 && marker <= 0xC3) {
          return { width: fullHeader.readUInt16BE(i + 7), height: fullHeader.readUInt16BE(i + 5) };
        }
        if (marker !== 0xD8 && marker !== 0xD9 && marker !== 0x00) {
          i += 1 + fullHeader.readUInt16BE(i + 2);
        }
      }
    }

    // GIF: bytes 6-9 (little-endian)
    if (buf.length >= 10 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }

    // BMP: bytes 18-25
    if (buf.length >= 26 && buf[0] === 0x42 && buf[1] === 0x4D) {
      return { width: buf.readInt32LE(18), height: Math.abs(buf.readInt32LE(22)) };
    }

    // WebP
    if (buf.length >= 30 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) {
      const fourCC = buf.toString('ascii', 12, 16);
      if (fourCC === 'VP8 ' && buf.length >= 30) return { width: buf.readUInt16LE(26) & 0x3FFF, height: buf.readUInt16LE(28) & 0x3FFF };
      if (fourCC === 'VP8L' && buf.length >= 25) { const b = buf.readUInt32LE(21); return { width: (b & 0x3FFF) + 1, height: ((b >> 14) & 0x3FFF) + 1 }; }
      if (fourCC === 'VP8X' && buf.length >= 30) return { width: (buf[24] | (buf[25] << 8) | (buf[26] << 16)) + 1, height: (buf[27] | (buf[28] << 8) | (buf[29] << 16)) + 1 };
    }

    return null;
  } catch { return null; }
}

/**
 * 过滤超过 API 尺寸限制的图片。
 */
function filterOversizedImages(
  images: Array<{ data: string; mimeType?: string }>,
): { valid: Array<{ data: string; mimeType?: string }>; rejected: string[] } {
  const valid: Array<{ data: string; mimeType?: string }> = [];
  const rejected: string[] = [];
  for (const img of images) {
    const dims = getImageDimensions(img.data);
    if (dims && (dims.width > IMAGE_MAX_DIMENSION || dims.height > IMAGE_MAX_DIMENSION)) {
      const reason = `图片尺寸 ${dims.width}×${dims.height} 超过 API 限制（最大 ${IMAGE_MAX_DIMENSION}px），已跳过`;
      log(reason);
      rejected.push(reason);
    } else {
      valid.push(img);
    }
  }
  return { valid, rejected };
}

/**
 * Push-based async iterable for streaming user messages to the SDK.
 * Keeps the iterable alive until end() is called, preventing isSingleUserTurn.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string, images?: Array<{ data: string; mimeType?: string }>): string[] {
    const rejectedReasons: string[] = [];
    let filteredImages = images;

    // 过滤超限图片，在发送给 SDK 之前拦截
    if (filteredImages && filteredImages.length > 0) {
      const { valid, rejected } = filterOversizedImages(filteredImages);
      rejectedReasons.push(...rejected);
      filteredImages = valid.length > 0 ? valid : undefined;
    }

    let content:
      | string
      | Array<{ type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }>;

    if (filteredImages && filteredImages.length > 0) {
      // 多模态消息：text + images
      content = [
        { type: 'text', text },
        ...filteredImages.map((img) => ({
          type: 'image' as const,
          source: {
            type: 'base64' as const,
            media_type: resolveImageMimeType(img),
            data: img.data,
          },
        })),
      ];
    } else {
      // 纯文本消息
      content = text;
    }

    this.queue.push({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
    return rejectedReasons;
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>(r => { this.waiting = r; });
      this.waiting = null;
    }
  }
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const OUTPUT_START_MARKER = '---HAPPYCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---HAPPYCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

/**
 * Normalize isMain/isHome/isAdminHome flags for backward compatibility.
 * If the host sends the old `isMain` field, treat it as isHome=true + isAdminHome=true.
 */
function normalizeHomeFlags(input: ContainerInput): { isHome: boolean; isAdminHome: boolean } {
  if (input.isHome !== undefined) {
    return { isHome: !!input.isHome, isAdminHome: !!input.isAdminHome };
  }
  // Legacy: isMain was the only flag
  const legacy = !!input.isMain;
  return { isHome: legacy, isAdminHome: legacy };
}

/**
 * 检测是否为上下文溢出错误
 */
function isContextOverflowError(msg: string): boolean {
  const patterns: RegExp[] = [
    /prompt is too long/i,
    /maximum context length/i,
    /context.*too large/i,
    /exceeds.*token limit/i,
    /context window.*exceeded/i,
  ];
  return patterns.some(pattern => pattern.test(msg));
}

/**
 * 检测会话转录中不可恢复的请求错误（400 invalid_request_error）。
 * 这类错误被固化在会话历史中，每次 resume 都会重放导致永久失败。
 * 例如：图片尺寸超过 8000px 限制、图片 MIME 声明与真实内容不一致等。
 *
 * 判定条件：必须同时满足「图片特征」+「API 拒绝」，避免对通用 400 错误误判导致会话丢失。
 */
function isImageMimeMismatchError(msg: string): boolean {
  return (
    /image\s+was\s+specified\s+using\s+the\s+image\/[a-z0-9.+-]+\s+media\s+type,\s+but\s+the\s+image\s+appears\s+to\s+be\s+(?:an?\s+)?image\/[a-z0-9.+-]+\s+image/i.test(msg) ||
    /image\/[a-z0-9.+-]+\s+media\s+type.*appears\s+to\s+be.*image\/[a-z0-9.+-]+/i.test(msg)
  );
}

function isUnrecoverableTranscriptError(msg: string): boolean {
  const isImageSizeError =
    /image.*dimensions?\s+exceed/i.test(msg) ||
    /max\s+allowed\s+size.*pixels/i.test(msg);
  const isMimeMismatch = isImageMimeMismatchError(msg);
  const isApiReject = /invalid_request_error/i.test(msg);
  return isApiReject && (isImageSizeError || isMimeMismatch);
}

function getSessionSummary(sessionId: string, transcriptPath: string): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) {
    log(`Sessions index not found at ${indexPath}`);
    return null;
  }

  try {
    const index: SessionsIndex = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    const entry = index.entries.find(e => e.sessionId === sessionId);
    if (entry?.summary) {
      return entry.summary;
    }
  } catch (err) {
    log(`Failed to read sessions index: ${err instanceof Error ? err.message : String(err)}`);
  }

  return null;
}

/**
 * Archive the full transcript to conversations/ before compaction.
 */
function createPreCompactHook(
  isHome: boolean,
  _isAdminHome: boolean,
  groupFolder: string,
  userId?: string,
): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log('No transcript found for archiving');
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);

      if (messages.length === 0) {
        log('No messages to archive');
        return {};
      }

      const summary = getSessionSummary(sessionId, transcriptPath);
      const name = summary ? sanitizeFilename(summary) : generateFallbackName();

      const conversationsDir = path.join(WORKSPACE_GROUP, 'conversations');
      fs.mkdirSync(conversationsDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const filename = `${date}-${name}.md`;
      const filePath = path.join(conversationsDir, filename);

      const markdown = formatTranscriptMarkdown(messages, summary);
      fs.writeFileSync(filePath, markdown);

      log(`Archived conversation to ${filePath}`);

      // Signal main process to trigger session_wrapup for memory system
      if (isHome && userId) {
        const tasksDir = path.join(WORKSPACE_IPC, 'tasks');
        writeIpcFile(tasksDir, {
          type: 'session_wrapup',
          groupFolder,
          userId,
          timestamp: new Date().toISOString(),
        });
        log(`Sent session_wrapup IPC signal for ${groupFolder}`);
      }
    } catch (err) {
      log(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
    }

    return {};
  };
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text = typeof entry.message.content === 'string'
          ? entry.message.content
          : entry.message.content.map((c: { text?: string }) => c.text || '').join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
    }
  }

  return messages;
}

function formatTranscriptMarkdown(messages: ParsedMessage[], title?: string | null): string {
  const now = new Date();
  const formatDateTime = (d: Date) => d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : 'HappyClaw';
    const content = msg.content.length > 2000
      ? msg.content.slice(0, 2000) + '...'
      : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Check for _close sentinel.
 */
function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}

/**
 * Check for _drain sentinel.
 * Unlike _close (immediate exit), _drain means "finish current query then exit".
 */
function shouldDrain(): boolean {
  if (fs.existsSync(IPC_INPUT_DRAIN_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_DRAIN_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}

const IPC_INPUT_INTERRUPT_SENTINEL = path.join(IPC_INPUT_DIR, '_interrupt');
const INTERRUPT_GRACE_WINDOW_MS = 10_000;
let lastInterruptRequestedAt = 0;

function markInterruptRequested(): void {
  lastInterruptRequestedAt = Date.now();
}

function clearInterruptRequested(): void {
  lastInterruptRequestedAt = 0;
}

function isWithinInterruptGraceWindow(): boolean {
  return lastInterruptRequestedAt > 0 && Date.now() - lastInterruptRequestedAt <= INTERRUPT_GRACE_WINDOW_MS;
}

function isInterruptRelatedError(err: unknown): boolean {
  const errno = err as NodeJS.ErrnoException;
  const message = err instanceof Error ? err.message : String(err ?? '');
  return errno?.code === 'ABORT_ERR'
    || /abort|aborted|interrupt|interrupted|cancelled|canceled/i.test(message);
}

/**
 * Check for _interrupt sentinel (graceful query interruption).
 */
function shouldInterrupt(): boolean {
  if (fs.existsSync(IPC_INPUT_INTERRUPT_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_INTERRUPT_SENTINEL); } catch { /* ignore */ }
    markInterruptRequested();
    return true;
  }
  return false;
}

/**
 * Drain all pending IPC input messages.
 * Returns messages found (with optional images), or empty array.
 */
interface IpcDrainResult {
  messages: Array<{ text: string; images?: Array<{ data: string; mimeType?: string }> }>;
  modeChange?: string; // 'plan' | 'bypassPermissions'
}

function drainIpcInput(): IpcDrainResult {
  const result: IpcDrainResult = { messages: [] };
  try {
    const files = fs.readdirSync(IPC_INPUT_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();

    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          result.messages.push({
            text: data.text,
            images: data.images,
          });
        } else if (data.type === 'set_mode' && data.mode) {
          result.modeChange = data.mode;
        }
      } catch (err) {
        log(`Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`);
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
  }
  return result;
}

/**
 * Wait for a new IPC message or _close sentinel.
 * Returns the messages (with optional images), or null if _close.
 */
function waitForIpcMessage(): Promise<{ text: string; images?: Array<{ data: string; mimeType?: string }> } | null> {
  return new Promise((resolve) => {
    let pollCount = 0;
    const HEARTBEAT_INTERVAL = 120; // Log every ~60 seconds (120 polls * 500ms)
    const poll = () => {
      pollCount++;
      if (shouldClose()) {
        resolve(null);
        return;
      }
      if (shouldDrain()) {
        log('Drain sentinel received while idle, exiting for turn boundary');
        writeOutput({ status: 'drained', result: null });
        // Must self-exit: unlike _close (host sends SIGTERM), _drain expects
        // the process to terminate. SDK/MCP resources keep the event loop alive.
        process.exit(0);
      }
      if (shouldInterrupt()) {
        log('Interrupt sentinel received while idle, ignoring');
        clearInterruptRequested();
      }
      // Periodic heartbeat to detect stuck polling
      if (pollCount % HEARTBEAT_INTERVAL === 0) {
        try {
          const files = fs.readdirSync(IPC_INPUT_DIR);
          log(`Idle heartbeat: ${Math.round(pollCount * IPC_POLL_MS / 1000)}s waiting, IPC dir has ${files.length} files: [${files.join(', ')}]`);
        } catch {
          log(`Idle heartbeat: ${Math.round(pollCount * IPC_POLL_MS / 1000)}s waiting, IPC dir read failed`);
        }
      }
      const { messages, modeChange } = drainIpcInput();
      if (modeChange) {
        currentPermissionMode = modeChange as PermissionMode;
        log(`Mode change during idle: ${modeChange}`);
      }
      if (messages.length > 0) {
        // 合并多条消息的文本和图片
        const combinedText = messages.map((m) => m.text).join('\n');
        const allImages = messages.flatMap((m) => m.images || []);
        // Track IM channels for post-compaction routing reminder
        extractSourceChannels(combinedText);
        log(`Idle IPC pickup: ${messages.length} message(s), ${combinedText.length} chars`);
        // Emit acknowledgement so host can track IPC delivery (mirrors pollIpcDuringQuery)
        writeOutput({ status: 'stream', result: null, streamEvent: { eventType: 'status', statusText: 'ipc_message_received' } });
        resolve({ text: combinedText, images: allImages.length > 0 ? allImages : undefined });
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

// Memory Agent mode: read index.md from the memory-index mount
const WORKSPACE_MEMORY_INDEX = process.env.HAPPYCLAW_WORKSPACE_MEMORY_INDEX || '/workspace/memory-index';

function readMemoryIndex(): string {
  const indexPath = path.join(WORKSPACE_MEMORY_INDEX, 'index.md');
  try {
    if (fs.existsSync(indexPath)) {
      return fs.readFileSync(indexPath, 'utf-8');
    }
  } catch { /* ignore read errors */ }
  return '';
}

function readPersonality(): string {
  const personalityPath = path.join(WORKSPACE_MEMORY_INDEX, 'personality.md');
  try {
    if (fs.existsSync(personalityPath)) {
      return fs.readFileSync(personalityPath, 'utf-8');
    }
  } catch { /* ignore read errors */ }
  return '';
}

function buildMemoryRecallPrompt(isHome: boolean, _isAdminHome: boolean): string {
  if (isHome) {
    const indexContent = readMemoryIndex();
    const parts = [
      '',
      '## 记忆系统',
      '',
    ];

    if (indexContent) {
      parts.push(
        '你的随身索引已加载（这是经过压缩的快速参考，条目可能不完整。涉及具体事实时，建议通过 memory_query 确认）：',
        '',
        '<memory-index>',
        indexContent,
        '</memory-index>',
        '',
      );
    }

    const personalityContent = readPersonality();
    if (personalityContent) {
      parts.push(
        '你对这位用户交互风格的观察记录：',
        '',
        '<personality-notes>',
        personalityContent,
        '</personality-notes>',
        '',
      );
    }

    parts.push(
      '### memory_query 和 memory_remember',
      '',
      '这两个 MCP 工具的底层是一个独立的记忆 Agent，它可以搜索、整理和存储你的长期记忆。',
      '',
      '**memory_query — 深度回忆**',
      '',
      '你可以像问一个知道一切过往的助手那样，直接问它问题。不需要把问题过度拆解，但要给足背景。例如：',
      '- 「今天是 2026-03-16 周一，根据记忆用户今天可能有什么安排？」',
      '- 「用户提到过一个关于 XXX 的项目，具体细节是什么？」',
      '- 「上周用户和我聊过一个技术方案，涉及向量数据库，帮我回忆一下。」',
      '',
      '**什么时候应该使用 memory_query：**',
      '- 当你不确定自己知不知道某件事时——先查再答，不要猜',
      '- 用户问起过去的事（"之前聊的"、"上次说的"、"还记得吗"）',
      '- 涉及用户个人信息、日程、偏好等需要确认准确性的问题',
      '- 用户在考你/测试你的记忆时',
      '- compact summary 或随身索引中的信息不够详细，需要深入了解时',
      '',
      '随身索引是快速参考，但**不是权威事实来源**。索引条目经过压缩，可能丢失限定条件或上下文。',
      '如果索引中已有一些信息，你可以先给出快速印象，',
      '然后询问用户要不要让你深入想想（调用 memory_query 获取完整细节）。',
      '涉及具体事实（日期、数字、决策结论）时，优先通过 memory_query 确认后再回答。',
      '',
      '**重要：查询通常需要 1-2 分钟。** 发起查询前，先给用户发一条消息（如「让我好好想想……」「我去翻翻记忆～」），',
      '避免用户以为你卡死了。如果是 IM 渠道，用 send_message 发送提示后再调用 memory_query。',
      '',
      '**memory_remember — 主动记忆**',
      '',
      '每次对话结束后，系统会自动整理对话内容存入记忆，所以不需要频繁手动记录。',
      '只在以下情况使用：',
      '- 用户明确说「记住」「别忘了」',
      '- 特别重要、怕被自动整理遗漏的信息（如用户纠正了个人信息、重要决策）',
      '',
      '不要在 CLAUDE.md 里手动维护用户信息——用户身份、偏好、知识由记忆系统统一管理，已通过上方随身索引加载。',
    );
    return parts.join('\n');
  }

  // Non-home group container: read-only query via memory_query
  return [
    '',
    '## 记忆',
    '',
    '### 查询记忆',
    '可使用 `memory_query` 工具查询用户的记忆（过去的对话、偏好、项目知识等）。',
    '查询可能需要几秒钟。',
    '',
    '### 本地记忆',
    '重要信息直接记录在当前工作区的 CLAUDE.md 或其他文件中。',
    'Claude 会自动维护你的会话记忆，无需额外操作。',
  ].join('\n');
}

/** 从 settings.json 读取用户配置的 MCP servers（stdio/http/sse 类型） */
function loadUserMcpServers(): Record<string, unknown> {
  const configDir = process.env.CLAUDE_CONFIG_DIR
    || path.join(process.env.HOME || '/home/node', '.claude');
  const settingsFile = path.join(configDir, 'settings.json');
  try {
    if (fs.existsSync(settingsFile)) {
      const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
      if (settings.mcpServers && typeof settings.mcpServers === 'object') {
        return settings.mcpServers;
      }
    }
  } catch { /* ignore parse errors */ }
  return {};
}

/**
 * Run a single query and stream results via writeOutput.
 * Uses MessageStream (AsyncIterable) to keep isSingleUserTurn=false,
 * allowing agent teams subagents to run to completion.
 * Also pipes IPC messages into the stream during the query.
 */
async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerConfig: ReturnType<typeof createSdkMcpServer>,
  containerInput: ContainerInput,
  memoryRecall: string,
  resumeAt?: string,
  emitOutput = true,
  allowedTools: string[] = DEFAULT_ALLOWED_TOOLS,
  disallowedTools?: string[],
  images?: Array<{ data: string; mimeType?: string }>,
): Promise<{ newSessionId?: string; lastAssistantUuid?: string; lastResumeUuid?: string; closedDuringQuery: boolean; contextOverflow?: boolean; unrecoverableTranscriptError?: boolean; interruptedDuringQuery: boolean; sessionResumeFailed?: boolean; drainDetectedDuringQuery?: boolean }> {
  const stream = new MessageStream();
  // Track IM channels from initial prompt
  extractSourceChannels(prompt);
  const initialRejected = stream.push(prompt, images);
  const emit = (output: ContainerOutput): void => {
    if (emitOutput) writeOutput(output);
  };

  // 如果有图片被拒绝，立即通知用户
  for (const reason of initialRejected) {
    emit({ status: 'success', result: `\u26a0\ufe0f ${reason}`, newSessionId: undefined });
  }

  // Poll IPC for follow-up messages and _close/_interrupt sentinel during the query
  let ipcPolling = true;
  let closedDuringQuery = false;
  let interruptedDuringQuery = false;
  // When true, the main result has been emitted but we're waiting for background
  // tasks to finish.  IPC polling is stopped (to avoid push-after-close crashes)
  // but the for-await loop stays alive to receive task_notifications.
  let waitingForBackgroundTasks = false;

  // Query activity watchdog: if the SDK for-await loop yields no events for
  // QUERY_ACTIVITY_TIMEOUT_MS, the API call is likely hung.  Force an interrupt
  // so the session loop can retry with the same prompt.
  const QUERY_ACTIVITY_TIMEOUT_MS = 300_000;
  let lastEventAt = Date.now();
  let queryActivityTimer: ReturnType<typeof setTimeout> | null = null;
  const resetQueryActivityTimer = () => {
    lastEventAt = Date.now();
    if (queryActivityTimer) clearTimeout(queryActivityTimer);
    queryActivityTimer = setTimeout(() => {
      if (!ipcPolling && !waitingForBackgroundTasks) return; // query already ended
      // Don't interrupt while background sub-agents are still running —
      // they won't produce events on the main iterator but are doing real work.
      if (processor.pendingBackgroundTaskCount > 0) {
        log(`Activity timeout skipped: ${processor.pendingBackgroundTaskCount} background task(s) still running, extending timer`);
        resetQueryActivityTimer();
        return;
      }
      // Don't interrupt while a tool call (e.g. MCP memory_query) is executing —
      // it blocks the SDK iterator but is doing real work.
      if (processor.hasActiveToolCall) {
        log(`Activity timeout skipped: tool call in progress, extending timer`);
        resetQueryActivityTimer();
        return;
      }
      log(`Query activity timeout: no SDK events for ${QUERY_ACTIVITY_TIMEOUT_MS}ms, forcing interrupt`);
      interruptedDuringQuery = true;
      waitingForBackgroundTasks = false;
      queryRef?.interrupt().catch((err: unknown) => log(`Activity timeout interrupt failed: ${err}`));
      stream.end();
      ipcPolling = false;
    }, QUERY_ACTIVITY_TIMEOUT_MS);
  };
  resetQueryActivityTimer();
  // queryRef is set just before the for-await loop so pollIpcDuringQuery can call interrupt()
  let queryRef: { interrupt(): Promise<void>; setPermissionMode(mode: PermissionMode): Promise<void> } | null = null;
  // Track drain detection during query: if _drain appears while the SDK query
  // is still running, we set this flag and let the query finish naturally.
  // The main loop will check this flag after the for-await loop exits.
  let drainDetectedDuringQuery = false;

  const pollIpcDuringQuery = () => {
    if (!ipcPolling) return;
    if (shouldClose()) {
      log('Close sentinel detected during query, ending stream');
      closedDuringQuery = true;
      stream.end();
      ipcPolling = false;
      return;
    }
    // Check for _drain during query: consume the sentinel immediately so it
    // isn't lost to a filesystem race, but let the current query finish.
    if (!drainDetectedDuringQuery && shouldDrain()) {
      log('Drain sentinel detected during query, will exit after query completes');
      drainDetectedDuringQuery = true;
      // Don't end the stream or stop polling — let the query finish naturally.
      // The flag is checked in the main loop after the for-await exits.
    }
    if (shouldInterrupt()) {
      log('Interrupt sentinel detected, interrupting current query');
      interruptedDuringQuery = true;
      lastInterruptRequestedAt = Date.now();
      queryRef?.interrupt().catch((err: unknown) => log(`Interrupt call failed: ${err}`));
      stream.end();
      ipcPolling = false;
      return;
    }
    const { messages, modeChange } = drainIpcInput();
    if (modeChange) {
      currentPermissionMode = modeChange as PermissionMode;
      log(`Mode change via IPC: ${modeChange}`);
      queryRef?.setPermissionMode(modeChange as PermissionMode).catch((err: unknown) =>
        log(`setPermissionMode failed: ${err}`),
      );
    }
    for (const msg of messages) {
      log(`Piping IPC message into active query (${msg.text.length} chars, ${msg.images?.length || 0} images)`);
      // Track IM channels for post-compaction routing reminder
      extractSourceChannels(msg.text);
      // Emit acknowledgement so host can track IPC delivery
      emit({ status: 'stream', result: null, streamEvent: { eventType: 'status', statusText: 'ipc_message_received' } });
      const rejected = stream.push(msg.text, msg.images);
      for (const reason of rejected) {
        emit({ status: 'success', result: `\u26a0\ufe0f ${reason}`, newSessionId: undefined });
      }
    }
    setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
  };
  setTimeout(pollIpcDuringQuery, IPC_POLL_MS);

  // Create the StreamEventProcessor with mode change callback
  const processor = new StreamEventProcessor(emit, log, (newMode) => {
    currentPermissionMode = newMode as PermissionMode;
    log(`Auto mode switch on ${newMode === 'plan' ? 'EnterPlanMode' : 'ExitPlanMode'} detection`);
    queryRef?.setPermissionMode(newMode as PermissionMode).catch((err: unknown) =>
      log(`setPermissionMode failed: ${err}`),
    );
  });

  let newSessionId: string | undefined;
  let lastAssistantUuid: string | undefined;
  // Track the latest safe resume point across ALL message types (assistant/text
  // and user/tool_result). This prevents the fan-out branch problem: when the
  // agent's final response in a query is tool_use-only (no text output),
  // lastAssistantUuid stays stuck at an earlier text message. Without advancing,
  // all subsequent queries branch from the same node and lose visibility of each
  // other's turns — causing repeated/lost context (e.g. resending reports).
  // By tracking the last tool_result UUID, we ensure the session advances
  // linearly, preserving the full tool_use→tool_result pair in the next resume.
  let lastResumeUuid: string | undefined;
  let messageCount = 0;
  let resultCount = 0;

  // Build system prompt: memory recall guidance + global CLAUDE.md (for non-admin-home)
  const { isHome, isAdminHome } = normalizeHomeFlags(containerInput);
  const globalClaudeMdPath = path.join(WORKSPACE_GLOBAL, 'CLAUDE.md');

  // Home containers: inject full global CLAUDE.md for immediate context.
  // Non-home containers: global CLAUDE.md is accessible via filesystem (mounted readonly)
  // but NOT injected into system prompt to avoid context pollution that causes
  // the agent to "continue" unrelated previous work.
  let globalClaudeMd = '';
  if (isHome && fs.existsSync(globalClaudeMdPath)) {
    globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
  }
  const outputGuidelines = [
    '',
    '## 输出格式',
    '',
    '### 图片引用',
    '当你生成了图片文件并需要在回复中展示时，使用 Markdown 图片语法引用**相对路径**（相对于当前工作目录）：',
    '`![描述](filename.png)`',
    '',
    '**禁止使用绝对路径**（如 `/workspace/group/filename.png`）。Web 界面会自动将相对路径解析为正确的文件下载地址。',
    '',
    '### 技术图表',
    '需要输出技术图表（流程图、时序图、架构图、ER 图、类图、状态图、甘特图等）时，**使用 Mermaid 语法**，用 ```mermaid 代码块包裹。',
    'Web 界面会自动将 Mermaid 代码渲染为可视化图表。',
  ].join('\n');

  const webFetchGuidelines = [
    '',
    '## 网页访问策略',
    '',
    '访问外部网页时优先使用 WebFetch（速度快）。',
    '如果 WebFetch 失败（403、被拦截、内容为空或需要 JavaScript 渲染），',
    '且 agent-browser 可用，立即改用 agent-browser 通过真实浏览器访问。不要反复重试 WebFetch。',
  ].join('\n');

  // HEARTBEAT.md injection disabled — replaced by Memory Agent's index.md
  const heartbeatContent = '';

  const backgroundTaskGuidelines = [
    '',
    '## 后台任务',
    '',
    '当用户要求执行耗时较长的批量任务（如批量文件处理、大规模数据操作等），',
    '你应该使用 Task 工具并设置 `run_in_background: true`，让任务在后台运行。',
    '这样用户无需等待，可以继续与你交流其他事项。',
    '任务结束时你会自动收到通知，届时使用 send_message 向用户汇报即可。',
    '告知用户：「已为您在后台启动该任务，完成后我会第一时间反馈。现在有其他问题也可以随时问我。」',
    '',
    '**重要**：启动后台任务后，不要使用 TaskOutput 去阻塞等待结果——系统会自动通知你。',
    '你可以继续回答用户的其他问题，当后台任务完成时，你会收到通知并可以立即汇报结果。',
  ].join('\n');

  // Interaction guidelines to prevent the agent from confusing MCP tool
  // descriptions with user input, or proactively describing available tools.
  const interactionGuidelines = [
    '',
    '## 交互原则',
    '',
    '**始终专注于用户当前的实际消息。**',
    '',
    '- 你可能拥有多种 MCP 工具（如外卖点餐、优惠券查询等），这些是你的辅助能力，**不是用户发送的内容**。',
    '- **不要主动介绍、列举或描述你的可用工具**，除非用户明确询问「你能做什么」或「你有什么功能」。',
    '- 当用户需要某个功能时，直接使用对应工具完成任务即可，无需事先解释工具的存在。',
    '- 如果用户的消息很简短（如打招呼），简洁回应即可，不要用工具列表填充回复。',
  ].join('\n');

  const channelRoutingGuidelines = [
    '',
    '## 消息渠道',
    '',
    '用户的消息可能来自不同渠道（Web、飞书、Telegram、QQ）。每条消息的 `source` 属性标识了来源渠道。',
    '',
    '- **你的文字输出（stdout）仅显示在 Web 界面**，不会自动发送到任何 IM 渠道。',
    '- 要向 IM 渠道发送消息，**必须**使用 `send_message` 工具并指定 `channel` 参数（值取自消息的 `source` 属性）。',
    '- 发送图片/文件到 IM 时，`send_image` / `send_file` 的 `channel` 参数为必填。',
    '- 如果所有消息都来自 Web（没有 source 属性），正常回复即可，无需调用 send_message。',
    '- 同一批消息可能来自不同渠道，根据需要分别回复。',
    '- **上下文压缩后**：之前的渠道上下文可能丢失，但 `source` 属性仍然存在于每条消息中。压缩后请务必检查最新消息的 `source` 属性，确保通过 `send_message` 回复 IM 用户。',
  ].join('\n');

  const systemPromptAppend = [
    globalClaudeMd,
    heartbeatContent,
    interactionGuidelines,
    channelRoutingGuidelines,
    memoryRecall,
    outputGuidelines,
    webFetchGuidelines,
    backgroundTaskGuidelines,
  ].filter(Boolean).join('\n');

  // All containers can access global and memory directories via additionalDirectories.
  // Home containers additionally inject global CLAUDE.md into systemPrompt for immediate context.
  // Non-home containers discover it via filesystem (readonly mount) without systemPrompt injection.
  const extraDirs = [WORKSPACE_GLOBAL, WORKSPACE_MEMORY];

  try {
    const q = query({
    prompt: stream,
    options: {
      model: CLAUDE_MODEL,
      cwd: WORKSPACE_GROUP,
      additionalDirectories: extraDirs,
      resume: sessionId,
      resumeSessionAt: resumeAt,
      systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const, append: systemPromptAppend },
      allowedTools,
      ...(disallowedTools && { disallowedTools }),
      maxThinkingTokens: 16384,
      permissionMode: currentPermissionMode,
      allowDangerouslySkipPermissions: true,
      settingSources: ['project', 'user'],
      includePartialMessages: true,
      mcpServers: {
        ...loadUserMcpServers(),     // 用户配置的 MCP（stdio/http/sse），SDK 原生支持
        happyclaw: mcpServerConfig,  // 内置 SDK MCP 放最后，确保不被同名覆盖
      },
      hooks: {
        PreCompact: [{ hooks: [createPreCompactHook(isHome, isAdminHome, containerInput.groupFolder, containerInput.userId)] }]
      },
      agents: PREDEFINED_AGENTS,
    }
  });
    queryRef = q;
    for await (const message of q) {
    // Reset activity watchdog on every SDK event
    resetQueryActivityTimer();
    // 流式事件处理
    if (message.type === 'stream_event') {
      processor.processStreamEvent(message as any);
      continue;
    }

    if (message.type === 'tool_progress') {
      processor.processToolProgress(message as any);
      continue;
    }

    if (message.type === 'tool_use_summary') {
      processor.processToolUseSummary(message as any);
      continue;
    }

    // Hook 事件
    if (message.type === 'system') {
      const sys = message as any;
      if (processor.processSystemMessage(sys)) {
        continue;
      }
    }

    messageCount++;
    const msgType = message.type === 'system' ? `system/${(message as { subtype?: string }).subtype}` : message.type;
    const msgParentToolUseId = (message as any).parent_tool_use_id ?? null;
    // 诊断：对所有 assistant/user 消息打印 parent_tool_use_id 和内容块类型
    if (message.type === 'assistant' || message.type === 'user') {
      const rawParent = (message as any).parent_tool_use_id;
      const contentTypes = (Array.isArray((message as any).message?.content)
        ? ((message as any).message.content as Array<{ type: string }>).map(b => b.type).join(',')
        : typeof (message as any).message?.content === 'string' ? 'string' : 'none');
      log(`[msg #${messageCount}] type=${msgType} parent_tool_use_id=${rawParent === undefined ? 'UNDEFINED' : rawParent === null ? 'NULL' : rawParent} content_types=[${contentTypes}] keys=[${Object.keys(message).join(',')}]`);
    } else {
      log(`[msg #${messageCount}] type=${msgType}${msgParentToolUseId ? ` parent=${msgParentToolUseId.slice(0, 12)}` : ''}`);
    }

    // ── Extract SDK task_id from background Task tool_results ──
    // The SDK assigns its own short-hash task_id (e.g. "a68ac00") to background tasks,
    // which differs from the tool_use block's id. We parse the tool_result to build
    // a mapping so processTaskNotification can resolve IDs correctly.
    if (message.type === 'user' && !msgParentToolUseId) {
      const userContent = (message as any).message?.content;
      if (Array.isArray(userContent)) {
        for (const block of userContent) {
          if (block.type === 'tool_result' && block.tool_use_id && Array.isArray(block.content)) {
            const text = block.content.map((b: { text?: string }) => b.text || '').join('');
            const agentIdMatch = text.match(/agentId:\s*([a-f0-9]+)/);
            if (agentIdMatch && processor.isBackgroundTask(block.tool_use_id)) {
              processor.registerSdkTaskId(agentIdMatch[1], block.tool_use_id);
            }
          }
        }
      }
    }

    // ── 子 Agent 消息转 StreamEvent ──
    processor.processSubAgentMessage(message as any);

    if (message.type === 'assistant' && 'uuid' in message) {
      // Only update lastAssistantUuid for assistant messages that contain text
      // (not tool_use-only messages). Resuming at a tool_use assistant node
      // causes the subsequent user(tool_result) to be missing, triggering
      // ensureToolResultPairing repairs and potential session instability.
      const assistantContent = (message as any).message?.content;
      const hasTextContent = Array.isArray(assistantContent)
        ? assistantContent.some((b: { type: string }) => b.type === 'text')
        : typeof assistantContent === 'string';
      if (hasTextContent) {
        lastAssistantUuid = (message as { uuid: string }).uuid;
        lastResumeUuid = lastAssistantUuid;
      }
      processor.processAssistantMessage(message as any);
    }

    // Track user(tool_result) UUIDs as resume points.
    // When the agent ends a turn with only tool_use (e.g. send_message with no
    // stdout text), lastAssistantUuid stays stuck at the earlier text message.
    // Using the tool_result UUID preserves the full tool_use→tool_result pair
    // in the resumed session, preventing the fan-out branch problem.
    if (message.type === 'user' && 'uuid' in message) {
      const userContent = (message as any).message?.content;
      const hasToolResult = Array.isArray(userContent)
        && userContent.some((b: { type: string }) => b.type === 'tool_result');
      if (hasToolResult) {
        lastResumeUuid = (message as { uuid: string }).uuid;
      }
    }

    if (message.type === 'system' && message.subtype === 'init') {
      newSessionId = message.session_id;
      log(`Session initialized: ${newSessionId}`);
    }

    // After context compaction, inject a routing reminder so the agent
    // doesn't forget to use send_message for IM channels.
    // The reminder arrives as a user message in the NEXT turn.
    if (message.type === 'system' && (message as { subtype?: string }).subtype === 'compact_boundary') {
      const channels = [...recentImChannels];
      if (channels.length > 0) {
        log(`Context compacted, injecting routing reminder for channels: ${channels.join(', ')}`);
        stream.push(
          `[系统提示] 上下文已压缩。重要提醒：你的文字输出（stdout）仅在 Web 界面可见。` +
          `你近期与以下 IM 渠道有活跃对话：${channels.join('、')}。` +
          `回复这些渠道的用户时，必须使用 send_message(channel="渠道值") 工具，否则他们收不到你的消息。` +
          `请检查消息的 source 属性确定 channel 值。`,
        );
      } else {
        log('Context compacted, no IM channels tracked');
      }
    }

    if (message.type === 'system' && (message as { subtype?: string }).subtype === 'task_notification') {
      const tn = message as unknown as { task_id: string; tool_use_id?: string; status: string; summary: string };
      processor.processTaskNotification(tn);
    }

    if (message.type === 'result') {
      resultCount++;
      const textResult = 'result' in message ? (message as { result?: string }).result : null;
      const resultSubtype = message.subtype;
      log(`Result #${resultCount}: subtype=${resultSubtype}${textResult ? ` text=${textResult.slice(0, 200)}` : ''}`);

      // ── Error results: always end the stream immediately ──
      // These paths return/throw, so stream must be closed before exiting.

      // SDK 在某些失败场景会返回 error_* subtype 且不抛异常。
      // 匹配策略：显式枚举已知的 error subtype，并用 startsWith('error') 兜底。
      if (typeof resultSubtype === 'string' && (resultSubtype === 'error_during_execution' || resultSubtype.startsWith('error'))) {
        if (queryActivityTimer) clearTimeout(queryActivityTimer);
        waitingForBackgroundTasks = false;
        ipcPolling = false;
        stream.end();
        if (!newSessionId) {
          log(`Session resume failed (no init): ${resultSubtype}`);
          return { newSessionId, lastAssistantUuid, closedDuringQuery, interruptedDuringQuery, sessionResumeFailed: true };
        }
        const detail = textResult?.trim()
          ? textResult.trim()
          : `Claude Code execution failed (${resultSubtype})`;
        throw new Error(detail);
      }

      // SDK 将某些 API 错误包装为 subtype=success 的 result（不抛异常）
      if (textResult && isContextOverflowError(textResult)) {
        if (queryActivityTimer) clearTimeout(queryActivityTimer);
        waitingForBackgroundTasks = false;
        ipcPolling = false;
        stream.end();
        log(`Context overflow detected in result: ${textResult.slice(0, 100)}`);
        processor.resetFullTextAccumulator();
        return { newSessionId, lastAssistantUuid, closedDuringQuery, contextOverflow: true, interruptedDuringQuery };
      }
      if (textResult && isUnrecoverableTranscriptError(textResult)) {
        if (queryActivityTimer) clearTimeout(queryActivityTimer);
        waitingForBackgroundTasks = false;
        ipcPolling = false;
        stream.end();
        log(`Unrecoverable transcript error in result: ${textResult.slice(0, 200)}`);
        processor.resetFullTextAccumulator();
        return { newSessionId, lastAssistantUuid, closedDuringQuery, unrecoverableTranscriptError: true, interruptedDuringQuery };
      }

      // ── Successful result: check for pending background tasks ──

      if (processor.pendingBackgroundTaskCount > 0) {
        // Background tasks still running — keep the for-await loop alive so we
        // receive task_notification messages.  The SDK will re-invoke the model
        // when a background task completes, producing another result.
        // IPC polling stays active so new user messages and _close sentinels
        // can still be received while waiting for background tasks.
        log(`Result received but ${processor.pendingBackgroundTaskCount} background task(s) pending, keeping query alive`);
        waitingForBackgroundTasks = true;
        resetQueryActivityTimer();
      } else {
        // No background tasks — safe to end the stream and stop IPC polling.
        // IPC polling must stop before stream.end() to avoid push-after-close
        // crashes on ProcessTransport (see commit c6b5086).
        if (queryActivityTimer) clearTimeout(queryActivityTimer);
        waitingForBackgroundTasks = false;
        ipcPolling = false;
        stream.end();
      }

      const { effectiveResult } = processor.processResult(textResult);
      if (!effectiveResult && resultCount > 0) {
        log(`Warning: query produced empty result (no text, no tool output). Result #${resultCount}, messages: ${messageCount}`);
      }
      emit({
        status: 'success',
        result: effectiveResult,
        newSessionId
      });

      // Emit usage stream event with token counts and cost
      const resultMsg = message as Record<string, unknown>;
      const sdkUsage = resultMsg.usage as Record<string, number> | undefined;
      const sdkModelUsage = resultMsg.modelUsage as Record<string, Record<string, number>> | undefined;
      if (sdkUsage) {
        const modelUsageSummary: Record<string, { inputTokens: number; outputTokens: number; costUSD: number }> = {};
        if (sdkModelUsage && Object.keys(sdkModelUsage).length > 0) {
          for (const [model, mu] of Object.entries(sdkModelUsage)) {
            modelUsageSummary[model] = {
              inputTokens: mu.inputTokens || 0,
              outputTokens: mu.outputTokens || 0,
              costUSD: mu.costUSD || 0,
            };
          }
        } else {
          // Fallback: use session-level model name when SDK doesn't provide per-model breakdown
          modelUsageSummary[CLAUDE_MODEL] = {
            inputTokens: sdkUsage.input_tokens || 0,
            outputTokens: sdkUsage.output_tokens || 0,
            costUSD: (resultMsg.total_cost_usd as number) || 0,
          };
        }
        emit({
          status: 'stream',
          result: null,
          streamEvent: {
            eventType: 'usage',
            usage: {
              inputTokens: sdkUsage.input_tokens || 0,
              outputTokens: sdkUsage.output_tokens || 0,
              cacheReadInputTokens: sdkUsage.cache_read_input_tokens || 0,
              cacheCreationInputTokens: sdkUsage.cache_creation_input_tokens || 0,
              costUSD: (resultMsg.total_cost_usd as number) || 0,
              durationMs: (resultMsg.duration_ms as number) || 0,
              numTurns: (resultMsg.num_turns as number) || 0,
              modelUsage: Object.keys(modelUsageSummary).length > 0 ? modelUsageSummary : undefined,
            },
          },
        });
        log(`Usage: input=${sdkUsage.input_tokens} output=${sdkUsage.output_tokens} cost=$${resultMsg.total_cost_usd} turns=${resultMsg.num_turns}`);
      }
    }
  }

  // Cleanup residual state
  processor.cleanup();

  ipcPolling = false;
  if (queryActivityTimer) clearTimeout(queryActivityTimer);
  log(`Query done. Messages: ${messageCount}, results: ${resultCount}, lastAssistantUuid: ${lastAssistantUuid || 'none'}, lastResumeUuid: ${lastResumeUuid || 'none'}, closedDuringQuery: ${closedDuringQuery}, interruptedDuringQuery: ${interruptedDuringQuery}, drainDetectedDuringQuery: ${drainDetectedDuringQuery}`);
  return { newSessionId, lastAssistantUuid, lastResumeUuid, closedDuringQuery, interruptedDuringQuery, drainDetectedDuringQuery };
  } catch (err) {
    ipcPolling = false;
    if (queryActivityTimer) clearTimeout(queryActivityTimer);
    const errorMessage = err instanceof Error ? err.message : String(err);

    // 检测上下文溢出错误
    if (isContextOverflowError(errorMessage)) {
      log(`Context overflow detected: ${errorMessage}`);
      return { newSessionId, lastAssistantUuid, closedDuringQuery, contextOverflow: true, interruptedDuringQuery };
    }

    // 检测不可恢复的转录错误
    if (isUnrecoverableTranscriptError(errorMessage)) {
      log(`Unrecoverable transcript error: ${errorMessage}`);
      return { newSessionId, lastAssistantUuid, closedDuringQuery, unrecoverableTranscriptError: true, interruptedDuringQuery };
    }

    // 中断导致的 SDK 错误（error_during_execution 等）：正常返回，不抛出
    if (interruptedDuringQuery) {
      log(`runQuery error during interrupt (non-fatal): ${errorMessage}`);
      return { newSessionId, lastAssistantUuid, closedDuringQuery, interruptedDuringQuery };
    }

    // 其他错误：记录完整堆栈后继续抛出
    log(`runQuery error [${(err as NodeJS.ErrnoException).code ?? 'unknown'}]: ${errorMessage}`);
    if (err instanceof Error && err.stack) {
      log(`runQuery error stack:\n${err.stack}`);
    }
    // 继续抛出
    throw err;
  }
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  let sessionId = containerInput.sessionId;
  const { isHome, isAdminHome } = normalizeHomeFlags(containerInput);

  // Create ContextManager with all plugins, then convert to SDK tools
  const pluginCtx = {
    chatJid: containerInput.chatJid,
    groupFolder: containerInput.groupFolder,
    isHome,
    isAdminHome,
    workspaceIpc: WORKSPACE_IPC,
    workspaceGroup: WORKSPACE_GROUP,
    workspaceGlobal: WORKSPACE_GLOBAL,
    workspaceMemory: WORKSPACE_MEMORY,
    userId: containerInput.userId,
  };
  const ctxMgr = createContextManager(pluginCtx);
  const buildMcpServerConfig = () => createSdkMcpServer({
    name: 'happyclaw',
    version: '1.0.0',
    tools: coreToolsToSdkTools(ctxMgr),
  });
  let mcpServerConfig = buildMcpServerConfig();
  const memoryRecallPrompt = buildMemoryRecallPrompt(isHome, isAdminHome);
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale sentinels from previous container runs
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
  try { fs.unlinkSync(IPC_INPUT_DRAIN_SENTINEL); } catch { /* ignore */ }
  try { fs.unlinkSync(IPC_INPUT_INTERRUPT_SENTINEL); } catch { /* ignore */ }

  // Build initial prompt (drain any pending IPC messages too)
  let prompt = containerInput.prompt;
  let promptImages = containerInput.images;
  const pendingDrain = drainIpcInput();
  if (pendingDrain.modeChange) {
    currentPermissionMode = pendingDrain.modeChange as PermissionMode;
    log(`Initial mode change via IPC: ${pendingDrain.modeChange}`);
  }
  if (pendingDrain.messages.length > 0) {
    log(`Draining ${pendingDrain.messages.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pendingDrain.messages.map((m) => m.text).join('\n');
    const pendingImages = pendingDrain.messages.flatMap((m) => m.images || []);
    if (pendingImages.length > 0) {
      promptImages = [...(promptImages || []), ...pendingImages];
    }
  }

  // Query loop: run query -> wait for IPC message -> run new query -> repeat
  let resumeAt: string | undefined;
  let overflowRetryCount = 0;
  const MAX_OVERFLOW_RETRIES = 3;
  try {
    while (true) {
      // 清理残留的 _interrupt sentinel，防止空闲期间写入的中断信号影响下一次 query
      try { fs.unlinkSync(IPC_INPUT_INTERRUPT_SENTINEL); } catch { /* ignore */ }
      clearInterruptRequested();

      log(`Starting query (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'})...`);

      const queryResult = await runQuery(
        prompt,
        sessionId,
        mcpServerConfig,
        containerInput,
        memoryRecallPrompt,
        resumeAt,
        true,
        DEFAULT_ALLOWED_TOOLS,
        undefined,
        promptImages,
      );
      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
      }
      // Advance resumeAt to the latest safe resume point in the session.
      // lastResumeUuid tracks the latest of: assistant(text) or user(tool_result).
      // This ensures the session advances linearly even when the agent's last
      // action is a tool_use without text output (common in IM chat where the
      // agent only calls send_message). Without this, resumeAt sticks at an
      // earlier text message, creating parallel branches where each query loses
      // visibility of prior turns.
      if (queryResult.lastResumeUuid) {
        resumeAt = queryResult.lastResumeUuid;
      } else if (queryResult.lastAssistantUuid) {
        resumeAt = queryResult.lastAssistantUuid;
      }

      // Rebuild MCP server config between queries to prevent stale transport.
      // The SDK's createSdkMcpServer transport can become disconnected when the
      // internal CLI process exits between query turns. Without rebuilding, the
      // next query may get "Stream closed" errors on MCP tool calls.
      mcpServerConfig = buildMcpServerConfig();

      // Session resume 失败（SDK 无法恢复旧会话）：清除 session，以新会话重试
      if (queryResult.sessionResumeFailed) {
        log(`Session resume failed, retrying with fresh session (old: ${sessionId})`);
        sessionId = undefined;
        resumeAt = undefined;
        continue;
      }

      // 不可恢复的转录错误（如超大图片或 MIME 错配被固化在会话历史中）
      if (queryResult.unrecoverableTranscriptError) {
        const errorMsg = '会话历史中包含无法处理的数据（如超大图片或图片 MIME 错配），会话需要重置。';
        log(`Unrecoverable transcript error, signaling session reset`);
        writeOutput({
          status: 'error',
          result: null,
          error: `unrecoverable_transcript: ${errorMsg}`,
          newSessionId: sessionId,
        });
        process.exit(1);
      }

      // 检查上下文溢出
      if (queryResult.contextOverflow) {
        overflowRetryCount++;
        log(`Context overflow detected, retry ${overflowRetryCount}/${MAX_OVERFLOW_RETRIES}`);

        if (overflowRetryCount >= MAX_OVERFLOW_RETRIES) {
          const errorMsg = `上下文溢出错误：已重试 ${MAX_OVERFLOW_RETRIES} 次仍失败。请联系管理员检查 CLAUDE.md 大小或减少会话历史。`;
          log(errorMsg);
          writeOutput({
            status: 'error',
            result: null,
            error: `context_overflow: ${errorMsg}`,
            newSessionId: sessionId,
          });
          process.exit(1);
        }

        // 未超过重试次数，等待后继续下一轮循环（会触发自动压缩）
        log('Retrying query after context overflow (will trigger auto-compaction)...');
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }

      // 成功执行后重置溢出重试计数器
      overflowRetryCount = 0;

      // If _close was consumed during the query, exit immediately.
      // Don't emit a session-update marker (it would reset the host's
      // idle timer and cause a 30-min delay before the next _close).
      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        // Notify host that this exit was due to _close, not a normal completion.
        // Without this marker the host treats the exit as silent success and
        // commits the message cursor, causing the in-flight IM message to be
        // consumed without a reply (the "swallowed message" bug).
        writeOutput({ status: 'closed', result: null });
        break;
      }

      // 中断后：跳过 memory flush 和 session update，等待下一条消息
      if (queryResult.interruptedDuringQuery) {
        log('Query interrupted by user, waiting for next message');
        writeOutput({
          status: 'stream',
          result: null,
          streamEvent: { eventType: 'status', statusText: 'interrupted' },
        });
        // 清理可能残留的 _interrupt 文件
        try { fs.unlinkSync(IPC_INPUT_INTERRUPT_SENTINEL); } catch { /* ignore */ }
        // 不 break，等待下一条消息
        const nextMessage = await waitForIpcMessage();
        if (nextMessage === null) {
          log('Close sentinel received after interrupt, exiting');
          break;
        }
        clearInterruptRequested();
        prompt = nextMessage.text;
        promptImages = nextMessage.images;
        continue;
      }

      // Check for _drain sentinel: finish current query then exit for turn boundary.
      // Unlike _close (where the host sends SIGTERM), _drain requires self-exit
      // because the host is waiting for the process to terminate naturally.
      // Check both: the flag set during pollIpcDuringQuery AND the sentinel file
      // (in case it was written after the query's IPC polling stopped).
      if (queryResult.drainDetectedDuringQuery || shouldDrain()) {
        log('Drain sentinel detected, exiting for turn boundary');
        writeOutput({ status: 'drained', result: null, newSessionId: sessionId });
        process.exit(0);
      }

      // Emit session update so host can track it
      writeOutput({ status: 'success', result: null, newSessionId: sessionId });

      log('Query ended, waiting for next IPC message...');

      // Wait for the next message or _close/_drain sentinel
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close/drain sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.text.length} chars, ${nextMessage.images?.length || 0} images), starting new query`);
      prompt = nextMessage.text;
      promptImages = nextMessage.images;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    if (err instanceof Error && err.stack) {
      log(`Agent error stack:\n${err.stack}`);
    }
    // Log cause chain for SDK-wrapped errors (e.g. EPIPE from internal claude CLI)
    const cause = err instanceof Error ? (err as NodeJS.ErrnoException & { cause?: unknown }).cause : undefined;
    if (cause) {
      const causeMsg = cause instanceof Error ? cause.stack || cause.message : String(cause);
      log(`Agent error cause:\n${causeMsg}`);
    }
    log(`Agent error errno: ${(err as NodeJS.ErrnoException).code ?? 'none'} exitCode: ${process.exitCode ?? 'none'}`);
    // 不在 error output 中携带 sessionId：
    // 流式输出已通过 onOutput 回调传递了有效的 session 更新。
    // 如果这里携带的是 throw 前的旧 sessionId，会覆盖中间成功产生的新 session。
    writeOutput({
      status: 'error',
      result: null,
      error: errorMessage
    });
    process.exit(1);
  }
}

// 处理管道断开（EPIPE）：父进程关闭管道后仍有写入时，静默退出避免 code 1 错误输出
(process.stdout as NodeJS.WriteStream & NodeJS.EventEmitter).on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
});
(process.stderr as NodeJS.WriteStream & NodeJS.EventEmitter).on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
});

/**
 * 某些 SDK/底层 socket 会在管道断开后触发未捕获 EPIPE。
 * 这类错误通常发生在结果已输出之后，属于"收尾写入失败"，
 * 不应把整个 host query 标记为启动失败（code 1）。
 */
process.on('SIGTERM', () => {
  log('Received SIGTERM, exiting gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  log('Received SIGINT, exiting gracefully');
  process.exit(0);
});

process.on('uncaughtException', (err: unknown) => {
  const errno = err as NodeJS.ErrnoException;
  if (errno?.code === 'EPIPE') {
    process.exit(0);
  }
  if (isWithinInterruptGraceWindow() && isInterruptRelatedError(err)) {
    console.error('Suppressing interrupt-related uncaught exception:', err);
    process.exit(0);
  }
  console.error('Uncaught exception:', err);
  // 尝试输出结构化错误，让主进程能收到错误信息而非仅看到 exit code 1
  try { writeOutput({ status: 'error', result: null, error: String(err) }); } catch { /* ignore */ }
  process.exit(1);
});

process.on('unhandledRejection', (reason: unknown) => {
  const errno = reason as NodeJS.ErrnoException;
  if (errno?.code === 'EPIPE') {
    process.exit(0);
  }
  // ProcessTransport closed — can happen if IPC poll races with query completion.
  // The message that triggered this was already consumed from IPC and is lost,
  // but the process should not crash. The main loop will pick up subsequent messages.
  if (reason instanceof Error && /ProcessTransport is not ready/i.test(reason.message)) {
    console.error('[agent-runner] ProcessTransport not ready (non-fatal, query ended):', reason.message);
    return;
  }
  if (isWithinInterruptGraceWindow()) {
    console.error('Unhandled rejection during interrupt (non-fatal):', reason);
    return;
  }
  console.error('Unhandled rejection:', reason);
  process.exit(1);
});
main();
