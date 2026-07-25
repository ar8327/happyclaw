import {
  contextBridge,
  ipcRenderer,
  shell,
  clipboard,
  nativeImage,
} from 'electron';
import path from 'node:path';

export interface AgentDockNativeAPI {
  // Window control
  toggleFloatWindow: () => Promise<void>;
  showMainWindow: () => Promise<void>;
  setAlwaysOnTop: (flag: boolean) => Promise<boolean>;

  // Shell / OS integration
  showInFolder: (filePath: string) => Promise<void>;
  openExternal: (url: string) => Promise<void>;
  chooseWorkspaceDir: () => Promise<string | null>;
  revealLogs: () => Promise<void>;

  // Clipboard — used by floating window to inject selection context into prompt
  getClipboardText: () => string;
  getClipboardFiles: () => { path: string; name: string; size: number }[];

  // Proxy & system
  getSystemProxy: () => Promise<string | null>;

  // App lifecycle & metadata
  getAppMeta: () => Promise<{
    version: string;
    isPackaged: boolean;
    platform: string;
    logsDir: string;
    userDataDir: string;
  }>;

  // Drag out — lets user drag a workspace file from the web UI to Finder
  startDragOut: (filePath: string) => Promise<boolean>;

  // Auto launch
  isLaunchAtLogin: () => Promise<boolean>;
  setLaunchAtLogin: (enabled: boolean, openAsHidden?: boolean) => Promise<void>;

  // Updates
  getUpdateState: () => Promise<DesktopUpdateState>;
  setUpdateFeedUrl: (url: string) => Promise<DesktopUpdateState>;
  clearUpdateFeedUrl: () => Promise<DesktopUpdateState>;
  checkForUpdates: () => Promise<DesktopUpdateState>;
  downloadUpdate: () => Promise<DesktopUpdateState>;
  installUpdate: () => Promise<DesktopUpdateState>;
  onUpdateStatus: (handler: (state: DesktopUpdateState) => void) => () => void;

  // Theme — renderer reports the resolved theme so the main process can
  // persist it and pre-paint the native window background on next launch,
  // preventing a black/white flash before React renders the first frame.
  reportTheme: (theme: 'light' | 'dark') => Promise<void>;
}

export interface DesktopUpdateState {
  currentVersion: string;
  isPackaged: boolean;
  source: { type: 'feed-url'; url: string } | null;
  phase:
    | 'idle'
    | 'checking'
    | 'available'
    | 'not-available'
    | 'downloading'
    | 'downloaded'
    | 'error';
  updateInfo: {
    version: string;
    releaseDate: string;
    releaseName?: string | null;
  } | null;
  progress: {
    total: number;
    delta: number;
    transferred: number;
    percent: number;
    bytesPerSecond: number;
  } | null;
  error: string | null;
}

const api: AgentDockNativeAPI = {
  // Window control
  toggleFloatWindow: () => ipcRenderer.invoke('window:toggle-float'),
  showMainWindow: () => ipcRenderer.invoke('window:open-main'),
  setAlwaysOnTop: (flag: boolean) =>
    ipcRenderer.invoke('window:alwaysOnTop', flag),

  // Shell / OS integration
  showInFolder: (filePath: string) =>
    ipcRenderer.invoke('shell:showInFolder', filePath),
  openExternal: async (url: string) => {
    if (/^https?:\/\//i.test(url)) {
      await shell.openExternal(url);
    }
  },
  chooseWorkspaceDir: () => ipcRenderer.invoke('dialog:chooseDir'),
  revealLogs: () => ipcRenderer.invoke('shell:revealLogs'),

  // Clipboard
  getClipboardText: () => clipboard.readText(),
  getClipboardFiles: () => {
    const files = clipboard.read('NSFilenamesPboardType');
    if (!files) return [];
    // NSFilenamesPboardType returns a newline-separated list of paths on macOS
    const paths = files.split('\n').filter(Boolean);
    const fs = require('node:fs') as typeof import('node:fs');
    return paths
      .map((p) => {
        try {
          const st = fs.statSync(p);
          if (!st.isFile()) return null;
          return { path: p, name: path.basename(p), size: st.size };
        } catch {
          return null;
        }
      })
      .filter(Boolean) as { path: string; name: string; size: number }[];
  },

  // Proxy & system
  getSystemProxy: () => ipcRenderer.invoke('system:getProxy'),

  // App meta
  getAppMeta: () => ipcRenderer.invoke('app:getMeta'),

  // Drag out
  startDragOut: async (filePath: string) => {
    const fs = require('node:fs') as typeof import('node:fs');
    try {
      if (!fs.existsSync(filePath)) return false;
      const icon = nativeImage.createFromPath(filePath);
      const iconToUse = icon.isEmpty() ? nativeImage.createEmpty() : icon;
      ipcRenderer.send('drag:out', filePath);
      // startDrag available from webContents — we invoke via ipc because the
      // preload doesn't have direct access. main side listens on 'drag:out'.
      return true;
    } catch {
      return false;
    }
  },

  // Auto launch
  isLaunchAtLogin: () => ipcRenderer.invoke('app:isLaunchAtLogin'),
  setLaunchAtLogin: (enabled, openAsHidden) =>
    ipcRenderer.invoke('app:setLaunchAtLogin', enabled, openAsHidden),

  // Updates
  getUpdateState: () => ipcRenderer.invoke('updates:getState'),
  setUpdateFeedUrl: (url) => ipcRenderer.invoke('updates:setFeedUrl', url),
  clearUpdateFeedUrl: () => ipcRenderer.invoke('updates:clearFeedUrl'),
  checkForUpdates: () => ipcRenderer.invoke('updates:check'),
  downloadUpdate: () => ipcRenderer.invoke('updates:download'),
  installUpdate: () => ipcRenderer.invoke('updates:install'),
  onUpdateStatus: (handler) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      state: DesktopUpdateState,
    ) => handler(state);
    ipcRenderer.on('updates:status', listener);
    return () => ipcRenderer.removeListener('updates:status', listener);
  },

  // Theme reporting
  reportTheme: (theme) => ipcRenderer.invoke('app:reportTheme', theme),
};

contextBridge.exposeInMainWorld('agentdockNative', api);

// Expose a small env flag so the web SPA can detect desktop mode immediately
contextBridge.exposeInMainWorld('__AGENTDOCK_DESKTOP__', true);
