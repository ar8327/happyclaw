import { SessionRuntimeQueue } from './session-runtime-queue.js';

export type SessionRuntimeStatus = ReturnType<SessionRuntimeQueue['getStatus']>;

/**
 * Thin session/runtime facade over the legacy queue implementation.
 *
 * The internal scheduler is still folder-serialized for compatibility,
 * but new call sites should use session/runtime terminology from here
 * instead of growing more `group/container` vocabulary.
 */
export class SessionRuntimeManager extends SessionRuntimeQueue {
  getRuntimeStatus(): SessionRuntimeStatus {
    return this.getStatus();
  }

  addOnRuntimeExitListener(fn: (sessionJid: string) => void): void {
    this.addOnContainerExitListener(fn);
  }

  closeAllActiveForRuntimeRefresh(): number {
    return this.closeAllActiveForCredentialRefresh();
  }

  async stopSession(
    sessionJid: string,
    options?: { force?: boolean },
  ): Promise<void> {
    await this.stopGroup(sessionJid, options);
  }

  async restartSession(sessionJid: string): Promise<void> {
    await this.restartGroup(sessionJid);
  }
}
