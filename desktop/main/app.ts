import {
  app,
  shell,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  Notification,
  nativeImage,
} from 'electron';
import path from 'node:path';
import fs from 'node:fs';

import { findFreePort, resolveRuntimePaths, RuntimePaths } from './paths.js';
import { startBackend, BackendHandle } from './backend.js';
import { WindowManager } from './window-manager.js';
import { TrayController } from './tray.js';
import { installGlobalShortcuts } from './shortcuts.js';
import { isLaunchAtLoginEnabled, setLaunchAtLogin } from './auto-launch.js';
import { registerUpdaterIpcHandlers } from './updater.js';

// ─────────────────────────────────────────────────────────────────────────────
// Globals
// ─────────────────────────────────────────────────────────────────────────────

let paths: RuntimePaths;
let backend: BackendHandle | null = null;
let windowMgr: WindowManager | null = null;
let trayCtrl: TrayController | null = null;
let uninstallShortcuts: (() => void) | null = null;
let shuttingDown = false;
let quitConfirmationOpen = false;

// ─────────────────────────────────────────────────────────────────────────────
// Single instance lock
// ─────────────────────────────────────────────────────────────────────────────

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // Second instance: quit immediately (primary instance will raise the window)
  shuttingDown = true;
  app.quit();
} else {
  app.on('second-instance', (_event, _cmdLine, _workingDir) => {
    if (windowMgr) windowMgr.showMain();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────────────────────────────────────

app
  .whenReady()
  .then(bootstrap)
  .catch((err) => {
    console.error('[desktop] bootstrap failed:', err);
    shuttingDown = true;
    app.quit();
  });

async function bootstrap(): Promise<void> {
  paths = resolveRuntimePaths();
  process.chdir(paths.projectRoot);

  applyDesktopIcon();
  app.dock?.show();

  // Enable macOS custom URL scheme: agentdock://...
  app.setAsDefaultProtocolClient('agentdock');

  // Find free port
  const port = process.env.WEB_PORT
    ? parseInt(process.env.WEB_PORT, 10)
    : await findFreePort(3000, 20);

  // ─── Start backend ─────────────────────────────────────────────────────
  console.log(
    `[desktop] starting backend on port=${port} projectRoot=${paths.projectRoot}`,
  );
  backend = await startBackend(paths, port, (line) => {
    if (paths.devMode) process.stdout.write(`[backend] ${line}\n`);
    // Track runtime state for tray
    if (/\[agentdock\]\s+queue_status/i.test(line)) {
      // TODO: parse JSON payload when backend emits structured queue status
    }
  });
  console.log(`[desktop] backend ready at ${backend.baseUrl}`);

  // ─── Window manager ────────────────────────────────────────────────────
  windowMgr = new WindowManager(backend.baseUrl);
  windowMgr.registerIpcHandlers();

  // Register drag-out handler
  ipcMain.on('drag:out', (evt, filePath: string) => {
    try {
      if (!fs.existsSync(filePath)) return;
      const wc = evt.sender;
      wc.startDrag({
        file: filePath,
        icon: path.join(paths.projectRoot, 'web/public/icons/logo-32.png'),
      });
    } catch (err) {
      console.warn('[desktop] drag-out failed:', err);
    }
  });

  // ─── IPC: App-level handlers not covered by WindowManager ─────────────
  ipcMain.handle('shell:revealLogs', () => shell.openPath(app.getPath('logs')));
  ipcMain.handle('app:getMeta', () => ({
    version: app.getVersion(),
    isPackaged: app.isPackaged,
    platform: process.platform,
    logsDir: app.getPath('logs'),
    userDataDir: app.getPath('userData'),
  }));
  ipcMain.handle('app:isLaunchAtLogin', () => isLaunchAtLoginEnabled());
  ipcMain.handle(
    'app:setLaunchAtLogin',
    (_e, enabled: boolean, openAsHidden?: boolean) =>
      setLaunchAtLogin(enabled, { openAsHidden }),
  );
  registerUpdaterIpcHandlers({ beforeInstall: prepareForUpdateInstall });

  // ─── Tray + shortcuts + main window ────────────────────────────────────
  trayCtrl = new TrayController(windowMgr, requestFullQuit);
  trayCtrl.install();
  installDockMenu();
  uninstallShortcuts = installGlobalShortcuts(windowMgr);

  // First-run: auto-launch at login on macOS (opt-in, only after first successful run)
  // (Do NOT enable by default — respect user choice; only expose the toggle in settings.)

  // Default: open main window. User can close it and work only from tray + float.
  await windowMgr.showMain();
}

async function prepareForUpdateInstall(): Promise<void> {
  shuttingDown = true;
  if (uninstallShortcuts) uninstallShortcuts();
  windowMgr?.closeAll(true);

  if (backend) {
    try {
      await backend.stop();
    } catch (err) {
      console.warn('[desktop] backend stop before update install failed:', err);
    }
    backend = null;
  }
}

function installDockMenu(): void {
  if (process.platform !== 'darwin' || !app.dock) return;

  const menu = Menu.buildFromTemplate([
    {
      label: '显示主窗口',
      click: () => {
        void windowMgr?.showMain();
      },
    },
    { type: 'separator' },
    {
      label: '退出 AgentDock…',
      click: () => {
        void requestFullQuit();
      },
    },
  ]);
  app.dock.setMenu(menu);
}

async function requestFullQuit(): Promise<void> {
  if (shuttingDown || quitConfirmationOpen) return;

  quitConfirmationOpen = true;
  try {
    const focusedWindow = BrowserWindow.getFocusedWindow();
    const parentWindow =
      focusedWindow && !focusedWindow.isDestroyed()
        ? focusedWindow
        : (windowMgr?.getMain() ?? undefined);
    const options = {
      type: 'warning' as const,
      buttons: ['退出 AgentDock', '取消'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      message: '退出 AgentDock？',
      detail: '将关闭所有桌面窗口，并停止本机后端进程。',
    };
    const result = parentWindow
      ? await dialog.showMessageBox(parentWindow, options)
      : await dialog.showMessageBox(options);
    if (result.response !== 0) return;

    await quitFully();
  } finally {
    quitConfirmationOpen = false;
  }
}

async function quitFully(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  if (uninstallShortcuts) uninstallShortcuts();
  windowMgr?.closeAll(true);

  if (backend) {
    try {
      await backend.stop();
    } catch (err) {
      console.warn('[desktop] backend stop error:', err);
    }
    backend = null;
  }

  app.quit();
}

function applyDesktopIcon(): void {
  if (process.platform !== 'darwin' || !app.dock) return;

  const iconPath = path.join(paths.projectRoot, 'desktop/build/icon.png');
  if (!fs.existsSync(iconPath)) return;

  const icon = nativeImage.createFromPath(iconPath);
  if (!icon.isEmpty()) {
    app.dock.setIcon(icon);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Shutdown
// ─────────────────────────────────────────────────────────────────────────────

app.on('before-quit', async (e) => {
  if (shuttingDown) return;
  e.preventDefault();
  void requestFullQuit();
});

app.on('window-all-closed', () => {
  // On macOS, keep app alive in the Dock. The close button only hides windows;
  // full shutdown must go through the confirmed quit path.
  if (process.platform !== 'darwin') {
    void requestFullQuit();
  }
});

app.on('activate', () => {
  if (!shuttingDown && windowMgr) void windowMgr.showMain();
});

// ─────────────────────────────────────────────────────────────────────────────
// macOS URL scheme (deep links)
// ─────────────────────────────────────────────────────────────────────────────

app.on('open-url', (_e, url) => {
  if (!windowMgr) return;
  try {
    const u = new URL(url);
    // agentdock://open/<relative path>
    if (u.protocol === 'agentdock:') {
      const host = u.host;
      const pathname = u.pathname || '';
      if (host === 'open') {
        void windowMgr.navigateMain(pathname || '/');
      } else if (host === 'float') {
        void windowMgr.showFloat(pathname);
      } else {
        void windowMgr.showMain();
      }
    }
  } catch (err) {
    console.warn('[desktop] open-url failed:', err, url);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Unhandled rejection guard (keeps app alive on isolated errors)
// ─────────────────────────────────────────────────────────────────────────────

process.on('unhandledRejection', (reason) => {
  console.error('[desktop] unhandledRejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[desktop] uncaughtException:', err);
});
