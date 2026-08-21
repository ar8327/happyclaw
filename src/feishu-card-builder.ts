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
  state: 'active' | 'completed' | 'aborted' | 'failed';
  abortReason?: string;
  failureDetail?: string;
  runnerError?: {
    message: string;
    detail?: string;
    willRetry: boolean;
  };
  activeSubAgents: ProgressCardAgent[];
  completedSubAgents: ProgressCardAgent[];
  latestCommentary?: string;
  stopActionId?: string;
}

const MAX_PANEL_CHARS = 24_000;
const MAX_ERROR_CHARS = 8_000;
// CardKit requires 1-20 alphanumeric/underscore characters.
export const STREAMING_CONTENT_ELEMENT_ID = 'hc_reply_content';
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

function cleanErrorText(value: string): string {
  return value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r\n?/g, '\n')
    .trim();
}

function errorSummary(value: string): string {
  const cleaned = cleanErrorText(value);
  const firstLine = cleaned
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);
  return compactLine(firstLine || 'Runner 未返回具体错误信息', 110);
}

function escapeInlineMarkdown(value: string): string {
  return value.replace(/([\\`*_[\]<>])/g, '\\$1');
}

function errorDetailBlock(value: string): string {
  const cleaned = cleanErrorText(value) || 'Runner 未返回具体错误信息';
  const fitted =
    cleaned.length <= MAX_ERROR_CHARS
      ? cleaned
      : `${cleaned.slice(0, MAX_ERROR_CHARS)}\n\n[错误详情过长，后续内容已截断]`;
  return `\`\`\`text\n${fitted.replace(/```/g, '``\u200b`')}\n\`\`\``;
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
  iconToken?: string,
): Record<string, unknown> {
  return {
    tag: 'collapsible_panel',
    expanded: false,
    header: {
      title: plain(title),
      ...(iconToken
        ? {
            icon: { tag: 'standard_icon', token: iconToken },
            icon_position: 'left',
          }
        : {}),
      padding: '4px 0px 4px 0px',
    },
    padding: '4px 0px 6px 0px',
    elements: [markdown(content || '暂无记录', { text_size: 'notation' })],
  };
}

/** Muted single line used for status/meta rows. */
function metaLine(content: string): Record<string, unknown> {
  return markdown(`<font color='grey'>${content}</font>`, {
    text_size: 'notation',
  });
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
      enable_forward: true,
      streaming_mode: false,
      summary: { content: compactLine(body, 80) || '回复' },
    },
    body: {
      direction: 'vertical',
      padding: '12px 16px 12px 16px',
      vertical_spacing: '8px',
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
  const finalFailureDetail =
    data.state === 'failed'
      ? cleanErrorText(
          data.failureDetail ||
            data.runnerError?.detail ||
            data.runnerError?.message ||
            'Runner 未返回具体错误信息',
        )
      : undefined;
  const visibleRunnerError =
    data.state === 'failed'
      ? {
          message: errorSummary(finalFailureDetail || ''),
          detail: finalFailureDetail,
          willRetry: false,
        }
      : data.runnerError;
  const statusLabel = visibleRunnerError
    ? visibleRunnerError.willRetry
      ? '自动重试中'
      : '执行失败'
    : data.state === 'active'
      ? '执行中'
      : data.state === 'completed'
        ? '已完成'
        : data.state === 'failed'
          ? '执行失败'
          : data.abortReason || '已中断';
  // Minimal presentation: the header stays neutral grey for every healthy
  // state so the card blends into the chat stream. Colour is reserved for
  // failures, where drawing attention is the point.
  const template = visibleRunnerError
    ? visibleRunnerError.willRetry
      ? 'orange'
      : 'red'
    : data.state === 'failed'
      ? 'red'
      : 'grey';
  const title =
    compactLine(data.title || data.latestCommentary || 'Agent 执行', 48) ||
    'Agent 执行';
  const totalTools = data.activeTools.length + data.completedTools.length;
  const totalAgents =
    data.activeSubAgents.length + data.completedSubAgents.length;

  const statusParts = [statusLabel, formatElapsed(data.elapsedMs)];
  if (data.modelLabel) statusParts.push(compactLine(data.modelLabel, 18));

  const elements: Array<Record<string, unknown>> = [
    metaLine(statusParts.join(' · ')),
  ];

  if (visibleRunnerError) {
    const retrying = visibleRunnerError.willRetry;
    const headline = retrying
      ? 'Runner 暂时异常，正在自动重试'
      : 'Runner 无法继续当前 turn';
    const color = retrying ? 'orange' : 'red';
    elements.push(
      markdown(
        `<font color='${color}'>**${headline}**</font>\n${escapeInlineMarkdown(errorSummary(visibleRunnerError.message))}`,
      ),
      collapsiblePanel(
        'Runner 错误详情',
        errorDetailBlock(
          visibleRunnerError.detail || visibleRunnerError.message,
        ),
        'warning_outlined',
      ),
      markdown(
        retrying
          ? "<font color='grey'>app-server 正在当前 turn 内自动重试，无需重新发送消息。</font>"
          : "<font color='grey'>当前 turn 已停止；后续消息仍会按可靠投递策略处理。</font>",
        { text_size: 'notation' },
      ),
    );
  }

  for (const tool of data.activeTools) {
    const elapsed =
      tool.startTime === undefined
        ? ''
        : ` <font color='grey'>· ${formatElapsed(Date.now() - tool.startTime)}</font>`;
    elements.push(
      markdown(
        `**${toolName(tool)}**${tool.inputSummary ? ` \`${compactLine(tool.inputSummary, 70)}\`` : ''}${elapsed}`,
      ),
    );
  }

  if (data.activeTools.length === 0 && data.isThinking && !visibleRunnerError) {
    elements.push(metaLine('正在思考…'));
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
      collapsiblePanel(`工具调用 (${totalTools})`, fitPanelLines(toolLines)),
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
      collapsiblePanel(`子 Agent (${totalAgents})`, fitPanelLines(agentLines)),
    );
  }

  if (
    data.state === 'active' &&
    data.stopActionId &&
    visibleRunnerError?.willRetry !== false
  ) {
    elements.push({
      tag: 'button',
      text: plain('停止'),
      type: 'default',
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
      template,
      icon: {
        tag: 'standard_icon',
        token: visibleRunnerError
          ? 'warning_outlined'
          : data.state === 'active'
            ? 'loading_outlined'
            : data.state === 'completed'
              ? 'yes_outlined'
              : 'warning_outlined',
      },
      padding: '10px 16px 10px 16px',
    },
    body: {
      direction: 'vertical',
      padding: '10px 16px 12px 16px',
      vertical_spacing: '8px',
      elements,
    },
  };
}

// ─── Model config card ────────────────────────────────────────

/** Sentinel option value meaning "clear the override". */
export const MODEL_CARD_DEFAULT_VALUE = '__default__';
/** Feishu rejects oversized option lists; keep well below the platform cap. */
export const MODEL_CARD_MAX_OPTIONS = 40;

export interface ModelCardOption {
  value: string;
  label: string;
}

export interface ModelCardField {
  /** Callback field name, e.g. `runner` / `model` / `effort` / `variant`. */
  field: string;
  label: string;
  placeholder: string;
  selected: string | null;
  options: ModelCardOption[];
  /** Number of options dropped by MODEL_CARD_MAX_OPTIONS, if any. */
  truncated?: number;
  /** Shown before the callback fires — used where a choice is destructive. */
  confirm?: { title: string; text: string };
}

export interface ModelCardData {
  locationLine: string;
  summaryLines: string[];
  fields: ModelCardField[];
  /** Merged into every callback value so the handler can find the session. */
  actionValue: Record<string, unknown>;
  note?: string;
  warning?: string;
}

function modelCardSelect(
  field: ModelCardField,
  actionValue: Record<string, unknown>,
) {
  let visible = field.options.slice(0, MODEL_CARD_MAX_OPTIONS);
  // Truncation must never drop the current selection — a select whose
  // initial_option is missing renders as "unset" and misreports the session.
  if (
    field.selected &&
    !visible.some((option) => option.value === field.selected) &&
    field.options.some((option) => option.value === field.selected)
  ) {
    const current = field.options.find(
      (option) => option.value === field.selected,
    )!;
    visible = [current, ...visible.slice(0, MODEL_CARD_MAX_OPTIONS - 1)];
  }

  const options = visible.map((option) => ({
    text: plain(compactLine(option.label, 60)),
    value: option.value,
  }));
  const selected =
    field.selected && options.some((option) => option.value === field.selected)
      ? field.selected
      : undefined;
  return {
    tag: 'select_static',
    name: `hc_model_${field.field}`,
    placeholder: plain(field.placeholder),
    width: 'fill',
    ...(selected ? { initial_option: selected } : {}),
    options,
    ...(field.confirm
      ? {
          confirm: {
            title: plain(field.confirm.title),
            text: plain(field.confirm.text),
          },
        }
      : {}),
    behaviors: [
      {
        type: 'callback',
        value: { ...actionValue, field: field.field },
      },
    ],
  };
}

/**
 * Interactive `/model` card.
 *
 * Every select applies immediately through a `card.action.trigger` callback —
 * there is no submit button, because a half-applied form would leave the
 * session config and the card visibly out of sync.
 */
export function buildModelConfigCard(
  data: ModelCardData,
): Record<string, unknown> {
  const elements: Array<Record<string, unknown>> = [
    markdown(`**${data.locationLine}**`),
  ];
  if (data.summaryLines.length > 0) {
    elements.push(markdown(data.summaryLines.join('\n')));
  }
  elements.push({ tag: 'hr' });

  for (const field of data.fields) {
    if (field.options.length === 0) continue;
    elements.push(metaLine(field.label));
    elements.push(modelCardSelect(field, data.actionValue));
    if (field.truncated) {
      elements.push(
        metaLine(`还有 ${field.truncated} 个未列出，可用 /model 文本命令指定`),
      );
    }
  }

  if (data.warning) {
    elements.push(
      markdown(`<font color='orange'>${data.warning}</font>`, {
        text_size: 'notation',
      }),
    );
  }
  if (data.note) {
    elements.push(metaLine(data.note));
  }

  elements.push({
    tag: 'button',
    text: plain('重置为默认'),
    type: 'text',
    size: 'small',
    width: 'default',
    behaviors: [
      {
        type: 'callback',
        value: { ...data.actionValue, field: 'reset' },
      },
    ],
    confirm: {
      title: plain('重置模型配置？'),
      text: plain('会清除 model / effort / variant 覆盖，runner 保持不变。'),
    },
  });

  return {
    schema: '2.0',
    config: {
      width_mode: 'fill',
      update_multi: true,
      enable_forward_interaction: false,
      summary: { content: `模型配置 · ${compactLine(data.locationLine, 40)}` },
    },
    header: {
      title: plain('⚙️ 模型配置'),
      template: 'blue',
      padding: '10px 16px 10px 16px',
    },
    body: {
      direction: 'vertical',
      padding: '10px 16px 12px 16px',
      vertical_spacing: '8px',
      elements,
    },
  };
}
