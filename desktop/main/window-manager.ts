import {
  app,
  BrowserWindow,
  nativeTheme,
  screen,
  shell,
  ipcMain,
  type BrowserWindowConstructorOptions,
} from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { resolveRuntimePaths } from './paths.js';

type WindowKind = 'main' | 'float';
type ThemeMode = 'light' | 'dark';

// Keep these in sync with web/src/styles/globals.css `--background` token.
// Mismatch causes a visible flash between the native window background and
// the first painted frame from React.
const BG_LIGHT = '#ffffff';
const BG_DARK = '#0f172a';

export class WindowManager {
  private mainWindow: BrowserWindow | null = null;
  private floatWindow: BrowserWindow | null = null;
  private allowWindowClose = false;
  private baseUrl: string;
  private preloadPath: string;
  private themeCachePath: string;
  private cachedTheme: ThemeMode;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
    // Compiled layout:
    //   dist/main/app.js
    //   dist/preload/index.js
    // So from dist/main/: go up one dir → dist/, then preload/index.js
    this.preloadPath = path.resolve(__dirname, '..', 'preload', 'index.js');

    this.themeCachePath = path.join(app.getPath('userData'), 'theme.json');
    this.cachedTheme = this.loadCachedTheme();

    // Re-paint native window background when the OS theme flips, so the
    // chrome edges don't briefly show stale colour during a redraw.
    nativeTheme.on('updated', () => {
      // Only follow the OS if the renderer hasn't pinned an explicit choice
      // (we treat the cached value as authoritative once set this session).
      const bg = this.currentBackgroundColor();
      for (const w of [this.mainWindow, this.floatWindow]) {
        if (w && !w.isDestroyed()) w.setBackgroundColor(bg);
      }
    });
  }

  private loadCachedTheme(): ThemeMode {
    try {
      const raw = fs.readFileSync(this.themeCachePath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed?.theme === 'light' || parsed?.theme === 'dark') {
        return parsed.theme;
      }
    } catch {
      /* first run or corrupt — fall back to system */
    }
    return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  }

  private saveCachedTheme(theme: ThemeMode): void {
    try {
      fs.writeFileSync(this.themeCachePath, JSON.stringify({ theme }), 'utf-8');
    } catch (err) {
      console.warn('[desktop] persist theme failed:', err);
    }
  }

  private currentBackgroundColor(): string {
    return this.cachedTheme === 'dark' ? BG_DARK : BG_LIGHT;
  }

  /** Called by the renderer once it has resolved the effective theme. */
  applyRendererTheme(theme: ThemeMode): void {
    if (theme !== 'light' && theme !== 'dark') return;
    if (theme === this.cachedTheme) return;
    this.cachedTheme = theme;
    this.saveCachedTheme(theme);
    const bg = this.currentBackgroundColor();
    for (const w of [this.mainWindow, this.floatWindow]) {
      if (w && !w.isDestroyed()) w.setBackgroundColor(bg);
    }
  }

  private commonWindowOptions(): BrowserWindowConstructorOptions {
    return {
      show: false,
      backgroundColor: this.currentBackgroundColor(),
      title: 'AgentDock',
      titleBarStyle: 'hiddenInset',
      autoHideMenuBar: true,
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        spellcheck: true,
      },
    };
  }

  getMain(): BrowserWindow | null {
    return this.mainWindow;
  }
  getFloat(): BrowserWindow | null {
    return this.floatWindow;
  }

  /**
   * Resolve when the window has rendered its first frame, so callers can
   * `show()` without exposing the empty `backgroundColor` flash that happens
   * if we show right after `loadURL` resolves (which fires on
   * `did-finish-load`, before React has painted).
   *
   * Must be called BEFORE `loadURL` to avoid missing an early
   * `ready-to-show` event (which is fire-and-forget).
   */
  private armReadyToShow(window: BrowserWindow): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      window.once('ready-to-show', done);
      window.webContents.once('did-fail-load', (_e, code, desc) => {
        console.warn('[desktop] did-fail-load:', code, desc);
        done();
      });
      // Safety: if ready-to-show never fires (e.g. blank URL), unblock after 5s
      setTimeout(done, 5000);
    });
  }

  private async clearDesktopWebCache(window: BrowserWindow): Promise<void> {
    try {
      await window.webContents.session.clearStorageData({
        storages: ['serviceworkers', 'cachestorage'],
      });
    } catch (err) {
      console.warn('[desktop] clear web cache failed:', err);
    }
  }

  async showMain(): Promise<BrowserWindow> {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.show();
      this.mainWindow.focus();
      return this.mainWindow;
    }

    const { workArea } = screen.getPrimaryDisplay();
    const w = Math.max(1100, Math.floor(workArea.width * 0.72));
    const h = Math.max(720, Math.floor(workArea.height * 0.78));

    this.mainWindow = new BrowserWindow({
      ...this.commonWindowOptions(),
      width: w,
      height: h,
      minWidth: 820,
      minHeight: 560,
      x: Math.floor(workArea.x + (workArea.width - w) / 2),
      y: Math.floor(workArea.y + (workArea.height - h) / 2),
    });

    this.mainWindow.on('close', (event) => {
      if (this.allowWindowClose) return;
      event.preventDefault();
      this.mainWindow?.hide();
    });
    this.mainWindow.on('closed', () => {
      this.mainWindow = null;
    });

    // Open new tabs / external links in default browser
    this.mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('http:') || url.startsWith('https:')) {
        shell.openExternal(url);
      }
      return { action: 'deny' };
    });

    // Session-independent cookie permissiveness for localhost SPA
    await this.mainWindow.webContents.session.webRequest.onHeadersReceived(
      (details, callback) => {
        const headers = { ...details.responseHeaders };
        // strip restrictive x-frame / cookie attributes for our embedded UI
        for (const k of Object.keys(headers)) {
          if (/^x-frame-options$/i.test(k)) delete headers[k];
          if (/^set-cookie$/i.test(k)) {
            headers[k] = (headers[k] || []).map((c) =>
              c.replace(/;\s*Secure\b/i, '').replace(/;\s*SameSite=[^;]+/i, ''),
            );
          }
        }
        callback({ responseHeaders: headers });
      },
    );

    await this.clearDesktopWebCache(this.mainWindow);
    const ready = this.armReadyToShow(this.mainWindow);
    this.mainWindow.loadURL(this.baseUrl).catch((err) => {
      console.warn('[desktop] main window loadURL failed:', err);
    });
    await ready;
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.show();
      this.mainWindow.focus();
    }
    return this.mainWindow;
  }

  async showFloat(sessionPath = '/'): Promise<BrowserWindow> {
    if (this.floatWindow && !this.floatWindow.isDestroyed()) {
      if (this.floatWindow.isVisible()) {
        this.floatWindow.hide();
        return this.floatWindow;
      }
      this.floatWindow.show();
      this.floatWindow.focus();
      return this.floatWindow;
    }

    const { workArea } = screen.getPrimaryDisplay();
    const w = Math.min(780, Math.floor(workArea.width * 0.55));
    const h = Math.min(560, Math.floor(workArea.height * 0.62));

    this.floatWindow = new BrowserWindow({
      ...this.commonWindowOptions(),
      width: w,
      height: h,
      minWidth: 520,
      minHeight: 380,
      frame: false,
      movable: true,
      resizable: true,
      hasShadow: true,
      transparent: false,
      alwaysOnTop: true,
      skipTaskbar: false,
      x: Math.floor(workArea.x + (workArea.width - w) / 2),
      y: Math.floor(workArea.y + workArea.height * 0.22),
      visualEffectState: 'active',
      vibrancy: 'under-window',
    });

    this.floatWindow.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
    });

    this.floatWindow.on('close', (event) => {
      if (this.allowWindowClose) return;
      event.preventDefault();
      this.floatWindow?.hide();
    });
    this.floatWindow.on('closed', () => {
      this.floatWindow = null;
    });
    this.floatWindow.on('blur', () => {
      // Soft auto-hide on blur; user can toggle via hotkey again
      if (this.floatWindow && !this.floatWindow.isDestroyed()) {
        this.floatWindow.hide();
      }
    });

    const target =
      sessionPath && sessionPath !== '/'
        ? `${this.baseUrl}${sessionPath.startsWith('/') ? '' : '/'}${sessionPath}`
        : this.baseUrl;
    await this.clearDesktopWebCache(this.floatWindow);
    const ready = this.armReadyToShow(this.floatWindow);
    this.floatWindow.loadURL(target).catch((err) => {
      console.warn('[desktop] float window loadURL failed:', err);
    });
    await ready;
    if (this.floatWindow && !this.floatWindow.isDestroyed()) {
      this.floatWindow.show();
      this.floatWindow.focus();
    }
    return this.floatWindow;
  }

  toggleFloat(): void {
    if (!this.floatWindow || this.floatWindow.isDestroyed()) {
      void this.showFloat();
      return;
    }
    if (this.floatWindow.isVisible()) this.floatWindow.hide();
    else {
      this.floatWindow.show();
      this.floatWindow.focus();
    }
  }

  /** Load an arbitrary path in the main window (deep link handler). */
  async navigateMain(urlPath: string): Promise<void> {
    const w = await this.showMain();
    const target = urlPath.startsWith('http')
      ? urlPath
      : `${this.baseUrl}${urlPath.startsWith('/') ? '' : '/'}${urlPath}`;
    await w.loadURL(target);
  }

  closeAll(force = false): void {
    if (force) this.allowWindowClose = true;
    for (const w of [this.mainWindow, this.floatWindow]) {
      if (w && !w.isDestroyed()) w.close();
    }
  }

  registerIpcHandlers(): void {
    ipcMain.handle('window:toggle-float', () => this.toggleFloat());
    ipcMain.handle('window:alwaysOnTop', (_e, flag: boolean) => {
      const w = BrowserWindow.getFocusedWindow();
      w?.setAlwaysOnTop(flag);
      return true;
    });
    ipcMain.handle('window:open-main', () => this.showMain());
    ipcMain.handle('shell:showInFolder', (_e, p: string) => {
      if (p) shell.showItemInFolder(p);
    });
    ipcMain.handle(
      'system:getProxy',
      () => process.env.HTTPS_PROXY || process.env.HTTP_PROXY || null,
    );
    ipcMain.handle('dialog:chooseDir', async () => {
      const { dialog } = await import('electron');
      const r = await dialog.showOpenDialog({
        properties: ['openDirectory', 'createDirectory'],
      });
      return r.canceled ? null : (r.filePaths[0] ?? null);
    });
    ipcMain.handle('app:reportTheme', (_e, theme: ThemeMode) => {
      this.applyRendererTheme(theme);
    });
  }
}
