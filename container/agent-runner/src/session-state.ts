import fs from 'fs';

// PermissionMode 是字符串枚举，由各 provider 映射到自身概念
type PermissionMode = string;

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
  private providerState?: Record<string, unknown>;
  private lastMessageCursor: string | null = null;

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

  hydrate(snapshot?: {
    providerState?: Record<string, unknown>;
    recentImChannels?: string[];
    imChannelLastSeen?: Record<string, number>;
    currentPermissionMode?: string | null;
    lastMessageCursor?: string | null;
  }): void {
    if (!snapshot) return;
    if (
      snapshot.providerState
      && typeof snapshot.providerState === 'object'
      && !Array.isArray(snapshot.providerState)
    ) {
      this.providerState = { ...snapshot.providerState };
    }
    if (Array.isArray(snapshot.recentImChannels)) {
      for (const channel of snapshot.recentImChannels) {
        if (typeof channel !== 'string' || !channel) continue;
        this.recentImChannels.add(channel);
      }
    }
    if (snapshot.imChannelLastSeen) {
      for (const [channel, lastSeen] of Object.entries(snapshot.imChannelLastSeen)) {
        if (!channel || typeof lastSeen !== 'number' || !Number.isFinite(lastSeen)) {
          continue;
        }
        this.recentImChannels.add(channel);
        this.imChannelLastSeen.set(channel, lastSeen);
      }
    }
    if (typeof snapshot.currentPermissionMode === 'string' && snapshot.currentPermissionMode) {
      this.currentPermissionMode = snapshot.currentPermissionMode;
    }
    if ('lastMessageCursor' in snapshot) {
      this.lastMessageCursor =
        typeof snapshot.lastMessageCursor === 'string'
          ? snapshot.lastMessageCursor
          : null;
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

  applyRuntimeSnapshot(snapshot?: {
    providerState?: Record<string, unknown>;
    lastMessageCursor?: string | null;
  }): void {
    if (!snapshot) return;
    if (Object.prototype.hasOwnProperty.call(snapshot, 'providerState')) {
      if (
        snapshot.providerState
        && typeof snapshot.providerState === 'object'
        && !Array.isArray(snapshot.providerState)
      ) {
        this.providerState = { ...snapshot.providerState };
      } else {
        this.providerState = undefined;
      }
    }
    if (Object.prototype.hasOwnProperty.call(snapshot, 'lastMessageCursor')) {
      this.lastMessageCursor =
        typeof snapshot.lastMessageCursor === 'string'
          ? snapshot.lastMessageCursor
          : null;
    }
  }

  snapshot(overrides?: {
    providerSessionId?: string;
    resumeAnchor?: string;
    providerState?: Record<string, unknown>;
    lastMessageCursor?: string | null;
  }): {
    providerSessionId?: string;
    resumeAnchor?: string;
    providerState?: Record<string, unknown>;
    recentImChannels: string[];
    imChannelLastSeen: Record<string, number>;
    currentPermissionMode: string;
    lastMessageCursor?: string | null;
  } {
    const hasProviderStateOverride =
      overrides && Object.prototype.hasOwnProperty.call(overrides, 'providerState');
    const hasLastMessageCursorOverride =
      overrides && Object.prototype.hasOwnProperty.call(overrides, 'lastMessageCursor');
    return {
      providerSessionId: overrides?.providerSessionId,
      resumeAnchor: overrides?.resumeAnchor,
      providerState: hasProviderStateOverride
        ? overrides?.providerState
        : this.providerState,
      recentImChannels: [...this.recentImChannels],
      imChannelLastSeen: Object.fromEntries(this.imChannelLastSeen.entries()),
      currentPermissionMode: this.currentPermissionMode,
      lastMessageCursor: hasLastMessageCursorOverride
        ? overrides?.lastMessageCursor
        : this.lastMessageCursor,
    };
  }
}
