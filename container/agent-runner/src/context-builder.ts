/**
 * Context Builder — assembles the system prompt from ~8 segments.
 *
 * Extracted from index.ts to keep the main entry point focused on
 * orchestration (query loop, IPC polling, lifecycle management).
 */

import fs from 'fs';
import path from 'path';

import type { ContainerInput } from './types.js';
import type { SessionState } from './session-state.js';

// Memory Agent mode: read index.md from the memory-index mount
const WORKSPACE_MEMORY_INDEX = process.env.HAPPYCLAW_WORKSPACE_MEMORY_INDEX || '/workspace/memory-index';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface ContextBuilderInput {
  state: SessionState;           // for getActiveImChannels()
  containerInput: ContainerInput; // for contextSummary, isHome, isAdminHome, userId
  groupDir: string;              // WORKSPACE_GROUP
  globalDir: string;             // WORKSPACE_GLOBAL
  memoryDir: string;             // WORKSPACE_MEMORY
}

/**
 * Build the full `systemPromptAppend` string that is appended to the
 * claude_code preset system prompt.
 *
 * Segments (in order):
 *  1. globalClaudeMd        — read from globalDir/CLAUDE.md, only if isHome
 *  2. contextSummary        — from containerInput.contextSummary
 *  3. interactionGuidelines — static
 *  4. channelRoutingGuidelines — static + dynamic activeImChannels
 *  5. memoryRecall          — read from memoryDir
 *  6. outputGuidelines      — static
 *  7. webFetchGuidelines    — static
 *  8. backgroundTaskGuidelines — static
 */
export function buildSystemPromptAppend(input: ContextBuilderInput): string {
  const { state, containerInput, globalDir } = input;
  const { isHome, isAdminHome } = normalizeHomeFlags(containerInput);

  // 1. Global CLAUDE.md — only for home containers
  const globalClaudeMdPath = path.join(globalDir, 'CLAUDE.md');
  let globalClaudeMd = '';
  if (isHome && fs.existsSync(globalClaudeMdPath)) {
    globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
  }

  // 2. Context summary from previous compressed session
  const contextSummarySection = containerInput.contextSummary
    ? [
        '## 上下文摘要',
        '',
        '以下是之前对话的压缩摘要。这些信息来自于已压缩的历史对话，你可以基于此继续工作：',
        '',
        '<previous-context-summary>',
        containerInput.contextSummary,
        '</previous-context-summary>',
        '',
      ].join('\n')
    : '';

  // 3. Interaction guidelines
  // (prevent agent from confusing MCP tool descriptions with user input)

  // 4. Channel routing guidelines (static + dynamic IM channels)
  const channelRoutingGuidelines = buildChannelRoutingSection(state);

  // 5. Memory recall
  const memoryRecall = buildMemoryRecallPrompt(isHome, isAdminHome);

  // HEARTBEAT.md injection disabled — replaced by Memory Agent's index.md
  const heartbeatContent = '';

  return [
    globalClaudeMd,
    heartbeatContent,
    contextSummarySection,
    interactionGuidelines,
    channelRoutingGuidelines,
    memoryRecall,
    outputGuidelines,
    webFetchGuidelines,
    backgroundTaskGuidelines,
  ].filter(Boolean).join('\n');
}

/**
 * Build the routing reminder injected as a user message after context
 * compaction (compact_boundary). Returns the message text to push into
 * the MessageStream, or `null` if no reminder is needed (fallback
 * message is always returned).
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

export function normalizeHomeFlags(input: ContainerInput): { isHome: boolean; isAdminHome: boolean } {
  return { isHome: !!input.isHome, isAdminHome: !!input.isAdminHome };
}

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

// ---------------------------------------------------------------------------
// Static guideline strings (module-level constants)
// ---------------------------------------------------------------------------

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

/**
 * Build the channel routing section including dynamic IM channel list.
 */
function buildChannelRoutingSection(state: SessionState): string {
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
    ...(state.recentImChannels.size > 0
      ? [
          '',
          `**活跃 IM 渠道**：你近期与以下渠道有活跃对话：${[...state.recentImChannels].join('、')}。`,
          '完成任务后，务必通过 `send_message(channel="渠道值")` 主动向这些渠道的用户汇报结果。',
        ]
      : []),
  ].join('\n');
}
