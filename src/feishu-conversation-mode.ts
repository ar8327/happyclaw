export type FeishuConversationMode = 'chat' | 'thread';

export interface FeishuThreadSource {
  id?: string | null;
  reply_to_id?: string | null;
  root_id?: string | null;
  thread_id?: string | null;
}

export interface FeishuThreadReplyOptions {
  replyToMsgId?: string;
  replyInThread?: boolean;
  threadRootMsgId?: string;
  threadId?: string;
  threadFallbackReason?: string;
}

export function isFeishuBotMentioned(
  mentions: Array<{ id?: { open_id?: string } }> | undefined,
  botOpenId: string,
): boolean {
  return botOpenId
    ? (mentions?.some((mention) => mention.id?.open_id === botOpenId) ?? false)
    : Boolean(mentions?.length);
}

function cleanId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function normalizeFeishuConversationMode(
  value: unknown,
): FeishuConversationMode {
  return value === 'thread' ? 'thread' : 'chat';
}

export function resolveFeishuThreadRootMsgId(
  source?: FeishuThreadSource | null,
): string | undefined {
  return (
    cleanId(source?.root_id) ||
    cleanId(source?.reply_to_id) ||
    cleanId(source?.id)
  );
}

export function hasFeishuThreadContext(
  source?: FeishuThreadSource | null,
): boolean {
  return !!cleanId(source?.thread_id);
}

export function applyFeishuConversationMode(
  mode: FeishuConversationMode | null | undefined,
  base: FeishuThreadReplyOptions = {},
  source?: FeishuThreadSource | null,
): FeishuThreadReplyOptions {
  const normalized = normalizeFeishuConversationMode(mode);
  const replyToMsgId = cleanId(base.replyToMsgId) || cleanId(source?.id);
  const threadRootMsgId =
    cleanId(base.threadRootMsgId) || resolveFeishuThreadRootMsgId(source);
  const threadId = cleanId(base.threadId) || cleanId(source?.thread_id);

  if (normalized !== 'thread') {
    return {
      ...base,
      ...(replyToMsgId ? { replyToMsgId } : {}),
      ...(threadRootMsgId ? { threadRootMsgId } : {}),
      ...(threadId ? { threadId } : {}),
    };
  }

  if (!replyToMsgId) {
    return {
      ...base,
      ...(threadRootMsgId ? { threadRootMsgId } : {}),
      ...(threadId ? { threadId } : {}),
      threadFallbackReason: 'missing_reply_target',
    };
  }

  return {
    ...base,
    replyToMsgId,
    replyInThread: true,
    threadRootMsgId: threadRootMsgId || replyToMsgId,
    ...(threadId ? { threadId } : {}),
  };
}

export function shouldReplyInFeishuThread(
  options?: Pick<FeishuThreadReplyOptions, 'replyInThread' | 'threadId'>,
): boolean {
  return options?.replyInThread === true || !!cleanId(options?.threadId);
}
