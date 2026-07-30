import type { IMSendOptions } from './im-channel.js';

export interface CanonicalFallbackRoute {
  sendToIM: boolean;
  imTargetJid?: string;
  imOptions?: IMSendOptions;
  sourceJid?: string;
  replyToId?: string;
  threadId?: string;
  rootId?: string;
}

export interface CanonicalOutboundRoute {
  chatJid: string;
  targetChannel?: string;
  threadId?: string;
}

export interface ConsumedInboundRoute {
  rowid: number;
  chatJid: string;
  sourceJid?: string | null;
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

/**
 * An explicit send_message can replace provider stdout only when it was
 * delivered back to the same source conversation. Messages sent as a side
 * effect to another IM target (or only persisted to Web) must not consume the
 * triggering conversation's canonical result.
 */
export function canReuseCanonicalOutbound(params: {
  chatJid: string;
  sourceChannel: string | null;
  sourceChannelType: string | null;
  imOptions?: IMSendOptions;
  outbound?: CanonicalOutboundRoute;
}): boolean {
  const { outbound } = params;
  if (!outbound || outbound.chatJid !== params.chatJid) return false;

  if (!params.sourceChannel || !params.sourceChannelType) {
    return outbound.targetChannel === undefined;
  }

  if (outbound.targetChannel !== params.sourceChannel) return false;

  const expectedThreadId = params.imOptions?.threadId;
  return outbound.threadId === expectedThreadId;
}

export function selectLatestConsumedSourceChannel(
  messages: ConsumedInboundRoute[],
  fallback: string | null,
): string | null {
  let latest: ConsumedInboundRoute | undefined;
  for (const message of messages) {
    if (!latest || message.rowid > latest.rowid) latest = message;
  }
  return latest ? latest.sourceJid || latest.chatJid : fallback;
}
