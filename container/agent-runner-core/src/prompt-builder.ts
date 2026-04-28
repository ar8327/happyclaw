/**
 * System prompt builder — assembles prompt sections shared by all runners.
 *
 * Two-level API:
 * - buildBasePrompt(): environment + workspace/global CLAUDE.md (for Codex etc.)
 * - buildAppendPrompt(): all guideline segments + plugins (for all providers)
 * - buildFullPrompt(): base + append (for Codex)
 *
 * Claude uses only buildAppendPrompt() because the claude_code preset
 * already includes base environment info.
 */

import fs from 'fs';
import path from 'path';
import type { PluginContext, ContextPlugin } from './plugin.js';

// ---------------------------------------------------------------------------
// Static guideline constants (migrated from agent-runner/context-builder.ts)
// ---------------------------------------------------------------------------

export const INTERACTION_GUIDELINES = [
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

export const OUTPUT_GUIDELINES = [
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

export const WEB_FETCH_GUIDELINES = [
  '',
  '## 网页访问策略',
  '',
  '访问外部网页时优先使用 WebFetch（速度快）。',
  '如果 WebFetch 失败（403、被拦截、内容为空或需要 JavaScript 渲染），',
  '且 agent-browser 可用，立即改用 agent-browser 通过真实浏览器访问。不要反复重试 WebFetch。',
].join('\n');

export const BACKGROUND_TASK_GUIDELINES = [
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

// ---------------------------------------------------------------------------
// Channel routing section (static + dynamic IM channels)
// ---------------------------------------------------------------------------

function buildChannelRoutingSection(recentImChannels?: Set<string>): string {
  return [
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
    // Inject persisted IM channels reminder so continued sessions don't forget
    ...(recentImChannels && recentImChannels.size > 0
      ? [
          '',
          `**活跃 IM 渠道**：你近期与以下渠道有活跃对话：${[...recentImChannels].join('、')}。`,
          '完成任务后，务必通过 `send_message(channel="渠道值")` 主动向这些渠道的用户汇报结果。',
        ]
      : []),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Context summary section
// ---------------------------------------------------------------------------

function buildContextSummarySection(contextSummary?: string): string {
  if (!contextSummary) return '';
  return [
    '## 上下文摘要',
    '',
    '以下是之前对话的压缩摘要。这些信息来自于已压缩的历史对话，你可以基于此继续工作：',
    '',
    '<previous-context-summary>',
    contextSummary,
    '</previous-context-summary>',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Base prompt — environment info + workspace CLAUDE.md + global CLAUDE.md.
 * Used by Codex and other providers that don't have a preset.
 * Claude doesn't need this (claude_code preset already includes base info).
 */
export function buildBasePrompt(ctx: PluginContext): string {
  const parts: string[] = [];

  parts.push(
    `You are an AI assistant running in the HappyClaw platform${ctx.providerInfo ? `, powered by ${ctx.providerInfo}` : ''}.`,
    '',
    '## Environment',
    `- Working directory: ${ctx.workspaceGroup}`,
    `- Group folder: ${ctx.groupFolder}`,
    '',
  );

  // Load workspace CLAUDE.md
  const workspaceInstructions = tryReadFile(path.join(ctx.workspaceGroup, 'CLAUDE.md'));
  if (workspaceInstructions) {
    parts.push('## Workspace Instructions', '', workspaceInstructions, '');
  }

  // Load global CLAUDE.md (only for home containers, same logic as before)
  if (ctx.isHome) {
    const globalInstructions = tryReadFile(path.join(ctx.workspaceGlobal, 'CLAUDE.md'));
    if (globalInstructions) {
      parts.push('## Global Instructions', '', globalInstructions, '');
    }
  }

  return parts.join('\n');
}

/**
 * Append prompt — all guideline segments + plugin prompt sections.
 * Used by ALL providers (Claude appends to preset, Codex appends to base).
 *
 * Segments (in order, matching original context-builder.ts):
 * 1. Global CLAUDE.md (only for isHome — Claude preset doesn't load this)
 * 2. contextSummary (if any)
 * 3. Interaction guidelines (static)
 * 4. Channel routing (static + dynamic recentImChannels)
 * 5. Plugin prompt sections (includes MemoryPlugin)
 * 6. Output guidelines (static)
 * 7. WebFetch guidelines (static)
 * 8. Background task guidelines (static)
 */
export function buildAppendPrompt(
  ctx: PluginContext,
  plugins: ContextPlugin[],
  options?: { includeGlobalInstructions?: boolean },
): string {
  // 1. Global CLAUDE.md — only for home containers
  let globalClaudeMd = '';
  if (options?.includeGlobalInstructions !== false && ctx.isHome) {
    const globalClaudeMdPath = path.join(ctx.workspaceGlobal, 'CLAUDE.md');
    globalClaudeMd = tryReadFile(globalClaudeMdPath) || '';
  }

  // 2. Context summary
  const contextSummarySection = buildContextSummarySection(ctx.contextSummary);

  // 3. Interaction guidelines
  // (static constant)

  // 4. Channel routing (static + dynamic IM channels)
  const channelRoutingSection = buildChannelRoutingSection(ctx.recentImChannels);

  // 5. Plugin prompt sections
  const pluginSections: string[] = [];
  for (const plugin of plugins) {
    if (!plugin.isEnabled(ctx)) continue;
    const section = plugin.getSystemPromptSection(ctx);
    if (section) pluginSections.push(section);
  }

  return [
    globalClaudeMd,
    contextSummarySection,
    INTERACTION_GUIDELINES,
    channelRoutingSection,
    ...pluginSections,
    OUTPUT_GUIDELINES,
    WEB_FETCH_GUIDELINES,
    BACKGROUND_TASK_GUIDELINES,
  ].filter(Boolean).join('\n');
}

/**
 * Full prompt = base + append.
 * Used by Codex and other providers that need the complete prompt.
 */
export function buildFullPrompt(
  ctx: PluginContext,
  plugins: ContextPlugin[],
): string {
  return (
    buildBasePrompt(ctx) +
    '\n' +
    buildAppendPrompt(ctx, plugins, { includeGlobalInstructions: false })
  );
}

/**
 * Post-compaction routing reminder.
 * Claude-specific (other providers have no compaction concept), but defined
 * in core because it only depends on activeChannels, not SDK types.
 */
export function buildChannelRoutingReminder(activeChannels: string[]): string {
  if (activeChannels.length > 0) {
    return (
      `[系统提示] 上下文已压缩。重要提醒：\n` +
      `1. 你的文字输出（stdout）仅在 Web 界面可见。` +
      `你近期与以下 IM 渠道有活跃对话：${activeChannels.join('、')}。` +
      `回复这些渠道的用户时，必须使用 send_message(channel="渠道值") 工具，否则他们收不到你的消息。` +
      `请检查消息的 source 属性确定 channel 值。\n` +
      `2. 压缩摘要中包含的用户消息是压缩前已经处理过的历史消息，你已经回复过了。` +
      `不要重复回复这些消息。只有压缩后通过 IPC 新到达的消息才需要回复。` +
      `如果压缩后没有新消息到达，保持安静等待即可。`
    );
  }
  return (
    `[系统提示] 上下文已压缩。注意：压缩摘要中包含的用户消息是压缩前已经处理过的历史消息，` +
    `你已经回复过了。不要重复回复这些消息。只有压缩后新到达的消息才需要回复。` +
    `如果压缩后没有新消息到达，保持安静等待即可。`
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tryReadFile(filePath: string): string | null {
  try {
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf-8');
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * Normalize isHome/isAdminHome flags from ContainerInput.
 */
export function normalizeHomeFlags(input: { isHome?: boolean; isAdminHome?: boolean }): { isHome: boolean; isAdminHome: boolean } {
  return { isHome: !!input.isHome, isAdminHome: !!input.isAdminHome };
}
