import { useCallback, useEffect, useState } from 'react';
import { Cpu, Loader2, RefreshCw, TerminalSquare } from 'lucide-react';

import { api } from '@/api/client';
import { Button } from '@/components/ui/button';
import type { SettingsNotification } from './types';

interface LocalCodexCliStatus {
  detected: boolean;
  hasAuth: boolean;
  authMode: string | null;
  accountId: string | null;
  lastRefresh: string | null;
}

export function CodexProviderSection({ setError }: SettingsNotification) {
  const [status, setStatus] = useState<LocalCodexCliStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      const data = await api.get<LocalCodexCliStatus>('/api/config/codex/detect-local');
      setStatus(data);
      setError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : '读取 Codex 本机状态失败';
      setError(message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [setError]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-slate-200 bg-white p-5 space-y-3">
        <div className="flex items-center gap-2">
          <TerminalSquare className="size-4 text-slate-700" />
          <div className="text-sm font-medium text-slate-900">直接使用宿主机 Codex 命令</div>
        </div>
        <p className="text-sm text-slate-600 leading-6">
          HappyClaw 不再管理 Codex API Key、Profile、Base URL、默认模型或自定义环境变量。系统只会直接使用宿主机上的
          <code className="mx-1 rounded bg-slate-100 px-1.5 py-0.5 text-xs">codex</code>
          命令和本机已有登录态。
        </p>
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 space-y-2 text-sm text-slate-600">
          <div>要求</div>
          <div>1. 宿主机存在可执行的 <code className="rounded bg-white px-1.5 py-0.5 text-xs">codex</code> 命令</div>
          <div>2. 你自己已经在宿主机执行过 <code className="rounded bg-white px-1.5 py-0.5 text-xs">codex login</code></div>
          <div>3. 如果依赖环境变量，也需要在启动 HappyClaw 前由宿主机自行提供</div>
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-5 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Cpu className="size-4 text-slate-700" />
            <div className="text-sm font-medium text-slate-900">本机检测</div>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setRefreshing(true);
              void loadStatus();
            }}
            disabled={refreshing}
          >
            {(refreshing || loading) && <Loader2 className="size-4 animate-spin" />}
            <RefreshCw className="size-4" />
            刷新检测
          </Button>
        </div>

        {loading && !status ? (
          <div className="text-sm text-slate-500">加载中…</div>
        ) : (
          <div className="space-y-3">
            <div className={`rounded-lg border px-4 py-3 text-sm ${
              status?.hasAuth
                ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                : 'border-amber-200 bg-amber-50 text-amber-800'
            }`}>
              {status?.hasAuth
                ? '检测到本机 Codex 登录态，运行时将直接使用本机命令。'
                : '没有检测到可用的本机 Codex 登录态。'}
            </div>

            <div className="grid gap-2 text-sm text-slate-600">
              <div>检测到本机目录: {status?.detected ? '是' : '否'}</div>
              <div>检测到有效登录: {status?.hasAuth ? '是' : '否'}</div>
              <div>认证模式: {status?.authMode || '未知'}</div>
              <div>账号标识: {status?.accountId || '无'}</div>
              <div>最近刷新: {status?.lastRefresh || '无'}</div>
            </div>

            <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600 leading-6">
              如果这里显示不可用，就去宿主机终端先把 Codex 命令跑通。HappyClaw 不再提供 Web 侧的 API Key、Profile 或桥接配置入口。
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
