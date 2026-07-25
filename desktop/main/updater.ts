import { app, BrowserWindow, ipcMain } from 'electron';
import { autoUpdater, type UpdateDownloadedEvent } from 'electron-updater';
import type { ProgressInfo, UpdateInfo } from 'builder-util-runtime';
import fs from 'node:fs';
import path from 'node:path';

type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error';

interface UpdateSource {
  type: 'feed-url';
  url: string;
}

interface UpdateState {
  currentVersion: string;
  isPackaged: boolean;
  source: UpdateSource | null;
  phase: UpdatePhase;
  updateInfo: Pick<
    UpdateInfo,
    'version' | 'releaseDate' | 'releaseName'
  > | null;
  progress: ProgressInfo | null;
  error: string | null;
}

interface StoredUpdateConfig {
  source?: UpdateSource | null;
}

interface RegisterUpdaterOptions {
  beforeInstall?: () => Promise<void>;
}

const CONFIG_FILE = 'desktop-update-source.json';
const STATUS_CHANNEL = 'updates:status';

let source: UpdateSource | null = null;
let phase: UpdatePhase = 'idle';
let updateInfo: UpdateState['updateInfo'] = null;
let progress: ProgressInfo | null = null;
let error: string | null = null;
let initialized = false;
let beforeInstall: (() => Promise<void>) | undefined;

function configPath(): string {
  return path.join(app.getPath('userData'), CONFIG_FILE);
}

function state(): UpdateState {
  return {
    currentVersion: app.getVersion(),
    isPackaged: app.isPackaged,
    source,
    phase,
    updateInfo,
    progress,
    error,
  };
}

function serializeUpdateInfo(
  info: UpdateInfo | UpdateDownloadedEvent,
): UpdateState['updateInfo'] {
  return {
    version: info.version,
    releaseDate: info.releaseDate,
    releaseName: info.releaseName ?? null,
  };
}

function setState(next: Partial<UpdateState>): UpdateState {
  if (next.phase) phase = next.phase;
  if ('source' in next) source = next.source ?? null;
  if ('updateInfo' in next) updateInfo = next.updateInfo ?? null;
  if ('progress' in next) progress = next.progress ?? null;
  if ('error' in next) error = next.error ?? null;

  const snapshot = state();
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(STATUS_CHANNEL, snapshot);
  }
  return snapshot;
}

function loadConfig(): StoredUpdateConfig {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    const parsed = JSON.parse(raw) as StoredUpdateConfig;
    if (parsed.source?.type !== 'feed-url' || !parsed.source.url) return {};
    return parsed;
  } catch {
    return {};
  }
}

function saveConfig(config: StoredUpdateConfig): void {
  const target = configPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(config, null, 2)}\n`);
}

function normalizeFeedUrl(input: string): string {
  const value = input.trim();
  if (!value) throw new Error('请输入更新源 URL');

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('更新源 URL 格式不正确');
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('更新源仅支持 http 或 https');
  }
  if (parsed.username || parsed.password) {
    throw new Error('更新源 URL 不能包含用户名或密码');
  }
  if (parsed.hash) parsed.hash = '';

  const lastSegment = parsed.pathname.split('/').filter(Boolean).pop() || '';
  if (/^latest(?:-[0-9A-Za-z-]+)?\.ya?ml$/i.test(lastSegment)) {
    parsed.pathname = parsed.pathname.slice(0, -lastSegment.length);
  }

  if (!parsed.pathname.endsWith('/')) parsed.pathname += '/';
  return parsed.toString();
}

function applySource(nextSource: UpdateSource | null): void {
  source = nextSource;
  if (!source) return;

  autoUpdater.setFeedURL({
    provider: 'generic',
    url: source.url,
  });
}

function ensureConfigured(): UpdateSource {
  if (!source) throw new Error('请先配置更新源 URL');
  return source;
}

function ensurePackaged(): void {
  if (!app.isPackaged && process.env.AGENTDOCK_ALLOW_DEV_UPDATE_CHECK !== '1') {
    throw new Error('当前是开发模式，打包后的应用才能检查更新');
  }
}

function wireUpdaterEvents(): void {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.logger = {
    info: (...args: unknown[]) => console.log('[desktop:update]', ...args),
    warn: (...args: unknown[]) => console.warn('[desktop:update]', ...args),
    error: (...args: unknown[]) => console.error('[desktop:update]', ...args),
  };

  autoUpdater.on('checking-for-update', () => {
    setState({ phase: 'checking', progress: null, error: null });
  });
  autoUpdater.on('update-available', (info) => {
    setState({
      phase: 'available',
      updateInfo: serializeUpdateInfo(info),
      progress: null,
      error: null,
    });
  });
  autoUpdater.on('update-not-available', (info) => {
    setState({
      phase: 'not-available',
      updateInfo: serializeUpdateInfo(info),
      progress: null,
      error: null,
    });
  });
  autoUpdater.on('download-progress', (info) => {
    setState({ phase: 'downloading', progress: info, error: null });
  });
  autoUpdater.on('update-downloaded', (event) => {
    setState({
      phase: 'downloaded',
      updateInfo: serializeUpdateInfo(event),
      progress: null,
      error: null,
    });
  });
  autoUpdater.on('error', (err) => {
    setState({ phase: 'error', error: err.message || String(err) });
  });
}

export function registerUpdaterIpcHandlers(
  options: RegisterUpdaterOptions = {},
): void {
  beforeInstall = options.beforeInstall;
  if (!initialized) {
    initialized = true;
    wireUpdaterEvents();
    const stored = loadConfig();
    if (stored.source) applySource(stored.source);
  }

  ipcMain.handle('updates:getState', () => state());

  ipcMain.handle('updates:setFeedUrl', (_event, rawUrl: string) => {
    const url = normalizeFeedUrl(String(rawUrl || ''));
    const nextSource: UpdateSource = { type: 'feed-url', url };
    applySource(nextSource);
    saveConfig({ source: nextSource });
    return setState({
      source: nextSource,
      phase: 'idle',
      updateInfo: null,
      progress: null,
      error: null,
    });
  });

  ipcMain.handle('updates:clearFeedUrl', () => {
    applySource(null);
    saveConfig({ source: null });
    return setState({
      source: null,
      phase: 'idle',
      updateInfo: null,
      progress: null,
      error: null,
    });
  });

  ipcMain.handle('updates:check', async () => {
    ensureConfigured();
    ensurePackaged();
    await autoUpdater.checkForUpdates();
    return state();
  });

  ipcMain.handle('updates:download', async () => {
    ensureConfigured();
    ensurePackaged();
    setState({ phase: 'downloading', progress: null, error: null });
    await autoUpdater.downloadUpdate();
    return state();
  });

  ipcMain.handle('updates:install', async () => {
    if (phase !== 'downloaded') {
      throw new Error('更新尚未下载完成');
    }
    if (beforeInstall) await beforeInstall();
    autoUpdater.quitAndInstall(false, true);
    return state();
  });
}
