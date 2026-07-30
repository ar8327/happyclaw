export interface DurableTextOutbound {
  sequence: number;
  messageId: string;
  chatJid: string;
  text: string;
  turnId?: string;
  targetChannel?: string;
}

/**
 * Tracks host-accepted outbound tool calls for one runtime invocation.
 *
 * The counter is also used as the durable-reply signal. Text records let the
 * host reuse the explicit send_message Web copy as the canonical assistant
 * message instead of persisting the provider's final stdout a second time.
 */
export class DurableOutboundTracker {
  private readonly counts = new Map<string, number>();
  private readonly textRecords = new Map<string, DurableTextOutbound[]>();

  snapshot(runtimeKey: string): number {
    return this.counts.get(runtimeKey) ?? 0;
  }

  mark(
    runtimeKey: string,
    textRecord?: Omit<DurableTextOutbound, 'sequence'>,
  ): number {
    const sequence = this.snapshot(runtimeKey) + 1;
    this.counts.set(runtimeKey, sequence);
    if (textRecord) {
      const records = this.textRecords.get(runtimeKey) ?? [];
      records.push({ sequence, ...textRecord });
      this.textRecords.set(runtimeKey, records.slice(-32));
    }
    return sequence;
  }

  latestTextSince(
    runtimeKey: string,
    sequence: number,
    turnId?: string,
    targetChannel?: string,
  ): DurableTextOutbound | undefined {
    const records = this.textRecords.get(runtimeKey) || [];
    for (let index = records.length - 1; index >= 0; index--) {
      const record = records[index];
      const effectiveTarget = record.targetChannel || record.chatJid;
      if (
        record.sequence > sequence &&
        (!turnId || record.turnId === turnId) &&
        (!targetChannel || effectiveTarget === targetChannel)
      ) {
        return record;
      }
    }
    return undefined;
  }
}
