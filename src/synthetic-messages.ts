/**
 * Host-injected synthetic messages.
 *
 * Scheduled task triggers, system notices and restart recovery control blocks
 * are written into the same `messages` table as real inbound IM messages so the
 * regular polling loop picks them up. Their ids are host-generated
 * (`task-...`, a UUID, `recovery:...`) and are NOT valid IM message ids.
 *
 * Using one as a Feishu reply anchor makes `im.message.reply` fail with an
 * invalid message_id, and the plain-text fallback replies too — so the whole
 * delivery is lost. Reply anchors must therefore only ever come from real
 * inbound messages.
 */

export const SYNTHETIC_SENDERS = ['__task__', '__system__'] as const;

export function isSyntheticSender(sender: string | null | undefined): boolean {
  return !!sender && (SYNTHETIC_SENDERS as readonly string[]).includes(sender);
}

/** True for any host-injected message that must not become a reply anchor. */
export function isSyntheticMessage(message: {
  id?: string | null;
  sender?: string | null;
}): boolean {
  return (
    isSyntheticSender(message.sender) ||
    Boolean(message.id?.startsWith('recovery:'))
  );
}
