/**
 * Lightweight notification mechanism for IM messages.
 *
 * The message polling loop in index.ts sleeps for POLL_INTERVAL (1s) between
 * iterations.  When a Feishu / Telegram / QQ handler stores a new message it
 * calls `notifyNewImMessage()` which wakes the loop immediately so the message
 * is picked up without waiting for the remaining sleep time.
 *
 * Web messages are NOT routed through this notifier — they already bypass the
 * polling loop via direct IPC injection + `enqueueMessageCheck()`.
 */

let wakeup: (() => void) | null = null;
let pendingWakeup = false;

/**
 * Returns a Promise that resolves after `ms` milliseconds **or** as soon as
 * `notifyNewImMessage()` is called — whichever comes first.
 */
export function interruptibleSleep(ms: number): Promise<void> {
  if (pendingWakeup) {
    pendingWakeup = false;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      wakeup = null;
      resolve();
    }, ms);

    wakeup = () => {
      clearTimeout(timer);
      wakeup = null;
      pendingWakeup = false;
      resolve();
    };
  });
}

/**
 * Wake the message loop immediately. Safe to call at any time: a dirty bit
 * preserves notifications that arrive just before the loop begins sleeping.
 */
export function notifyNewImMessage(): void {
  pendingWakeup = true;
  wakeup?.();
}
