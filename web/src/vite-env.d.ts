/// <reference types="vite/client" />

declare module '*.css' {
  const content: string;
  export default content;
}

interface Window {
  __HAPPYCLAW_HASH_ROUTER__?: boolean;
  __AGENTDOCK_DESKTOP__?: boolean;
  agentdockNative?: {
    reportTheme?: (theme: 'light' | 'dark') => Promise<void>;
    getUpdateState?: () => Promise<DesktopUpdateState>;
    setUpdateFeedUrl?: (url: string) => Promise<DesktopUpdateState>;
    clearUpdateFeedUrl?: () => Promise<DesktopUpdateState>;
    checkForUpdates?: () => Promise<DesktopUpdateState>;
    downloadUpdate?: () => Promise<DesktopUpdateState>;
    installUpdate?: () => Promise<DesktopUpdateState>;
    onUpdateStatus?: (
      handler: (state: DesktopUpdateState) => void,
    ) => () => void;
  };
}

interface DesktopUpdateState {
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
