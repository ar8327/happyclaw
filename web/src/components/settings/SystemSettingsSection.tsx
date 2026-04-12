import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';

import { useAuthStore } from '../../stores/auth';
import { api } from '../../api/client';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import type { SettingsNotification, SystemSettings } from './types';
import { getErrorMessage } from './types';

interface SystemSettingsSectionProps extends SettingsNotification {}

interface FieldConfig {
  key: keyof SystemSettings;
  label: string;
  description: string;
  unit: string;
  /** Convert stored value to display value */
  toDisplay: (v: number) => number;
  /** Convert display value to stored value */
  toStored: (v: number) => number;
  min: number;
  max: number;
  step: number;
}

const fields: FieldConfig[] = [
  {
    key: 'runtimeTimeout',
    label: '运行时最大执行时间',
    description: '单个 Agent 运行的最长执行时间',
    unit: '分钟',
    toDisplay: (v) => Math.round(v / 60000),
    toStored: (v) => v * 60000,
    min: 1,
    max: 1440,
    step: 1,
  },
  {
    key: 'idleTimeout',
    label: '运行时空闲超时',
    description: '最后一次输出后无新消息则回收运行时',
    unit: '分钟',
    toDisplay: (v) => Math.round(v / 60000),
    toStored: (v) => v * 60000,
    min: 1,
    max: 1440,
    step: 1,
  },
  {
    key: 'runtimeMaxOutputSize',
    label: '单次输出上限',
    description: '单次 Agent 运行的最大输出大小',
    unit: 'MB',
    toDisplay: (v) => Math.round(v / 1048576),
    toStored: (v) => v * 1048576,
    min: 1,
    max: 100,
    step: 1,
  },
  {
    key: 'maxConcurrentRuntimes',
    label: '最大并发运行时数',
    description: '同时运行的 Agent runtime 数量上限',
    unit: '个',
    toDisplay: (v) => v,
    toStored: (v) => v,
    min: 1,
    max: 100,
    step: 1,
  },
  {
    key: 'maxConcurrentScripts',
    label: '脚本任务最大并发数',
    description: '同时运行的脚本任务数量上限',
    unit: '个',
    toDisplay: (v) => v,
    toStored: (v) => v,
    min: 1,
    max: 50,
    step: 1,
  },
  {
    key: 'scriptTimeout',
    label: '脚本执行超时',
    description: '单个脚本任务的最长执行时间',
    unit: '秒',
    toDisplay: (v) => Math.round(v / 1000),
    toStored: (v) => v * 1000,
    min: 5,
    max: 600,
    step: 5,
  },
  {
    key: 'turnBatchWindowMs',
    label: '消息聚合窗口',
    description: '同渠道消息在此时间窗口内追加到当前 Turn',
    unit: '秒',
    toDisplay: (v) => Math.round(v / 1000),
    toStored: (v) => v * 1000,
    min: 1,
    max: 60,
    step: 1,
  },
  {
    key: 'turnMaxBatchMs',
    label: '最大聚合时间',
    description: '无论如何不再追加消息的硬上限',
    unit: '秒',
    toDisplay: (v) => Math.round(v / 1000),
    toStored: (v) => v * 1000,
    min: 5,
    max: 300,
    step: 5,
  },
  {
    key: 'traceRetentionDays',
    label: '轨迹保留天数',
    description: 'Turn 执行轨迹文件的保留天数',
    unit: '天',
    toDisplay: (v) => v,
    toStored: (v) => v,
    min: 1,
    max: 90,
    step: 1,
  },
];

export function SystemSettingsSection({ setNotice, setError }: SystemSettingsSectionProps) {
  const { hasPermission } = useAuthStore();

  const [settings, setSettings] = useState<SystemSettings | null>(null);
  const [displayValues, setDisplayValues] = useState<Record<string, number>>({});
  const [webPublicUrl, setWebPublicUrl] = useState('');
  const [defaultClaudeModel, setDefaultClaudeModel] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const canManage = hasPermission('manage_system_config');

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const data = await api.get<SystemSettings>('/api/config/system');
        setSettings(data);
        const display: Record<string, number> = {};
        for (const f of fields) {
          display[f.key] = f.toDisplay(data[f.key] as number);
        }
        setDisplayValues(display);
        setWebPublicUrl(data.webPublicUrl ?? '');
        setDefaultClaudeModel(data.defaultClaudeModel ?? '');
      } catch (err) {
        setError(getErrorMessage(err, '加载系统参数失败'));
      } finally {
        setLoading(false);
      }
    })();
  }, [setError]);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const payload: Partial<SystemSettings> = {
        webPublicUrl,
        defaultClaudeModel,
      };
      for (const f of fields) {
        const val = displayValues[f.key];
        if (val !== undefined) {
          (payload as Record<string, number>)[f.key] = f.toStored(val);
        }
      }
      const data = await api.put<SystemSettings>('/api/config/system', payload);
      setSettings(data);
      const display: Record<string, number> = {};
      for (const f of fields) {
        display[f.key] = f.toDisplay(data[f.key] as number);
      }
      setDisplayValues(display);
      setWebPublicUrl(data.webPublicUrl ?? '');
      setDefaultClaudeModel(data.defaultClaudeModel ?? '');
      setNotice('系统参数已保存，新参数将对后续启动的 runtime 生效');
    } catch (err) {
      setError(getErrorMessage(err, '保存系统参数失败'));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
      </div>
    );
  }

  if (!canManage) {
    return <div className="text-sm text-slate-500">需要系统配置权限才能修改系统参数。</div>;
  }

  if (!settings) return null;

  return (
    <div className="space-y-6">
      <p className="text-sm text-slate-500">
        调整 runtime、任务与 Web 参数。修改后无需重启，新参数对后续运行立即生效。
      </p>

      <div className="space-y-5">
        {fields.map((f) => (
          <div key={f.key}>
            <label className="block text-sm font-medium text-slate-900 mb-1">
              {f.label}
            </label>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                value={displayValues[f.key] ?? ''}
                onChange={(e) => {
                  const val = parseInt(e.target.value, 10);
                  setDisplayValues((prev) => ({
                    ...prev,
                    [f.key]: Number.isFinite(val) ? val : 0,
                  }));
                }}
                min={f.min}
                max={f.max}
                step={f.step}
                className="max-w-32"
              />
              <span className="text-sm text-slate-500">{f.unit}</span>
            </div>
            <p className="text-xs text-slate-400 mt-1">
              {f.description}（范围：{f.min} - {f.max} {f.unit}）
            </p>
          </div>
        ))}
      </div>

      {/* Web 设置 */}
      <div className="border-t border-border pt-6 space-y-5">
        <h3 className="text-sm font-semibold text-foreground">Web 设置</h3>
        <div>
          <label className="block text-sm font-medium text-foreground mb-1">公开访问地址</label>
          <Input
            type="url"
            value={webPublicUrl}
            onChange={(e) => setWebPublicUrl(e.target.value)}
            placeholder="https://your-domain.com"
            maxLength={200}
            className="max-w-md"
          />
          <p className="text-xs text-muted-foreground mt-1">
            用于飞书卡片按钮跳转等场景。留空则不生成跳转链接。
          </p>
        </div>
      </div>

      {/* 全局模型默认值 */}
      <div className="border-t border-border pt-6 space-y-5">
        <h3 className="text-sm font-semibold text-foreground">全局模型默认值</h3>
        <p className="text-xs text-muted-foreground -mt-3">
          工作区未指定模型时使用此默认值。工作区级别设置优先于此全局设置。
        </p>
        <div>
          <label className="block text-sm font-medium text-foreground mb-1">
            Claude 默认模型
          </label>
          <Input
            type="text"
            value={defaultClaudeModel}
            onChange={(e) => setDefaultClaudeModel(e.target.value)}
            placeholder="opus / sonnet / haiku 或完整模型 ID"
            className="max-w-md font-mono"
            list="sys-claude-model-presets"
          />
          <datalist id="sys-claude-model-presets">
            <option value="opus" />
            <option value="sonnet" />
            <option value="haiku" />
          </datalist>
          <p className="text-xs text-muted-foreground mt-1">
            留空则使用 Claude 提供商配置中的模型，最终默认为 opus。
          </p>
        </div>
      </div>

      <div>
        <Button onClick={handleSave} disabled={saving}>
          {saving && <Loader2 className="size-4 animate-spin" />}
          保存系统参数
        </Button>
      </div>
    </div>
  );
}
