/**
 * Dump Feishu card JSON for design review.
 *
 * The payloads printed here are exactly what the bot sends, so they can be
 * pasted straight into 飞书卡片搭建工具 to eyeball the layout without having to
 * drive a real turn in a chat.
 *
 * Usage:
 *   npx tsx scripts/preview-feishu-card.ts            # list available samples
 *   npx tsx scripts/preview-feishu-card.ts active     # print one sample
 */
import {
  buildModelConfigCard,
  buildProgressCard,
  buildStaticReplyCard,
  MODEL_CARD_DEFAULT_VALUE,
  type ProgressCardRenderData,
} from '../src/feishu-card-builder.js';

const now = Date.now();

const baseProgress: ProgressCardRenderData = {
  title: '修复斜杠命令',
  modelLabel: 'opus',
  activeTools: [],
  completedTools: [],
  isThinking: false,
  thinkingText: '',
  elapsedMs: 12_000,
  state: 'active',
  activeSubAgents: [],
  completedSubAgents: [],
};

const completedTools = [
  { toolName: 'Read', inputSummary: 'src/index.ts', duration: 1_200 },
  { toolName: 'Grep', inputSummary: 'onCommand', duration: 800 },
  { toolName: 'Edit', inputSummary: 'src/feishu.ts', duration: 2_400 },
];

const samples: Record<string, () => unknown> = {
  active: () =>
    buildProgressCard({
      ...baseProgress,
      activeTools: [
        {
          toolName: 'Read',
          inputSummary: 'src/index.ts',
          startTime: now - 3_000,
        },
      ],
      completedTools,
      isThinking: true,
      thinkingText: '先确认斜杠命令的分发路径，再决定改动面。',
    }),
  thinking: () => buildProgressCard({ ...baseProgress, isThinking: true }),
  completed: () =>
    buildProgressCard({
      ...baseProgress,
      completedTools,
      elapsedMs: 80_000,
      state: 'completed',
    }),
  aborted: () =>
    buildProgressCard({
      ...baseProgress,
      completedTools,
      state: 'aborted',
      abortReason: '用户通过 /stop 停止',
    }),
  retrying: () =>
    buildProgressCard({
      ...baseProgress,
      runnerError: {
        message: 'stream disconnected before completion',
        detail:
          'stream disconnected before completion\n错误类型：responseStreamDisconnected（HTTP 502）',
        willRetry: true,
      },
    }),
  failed: () =>
    buildProgressCard({
      ...baseProgress,
      completedTools,
      state: 'failed',
      failureDetail:
        'invalid model configuration\n错误类型：badRequest\n附加详情：model gpt-x is unavailable',
    }),
  reply: () =>
    buildStaticReplyCard(
      '已经把斜杠命令的分发路径修好了：\n\n- `/stop` 现在会真的中断\n- `/require_mention` 不再被 activation_mode 悄悄覆盖',
    ),
  'reply-aborted': () => buildStaticReplyCard('这段回复被中断了', 'aborted'),
  model: () =>
    buildModelConfigCard({
      locationLine: '主工作区 / 主会话',
      summaryLines: [
        '**Runner** Claude (claude)',
        '**Model** opus _(继承)_',
        '**Effort** 默认',
      ],
      fields: [
        {
          field: 'runner',
          label: 'Runner',
          placeholder: '选择 Runner',
          selected: 'claude',
          options: [
            { value: 'claude', label: 'Claude' },
            { value: 'codex', label: 'Codex ⚠️ 未认证' },
            { value: 'agy', label: 'Antigravity' },
          ],
          confirm: {
            title: '切换 Runner？',
            text: '会停止当前 runtime 并清空会话恢复状态，正在执行的 turn 会被中断。',
          },
        },
        {
          field: 'model',
          label: 'Model',
          placeholder: '选择模型',
          selected: MODEL_CARD_DEFAULT_VALUE,
          options: [
            { value: MODEL_CARD_DEFAULT_VALUE, label: '默认（opus）' },
            { value: 'haiku', label: 'Haiku (haiku)' },
            { value: 'sonnet', label: 'Sonnet (sonnet)' },
            { value: 'opus', label: 'Opus (opus)' },
          ],
        },
        {
          field: 'effort',
          label: 'Thinking Effort',
          placeholder: '选择推理强度',
          selected: MODEL_CARD_DEFAULT_VALUE,
          options: [
            { value: MODEL_CARD_DEFAULT_VALUE, label: '默认' },
            { value: 'low', label: 'low' },
            { value: 'medium', label: 'medium' },
            { value: 'high', label: 'high' },
          ],
        },
      ],
      actionValue: {
        action: 'model_config',
        jid: 'feishu:oc_demo',
        target: 'web:main',
        session: 'main:main',
      },
      note: '选择后立即生效，下一条消息使用新配置',
    }),
};

const name = process.argv[2];
if (!name || !samples[name]) {
  console.log('可用样例：');
  for (const key of Object.keys(samples)) console.log(`  ${key}`);
  console.log('\n用法: npx tsx scripts/preview-feishu-card.ts <样例名>');
  process.exit(name ? 1 : 0);
}

console.log(JSON.stringify(samples[name](), null, 2));
