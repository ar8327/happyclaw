import { useState, useEffect, useCallback } from 'react';
import { api } from '@/api/client';
import { ToggleSwitch } from '@/components/ui/toggle-switch';
import type { SettingsNotification } from './types';
import { FeishuChannelCard } from './FeishuChannelCard';
import { TelegramChannelCard } from './TelegramChannelCard';
import { QQChannelCard } from './QQChannelCard';
import { ImGeneralCard } from './ImGeneralCard';
import { WeChatChannelCard } from './WeChatChannelCard';

interface UserIMPreferences {
  autoCreateWorkspaceForGroups?: boolean;
  autoCreateExecutionMode?: 'local';
}

interface UserChannelsSectionProps extends SettingsNotification {}

export function UserChannelsSection({ setNotice, setError }: UserChannelsSectionProps) {
  const [autoCreate, setAutoCreate] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .get<UserIMPreferences>('/api/config/user-im/preferences')
      .then((prefs) => {
        setAutoCreate(prefs.autoCreateWorkspaceForGroups === true);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const savePref = useCallback(
    async (patch: Partial<UserIMPreferences>) => {
      try {
        await api.put('/api/config/user-im/preferences', patch);
        return true;
      } catch {
        setError('保存偏好失败');
        return false;
      }
    },
    [setError],
  );

  const toggleAutoCreate = useCallback(
    async (checked: boolean) => {
      setAutoCreate(checked);
      const ok = await savePref({ autoCreateWorkspaceForGroups: checked });
      if (ok) {
        setNotice(checked ? '已开启自动创建工作区' : '已关闭自动创建工作区');
      } else {
        setAutoCreate(!checked);
      }
    },
    [savePref, setNotice],
  );

  return (
    <div className="space-y-6">
      <p className="text-sm text-slate-500 bg-slate-50 rounded-lg px-4 py-3">
        绑定你的 IM 账号，消息将发送到你的主会话。
      </p>

      <div className="bg-white border border-slate-200 rounded-lg p-4 space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex-1">
            <label className="block text-sm font-medium text-foreground">
              为 IM 群聊自动创建独立会话
            </label>
            <p className="text-xs text-muted-foreground mt-0.5">
              开启后，新加入的 IM 群聊将自动创建独立会话并绑定，而非共用主会话。私聊不受影响。
            </p>
          </div>
          {!loading && (
            <ToggleSwitch
              checked={autoCreate}
              onChange={toggleAutoCreate}
              aria-label="为 IM 群聊自动创建独立会话"
            />
          )}
        </div>

        {autoCreate && (
          <div className="pt-2 border-t border-slate-100">
            <p className="text-sm text-muted-foreground">
              新自动创建的会话会固定使用本地 Runtime。
            </p>
          </div>
        )}
      </div>

      <FeishuChannelCard setNotice={setNotice} setError={setError} />
      <TelegramChannelCard setNotice={setNotice} setError={setError} />
      <QQChannelCard setNotice={setNotice} setError={setError} />
      <WeChatChannelCard setNotice={setNotice} setError={setError} />
      <ImGeneralCard setNotice={setNotice} setError={setError} />
    </div>
  );
}
