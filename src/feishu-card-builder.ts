/**
 * Shared Feishu card JSON 2.0 builders.
 *
 * Controllers own lifecycle and transport; this module owns presentation only.
 * Keeping one builder avoids the previous drift where the "streaming" and
 * progress cards both claimed to be 2.0 while still emitting 1.0 payloads.
 */

export type ReplyCardState = 'streaming' | 'completed' | 'aborted';

export interface ProgressCardTool {
  toolName: string;
  startTime?: number;
  duration?: number;
  inputSummary?: string;
  skillName?: string;
}

export interface ProgressCardAgent {
  description: string;
  startTime?: number;
  duration?: number;
  summary?: string;
  isBackground?: boolean;
  agentType?: string;
  agentName?: string;
}

export interface ProgressCardRenderData {
  title?: string;
  modelLabel?: string;
  activeTools: ProgressCardTool[];
  completedTools: ProgressCardTool[];
  isThinking: boolean;
  thinkingText: string;
  elapsedMs: number;
  state: 'active' | 'completed' | 'aborted';
  abortReason?: string;
  activeSubAgents: ProgressCardAgent[];
  completedSubAgents: ProgressCardAgent[];
  latestCommentary?: string;
  stopActionId?: string;
}

const MAX_PANEL_CHARS = 24_000;
export const STREAMING_CONTENT_ELEMENT_ID = 'happyclaw_reply_content';
export const STREAMING_PRINT_FREQUENCY_MS = 40;
export const STREAMING_PRINT_STEP = 10;

function plain(content: string): Record<string, unknown> {
  return { tag: 'plain_text', content };
}

function markdown(
  content: string,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return { tag: 'markdown', content, ...extra };
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${seconds % 60}s`;
}

function compactLine(value: string, max = 80): string {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function toolName(tool: ProgressCardTool): string {
  return tool.skillName ? `技能 ${tool.skillName}` : tool.toolName;
}

function agentName(agent: ProgressCardAgent): string {
  const prefix = agent.agentName || agent.agentType;
  return compactLine(
    `${prefix ? `[${prefix}] ` : ''}${agent.description}`,
    100,
  );
}

/**
 * Keep the full trace during normal runs. Only trim at the card-size safety
 * boundary, and make the omission explicit instead of silently retaining an
 * arbitrary last-N window.
 */
function fitPanelLines(lines: string[]): string {
  const full = lines.join('\n');
  if (full.length <= MAX_PANEL_CHARS) return full;

  const kept: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const next = lines[i];
    if (used + next.length + 1 > MAX_PANEL_CHARS - 80) break;
    kept.unshift(next);
    used += next.length + 1;
  }
  const omitted = lines.length - kept.length;
  return `*内容过长，已省略最早 ${omitted} 条记录。*\n${kept.join('\n')}`;
}

function collapsiblePanel(
  title: string,
  content: string,
  iconToken: string,
): Record<string, unknown> {
  return {
    tag: 'collapsible_panel',
    expanded: false,
    border: { color: 'grey', corner_radius: '6px' },
    header: {
      title: plain(title),
      icon: { tag: 'standard_icon', token: iconToken },
      icon_position: 'left',
      padding: '8px 10px 8px 10px',
    },
    padding: '8px 10px 10px 10px',
    elements: [markdown(content || '暂无记录', { text_size: 'notation' })],
  };
}

export function buildStaticReplyCard(
  text: string,
  state: ReplyCardState = 'completed',
  extraElements?: Array<Record<string, unknown>>,
): Record<string, unknown> {
  const body = text.trim() || '...';
  const elements: Array<Record<string, unknown>> = [
    markdown(body, { element_id: STREAMING_CONTENT_ELEMENT_ID }),
  ];
  if (state === 'streaming') {
    elements.push(
      markdown("<font color='grey'>生成中…</font>", {
        text_size: 'notation',
      }),
    );
  } else if (state === 'aborted') {
    elements.push(
      markdown("<font color='orange'>已中断</font>", {
        text_size: 'notation',
      }),
    );
  }
  if (extraElements?.length) elements.push(...extraElements);

  return {
    schema: '2.0',
    config: {
      width_mode: 'fill',
      update_multi: true,
      summary: { content: compactLine(body, 80) || '回复' },
    },
    header: {
      title: plain('回复'),
      template:
        state === 'aborted'
          ? 'orange'
          : state === 'streaming'
            ? 'wathet'
            : 'indigo',
      icon: { tag: 'standard_icon', token: 'chat_outlined' },
    },
    body: {
      direction: 'vertical',
      padding: '12px 16px 14px 16px',
      vertical_spacing: '10px',
      elements,
    },
  };
}

/**
 * CardKit streaming mode currently accepts one markdown element reliably.
 * The richer fixed header is restored by the static fallback path; the live
 * entity deliberately stays minimal so native typewriter rendering works.
 */
export function buildCardKitStreamingCard(
  text: string,
): Record<string, unknown> {
  return {
    schema: '2.0',
    config: {
      streaming_mode: true,
      streaming_config: {
        print_frequency_ms: { default: STREAMING_PRINT_FREQUENCY_MS },
        print_step: { default: STREAMING_PRINT_STEP },
        print_strategy: 'fast',
      },
      width_mode: 'fill',
      update_multi: true,
      summary: { content: '回复生成中' },
    },
    body: {
      padding: '12px 16px 14px 16px',
      elements: [
        markdown(text.trim() || '...', {
          element_id: STREAMING_CONTENT_ELEMENT_ID,
        }),
      ],
    },
  };
}

export function buildProgressCard(
  data: ProgressCardRenderData,
): Record<string, unknown> {
  const statusLabel =
    data.state === 'active'
      ? '执行中'
      : data.state === 'completed'
        ? '已完成'
        : data.abortReason || '已中断';
  const template =
    data.state === 'active'
      ? 'wathet'
      : data.state === 'completed'
        ? 'green'
        : 'orange';
  const currentAction = data.activeTools[0]
    ? `${toolName(data.activeTools[0])}${data.activeTools[0].inputSummary ? ` · ${compactLine(data.activeTools[0].inputSummary, 48)}` : ''}`
    : data.isThinking
      ? '正在思考'
      : data.latestCommentary
        ? compactLine(data.latestCommentary, 60)
        : statusLabel;
  const title =
    compactLine(data.title || data.latestCommentary || 'Agent 执行', 48) ||
    'Agent 执行';
  const totalTools = data.activeTools.length + data.completedTools.length;
  const totalAgents =
    data.activeSubAgents.length + data.completedSubAgents.length;

  const textTags: Array<Record<string, unknown>> = [
    {
      tag: 'text_tag',
      text: plain(formatElapsed(data.elapsedMs)),
      color: data.state === 'active' ? 'blue' : 'neutral',
    },
  ];
  if (data.modelLabel) {
    textTags.push({
      tag: 'text_tag',
      text: plain(compactLine(data.modelLabel, 18)),
      color: 'indigo',
    });
  }
  if (totalTools > 0) {
    textTags.push({
      tag: 'text_tag',
      text: plain(`${totalTools} tools`),
      color: 'neutral',
    });
  }

  const elements: Array<Record<string, unknown>> = [];

  for (const tool of data.activeTools) {
    const elapsed =
      tool.startTime === undefined
        ? ''
        : formatElapsed(Date.now() - tool.startTime);
    elements.push({
      tag: 'column_set',
      flex_mode: 'stretch',
      vertical_align: 'center',
      columns: [
        {
          tag: 'column',
          width: 'weighted',
          weight: 4,
          elements: [
            markdown(
              `**${toolName(tool)}**${tool.inputSummary ? `  \`${compactLine(tool.inputSummary, 70)}\`` : ''}`,
            ),
          ],
        },
        {
          tag: 'column',
          width: 'auto',
          elements: [markdown(elapsed, { text_align: 'right' })],
        },
      ],
    });
  }

  if (data.latestCommentary) {
    elements.push(markdown(data.latestCommentary));
  }

  if (data.thinkingText.trim()) {
    const thinking = data.thinkingText.trim().replace(/\n{3,}/g, '\n\n');
    elements.push(
      collapsiblePanel(
        '思考过程',
        thinking.length <= MAX_PANEL_CHARS
          ? thinking
          : `${thinking.slice(0, MAX_PANEL_CHARS)}\n\n*后续内容过长，已截断。*`,
        'thinking_outlined',
      ),
    );
  }

  if (totalTools > 0) {
    const toolLines = [
      ...data.completedTools.map((tool) => {
        const summary = tool.inputSummary
          ? ` — \`${compactLine(tool.inputSummary, 100)}\``
          : '';
        return `✅ **${toolName(tool)}**${summary}${tool.duration === undefined ? '' : ` · ${formatElapsed(tool.duration)}`}`;
      }),
      ...data.activeTools.map((tool) => {
        const summary = tool.inputSummary
          ? ` — \`${compactLine(tool.inputSummary, 100)}\``
          : '';
        const elapsed =
          tool.startTime === undefined
            ? ''
            : ` · ${formatElapsed(Date.now() - tool.startTime)}`;
        return `⏳ **${toolName(tool)}**${summary}${elapsed}`;
      }),
    ];
    elements.push(
      collapsiblePanel(
        `工具调用 (${totalTools})`,
        fitPanelLines(toolLines),
        'tool_outlined',
      ),
    );
  }

  if (totalAgents > 0) {
    const agentLines = [
      ...data.completedSubAgents.map(
        (agent) =>
          `✅ **${agentName(agent)}**${agent.summary ? ` — ${compactLine(agent.summary, 120)}` : ''}${agent.duration === undefined ? '' : ` · ${formatElapsed(agent.duration)}`}`,
      ),
      ...data.activeSubAgents.map((agent) => {
        const elapsed =
          agent.startTime === undefined
            ? ''
            : ` · ${formatElapsed(Date.now() - agent.startTime)}`;
        return `⏳ **${agentName(agent)}**${agent.isBackground ? ' `[后台]`' : ''}${elapsed}`;
      }),
    ];
    elements.push(
      collapsiblePanel(
        `子 Agent (${totalAgents})`,
        fitPanelLines(agentLines),
        'robot_outlined',
      ),
    );
  }

  if (data.state === 'active' && data.stopActionId) {
    elements.push({
      tag: 'button',
      text: plain('停止'),
      type: 'danger',
      size: 'small',
      width: 'default',
      behaviors: [
        {
          type: 'callback',
          value: {
            action: 'stop_turn',
            action_id: data.stopActionId,
          },
        },
      ],
      confirm: {
        title: plain('停止当前执行？'),
        text: plain('已完成的工作会保留，当前运行中的步骤将被中断。'),
      },
    });
  }

  if (elements.length === 0) {
    elements.push(markdown(statusLabel));
  }

  return {
    schema: '2.0',
    config: {
      width_mode: 'fill',
      update_multi: true,
      enable_forward_interaction: false,
      summary: { content: `${title} · ${statusLabel}` },
    },
    header: {
      title: plain(title),
      subtitle: plain(currentAction),
      template,
      icon: {
        tag: 'standard_icon',
        token:
          data.state === 'active'
            ? 'loading_outlined'
            : data.state === 'completed'
              ? 'yes_outlined'
              : 'warning_outlined',
      },
      text_tag_list: textTags.slice(0, 3),
      padding: '12px 16px 12px 16px',
    },
    body: {
      direction: 'vertical',
      padding: '12px 16px 14px 16px',
      vertical_spacing: '10px',
      elements,
    },
  };
}
