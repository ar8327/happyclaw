import fs from 'fs';
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';

/** Channels not seen for 24 hours are considered stale */
const IM_CHANNEL_TTL_MS = 24 * 60 * 60 * 1000;
const INTERRUPT_GRACE_WINDOW_MS = 10_000;

/**
 * Explicit session state — replaces 5 module-level variables that were
 * previously scattered across index.ts and accessed via closures.
 */
export class SessionState {
  // --- IM channel tracking ---
  recentImChannels = new Set<string>();
  imChannelLastSeen = new Map<string, number>();
  private imPersistTimer: ReturnType<typeof setTimeout> | null = null;

  /** Load persisted IM channels from disk (with TTL filtering) */
  loadImChannels(channelsFile: string): void {
    try {
      if (!fs.existsSync(channelsFile)) return;
      const data = JSON.parse(fs.readFileSync(channelsFile, 'utf-8'));
      const now = Date.now();
      let pruned = false;
      if (Array.isArray(data)) {
        for (const entry of data) {
          // Support both old format (plain string) and new format ({ channel, lastSeen })
          const channel = typeof entry === 'string' ? entry : entry?.channel;
          const lastSeen = typeof entry === 'string' ? now : (entry?.lastSeen ?? now);
          if (typeof channel !== 'string') continue;
          if (now - lastSeen > IM_CHANNEL_TTL_MS) {
            pruned = true;
            continue; // expired, skip
          }
          this.recentImChannels.add(channel);
          this.imChannelLastSeen.set(channel, lastSeen);
        }
      }
      if (pruned) this.persistImChannels(channelsFile);
    } catch {
      // Ignore corrupt file
    }
  }

  /** Persist IM channels to disk */
  persistImChannels(channelsFile: string): void {
    try {
      const entries = [...this.recentImChannels].map((ch) => ({
        channel: ch,
        lastSeen: this.imChannelLastSeen.get(ch) ?? Date.now(),
      }));
      fs.writeFileSync(channelsFile, JSON.stringify(entries));
    } catch {
      // Best effort
    }
  }

  /** Debounced persist: coalesces rapid updates into one write per 5s window */
  schedulePersistImChannels(channelsFile: string): void {
    if (this.imPersistTimer) return;
    this.imPersistTimer = setTimeout(() => {
      this.imPersistTimer = null;
      this.persistImChannels(channelsFile);
    }, 5000);
  }

  /** Extract source channels from text and update lastSeen */
  extractSourceChannels(text: string, channelsFile: string): void {
    const matches = text.matchAll(/source="([^"]+)"/g);
    let anyUpdate = false;
    for (const m of matches) {
      const source = m[1];
      if (!source.startsWith('web:')) {
        this.recentImChannels.add(source);
        this.imChannelLastSeen.set(source, Date.now());
        anyUpdate = true;
      }
    }
    // Persist on every update (new or existing channel) to keep lastSeen fresh on disk
    if (anyUpdate) this.schedulePersistImChannels(channelsFile);
  }

  /** Return active IM channels (filtered by 24h TTL) */
  getActiveImChannels(): string[] {
    const now = Date.now();
    return [...this.recentImChannels].filter(
      (ch) => now - (this.imChannelLastSeen.get(ch) ?? 0) <= IM_CHANNEL_TTL_MS,
    );
  }

  // --- Permission mode ---
  currentPermissionMode: PermissionMode = 'bypassPermissions';

  // --- Interrupt tracking ---
  lastInterruptRequestedAt = 0;

  markInterruptRequested(): void {
    this.lastInterruptRequestedAt = Date.now();
  }

  clearInterruptRequested(): void {
    this.lastInterruptRequestedAt = 0;
  }

  isWithinInterruptGraceWindow(): boolean {
    return this.lastInterruptRequestedAt > 0 && Date.now() - this.lastInterruptRequestedAt <= INTERRUPT_GRACE_WINDOW_MS;
  }
}
