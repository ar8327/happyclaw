import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** Shown in the error UI so the user knows which section failed */
  label?: string;
}

interface State {
  error: Error | null;
}

/**
 * Generic React error boundary.
 * Catches render / lifecycle errors in its subtree and shows a
 * user-friendly fallback instead of white-screening the whole app.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', this.props.label ?? '', error, info.componentStack);
  }

  private handleRetry = () => {
    this.setState({ error: null });
  };

  private handleReload = () => {
    // Unregister service worker then reload to guarantee fresh assets
    navigator.serviceWorker
      ?.getRegistrations()
      .then((regs) => Promise.all(regs.map((r) => r.unregister())))
      .finally(() => window.location.reload());
  };

  render() {
    if (!this.state.error) return this.props.children;

    const { error } = this.state;
    const isChunkError =
      error.name === 'ChunkLoadError' ||
      /loading.*(chunk|module)/i.test(error.message) ||
      /dynamically imported module/i.test(error.message) ||
      /failed to fetch/i.test(error.message);

    return (
      <div className="flex items-center justify-center min-h-[40vh] p-6">
        <div className="max-w-lg w-full bg-card rounded-xl border border-border p-6 text-center space-y-4">
          <h2 className="text-lg font-semibold text-foreground">
            {isChunkError ? '页面资源加载失败' : '页面渲染出错'}
          </h2>
          <p className="text-sm text-muted-foreground">
            {isChunkError
              ? '可能是浏览器缓存了旧版本资源，请尝试刷新页面。'
              : '该页面遇到了未预期的错误。'}
          </p>
          <details className="text-left text-xs text-muted-foreground bg-muted rounded-lg p-3">
            <summary className="cursor-pointer font-medium mb-1">错误详情</summary>
            <pre className="whitespace-pre-wrap break-all mt-1">
              {error.name}: {error.message}
            </pre>
          </details>
          <div className="flex items-center justify-center gap-3">
            <button
              onClick={this.handleRetry}
              className="px-4 py-2 text-sm rounded-lg bg-primary text-white hover:bg-primary/90"
            >
              重试
            </button>
            <button
              onClick={this.handleReload}
              className="px-4 py-2 text-sm rounded-lg border border-border text-foreground hover:bg-accent"
            >
              清除缓存并刷新
            </button>
          </div>
        </div>
      </div>
    );
  }
}
