import type { IMSendOptions } from './im-channel.js';

export interface FallbackInboundMessage {
  rowid: number;
  id: string;
  chat_jid: string;
  source_jid?: string;
  reply_to_id?: string;
  thread_id?: string;
  root_id?: string;
}

export interface CanonicalFallbackSource {
  messageId: string;
  sourceChannel: string;
  replyToId?: string;
  threadId?: string;
  rootId?: string;
}

export interface CanonicalFallbackRoute {
  sendToIM: boolean;
  imTargetJid?: string;
  imOptions?: IMSendOptions;
  sourceJid?: string;
  replyToId?: string;
  threadId?: string;
  rootId?: string;
}

export function selectLatestCanonicalFallbackSource(
  messages: FallbackInboundMessage[],
): CanonicalFallbackSource | undefined {
  const latest = messages.reduce<FallbackInboundMessage | undefined>(
    (selected, message) =>
      !selected || message.rowid > selected.rowid ? message : selected,
    undefined,
  );
  if (!latest) return undefined;

  return {
    messageId: latest.id,
    sourceChannel: latest.source_jid || latest.chat_jid,
    replyToId: latest.reply_to_id,
    threadId: latest.thread_id,
    rootId: latest.root_id,
  };
}

export function buildCanonicalFallbackRoute(params: {
  sourceChannel: string | null;
  sourceChannelType: string | null;
  imOptions?: IMSendOptions;
}): CanonicalFallbackRoute {
  const imTargetJid =
    params.sourceChannel && params.sourceChannelType
      ? params.sourceChannel
      : undefined;

  return {
    sendToIM: !!imTargetJid,
    imTargetJid,
    imOptions: imTargetJid ? params.imOptions : undefined,
    sourceJid: imTargetJid,
    replyToId: imTargetJid ? params.imOptions?.replyToMsgId : undefined,
    threadId: imTargetJid ? params.imOptions?.threadId : undefined,
    rootId: imTargetJid ? params.imOptions?.threadRootMsgId : undefined,
  };
}
