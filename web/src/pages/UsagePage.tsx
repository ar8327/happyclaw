import { useEffect, useMemo, useState, useCallback } from 'react';
import {
  RefreshCw, Zap, ArrowUpRight, ArrowDownRight, DollarSign,
  MessageSquare, Database, Filter, Info, Clock,
  ExternalLink,
} from 'lucide-react';
import { useUsageStore } from '../stores/usage';
import type { SubscriptionWindow, OpenAIRateWindow } from '../stores/usage';
import { useAuthStore } from '../stores/auth';
import { PageHeader } from '@/components/common/PageHeader';
import { SkeletonStatCards } from '@/components/common/Skeletons';
import { Button } from '@/components/ui/button';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip as RechartsTooltip,
  ResponsiveContainer, CartesianGrid, Legend, PieChart, Pie, Cell,
} from 'recharts';

const PERIOD_OPTIONS = [
  { label: '7 天', value: 7 },
  { label: '14 天', value: 14 },
  { label: '30 天', value: 30 },
  { label: '90 天', value: 90 },
];

const CHART_COLORS = [
  'var(--color-primary)',
  '#f59e0b',
  '#ef4444',
  '#8b5cf6',
  '#06b6d4',
  '#10b981',
  '#f97316',
  '#ec4899',
];

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatCost(usd: number): string {
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `$${usd.toFixed(3)}`;
  if (usd > 0) return `$${usd.toFixed(4)}`;
  return '$0.00';
}

// --- Anthropic Subscription Usage Card ---

function formatResetTime(resetsAt: string): string {
  const now = Date.now();
  const reset = new Date(resetsAt).getTime();
  const diffMs = reset - now;
  if (diffMs <= 0) return '即将重置';
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 60) return `${diffMin} 分钟后重置`;
  const diffHr = Math.floor(diffMin / 60);
  const remMin = diffMin % 60;
  if (diffHr < 24) return remMin > 0 ? `${diffHr} 小时 ${remMin} 分钟后重置` : `${diffHr} 小时后重置`;
  const diffDay = Math.floor(diffHr / 24);
  const remHr = diffHr % 24;
  return remHr > 0 ? `${diffDay} 天 ${remHr} 小时后重置` : `${diffDay} 天后重置`;
}

function SubscriptionProgressBar({ utilization }: { utilization: number }) {
  const percent = Math.min(utilization, 100);
  const color =
    percent >= 90 ? 'bg-red-500' : percent >= 70 ? 'bg-yellow-500' : 'bg-teal-500';
  return (
    <div className="h-2.5 bg-zinc-200 dark:bg-zinc-700 rounded-full overflow-hidden">
      <div
        className={`h-full ${color} rounded-full transition-all duration-500`}
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

function SubscriptionWindowRow({
  label,
  window: w,
}: {
  label: string;
  window: SubscriptionWindow;
}) {
  const [resetText, setResetText] = useState(() => formatResetTime(w.resets_at));

  useEffect(() => {
    setResetText(formatResetTime(w.resets_at));
    const timer = setInterval(() => setResetText(formatResetTime(w.resets_at)), 60_000);
    return () => clearInterval(timer);
  }, [w.resets_at]);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium text-foreground">{label}</span>
        <span className="text-muted-foreground">
          {w.utilization.toFixed(0)}% 已用
          <span className="mx-1.5 text-border">·</span>
          <Clock className="inline w-3.5 h-3.5 -mt-0.5 mr-0.5" />
          {resetText}
        </span>
      </div>
      <SubscriptionProgressBar utilization={w.utilization} />
    </div>
  );
}

function SubscriptionUsageCard() {
  const { subscription, subscriptionLoading, subscriptionError, subscriptionErrorCode, loadSubscription } =
    useUsageStore();

  useEffect(() => {
    loadSubscription();
  }, [loadSubscription]);

  // Hide entirely if user is not on OAuth (no credentials = not using Anthropic subscription)
  if (subscriptionErrorCode === 'no_credentials') {
    return null;
  }

  // If API works, show data with refresh; otherwise show link to claude.ai
  const apiUnavailable = subscriptionError && !subscription;
  const handleRefresh = useCallback(() => loadSubscription(), [loadSubscription]);

  return (
    <div className="bg-card rounded-xl border border-border p-4 lg:p-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-md bg-teal-100 dark:bg-teal-900 flex items-center justify-center">
            <span className="text-xs font-bold text-teal-700 dark:text-teal-300">A</span>
          </div>
          <h2 className="text-base font-semibold text-foreground">Anthropic</h2>
        </div>
        <div className="flex items-center gap-2">
          <a
            href="https://claude.ai/settings/usage"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-xs text-teal-600 dark:text-teal-400 hover:underline"
          >
            claude.ai
            <ExternalLink className="w-3 h-3" />
          </a>
          {!apiUnavailable && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleRefresh}
              disabled={subscriptionLoading}
            >
              <RefreshCw className={`w-4 h-4 ${subscriptionLoading ? 'animate-spin' : ''}`} />
            </Button>
          )}
        </div>
      </div>

      {subscriptionLoading && !subscription && (
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="space-y-1.5">
              <div className="h-4 bg-muted rounded w-1/3 animate-pulse" />
              <div className="h-2.5 bg-muted rounded-full animate-pulse" />
            </div>
          ))}
        </div>
      )}

      {subscription && (
        <div className="space-y-4">
          {subscription.five_hour && (
            <SubscriptionWindowRow label="5 小时窗口" window={subscription.five_hour} />
          )}
          {subscription.seven_day && (
            <SubscriptionWindowRow label="7 天窗口" window={subscription.seven_day} />
          )}
          {subscription.seven_day_sonnet && subscription.seven_day_sonnet.utilization > 0 && (
            <SubscriptionWindowRow
              label="7 天 Sonnet 窗口"
              window={subscription.seven_day_sonnet}
            />
          )}
          {subscription.extra_usage?.is_enabled && (
            <p className="text-xs text-muted-foreground">
              超量使用已启用
            </p>
          )}
        </div>
      )}

      {apiUnavailable && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground px-3 py-2 rounded-md bg-muted">
          <Info className="w-4 h-4 shrink-0" />
          <span>Anthropic 暂未开放配额查询 API，请点击上方链接前往 claude.ai 查看用量</span>
        </div>
      )}
    </div>
  );
}

// --- OpenAI Subscription Usage Card ---

function formatPlanType(plan: string): string {
  const map: Record<string, string> = {
    guest: 'Guest',
    free: 'Free',
    go: 'ChatGPT Go',
    plus: 'Plus',
    pro: 'Pro',
    free_workspace: 'Free Workspace',
    team: 'Team',
    business: 'Business',
    education: 'Education',
    quorum: 'Quorum',
    k12: 'K12',
    enterprise: 'Enterprise',
    edu: 'Edu',
    // Legacy plan_type values from accounts check
    chatgptplusplan: 'Plus',
    chatgptproplan: 'Pro',
    chatgptteamplan: 'Team',
    chatgptenterpriseplan: 'Enterprise',
  };
  return map[plan?.toLowerCase()] || plan || 'Unknown';
}

function OpenAIRateWindowRow({ w }: { w: OpenAIRateWindow }) {
  const [resetText, setResetText] = useState(() => w.resets_at ? formatResetTime(w.resets_at) : '');
  useEffect(() => {
    if (!w.resets_at) return;
    setResetText(formatResetTime(w.resets_at));
    const timer = setInterval(() => setResetText(formatResetTime(w.resets_at!)), 60_000);
    return () => clearInterval(timer);
  }, [w.resets_at]);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium text-foreground">{w.label}</span>
        <span className="text-muted-foreground">
          {w.used_percent.toFixed(0)}% 已用
          {resetText && (
            <>
              <span className="mx-1.5 text-border">·</span>
              <Clock className="inline w-3.5 h-3.5 -mt-0.5 mr-0.5" />
              {resetText}
            </>
          )}
        </span>
      </div>
      <SubscriptionProgressBar utilization={w.used_percent} />
    </div>
  );
}

function OpenAISubscriptionUsageCard() {
  const { openaiAccount, openaiAccountLoading, openaiAccountError, openaiAccountErrorCode, loadOpenAIAccount } =
    useUsageStore();

  useEffect(() => {
    loadOpenAIAccount();
  }, [loadOpenAIAccount]);

  // Hide if no OpenAI OAuth configured
  if (openaiAccountErrorCode === 'no_credentials') {
    return null;
  }

  const apiUnavailable = openaiAccountError && !openaiAccount;
  const handleRefresh = useCallback(() => loadOpenAIAccount(), [loadOpenAIAccount]);

  return (
    <div className="bg-card rounded-xl border border-border p-4 lg:p-6">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-md bg-emerald-100 dark:bg-emerald-900 flex items-center justify-center">
            <span className="text-xs font-bold text-emerald-700 dark:text-emerald-300">O</span>
          </div>
          <h2 className="text-base font-semibold text-foreground">OpenAI</h2>
          {openaiAccount?.plan_type && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-900 text-emerald-700 dark:text-emerald-300 font-medium">
              {formatPlanType(openaiAccount.plan_type)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <a
            href="https://chatgpt.com/settings"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400 hover:underline"
          >
            chatgpt.com
            <ExternalLink className="w-3 h-3" />
          </a>
          {!apiUnavailable && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleRefresh}
              disabled={openaiAccountLoading}
            >
              <RefreshCw className={`w-4 h-4 ${openaiAccountLoading ? 'animate-spin' : ''}`} />
            </Button>
          )}
        </div>
      </div>

      {openaiAccountLoading && !openaiAccount && (
        <div className="space-y-4">
          {[1, 2].map((i) => (
            <div key={i} className="space-y-1.5">
              <div className="h-4 bg-muted rounded w-1/3 animate-pulse" />
              <div className="h-2.5 bg-muted rounded-full animate-pulse" />
            </div>
          ))}
        </div>
      )}

      {openaiAccount && (
        <div className="space-y-4">
          {openaiAccount.rate_windows && openaiAccount.rate_windows.length > 0 ? (
            openaiAccount.rate_windows.map((w, i) => (
              <OpenAIRateWindowRow key={`${w.label}-${i}`} w={w} />
            ))
          ) : (
            <p className="text-sm text-muted-foreground">
              账户已连接（{formatPlanType(openaiAccount.plan_type || '')}），暂无速率限制数据。
            </p>
          )}
          {openaiAccount.credits && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground pt-1">
              <DollarSign className="w-4 h-4 shrink-0" />
              {openaiAccount.credits.unlimited
                ? <span>Credits: 无限</span>
                : openaiAccount.credits.balance != null
                  ? <span>Credits 余额: ${openaiAccount.credits.balance.toFixed(2)}</span>
                  : <span>Credits: {openaiAccount.credits.has_credits ? '可用' : '无'}</span>
              }
            </div>
          )}
        </div>
      )}

      {apiUnavailable && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground px-3 py-2 rounded-md bg-muted">
          <Info className="w-4 h-4 shrink-0" />
          <span>{openaiAccountError}</span>
        </div>
      )}
    </div>
  );
}

/**
 * Responsive subscription quota section.
 * Shows Anthropic and/or OpenAI quota cards side-by-side on larger screens.
 */
function SubscriptionQuotaSection() {
  return (
    <div className="flex flex-col lg:flex-row gap-4 mb-6 [&>*]:flex-1 [&>*]:min-w-0">
      <SubscriptionUsageCard />
      <OpenAISubscriptionUsageCard />
    </div>
  );
}

export function UsagePage() {
  const {
    summary, breakdown, dataRange, days, loading, error,
    loadStats, setDays, loadFilters,
    selectedUserId, selectedModel, availableModels, availableUsers,
    setSelectedUserId, setSelectedModel,
  } = useUsageStore();
  const user = useAuthStore((s) => s.user);
  const isAdmin = user?.role === 'admin';

  useEffect(() => {
    loadStats();
    loadFilters();
  }, [loadStats, loadFilters]);

  // Subtitle with data range info
  const subtitle = useMemo(() => {
    if (dataRange && dataRange.activeDays > 0) {
      const from = dataRange.from.slice(5); // MM-DD
      const to = dataRange.to.slice(5);
      if (dataRange.activeDays < days) {
        return `过去 ${days} 天内有 ${dataRange.activeDays} 天数据（${from} ~ ${to}）`;
      }
      return `${from} ~ ${to} 共 ${dataRange.activeDays} 天`;
    }
    return `过去 ${days} 天的 Token 用量和费用`;
  }, [dataRange, days]);

  // Aggregate daily data for chart — fill all dates in the selected period
  const dailyData = useMemo(() => {
    // Aggregate breakdown by date
    const byDate = new Map<string, { date: string; input: number; output: number; cacheRead: number; cost: number; messages: number }>();
    for (const row of breakdown) {
      const existing = byDate.get(row.date);
      if (existing) {
        existing.input += row.input_tokens;
        existing.output += row.output_tokens;
        existing.cacheRead += row.cache_read_tokens;
        existing.cost += row.cost_usd;
        existing.messages += row.request_count;
      } else {
        byDate.set(row.date, {
          date: row.date,
          input: row.input_tokens,
          output: row.output_tokens,
          cacheRead: row.cache_read_tokens,
          cost: row.cost_usd,
          messages: row.request_count,
        });
      }
    }

    // Generate complete date range for the selected period
    const result: typeof Array.prototype = [];
    const today = new Date();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      const dateStr = `${yyyy}-${mm}-${dd}`;
      result.push(byDate.get(dateStr) || {
        date: dateStr,
        input: 0,
        output: 0,
        cacheRead: 0,
        cost: 0,
        messages: 0,
      });
    }
    return result;
  }, [breakdown, days]);

  // Model breakdown for pie chart
  const modelData = useMemo(() => {
    const byModel = new Map<string, { model: string; cost: number; tokens: number }>();
    for (const row of breakdown) {
      const existing = byModel.get(row.model);
      if (existing) {
        existing.cost += row.cost_usd;
        existing.tokens += row.input_tokens + row.output_tokens;
      } else {
        byModel.set(row.model, {
          model: row.model,
          cost: row.cost_usd,
          tokens: row.input_tokens + row.output_tokens,
        });
      }
    }
    return Array.from(byModel.values())
      .filter((m) => m.tokens > 0 || m.cost > 0)
      .sort((a, b) => b.cost - a.cost);
  }, [breakdown]);

  // Cache hit rate
  const cacheHitRate = useMemo(() => {
    if (!summary) return null;
    const totalInput = summary.totalInputTokens + summary.totalCacheReadTokens;
    if (totalInput === 0) return null;
    return (summary.totalCacheReadTokens / totalInput * 100).toFixed(1);
  }, [summary]);

  return (
    <div className="min-h-full bg-background p-4 lg:p-8">
      <div className="max-w-7xl mx-auto">
        <PageHeader
          title="用量统计"
          subtitle={subtitle}
          className="mb-6"
          actions={
            <div className="flex items-center gap-2 flex-wrap">
              {/* Filters */}
              {isAdmin && availableUsers.length > 1 && (
                <select
                  value={selectedUserId || ''}
                  onChange={(e) => setSelectedUserId(e.target.value || null)}
                  className="h-9 px-3 rounded-lg border border-border bg-card text-sm text-foreground"
                >
                  <option value="">全部用户</option>
                  {availableUsers.map((u) => (
                    <option key={u.id} value={u.id}>{u.username}</option>
                  ))}
                </select>
              )}
              {availableModels.length > 1 && (
                <select
                  value={selectedModel || ''}
                  onChange={(e) => setSelectedModel(e.target.value || null)}
                  className="h-9 px-3 rounded-lg border border-border bg-card text-sm text-foreground"
                >
                  <option value="">全部模型</option>
                  {availableModels.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              )}
              <div className="flex rounded-lg border border-border overflow-hidden">
                {PERIOD_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => setDays(opt.value)}
                    className={`px-3 py-1.5 text-sm transition-colors ${
                      days === opt.value
                        ? 'bg-primary text-white'
                        : 'bg-card text-muted-foreground hover:bg-accent'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              <Button variant="outline" onClick={() => loadStats()} disabled={loading}>
                <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              </Button>
            </div>
          }
        />

        <SubscriptionQuotaSection />

        {availableModels.length > 1 && (
          <p className="text-xs text-muted-foreground mb-4 flex items-center gap-1.5">
            <Info className="w-3.5 h-3.5 shrink-0" />
            除主模型外，SDK 可能调用轻量模型处理意图分析等内部任务以优化成本
          </p>
        )}

        {loading && !summary && <SkeletonStatCards />}

        {error && (
          <div className="bg-destructive/10 text-destructive rounded-lg p-4 mb-6">
            {error}
          </div>
        )}

        {summary && (
          <div className="space-y-6">
            {/* Stat Cards */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <StatCard
                icon={<ArrowDownRight className="w-5 h-5" />}
                label="输入 Token"
                value={formatTokens(summary.totalInputTokens)}
                color="text-blue-600 dark:text-blue-400"
                bgColor="bg-blue-50 dark:bg-blue-950"
              />
              <StatCard
                icon={<ArrowUpRight className="w-5 h-5" />}
                label="输出 Token"
                value={formatTokens(summary.totalOutputTokens)}
                color="text-green-600 dark:text-green-400"
                bgColor="bg-green-50 dark:bg-green-950"
              />
              <StatCard
                icon={<DollarSign className="w-5 h-5" />}
                label="总费用"
                value={formatCost(summary.totalCostUSD)}
                color="text-amber-600 dark:text-amber-400"
                bgColor="bg-amber-50 dark:bg-amber-950"
              />
              <StatCard
                icon={<MessageSquare className="w-5 h-5" />}
                label="请求次数"
                value={String(summary.totalMessages)}
                color="text-purple-600 dark:text-purple-400"
                bgColor="bg-purple-50 dark:bg-purple-950"
              />
            </div>

            {/* Cache Stats */}
            {(summary.totalCacheReadTokens > 0 || summary.totalCacheCreationTokens > 0) && (
              <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
                <StatCard
                  icon={<Database className="w-5 h-5" />}
                  label="缓存读取"
                  value={formatTokens(summary.totalCacheReadTokens)}
                  color="text-cyan-600 dark:text-cyan-400"
                  bgColor="bg-cyan-50 dark:bg-cyan-950"
                />
                <StatCard
                  icon={<Zap className="w-5 h-5" />}
                  label="缓存创建"
                  value={formatTokens(summary.totalCacheCreationTokens)}
                  color="text-orange-600 dark:text-orange-400"
                  bgColor="bg-orange-50 dark:bg-orange-950"
                />
                {cacheHitRate !== null && (
                  <StatCard
                    icon={<Filter className="w-5 h-5" />}
                    label="缓存命中率"
                    value={`${cacheHitRate}%`}
                    color="text-teal-600 dark:text-teal-400"
                    bgColor="bg-teal-50 dark:bg-teal-950"
                  />
                )}
              </div>
            )}

            {/* Daily Token Chart */}
            {dailyData.length > 0 && (
              <div className="bg-card rounded-xl border border-border p-4 lg:p-6">
                <h2 className="text-lg font-semibold text-foreground mb-4">每日 Token 用量</h2>
                <div className="h-64 lg:h-80">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={dailyData} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                      <XAxis
                        dataKey="date"
                        tick={{ fontSize: 12, fill: 'var(--muted-foreground)' }}
                        tickFormatter={(v: string) => v.slice(5)} // MM-DD
                      />
                      <YAxis
                        tick={{ fontSize: 12, fill: 'var(--muted-foreground)' }}
                        tickFormatter={formatTokens}
                      />
                      <RechartsTooltip
                        contentStyle={{
                          backgroundColor: 'var(--card)',
                          border: '1px solid var(--border)',
                          borderRadius: '8px',
                          color: 'var(--foreground)',
                        }}
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        formatter={(value: any, name: any) => [formatTokens(Number(value) || 0), String(name)]}
                        labelFormatter={(label) => `日期: ${label}`}
                      />
                      <Legend />
                      <Bar dataKey="input" name="输入" stackId="tokens" fill="var(--color-primary)" radius={[0, 0, 0, 0]} />
                      <Bar dataKey="output" name="输出" stackId="tokens" fill="#f59e0b" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}

            {/* Daily Cost Chart */}
            {dailyData.length > 0 && (
              <div className="bg-card rounded-xl border border-border p-4 lg:p-6">
                <h2 className="text-lg font-semibold text-foreground mb-4">每日费用</h2>
                <div className="h-64 lg:h-80">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={dailyData} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                      <XAxis
                        dataKey="date"
                        tick={{ fontSize: 12, fill: 'var(--muted-foreground)' }}
                        tickFormatter={(v: string) => v.slice(5)}
                      />
                      <YAxis
                        tick={{ fontSize: 12, fill: 'var(--muted-foreground)' }}
                        tickFormatter={(v) => formatCost(Number(v))}
                      />
                      <RechartsTooltip
                        contentStyle={{
                          backgroundColor: 'var(--card)',
                          border: '1px solid var(--border)',
                          borderRadius: '8px',
                          color: 'var(--foreground)',
                        }}
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                          formatter={(value: any) => [formatCost(Number(value) || 0), '费用']}
                        labelFormatter={(label) => `日期: ${label}`}
                      />
                      <Bar dataKey="cost" name="费用 (USD)" fill="#ef4444" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}

            {/* Model Breakdown */}
            {modelData.length > 0 && (
              <div className="bg-card rounded-xl border border-border p-4 lg:p-6">
                <h2 className="text-lg font-semibold text-foreground mb-4">模型用量分布</h2>
                <div className="flex flex-col lg:flex-row gap-6">
                  {/* Pie Chart */}
                  <div className="h-64 w-full lg:w-1/2">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={modelData}
                          dataKey="cost"
                          nameKey="model"
                          cx="50%"
                          cy="50%"
                          outerRadius={90}
                          // eslint-disable-next-line @typescript-eslint/no-explicit-any
                          label={(props: any) =>
                            `${String(props.model ?? '').replace('claude-', '')} ${((Number(props.percent) || 0) * 100).toFixed(0)}%`
                          }
                        >
                          {modelData.map((_, i) => (
                            <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                          ))}
                        </Pie>
                        <RechartsTooltip
                          contentStyle={{
                            backgroundColor: 'var(--card)',
                            border: '1px solid var(--border)',
                            borderRadius: '8px',
                            color: 'var(--foreground)',
                          }}
                          // eslint-disable-next-line @typescript-eslint/no-explicit-any
                          formatter={(value: any) => [formatCost(Number(value) || 0), '费用']}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                  {/* Table */}
                  <div className="w-full lg:w-1/2">
                    <table className="min-w-full divide-y divide-border">
                      <thead>
                        <tr>
                          <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground uppercase">模型</th>
                          <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground uppercase">Token</th>
                          <th className="px-3 py-2 text-right text-xs font-medium text-muted-foreground uppercase">费用</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {modelData.map((row, i) => (
                          <tr key={row.model} className="hover:bg-muted/50">
                            <td className="px-3 py-2 text-sm text-foreground">
                              <span className="inline-block w-3 h-3 rounded-full mr-2" style={{ backgroundColor: CHART_COLORS[i % CHART_COLORS.length] }} />
                              {row.model}
                            </td>
                            <td className="px-3 py-2 text-sm text-right text-muted-foreground">{formatTokens(row.tokens)}</td>
                            <td className="px-3 py-2 text-sm text-right text-foreground font-medium">{formatCost(row.cost)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}

            {/* Empty State */}
            {summary.totalMessages === 0 && !loading && (
              <div className="bg-card rounded-xl border border-border p-12 text-center">
                <Zap className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
                <h3 className="text-lg font-semibold text-foreground mb-2">暂无用量数据</h3>
                <p className="text-muted-foreground">
                  与 AI 对话后，用量数据将自动记录在这里
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  color,
  bgColor,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  color: string;
  bgColor: string;
}) {
  return (
    <div className="bg-card rounded-xl border border-border p-4">
      <div className="flex items-center gap-3 mb-2">
        <div className={`w-10 h-10 rounded-lg ${bgColor} flex items-center justify-center ${color}`}>
          {icon}
        </div>
      </div>
      <p className="text-2xl font-bold text-foreground">{value}</p>
      <p className="text-sm text-muted-foreground">{label}</p>
    </div>
  );
}
