import { app, globalShortcut } from 'electron';
import type { WindowManager } from './window-manager.js';

/**
 * Global hotkeys.
 *
 * Cmd+Shift+Space  → Toggle floating chat window (Codex-style)
 * Cmd+Shift+O      → Show main window
 */
export function installGlobalShortcuts(windowMgr: WindowManager): () => void {
  const registered: { accelerator: string; ok: boolean }[] = [];

  const tryRegister = (accelerator: string, action: () => void) => {
    try {
      const ok = globalShortcut.register(accelerator, action);
      registered.push({ accelerator, ok });
      if (!ok) {
        console.warn(
          `[desktop] Failed to register global shortcut: ${accelerator}`,
        );
      }
    } catch (err) {
      console.warn(`[desktop] Error registering ${accelerator}:`, err);
      registered.push({ accelerator, ok: false });
    }
  };

  // macOS-only modifiers: Cmd+Shift+Space
  const floatAccel =
    process.platform === 'darwin'
      ? 'Command+Shift+Space'
      : 'Control+Shift+Space';

  tryRegister(floatAccel, () => windowMgr.toggleFloat());
  tryRegister('CommandOrControl+Shift+O', () => windowMgr.showMain());

  const teardown = () => {
    for (const { accelerator, ok } of registered) {
      if (ok) {
        try {
          globalShortcut.unregister(accelerator);
        } catch {
          /* ignore */
        }
      }
    }
  };

  app.on('will-quit', teardown);
  return teardown;
}
