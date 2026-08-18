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
  buildProgressCard,
  buildStaticReplyCard,
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
};

const name = process.argv[2];
if (!name || !samples[name]) {
  console.log('可用样例：');
  for (const key of Object.keys(samples)) console.log(`  ${key}`);
  console.log('\n用法: npx tsx scripts/preview-feishu-card.ts <样例名>');
  process.exit(name ? 1 : 0);
}

console.log(JSON.stringify(samples[name](), null, 2));
