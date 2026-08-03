import { createHash } from 'node:crypto';

export interface FeishuTopicRouteContext {
  messageId?: string;
  parentId?: string;
  rootId?: string;
  threadId?: string;
}

function cleanId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function resolveFeishuTopicAnchor(
  context?: FeishuTopicRouteContext,
): string | null {
  // thread_id is the stable identifier shared by the initial topic event and
  // its replies. Older events may only expose root/parent/message IDs.
  return resolveFeishuTopicAnchorCandidates(context)[0] ?? null;
}

export function resolveFeishuTopicAnchorCandidates(
  context?: FeishuTopicRouteContext,
): string[] {
  return Array.from(
    new Set(
      [
        cleanId(context?.threadId),
        cleanId(context?.rootId),
        cleanId(context?.parentId),
        cleanId(context?.messageId),
      ].filter((value): value is string => Boolean(value)),
    ),
  );
}

export function stableFeishuTopicHash(
  baseChatJid: string,
  anchor: string,
): string {
  return createHash('sha1')
    .update(`${baseChatJid}\0${anchor}`)
    .digest('hex')
    .slice(0, 16);
}

export function buildFeishuTopicIdentity(
  baseChatJid: string,
  anchor: string,
): { hash: string; jid: string; folder: string } {
  const hash = stableFeishuTopicHash(baseChatJid, anchor);
  return {
    hash,
    jid: `web:feishu-topic-${hash}`,
    folder: `flow-feishu-topic-${hash}`,
  };
}
