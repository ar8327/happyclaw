import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Loader2,
  RefreshCw,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import { api } from '@/api/client';
import { Button } from '@/components/ui/button';
import type { SettingsNotification } from './types';
import { getErrorMessage } from './types';

interface FailedDelivery {
  id: string;
  sourceChatJid: string;
  targetJid: string;
  kind: 'text' | 'image' | 'file';
  attempts: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

interface IpcErrorFile {
  name: string;
  size: number;
  updatedAt: string;
}

export function FailedDeliveriesCard({
  setNotice,
  setError,
}: SettingsNotification) {
  const [deliveries, setDeliveries] = useState<FailedDelivery[]>([]);
  const [ipcErrors, setIpcErrors] = useState<IpcErrorFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [workingId, setWorkingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [deliveryData, ipcData] = await Promise.all([
        api.get<{ deliveries: FailedDelivery[] }>('/api/outbox/failed'),
        api.get<{ errors: IpcErrorFile[] }>('/api/outbox/ipc-errors'),
      ]);
      setDeliveries(deliveryData.deliveries);
      setIpcErrors(ipcData.errors);
    } catch (err) {
      setError(getErrorMessage(err, '读取失败投递记录失败'));
    } finally {
      setLoading(false);
    }
  }, [setError]);

  useEffect(() => {
    void load();
  }, [load]);

  const retry = async (id: string) => {
    setWorkingId(id);
    setError(null);
    try {
      await api.post(`/api/outbox/${encodeURIComponent(id)}/retry`);
      setDeliveries((current) => current.filter((item) => item.id !== id));
      setNotice('已重新加入投递队列');
    } catch (err) {
      setError(getErrorMessage(err, '重试投递失败'));
    } finally {
      setWorkingId(null);
    }
  };

  const clear = async (id: string) => {
    setWorkingId(id);
    setError(null);
    try {
      await api.delete(`/api/outbox/${encodeURIComponent(id)}`);
      setDeliveries((current) => current.filter((item) => item.id !== id));
      setNotice('失败记录已清除，清除后无法再重试');
    } catch (err) {
      setError(getErrorMessage(err, '清除失败记录失败'));
    } finally {
      setWorkingId(null);
    }
  };

  const clearIpcError = async (name: string) => {
    setWorkingId(name);
    setError(null);
    try {
      await api.delete(`/api/outbox/ipc-errors/${encodeURIComponent(name)}`);
      setIpcErrors((current) => current.filter((item) => item.name !== name));
      setNotice('IPC 错误文件已清除，清除后无法恢复');
    } catch (err) {
      setError(getErrorMessage(err, '清除 IPC 错误文件失败'));
    } finally {
      setWorkingId(null);
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle bg-surface/50">
        <div className="flex items-center gap-2">
          <AlertTriangle
            className={`size-4 ${deliveries.length || ipcErrors.length ? 'text-warning' : 'text-muted-foreground/80'}`}
          />
          <div>
            <h3 className="text-sm font-semibold text-foreground">
              失败的 IM 投递
            </h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              自动重试耗尽或永久失败的消息会保留在这里。
            </p>
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={`size-3.5 ${loading ? 'animate-spin' : ''}`} />
          刷新
        </Button>
      </div>

      <div className="px-5 py-4">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            加载中…
          </div>
        ) : deliveries.length === 0 && ipcErrors.length === 0 ? (
          <p className="text-sm text-muted-foreground">当前没有失败的投递。</p>
        ) : (
          <div className="space-y-3">
            {deliveries.map((delivery) => (
              <div
                key={delivery.id}
                className="rounded-lg border border-warning-border bg-warning-bg/50 p-3"
              >
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                  <span className="font-medium text-foreground">
                    {delivery.targetJid}
                  </span>
                  <span className="rounded bg-card px-1.5 py-0.5 text-muted-foreground">
                    {delivery.kind}
                  </span>
                  <span className="text-muted-foreground/80">
                    已尝试 {delivery.attempts} 次
                  </span>
                </div>
                <p className="mt-2 text-xs text-warning-foreground break-words">
                  {delivery.error || '未知错误'}
                </p>
                <div className="mt-3 flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={workingId === delivery.id}
                    onClick={() => retry(delivery.id)}
                  >
                    <RotateCcw className="size-3" />
                    重试
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={workingId === delivery.id}
                    onClick={() => clear(delivery.id)}
                  >
                    <Trash2 className="size-3" />
                    清除记录
                  </Button>
                </div>
              </div>
            ))}
            {ipcErrors.map((ipcError) => (
              <div
                key={ipcError.name}
                className="rounded-lg border border-error-border bg-error-bg/50 p-3"
              >
                <div className="text-xs font-medium text-foreground break-all">
                  IPC 解析错误 · {ipcError.name}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {(ipcError.size / 1024).toFixed(1)} KB ·{' '}
                  {new Date(ipcError.updatedAt).toLocaleString()}
                </p>
                <Button
                  className="mt-3"
                  size="sm"
                  variant="ghost"
                  disabled={workingId === ipcError.name}
                  onClick={() => clearIpcError(ipcError.name)}
                >
                  <Trash2 className="size-3" />
                  清除错误文件
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
