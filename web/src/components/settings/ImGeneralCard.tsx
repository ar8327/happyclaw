import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';

import { ToggleSwitch } from '@/components/ui/toggle-switch';
import { api } from '../../api/client';
import type { SettingsNotification } from './types';
import { getErrorMessage } from './types';

interface ImGeneralConfig {
  autoUnbindOnSendFailure: boolean;
  updatedAt: string | null;
}

interface ImGeneralCardProps extends SettingsNotification {}

export function ImGeneralCard({ setNotice, setError }: ImGeneralCardProps) {
  const [config, setConfig] = useState<ImGeneralConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const loadConfig = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.get<ImGeneralConfig>('/api/config/im/general');
      setConfig(data);
    } catch {
      // Default config if endpoint fails
      setConfig({ autoUnbindOnSendFailure: true, updatedAt: null });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  if (loading) {
    return (
      <div className="bg-white rounded-lg shadow-sm border border-slate-200 p-6">
        <div className="flex items-center gap-2 text-slate-500">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span className="text-sm">加载通用设置...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg shadow-sm border border-slate-200 p-6">
      <h3 className="text-base font-semibold text-slate-800 mb-4">IM 通用设置</h3>
      <div className="flex items-center justify-between gap-4">
        <div className="flex-1">
          <h4 className="text-xs font-semibold text-slate-700">发送失败自动解绑</h4>
          <p className="text-xs text-slate-500 mt-0.5">
            开启后，连续发送失败 3 次的 IM 群组将自动解除与工作区的绑定。
            关闭时仅记录日志，不自动解绑。
          </p>
        </div>
        <ToggleSwitch
          checked={config?.autoUnbindOnSendFailure ?? false}
          disabled={saving}
          onChange={async (v) => {
            setSaving(true);
            setNotice(null);
            setError(null);
            try {
              const data = await api.put<ImGeneralConfig>('/api/config/im/general', {
                autoUnbindOnSendFailure: v,
              });
              setConfig(data);
              setNotice(`发送失败自动解绑已${v ? '开启' : '关闭'}`);
            } catch (err) {
              setError(getErrorMessage(err, '保存通用设置失败'));
            } finally {
              setSaving(false);
            }
          }}
          aria-label="发送失败自动解绑"
        />
      </div>
    </div>
  );
}
