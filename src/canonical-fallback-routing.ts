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
