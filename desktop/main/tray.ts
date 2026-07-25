import { app, Tray, Menu, nativeImage, type BrowserWindow } from 'electron';
import path from 'node:path';
import type { WindowManager } from './window-manager.js';

export interface TrayState {
  activeSessions: number;
  queuedSessions: number;
}

/**
 * macOS menu bar tray controller.
 *
 * Provides quick access to windows, workspace list, settings, and app quit.
 * Icon changes colour to indicate active sessions.
 */
export class TrayController {
  private tray: Tray | null = null;
  private state: TrayState = { activeSessions: 0, queuedSessions: 0 };

  constructor(
    private windowMgr: WindowManager,
    private requestQuit: () => void | Promise<void>,
  ) {}

  buildIcon(state: TrayState): Electron.NativeImage {
    // Simple 18x18 template image so macOS renders it correctly in both dark/light.
    // In a real build we'd ship build/iconTemplate.png / iconActiveTemplate.png.
    const isActive = state.activeSessions > 0;
    const iconName = isActive
      ? 'icon-active-Template.png'
      : 'icon-Template.png';
    const candidate = path.resolve(__dirname, '..', '..', 'build', iconName);
    try {
      const fs = require('node:fs') as typeof import('node:fs');
      if (fs.existsSync(candidate)) {
        const img = nativeImage.createFromPath(candidate);
        img.setTemplateImage(true);
        return img;
      }
    } catch {
      /* ignore */
    }
    const appIcon = path.resolve(__dirname, '..', '..', 'build', 'icon.png');
    const fallbackIcon = nativeImage.createFromPath(appIcon);
    if (fallbackIcon.isEmpty()) {
      return nativeImage.createEmpty();
    }
    return fallbackIcon.resize({ width: 18, height: 18 });
  }

  install(): void {
    this.tray = new Tray(this.buildIcon(this.state));
    this.tray.setToolTip(`AgentDock — ${this.state.activeSessions} active`);
    this.refresh();

    this.tray.on('click', (_event, bounds) => {
      // Primary click: toggle floating window (Codex-style)
      this.windowMgr.toggleFloat();
    });
    this.tray.on('right-click', () => this.refresh());
  }

  setState(next: Partial<TrayState>): void {
    this.state = { ...this.state, ...next };
    if (this.tray) {
      this.tray.setImage(this.buildIcon(this.state));
      this.tray.setToolTip(
        `AgentDock — ${this.state.activeSessions} active · ${this.state.queuedSessions} queued`,
      );
    }
    this.refresh();
  }

  refresh(): void {
    if (!this.tray) return;

    const statusLine =
      this.state.activeSessions > 0
        ? `🟢 运行中（${this.state.activeSessions} 活跃 / ${this.state.queuedSessions} 排队）`
        : '⚪ 空闲';

    const menu = Menu.buildFromTemplate([
      { label: 'AgentDock', enabled: false },
      { label: statusLine, enabled: false },
      { type: 'separator' },
      {
        label: '显示主窗口',
        accelerator: 'CmdOrCtrl+Shift+O',
        click: () => this.windowMgr.showMain(),
      },
      {
        label: '浮动对话（全局 Cmd+Shift+Space）',
        accelerator: 'CmdOrCtrl+Shift+Space',
        click: () => this.windowMgr.toggleFloat(),
      },
      { type: 'separator' },
      {
        label: '打开日志目录',
        click: () => {
          const { shell } = require('electron');
          shell.openPath(app.getPath('logs'));
        },
      },
      {
        label: '偏好设置…',
        accelerator: 'CmdOrCtrl+,',
        click: () => this.windowMgr.navigateMain('/settings'),
      },
      { type: 'separator' },
      {
        label: '退出 AgentDock…',
        accelerator: 'CmdOrCtrl+Q',
        click: () => {
          void this.requestQuit();
        },
      },
    ]);
    this.tray.setContextMenu(menu);
  }
}
