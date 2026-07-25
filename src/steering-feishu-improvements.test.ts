import assert from 'node:assert/strict';
import type * as lark from '@larksuiteoapi/node-sdk';
import {
  buildCardKitStreamingCard,
  buildProgressCard,
  buildStaticReplyCard,
  STREAMING_CONTENT_ELEMENT_ID,
} from './feishu-card-builder.js';
import { StreamingCardController } from './feishu-streaming-card.js';
import { interruptibleSleep, notifyNewImMessage } from './message-notifier.js';
import { extractMessageContent } from './feishu.js';

function testCardBuilders(): void {
  const reply = buildStaticReplyCard('# 这不是标题\n正文');
  assert.equal(reply.schema, '2.0');
  assert.equal(
    (reply.header as { title: { content: string } }).title.content,
    '回复',
  );
  assert.match(JSON.stringify(reply), /# 这不是标题/);

  const streaming = buildCardKitStreamingCard('hello');
  const streamingConfig = (
    streaming.config as {
      streaming_config: {
        print_frequency_ms: { default: number };
        print_step: { default: number };
      };
    }
  ).streaming_config;
  assert.equal(streaming.schema, '2.0');
  assert.ok(streamingConfig.print_frequency_ms.default > 0);
  assert.ok(streamingConfig.print_step.default > 0);
  const streamingElements = (
    streaming.body as { elements: Array<Record<string, unknown>> }
  ).elements;
  assert.equal(streamingElements.length, 1);
  assert.equal(streamingElements[0].element_id, STREAMING_CONTENT_ELEMENT_ID);

  const tools = Array.from({ length: 30 }, (_, index) => ({
    toolName: `tool-${index}`,
    duration: index * 100,
    inputSummary: `input-${index}`,
  }));
  const progress = buildProgressCard({
    title: '实现可靠投递',
    modelLabel: 'codex',
    activeTools: [{ toolName: 'active-tool', startTime: Date.now() - 1_000 }],
    completedTools: tools,
    isThinking: true,
    thinkingText: 'reasoning',
    elapsedMs: 4_000,
    state: 'active',
    activeSubAgents: [],
    completedSubAgents: [],
    stopActionId: 'stop-action',
  });
  const serialized = JSON.stringify(progress);
  assert.equal(progress.schema, '2.0');
  assert.match(serialized, /collapsible_panel/);
  assert.match(serialized, /column_set/);
  assert.match(serialized, /tool-0/);
  assert.match(serialized, /tool-29/);
  assert.match(serialized, /stop-action/);
  assert.doesNotMatch(serialized, /wide_screen_mode/);
}

function testFeishuMediaExtraction(): void {
  const media = extractMessageContent(
    'media',
    JSON.stringify({ file_key: 'video-key', file_name: 'demo.mp4' }),
  );
  assert.equal(media.text, '[视频: demo.mp4]');
  assert.deepEqual(media.fileInfos, [
    {
      fileKey: 'video-key',
      filename: 'demo.mp4',
      kind: 'video',
      placeholder: '[视频: demo.mp4]',
    },
  ]);

  const audio = extractMessageContent(
    'audio',
    JSON.stringify({ file_key: 'audio-key', duration: 2_400 }),
  );
  assert.equal(audio.text, '[语音消息: 2s]');
  assert.equal(audio.fileInfos?.[0].filename, 'voice_audio-key.opus');

  const post = extractMessageContent(
    'post',
    JSON.stringify({
      title: '混合消息',
      content: [
        [
          { tag: 'text', text: '附件：' },
          { tag: 'img', image_key: 'image-key' },
          {
            tag: 'media',
            file_key: 'post-video-key',
            file_name: 'post.mp4',
          },
        ],
      ],
    }),
  );
  assert.deepEqual(post.imageKeys, ['image-key']);
  assert.equal(post.fileInfos?.[0].fileKey, 'post-video-key');
  assert.match(post.text, /\[图片\].*\[视频: post\.mp4\]/);
}

async function testCardKitSequenceAndCumulativeContent(): Promise<void> {
  const sequences: number[] = [];
  const contentUpdates: string[] = [];
  let createdCard: Record<string, unknown> | undefined;
  let sentContent = '';

  const client = {
    cardkit: {
      v1: {
        card: {
          create: async (payload: { data: { data: string } }) => {
            createdCard = JSON.parse(payload.data.data);
            return { code: 0, data: { card_id: 'card-1' } };
          },
          settings: async (payload: {
            data: { sequence: number; settings: string };
          }) => {
            sequences.push(payload.data.sequence);
            assert.deepEqual(JSON.parse(payload.data.settings), {
              streaming_mode: false,
            });
            return { code: 0 };
          },
        },
        cardElement: {
          content: async (payload: {
            data: { sequence: number; content: string };
          }) => {
            sequences.push(payload.data.sequence);
            contentUpdates.push(payload.data.content);
            return { code: 0 };
          },
        },
      },
    },
    im: {
      message: {
        reply: async () => {
          throw new Error('unexpected reply');
        },
      },
      v1: {
        message: {
          create: async (payload: { data: { content: string } }) => {
            sentContent = payload.data.content;
            return { data: { message_id: 'message-1' } };
          },
          patch: async () => ({ code: 0 }),
        },
      },
    },
  } as unknown as lark.Client;

  const controller = new StreamingCardController({
    client,
    chatId: 'oc_test',
    idempotencyKey: 'delivery-id',
  });
  const externalId = await controller.complete('完整累计文本');
  assert.equal(externalId, 'message-1');
  assert.equal(createdCard?.schema, '2.0');
  assert.deepEqual(JSON.parse(sentContent), {
    type: 'card',
    data: { card_id: 'card-1' },
  });
  assert.deepEqual(contentUpdates, ['完整累计文本']);
  assert.deepEqual(sequences, [1, 2]);
}

async function testWakeupBeforeSleepIsNotLost(): Promise<void> {
  notifyNewImMessage();
  const startedAt = Date.now();
  await interruptibleSleep(2_000);
  assert.ok(Date.now() - startedAt < 100);
}

testCardBuilders();
testFeishuMediaExtraction();
await testCardKitSequenceAndCumulativeContent();
await testWakeupBeforeSleepIsNotLost();
console.log('steering and Feishu improvement tests passed');
