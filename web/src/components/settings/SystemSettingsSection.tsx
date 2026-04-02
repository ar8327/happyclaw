import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { Label } from '@/components/ui/label';
import { useAuthStore } from '../../stores/auth';
import { useBillingStore, type BillingPlan } from '../../stores/billing';
import { api } from '../../api/client';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import type { SystemSettings } from './types';
import { getErrorMessage } from './types';

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
    key: 'containerTimeout',
    label: '容器最大运行时间',
    description: '单个容器/进程的最长运行时间',
    unit: '分钟',
    toDisplay: (v) => Math.round(v / 60000),
    toStored: (v) => v * 60000,
    min: 1,
    max: 1440,
    step: 1,
  },
  {
    key: 'idleTimeout',
    label: '容器空闲超时',
    description: '最后一次输出后无新消息则关闭容器',
    unit: '分钟',
    toDisplay: (v) => Math.round(v / 60000),
    toStored: (v) => v * 60000,
    min: 1,
    max: 1440,
    step: 1,
  },
  {
    key: 'containerMaxOutputSize',
    label: '单次输出上限',
    description: '单次容器运行的最大输出大小',
    unit: 'MB',
    toDisplay: (v) => Math.round(v / 1048576),
    toStored: (v) => v * 1048576,
    min: 1,
    max: 100,
    step: 1,
  },
  {
    key: 'maxConcurrentContainers',
    label: '最大并发容器数',
    description: '同时运行的 Docker 容器数量上限',
    unit: '个',
    toDisplay: (v) => v,
    toStored: (v) => v,
    min: 1,
    max: 100,
    step: 1,
  },
  {
    key: 'maxConcurrentHostProcesses',
    label: '最大并发宿主机进程数',
    description: '同时运行的宿主机模式进程数量上限',
    unit: '个',
    toDisplay: (v) => v,
    toStored: (v) => v,
    min: 1,
    max: 50,
    step: 1,
  },
  {
    key: 'maxLoginAttempts',
    label: '登录失败锁定次数',
    description: '连续失败该次数后锁定账户',
    unit: '次',
    toDisplay: (v) => v,
    toStored: (v) => v,
    min: 1,
    max: 100,
    step: 1,
  },
  {
    key: 'loginLockoutMinutes',
    label: '锁定时间',
    description: '账户被锁定后的等待时间',
    unit: '分钟',
    toDisplay: (v) => v,
    toStored: (v) => v,
    min: 1,
    max: 1440,
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
];

export function SystemSettingsSection() {
  const { hasPermission } = useAuthStore();

  const [settings, setSettings] = useState<SystemSettings | null>(null);
  const [displayValues, setDisplayValues] = useState<Record<string, number>>({});
  const [billingEnabled, setBillingEnabled] = useState(false);
  const [billingMinStartBalanceUsd, setBillingMinStartBalanceUsd] = useState(0.01);
  const [billingCurrency, setBillingCurrency] = useState('USD');
  const [billingCurrencyRate, setBillingCurrencyRate] = useState(1);
  const [webPublicUrl, setWebPublicUrl] = useState('');
  const [defaultLlmProvider, setDefaultLlmProvider] = useState<'claude' | 'openai'>('claude');
  const [defaultAnthropicModel, setDefaultAnthropicModel] = useState('');
  const [defaultOpenaiModel, setDefaultOpenaiModel] = useState('');
  const [anthropicUsageApiUrl, setAnthropicUsageApiUrl] = useState('');
  const [openaiUsageApiUrl, setOpenaiUsageApiUrl] = useState('');
  const [anthropicSdkBaseUrl, setAnthropicSdkBaseUrl] = useState('');
  const [openaiSdkBaseUrl, setOpenaiSdkBaseUrl] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const loadBillingStatus = useBillingStore((s) => s.loadBillingStatus);
  const { plans, loadPlans, updatePlan } = useBillingStore();
  const [defaultPlanId, setDefaultPlanId] = useState('');
  const [settingDefault, setSettingDefault] = useState(false);
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
        setBillingEnabled(data.billingEnabled ?? false);
        setBillingMinStartBalanceUsd(data.billingMinStartBalanceUsd ?? 0.01);
        setBillingCurrency(data.billingCurrency ?? 'USD');
        setBillingCurrencyRate(data.billingCurrencyRate ?? 1);
        setWebPublicUrl(data.webPublicUrl ?? '');
        setDefaultLlmProvider(data.defaultLlmProvider ?? 'claude');
        setDefaultAnthropicModel(data.defaultAnthropicModel ?? data.defaultClaudeModel ?? '');
        setDefaultOpenaiModel(data.defaultOpenaiModel ?? data.defaultCodexModel ?? '');
        setAnthropicUsageApiUrl(data.anthropicUsageApiUrl ?? data.claudeUsageApiUrl ?? '');
        setOpenaiUsageApiUrl(data.openaiUsageApiUrl ?? data.codexUsageApiUrl ?? '');
        setAnthropicSdkBaseUrl(data.anthropicSdkBaseUrl ?? data.claudeSdkBaseUrl ?? '');
        setOpenaiSdkBaseUrl(data.openaiSdkBaseUrl ?? data.codexSdkBaseUrl ?? '');
      } catch (err) {
        toast.error(getErrorMessage(err, '加载系统参数失败'));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Load plans when billing is enabled (for default plan picker)
  useEffect(() => {
    if (billingEnabled) {
      loadPlans();
    }
  }, [billingEnabled, loadPlans]);

  // Sync default plan ID from loaded plans
  useEffect(() => {
    const def = plans.find((p: BillingPlan) => p.is_default);
    setDefaultPlanId(def?.id ?? '');
  }, [plans]);

  const handleSetDefaultPlan = async (planId: string) => {
    if (!planId || planId === defaultPlanId) return;
    setSettingDefault(true);
    try {
      await updatePlan(planId, { is_default: true });
      setDefaultPlanId(planId);
      toast.success('默认套餐已更新');
    } catch (err) {
      toast.error(getErrorMessage(err, '设置默认套餐失败'));
    } finally {
      setSettingDefault(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const payload: Partial<SystemSettings> = {
        billingEnabled,
        billingMode: 'wallet_first',
        billingMinStartBalanceUsd,
        billingCurrency,
        billingCurrencyRate,
        webPublicUrl,
        defaultLlmProvider,
        defaultAnthropicModel,
        defaultOpenaiModel,
        anthropicUsageApiUrl,
        openaiUsageApiUrl,
        anthropicSdkBaseUrl,
        openaiSdkBaseUrl,
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
      setBillingEnabled(data.billingEnabled ?? false);
      setBillingMinStartBalanceUsd(data.billingMinStartBalanceUsd ?? 0.01);
      setBillingCurrency(data.billingCurrency ?? 'USD');
      setBillingCurrencyRate(data.billingCurrencyRate ?? 1);
      setWebPublicUrl(data.webPublicUrl ?? '');
      setDefaultLlmProvider(data.defaultLlmProvider ?? 'claude');
      setDefaultAnthropicModel(data.defaultAnthropicModel ?? data.defaultClaudeModel ?? '');
      setDefaultOpenaiModel(data.defaultOpenaiModel ?? data.defaultCodexModel ?? '');
      setAnthropicUsageApiUrl(data.anthropicUsageApiUrl ?? data.claudeUsageApiUrl ?? '');
      setOpenaiUsageApiUrl(data.openaiUsageApiUrl ?? data.codexUsageApiUrl ?? '');
      setAnthropicSdkBaseUrl(data.anthropicSdkBaseUrl ?? data.claudeSdkBaseUrl ?? '');
      setOpenaiSdkBaseUrl(data.openaiSdkBaseUrl ?? data.codexSdkBaseUrl ?? '');
      // 刷新计费状态，更新导航栏可见性
      loadBillingStatus();
      toast.success('系统参数已保存，新参数将对后续启动的容器/进程生效');
    } catch (err) {
      toast.error(getErrorMessage(err, '保存系统参数失败'));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!canManage) {
    return <div className="text-sm text-muted-foreground">需要系统配置权限才能修改系统参数。</div>;
  }

  if (!settings) return null;

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        调整容器运行参数和安全限制。修改后无需重启，新参数对后续创建的容器/进程立即生效。
      </p>

      <div className="space-y-5">
        {fields.map((f) => (
          <div key={f.key}>
            <Label className="mb-1">
              {f.label}
            </Label>
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
              <span className="text-sm text-muted-foreground">{f.unit}</span>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {f.description}（范围：{f.min} - {f.max} {f.unit}）
            </p>
          </div>
        ))}
      </div>

      {/* 计费设置 */}
      <div className="border-t border-border pt-6 space-y-5">
        <h3 className="text-sm font-semibold text-foreground">计费系统</h3>

        <div className="flex items-center justify-between">
          <div>
            <Label>启用计费</Label>
            <p className="text-xs text-muted-foreground mt-0.5">
              开启后普通用户必须先有余额才能使用，管理员可在后台进行充扣和套餐分配
            </p>
          </div>
          <Switch
            checked={billingEnabled}
            onCheckedChange={setBillingEnabled}
            aria-label="启用计费系统"
          />
        </div>

        {billingEnabled && (
          <>
          <div>
              <Label className="mb-1">
                计费模式
              </Label>
              <div className="rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
                钱包优先（固定）
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                普通用户必须先有余额才能使用，套餐只决定费率和资源上限。
              </p>
            </div>

            <div>
              <Label className="mb-1">
                最低起用余额
              </Label>
              <Input
                type="number"
                value={billingMinStartBalanceUsd}
                onChange={(e) => setBillingMinStartBalanceUsd(Number(e.target.value) || 0)}
                min={0}
                step={0.01}
                className="max-w-32"
              />
              <p className="text-xs text-muted-foreground mt-1">
                普通用户余额低于该值时，消息和任务都会被阻断。
              </p>
            </div>

            <div>
              <Label className="mb-1">
                显示货币符号
              </Label>
              <Input
                type="text"
                value={billingCurrency}
                onChange={(e) => setBillingCurrency(e.target.value)}
                className="max-w-32"
                placeholder="USD"
              />
              <p className="text-xs text-muted-foreground mt-1">
                前端显示的货币符号（如 USD、CNY、EUR）
              </p>
            </div>

            <div>
              <Label className="mb-1">
                汇率乘数
              </Label>
              <Input
                type="number"
                value={billingCurrencyRate}
                onChange={(e) => {
                  const val = parseFloat(e.target.value);
                  setBillingCurrencyRate(Number.isFinite(val) ? val : 1);
                }}
                min={0.01}
                max={1000}
                step={0.01}
                className="max-w-32"
              />
              <p className="text-xs text-muted-foreground mt-1">
                将 USD 转为显示货币的乘数（如 CNY 约 7.2）
              </p>
            </div>

            <div>
              <Label className="mb-1">
                默认套餐
              </Label>
              <select
                value={defaultPlanId}
                onChange={(e) => handleSetDefaultPlan(e.target.value)}
                disabled={settingDefault || plans.filter((p: BillingPlan) => p.is_active).length === 0}
                className="h-9 px-3 text-sm border border-border rounded-md bg-transparent max-w-64"
              >
                <option value="" disabled>
                  {plans.filter((p: BillingPlan) => p.is_active).length === 0
                    ? '请先创建可用套餐'
                    : '请选择默认套餐'}
                </option>
                {plans
                  .filter((p: BillingPlan) => p.is_active)
                  .map((p: BillingPlan) => (
                    <option key={p.id} value={p.id}>
                      {p.name}{p.is_default ? ' (当前默认)' : ''}
                    </option>
                  ))}
              </select>
              <p className="text-xs text-muted-foreground mt-1">
                新用户注册时自动分配的套餐
              </p>
            </div>
          </>
        )}
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
          工作区未指定时使用此默认值。工作区级别设置优先于此全局设置。
        </p>
        <div>
          <label className="block text-sm font-medium text-foreground mb-1">
            默认 LLM 提供商
          </label>
          <select
            value={defaultLlmProvider}
            onChange={(e) => setDefaultLlmProvider(e.target.value as 'claude' | 'openai')}
            className="max-w-md w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="claude">Anthropic</option>
            <option value="openai">OpenAI</option>
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-foreground mb-1">
            Anthropic 默认模型
          </label>
          <Input
            type="text"
            value={defaultAnthropicModel}
            onChange={(e) => setDefaultAnthropicModel(e.target.value)}
            placeholder="opus / sonnet / haiku 或完整模型 ID"
            className="max-w-md font-mono"
            list="sys-anthropic-model-presets"
          />
          <datalist id="sys-anthropic-model-presets">
            <option value="opus" />
            <option value="sonnet" />
            <option value="haiku" />
          </datalist>
          <p className="text-xs text-muted-foreground mt-1">
            留空则使用 Anthropic 通道配置中的模型，最终默认为 opus。
          </p>
        </div>
        <div>
          <label className="block text-sm font-medium text-foreground mb-1">
            OpenAI 默认模型
          </label>
          <Input
            type="text"
            value={defaultOpenaiModel}
            onChange={(e) => setDefaultOpenaiModel(e.target.value)}
            placeholder="gpt-5.4 / gpt-5.3 / 自定义模型 ID"
            className="max-w-md font-mono"
          />
        </div>
      </div>

      <div className="border-t border-border pt-6 space-y-5">
        <h3 className="text-sm font-semibold text-foreground">Provider 扩展接口</h3>
        <p className="text-xs text-muted-foreground -mt-3">
          用于后续接入更多 SDK 与用量接口，Anthropic 与 OpenAI 分开配置。
        </p>
        <div>
          <label className="block text-sm font-medium text-foreground mb-1">Anthropic 用量 API</label>
          <Input value={anthropicUsageApiUrl} onChange={(e) => setAnthropicUsageApiUrl(e.target.value)} placeholder="https://..." className="max-w-2xl font-mono" />
        </div>
        <div>
          <label className="block text-sm font-medium text-foreground mb-1">OpenAI 用量 API</label>
          <Input value={openaiUsageApiUrl} onChange={(e) => setOpenaiUsageApiUrl(e.target.value)} placeholder="https://..." className="max-w-2xl font-mono" />
        </div>
        <div>
          <label className="block text-sm font-medium text-foreground mb-1">Anthropic SDK Base URL</label>
          <Input value={anthropicSdkBaseUrl} onChange={(e) => setAnthropicSdkBaseUrl(e.target.value)} placeholder="https://..." className="max-w-2xl font-mono" />
        </div>
        <div>
          <label className="block text-sm font-medium text-foreground mb-1">OpenAI SDK Base URL</label>
          <Input value={openaiSdkBaseUrl} onChange={(e) => setOpenaiSdkBaseUrl(e.target.value)} placeholder="https://..." className="max-w-2xl font-mono" />
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
