export interface DurableTextOutbound {
  sequence: number;
  messageId: string;
  chatJid: string;
  text: string;
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
  ): DurableTextOutbound | undefined {
    const records = this.textRecords.get(runtimeKey) || [];
    for (let index = records.length - 1; index >= 0; index--) {
      if (records[index].sequence > sequence) return records[index];
    }
    return undefined;
  }
}

/**
 * Per-turn view over the durable outbound counter.
 *
 * A provider tool event is not a runner-agnostic signal: only runners with a
 * structured event stream (claude, codex) emit `tool_use_start`, so agy/grok/
 * traex never set it. The counter above is advanced by host-accepted IPC
 * writes and therefore works for every runner — but a baseline taken once per
 * runtime cannot answer "did *this* turn reply?" for a long-lived process that
 * stays alive across many turns. Re-baselining on each consumed user message
 * can, which is what keeps an idle-timeout exit from replaying an old reply as
 * a silent-success fallback.
 */
export class TurnOutboundGate {
  private baseline: number;
  private toolSignal = false;

  constructor(
    private readonly tracker: DurableOutboundTracker,
    private readonly runtimeKey: string,
  ) {
    this.baseline = tracker.snapshot(runtimeKey);
  }

  /** A runner reported an outbound tool call (structured event streams only). */
  markToolSignal(): void {
    this.toolSignal = true;
  }

  /** The agent consumed a new user message and owes a fresh reply. */
  beginTurn(): void {
    this.toolSignal = false;
    this.baseline = this.tracker.snapshot(this.runtimeKey);
  }

  /** Whether anything user-visible went out since the current turn started. */
  sentThisTurn(): boolean {
    return (
      this.toolSignal || this.tracker.snapshot(this.runtimeKey) > this.baseline
    );
  }
}
