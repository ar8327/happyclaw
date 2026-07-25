import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { EyeOff, Trash2 } from 'lucide-react';
import '@xterm/xterm/css/xterm.css';
import { wsManager } from '../../api/ws';
import { resolveStoreJid, useChatStore } from '../../stores/chat';
import { resolveCssColors } from '@/lib/theme-colors';
import { useTheme } from '../../hooks/useTheme';

type ConnectionState = 'idle' | 'connecting' | 'connected' | 'disconnected';

const TERMINAL_COLOR_VARS = [
  '--card',
  '--foreground',
  '--primary',
  '--accent',
  '--muted-foreground',
  '--border-strong',
  '--error',
  '--success',
  '--warning',
  '--info',
  '--tag-purple-fg',
  '--tag-cyan-fg',
] as const;

/** 让 xterm 跟随当前皮肤，而不是固定一套 Tokyo Night 配色 */
function buildTerminalTheme() {
  const c = resolveCssColors(TERMINAL_COLOR_VARS);
  return {
    background: c['--card'],
    foreground: c['--foreground'],
    cursor: c['--primary'],
    selectionBackground: c['--accent'],
    black: c['--border-strong'],
    red: c['--error'],
    green: c['--success'],
    yellow: c['--warning'],
    blue: c['--info'],
    magenta: c['--tag-purple-fg'],
    cyan: c['--tag-cyan-fg'],
    white: c['--muted-foreground'],
    brightBlack: c['--muted-foreground'],
    brightRed: c['--error'],
    brightGreen: c['--success'],
    brightYellow: c['--warning'],
    brightBlue: c['--info'],
    brightMagenta: c['--tag-purple-fg'],
    brightCyan: c['--tag-cyan-fg'],
    brightWhite: c['--foreground'],
  };
}

interface TerminalPanelProps {
  sessionId: string;
  visible: boolean;
  onHide?: () => void;
  onDelete?: () => void;
}

export function TerminalPanel({
  sessionId,
  visible,
  onHide,
  onDelete,
}: TerminalPanelProps) {
  const termRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const visibleRef = useRef<boolean>(visible);
  const [connState, setConnState] = useState<ConnectionState>('idle');
  const connStateRef = useRef<ConnectionState>('idle');
  const { resolvedMode, skin } = useTheme();
  const syncConnState = (state: ConnectionState) => {
    connStateRef.current = state;
    setConnState(state);
  };

  useEffect(() => {
    visibleRef.current = visible;
    if (!visible) return;
    // Delay fit until after the CSS height transition (200ms) completes,
    // otherwise FitAddon computes 0x0 dimensions during the animation.
    const timer = setTimeout(() => {
      if (!fitAddonRef.current || !xtermRef.current) return;
      fitAddonRef.current.fit();
      xtermRef.current.focus();
      if (connStateRef.current === 'connected') {
        const { cols, rows } = xtermRef.current;
        wsManager.send({ type: 'terminal_resize', chatJid: sessionId, cols, rows });
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [visible, sessionId]);

  // 切换明暗或皮肤时刷新终端配色。CSS 变量切换有 220ms 过渡，
  // 延迟一帧再取值，避免读到过渡中间态的颜色。
  useEffect(() => {
    if (!xtermRef.current) return;
    const timer = setTimeout(() => {
      if (xtermRef.current) xtermRef.current.options.theme = buildTerminalTheme();
    }, 260);
    return () => clearTimeout(timer);
  }, [resolvedMode, skin]);

  useEffect(() => {
    if (!termRef.current) return;

    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      lineHeight: 1.15,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
      scrollback: 5000,
      convertEol: true,
      theme: buildTerminalTheme(),
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(webLinksAddon);
    terminal.open(termRef.current);

    xtermRef.current = terminal;
    fitAddonRef.current = fitAddon;

    // Fit terminal to container — delay to ensure DOM layout is stable
    setTimeout(() => {
      fitAddon.fit();
    }, 100);

    const sendStartTerminal = () => {
      const cols = terminal.cols;
      const rows = terminal.rows;
      wsManager.send({ type: 'terminal_start', chatJid: sessionId, cols, rows });
    };

    const requestStartTerminal = () => {
      syncConnState('connecting');
      if (wsManager.isConnected()) {
        sendStartTerminal();
      } else {
        wsManager.connect();
      }
    };

    // 监听 WebSocket 消息
    const unsubOutput = wsManager.on('terminal_output', (data: any) => {
      if (resolveStoreJid(useChatStore.getState().groups, data.chatJid) === sessionId) {
        terminal.write(data.data);
      }
    });

    const unsubStarted = wsManager.on('terminal_started', (data: any) => {
      if (resolveStoreJid(useChatStore.getState().groups, data.chatJid) === sessionId) {
        syncConnState('connected');
      }
    });

    const unsubStopped = wsManager.on('terminal_stopped', (data: any) => {
      if (resolveStoreJid(useChatStore.getState().groups, data.chatJid) === sessionId) {
        syncConnState('disconnected');
        terminal.write(`\r\n\x1b[33m[${data.reason || '终端已断开'}]\x1b[0m\r\n`);
      }
    });

    const unsubError = wsManager.on('terminal_error', (data: any) => {
      if (resolveStoreJid(useChatStore.getState().groups, data.chatJid) === sessionId) {
        syncConnState('disconnected');
        // 针对工作区未运行的错误给出更友好的提示
        if (data.error?.includes('工作区未运行')) {
          terminal.write(`\r\n\x1b[33m[工作区启动中...]\x1b[0m\r\n`);
          terminal.write(`\r\n已自动尝试启动工作区，请稍后点击"重新连接"。\r\n`);
        } else if (data.error?.includes('工作区启动中')) {
          terminal.write(`\r\n\x1b[33m[工作区启动中...]\x1b[0m\r\n`);
          terminal.write(`\r\n工作区正在启动，请稍后点击"重新连接"。\r\n`);
        } else {
          terminal.write(`\r\n\x1b[31m[错误: ${data.error}]\x1b[0m\r\n`);
        }
      }
    });

    const unsubWsConnected = wsManager.on('connected', () => {
      if (connStateRef.current !== 'connected') {
        syncConnState('connecting');
        sendStartTerminal();
      }
    });

    const unsubWsDisconnected = wsManager.on('disconnected', () => {
      syncConnState('disconnected');
      terminal.write('\r\n\x1b[33m[WebSocket 已断开，等待重连]\x1b[0m\r\n');
    });

    // 用户输入 → WebSocket（仅在已连接时发送）
    const onDataDisposable = terminal.onData((data) => {
      if (connStateRef.current === 'connected') {
        wsManager.send({ type: 'terminal_input', chatJid: sessionId, data });
      }
    });

    // ResizeObserver 监听尺寸变化
    const resizeObserver = new ResizeObserver(() => {
      if (!visibleRef.current) return;
      requestAnimationFrame(() => {
        if (fitAddonRef.current && xtermRef.current) {
          fitAddonRef.current.fit();
          if (connStateRef.current === 'connected') {
            const { cols, rows } = xtermRef.current;
            wsManager.send({ type: 'terminal_resize', chatJid: sessionId, cols, rows });
          }
        }
      });
    });
    resizeObserver.observe(termRef.current);

    // 初次尝试连接；若 WS 未就绪，connected 事件会自动触发 terminal_start
    requestStartTerminal();

    // Cleanup
    return () => {
      resizeObserver.disconnect();
      onDataDisposable.dispose();
      unsubOutput();
      unsubStarted();
      unsubStopped();
      unsubError();
      unsubWsConnected();
      unsubWsDisconnected();
      if (wsManager.isConnected()) {
        wsManager.send({ type: 'terminal_stop', chatJid: sessionId });
      }
      terminal.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
  }, [sessionId]);

  return (
    <div className="h-full flex flex-col terminal-panel">
      {/* Status bar */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-surface border-b border-border text-xs">
        <div className="flex items-center gap-2">
          <span className={`inline-block w-2 h-2 rounded-full ${
            connState === 'connected' ? 'bg-success' :
            connState === 'connecting' ? 'bg-warning animate-pulse' :
            'bg-muted-foreground/60'
          }`} />
          <span className="text-muted-foreground">
            {connState === 'connected' ? '已连接' :
             connState === 'connecting' ? '连接中...' :
             connState === 'disconnected' ? '已断开' : '空闲'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {connState === 'disconnected' && (
            <button
              onClick={() => {
                syncConnState('connecting');
                if (wsManager.isConnected()) {
                  const cols = xtermRef.current?.cols || 80;
                  const rows = xtermRef.current?.rows || 24;
                  wsManager.send({
                    type: 'terminal_start',
                    chatJid: sessionId,
                    cols,
                    rows,
                  });
                } else {
                  wsManager.connect();
                }
              }}
              className="text-primary hover:text-primary/80 transition-colors cursor-pointer"
            >
              重新连接
            </button>
          )}
          {onHide && (
            <button
              onClick={onHide}
              className="p-1 rounded hover:bg-surface-3 text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
              aria-label="隐藏终端"
              title="隐藏终端"
            >
              <EyeOff className="w-3.5 h-3.5" />
            </button>
          )}
          {onDelete && (
            <button
              onClick={onDelete}
              className="p-1 rounded hover:bg-error-bg text-muted-foreground hover:text-error transition-colors cursor-pointer"
              aria-label="删除终端"
              title="删除终端"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
      {/* Terminal container */}
      <div ref={termRef} className="flex-1 min-h-0 overflow-hidden bg-card" />
    </div>
  );
}
