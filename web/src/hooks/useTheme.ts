import { useCallback, useEffect, useSyncExternalStore } from 'react';

import { DEFAULT_SKIN, getSkin, isValidSkin, type ThemeMode } from '@/lib/themes';

export type Theme = ThemeMode;

/** 沿用旧 key，老用户的明暗偏好不会丢 */
const MODE_KEY = 'happyclaw-theme';
const SKIN_KEY = 'happyclaw-skin';

const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((cb) => cb());
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSystemMode(): 'light' | 'dark' {
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function readMode(): ThemeMode {
  if (typeof window === 'undefined') return 'system';
  const stored = window.localStorage.getItem(MODE_KEY);
  if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  return 'system'; // 默认跟随系统
}

export function readSkin(): string {
  if (typeof window === 'undefined') return DEFAULT_SKIN;
  const stored = window.localStorage.getItem(SKIN_KEY);
  return isValidSkin(stored) ? stored : DEFAULT_SKIN;
}

export function resolveMode(mode: ThemeMode): 'light' | 'dark' {
  return mode === 'system' ? getSystemMode() : mode;
}

/**
 * 同步 <meta name="theme-color">，让移动端浏览器 / PWA 状态栏跟随皮肤。
 * 直接从计算样式里取实际生效的 --background，皮肤无需重复声明。
 */
function syncMetaThemeColor() {
  if (typeof document === 'undefined') return;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) return;
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--background').trim();
  if (bg) meta.setAttribute('content', bg);
}

export function applyTheme(mode: ThemeMode, skin: string) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.classList.toggle('dark', resolveMode(mode) === 'dark');
  root.dataset.skin = isValidSkin(skin) ? skin : DEFAULT_SKIN;
  syncMetaThemeColor();
}

/** 切换瞬间加一层短过渡，避免生硬跳变 */
let switchTimer: ReturnType<typeof setTimeout> | undefined;
function withTransition(fn: () => void) {
  if (typeof document === 'undefined') {
    fn();
    return;
  }
  const root = document.documentElement;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced) {
    fn();
    return;
  }
  root.classList.add('theme-switching');
  fn();
  clearTimeout(switchTimer);
  switchTimer = setTimeout(() => root.classList.remove('theme-switching'), 240);
}

export function useTheme() {
  const mode = useSyncExternalStore(
    subscribe,
    readMode,
    () => 'system' as ThemeMode,
  );
  const skin = useSyncExternalStore(subscribe, readSkin, () => DEFAULT_SKIN);

  // 首次挂载与偏好变化时应用
  useEffect(() => {
    applyTheme(mode, skin);
  }, [mode, skin]);

  // 仅在 mode === 'system' 时跟随系统明暗变化
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => {
      if (readMode() === 'system') {
        applyTheme('system', readSkin());
        emit();
      }
    };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  const setMode = useCallback((next: ThemeMode) => {
    if (typeof window !== 'undefined') {
      if (next === 'system') {
        window.localStorage.removeItem(MODE_KEY); // 无存储 = 跟随系统
      } else {
        window.localStorage.setItem(MODE_KEY, next);
      }
    }
    withTransition(() => applyTheme(next, readSkin()));
    emit();
  }, []);

  const setSkin = useCallback((next: string) => {
    const id = isValidSkin(next) ? next : DEFAULT_SKIN;
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(SKIN_KEY, id);
    }
    withTransition(() => applyTheme(readMode(), id));
    emit();
  }, []);

  // 循环：亮 → 暗 → 跟随系统 → 亮
  const toggle = useCallback(() => {
    setMode(mode === 'light' ? 'dark' : mode === 'dark' ? 'system' : 'light');
  }, [mode, setMode]);

  return {
    mode,
    resolvedMode: resolveMode(mode),
    skin,
    skinDef: getSkin(skin),
    setMode,
    setSkin,
    toggle,

    /** @deprecated 用 mode / setMode，保留是为了兼容既有调用点 */
    theme: mode,
    /** @deprecated 用 resolvedMode */
    resolvedTheme: resolveMode(mode),
    /** @deprecated 用 setMode */
    setTheme: setMode,
  };
}
