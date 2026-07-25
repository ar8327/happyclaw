import { app } from 'electron';
import type { LoginItemSettings } from 'electron';

export interface LaunchAtLoginOptions {
  openAsHidden?: boolean;
}

export function isLaunchAtLoginEnabled(): boolean {
  try {
    const s = app.getLoginItemSettings();
    return !!s.openAtLogin;
  } catch {
    return false;
  }
}

export function setLaunchAtLogin(
  enabled: boolean,
  opts: LaunchAtLoginOptions = {},
): void {
  try {
    const args = {
      openAtLogin: enabled,
      openAsHidden: opts.openAsHidden ?? false,
    } satisfies Partial<LoginItemSettings>;
    app.setLoginItemSettings(args as LoginItemSettings);
  } catch (err) {
    console.warn('[desktop] setLaunchAtLogin failed:', err);
  }
}
