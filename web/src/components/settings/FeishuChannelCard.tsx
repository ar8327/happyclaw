import { useCallback, useEffect, useState } from 'react';
import {
  Loader2,
  ExternalLink,
  ShieldCheck,
  ShieldX,
  Info,
  Copy,
  Check,
  ChevronDown,
} from 'lucide-react';

import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ToggleSwitch } from '@/components/ui/toggle-switch';
import { api } from '../../api/client';
import type { SettingsNotification } from './types';
import { getErrorMessage } from './types';

interface UserFeishuConfig {
  appId: string;
  hasAppSecret: boolean;
  appSecretMasked: string | null;
  enabled: boolean;
  connected: boolean;
  updatedAt: string | null;
  replyThreadingMode?: 'auto' | 'agent';
  streamingCard?: boolean;
  imCommentary?: boolean;
  hasCardVerificationToken?: boolean;
  hasCardEncryptKey?: boolean;
}

interface OAuthStatus {
  authorized: boolean;
  hasAppCredentials: boolean;
  authorizedAt?: string | null;
  scopes?: string;
  tokenExpired?: boolean;
  hasRefreshToken?: boolean;
}

function RedirectUrlHint() {
  const redirectUrl = `${window.location.origin}/feishu-oauth-callback`;
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(redirectUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="rounded-md bg-surface border border-border p-2.5 text-xs text-muted-foreground">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 w-full text-left"
      >
        <Info className="size-3.5 shrink-0 text-muted-foreground/80" />
        <span className="font-medium">
          授权前请确认：飞书开放平台已配置重定向 URL
        </span>
        <ChevronDown
          className={`size-3 shrink-0 ml-auto text-muted-foreground/80 transition-transform ${expanded ? 'rotate-180' : ''}`}
        />
      </button>
      {expanded && (
        <div className="mt-2 ml-5">
          <p className="text-muted-foreground">
            在飞书开放平台 {'>'} 应用详情 {'>'} 安全设置 {'>'} 重定向 URL
            中，添加以下地址：
          </p>
          <div className="mt-1.5 flex items-center gap-1.5">
            <code className="flex-1 rounded bg-surface-2 px-1.5 py-0.5 text-[11px] break-all select-all text-foreground">
              {redirectUrl}
            </code>
            <button
              type="button"
              onClick={handleCopy}
              className="shrink-0 rounded p-1 hover:bg-surface-2 transition-colors"
              title="复制"
            >
              {copied ? (
                <Check className="size-3 text-success" />
              ) : (
                <Copy className="size-3 text-muted-foreground/80" />
              )}
            </button>
          </div>
          <p className="mt-1 text-muted-foreground/80">
            未配置会导致授权时出现「重定向 URL 有误」错误（错误码 20029）。
          </p>
        </div>
      )}
    </div>
  );
}

interface FeishuChannelCardProps extends SettingsNotification {}

export function FeishuChannelCard({
  setNotice,
  setError,
}: FeishuChannelCardProps) {
  const [config, setConfig] = useState<UserFeishuConfig | null>(null);
  const [appId, setAppId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [cardVerificationToken, setCardVerificationToken] = useState('');
  const [cardEncryptKey, setCardEncryptKey] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [oauthStatus, setOauthStatus] = useState<OAuthStatus | null>(null);
  const [oauthLoading, setOauthLoading] = useState(false);
  const [savingThreadingMode, setSavingThreadingMode] = useState(false);
  const [savingStreamingCard, setSavingStreamingCard] = useState(false);
  const [savingImCommentary, setSavingImCommentary] = useState(false);
  const [savingCardCallback, setSavingCardCallback] = useState(false);

  const enabled = config?.enabled ?? false;

  const loadConfig = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.get<UserFeishuConfig>('/api/config/im/feishu');
      setConfig(data);
      setAppId(data.appId || '');
      setAppSecret('');
      setCardVerificationToken('');
      setCardEncryptKey('');
    } catch {
      setConfig(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadOAuthStatus = useCallback(async () => {
    try {
      const data = await api.get<OAuthStatus>(
        '/api/config/im/feishu/oauth-status',
      );
      setOauthStatus(data);
    } catch {
      setOauthStatus(null);
    }
  }, []);

  useEffect(() => {
    loadConfig();
    loadOAuthStatus();
  }, [loadConfig, loadOAuthStatus]);

  // Check for OAuth success redirect
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('oauth') === 'success') {
      loadOAuthStatus();
      setNotice('飞书文档授权成功！');
      // Clean up URL
      params.delete('oauth');
      const newUrl = params.toString()
        ? `${window.location.pathname}?${params.toString()}`
        : window.location.pathname;
      window.history.replaceState({}, '', newUrl);
    }
  }, [loadOAuthStatus, setNotice]);

  const handleOAuthAuthorize = async () => {
    setOauthLoading(true);
    setError(null);
    try {
      const data = await api.get<{ url: string }>(
        '/api/config/im/feishu/oauth-url',
      );
      // Open Feishu OAuth page
      window.location.href = data.url;
    } catch (err) {
      setError(getErrorMessage(err, '获取授权链接失败'));
      setOauthLoading(false);
    }
  };

  const handleOAuthRevoke = async () => {
    setOauthLoading(true);
    setError(null);
    try {
      await api.delete('/api/config/im/feishu/oauth-revoke');
      setOauthStatus({
        authorized: false,
        hasAppCredentials: oauthStatus?.hasAppCredentials ?? false,
      });
      setNotice('已撤销飞书文档授权');
    } catch (err) {
      setError(getErrorMessage(err, '撤销授权失败'));
    } finally {
      setOauthLoading(false);
    }
  };

  const handleToggle = async (newEnabled: boolean) => {
    setToggling(true);
    setNotice(null);
    setError(null);
    try {
      const data = await api.put<UserFeishuConfig>('/api/config/im/feishu', {
        enabled: newEnabled,
      });
      setConfig(data);
      setNotice(`飞书渠道已${newEnabled ? '启用' : '停用'}`);
    } catch (err) {
      setError(getErrorMessage(err, '切换飞书渠道状态失败'));
    } finally {
      setToggling(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const id = appId.trim();
      const secret = appSecret.trim();

      if (id && !secret && !config?.hasAppSecret) {
        setError('首次配置飞书需要同时提供 App ID 和 App Secret');
        setSaving(false);
        return;
      }

      if (!id && !secret) {
        if (config?.appId || config?.hasAppSecret) {
          setNotice('飞书配置未变更');
        } else {
          setError('请填写飞书 App ID 和 App Secret');
        }
        setSaving(false);
        return;
      }

      const payload: Record<string, string | boolean> = { enabled: true };
      if (id) payload.appId = id;
      if (secret) payload.appSecret = secret;
      const data = await api.put<UserFeishuConfig>(
        '/api/config/im/feishu',
        payload,
      );
      setConfig(data);
      setAppSecret('');
      setNotice('飞书配置已保存');
    } catch (err) {
      setError(getErrorMessage(err, '保存飞书配置失败'));
    } finally {
      setSaving(false);
    }
  };

  const handleSaveCardCallback = async () => {
    const token = cardVerificationToken.trim();
    const encryptKey = cardEncryptKey.trim();
    if (!token && !encryptKey) {
      setError('请填写 Verification Token 或 Encrypt Key');
      return;
    }
    setSavingCardCallback(true);
    setNotice(null);
    setError(null);
    try {
      const payload: Record<string, string> = {};
      if (token) payload.cardVerificationToken = token;
      if (encryptKey) payload.cardEncryptKey = encryptKey;
      const data = await api.put<UserFeishuConfig>(
        '/api/config/im/feishu',
        payload,
      );
      setConfig(data);
      setCardVerificationToken('');
      setCardEncryptKey('');
      setNotice('飞书卡片回调配置已保存');
    } catch (err) {
      setError(getErrorMessage(err, '保存卡片回调配置失败'));
    } finally {
      setSavingCardCallback(false);
    }
  };

  const clearCardCallbackSecret = async (
    field: 'clearCardVerificationToken' | 'clearCardEncryptKey',
  ) => {
    setSavingCardCallback(true);
    setNotice(null);
    setError(null);
    try {
      const data = await api.put<UserFeishuConfig>('/api/config/im/feishu', {
        [field]: true,
      });
      setConfig(data);
      setNotice('飞书卡片回调配置已清除');
    } catch (err) {
      setError(getErrorMessage(err, '清除卡片回调配置失败'));
    } finally {
      setSavingCardCallback(false);
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle bg-surface/50">
        <div className="flex items-center gap-2">
          <span
            className={`inline-block w-2 h-2 rounded-full ${config?.connected ? 'bg-success' : 'bg-border-strong'}`}
          />
          <div>
            <h3 className="text-sm font-semibold text-foreground">
              飞书 Feishu
            </h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              前往
              <a
                href="https://open.larkoffice.com/app?lang=zh-CN"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline mx-0.5"
              >
                飞书开放平台
              </a>
              创建应用，接收飞书群消息并通过 Agent 自动回复
            </p>
          </div>
        </div>
        <ToggleSwitch
          checked={enabled}
          disabled={loading || toggling}
          onChange={handleToggle}
        />
      </div>

      <div
        className={`px-5 py-4 space-y-4 transition-opacity ${!enabled ? 'opacity-50 pointer-events-none' : ''}`}
      >
        {loading ? (
          <div className="text-sm text-muted-foreground">加载中...</div>
        ) : (
          <>
            {config?.hasAppSecret && (
              <div className="text-xs text-muted-foreground">
                当前 Secret: {config.appSecretMasked || '已配置'}
              </div>
            )}
            <div className="grid md:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-muted-foreground mb-1">
                  App ID
                </label>
                <Input
                  type="text"
                  value={appId}
                  onChange={(e) => setAppId(e.target.value)}
                  placeholder="输入飞书 App ID"
                />
              </div>
              <div>
                <label className="block text-xs text-muted-foreground mb-1">
                  App Secret
                </label>
                <Input
                  type="password"
                  value={appSecret}
                  onChange={(e) => setAppSecret(e.target.value)}
                  placeholder={
                    config?.hasAppSecret ? '留空不修改' : '输入飞书 App Secret'
                  }
                />
              </div>
            </div>
            <div>
              <Button onClick={handleSave} disabled={saving}>
                {saving && <Loader2 className="size-4 animate-spin" />}
                保存飞书配置
              </Button>
            </div>

            {/* OAuth Document Access Section */}
            <div className="pt-3 border-t border-border-subtle">
              <div className="flex items-center gap-2 mb-2">
                {oauthStatus?.authorized ? (
                  <ShieldCheck className="size-4 text-success" />
                ) : (
                  <ShieldX className="size-4 text-muted-foreground/80" />
                )}
                <h4 className="text-xs font-semibold text-foreground">
                  飞书文档访问授权
                </h4>
              </div>
              <p className="text-xs text-muted-foreground mb-3">
                授权后，Agent 可以直接读取你有权限访问的飞书文档和 Wiki 页面。
              </p>

              {oauthStatus?.authorized ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-xs text-success">
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-success" />
                    已授权
                    {oauthStatus.authorizedAt && (
                      <span className="text-muted-foreground/80">
                        (
                        {new Date(
                          oauthStatus.authorizedAt,
                        ).toLocaleDateString()}
                        )
                      </span>
                    )}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleOAuthRevoke}
                    disabled={oauthLoading}
                  >
                    {oauthLoading && (
                      <Loader2 className="size-3 animate-spin" />
                    )}
                    撤销授权
                  </Button>
                </div>
              ) : (
                <div className="space-y-2">
                  <RedirectUrlHint />
                  <Button
                    size="sm"
                    onClick={handleOAuthAuthorize}
                    disabled={oauthLoading || !config?.hasAppSecret}
                  >
                    {oauthLoading ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : (
                      <ExternalLink className="size-3" />
                    )}
                    授权飞书文档访问
                  </Button>
                </div>
              )}

              {!config?.hasAppSecret && !oauthStatus?.authorized && (
                <p className="text-xs text-warning mt-1">
                  请先保存飞书 App ID 和 App Secret
                </p>
              )}
            </div>

            {/* Reply Threading Mode */}
            <div className="pt-3 border-t border-border-subtle">
              <div className="flex items-center justify-between gap-4">
                <div className="flex-1">
                  <h4 className="text-xs font-semibold text-foreground">
                    Agent 自主回复模式
                  </h4>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    开启后 Agent 可以指定回复哪条消息（需要 Agent 在
                    send_message 中传入 reply_to_message_id）。
                    关闭时自动选择触发消息作为回复目标。
                  </p>
                </div>
                <ToggleSwitch
                  checked={config?.replyThreadingMode === 'agent'}
                  disabled={savingThreadingMode}
                  onChange={async (v) => {
                    setSavingThreadingMode(true);
                    setNotice(null);
                    setError(null);
                    try {
                      const data = await api.put<UserFeishuConfig>(
                        '/api/config/im/feishu',
                        {
                          replyThreadingMode: v ? 'agent' : 'auto',
                        },
                      );
                      setConfig(data);
                      setNotice(
                        `回复线程模式已切换为${v ? ' Agent 自主' : '自动'}模式`,
                      );
                    } catch (err) {
                      setError(getErrorMessage(err, '切换回复模式失败'));
                    } finally {
                      setSavingThreadingMode(false);
                    }
                  }}
                  aria-label="Agent 自主回复模式"
                />
              </div>
            </div>

            {/* Verified card action callback */}
            <div className="pt-3 border-t border-border-subtle space-y-3">
              <div>
                <h4 className="text-xs font-semibold text-foreground">
                  卡片按钮回调
                </h4>
                <p className="text-xs text-muted-foreground mt-0.5">
                  配置后，执行进度卡会显示「停止」按钮。请在飞书开放平台把卡片回调地址设为：
                </p>
                <code className="mt-1.5 block rounded bg-surface-2 px-2 py-1 text-[11px] break-all select-all text-foreground">
                  {`${window.location.origin}/api/feishu/card-action`}
                </code>
              </div>
              <div className="grid md:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">
                    Verification Token
                    {config?.hasCardVerificationToken && (
                      <span className="ml-1 text-success">已配置</span>
                    )}
                  </label>
                  <Input
                    type="password"
                    value={cardVerificationToken}
                    onChange={(e) => setCardVerificationToken(e.target.value)}
                    placeholder={
                      config?.hasCardVerificationToken
                        ? '留空不修改'
                        : '输入 Verification Token'
                    }
                  />
                </div>
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">
                    Encrypt Key（可选）
                    {config?.hasCardEncryptKey && (
                      <span className="ml-1 text-success">已配置</span>
                    )}
                  </label>
                  <Input
                    type="password"
                    value={cardEncryptKey}
                    onChange={(e) => setCardEncryptKey(e.target.value)}
                    placeholder={
                      config?.hasCardEncryptKey
                        ? '留空不修改'
                        : '未启用加密回调可留空'
                    }
                  />
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleSaveCardCallback}
                  disabled={
                    savingCardCallback ||
                    (!cardVerificationToken.trim() && !cardEncryptKey.trim())
                  }
                >
                  {savingCardCallback && (
                    <Loader2 className="size-3 animate-spin" />
                  )}
                  保存回调配置
                </Button>
                {config?.hasCardVerificationToken && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      clearCardCallbackSecret('clearCardVerificationToken')
                    }
                    disabled={savingCardCallback}
                  >
                    清除 Token
                  </Button>
                )}
                {config?.hasCardEncryptKey && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      clearCardCallbackSecret('clearCardEncryptKey')
                    }
                    disabled={savingCardCallback}
                  >
                    清除 Encrypt Key
                  </Button>
                )}
              </div>
            </div>

            {/* Streaming Progress Card */}
            <div className="pt-3 border-t border-border-subtle">
              <div className="flex items-center justify-between gap-4">
                <div className="flex-1">
                  <h4 className="text-xs font-semibold text-foreground">
                    执行进度卡片
                  </h4>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    开启后使用 CardKit 流式回复，并实时显示 Agent
                    的工具调用和执行状态；完成后进度卡自动删除。
                  </p>
                </div>
                <ToggleSwitch
                  checked={config?.streamingCard ?? false}
                  disabled={savingStreamingCard}
                  onChange={async (v) => {
                    setSavingStreamingCard(true);
                    setNotice(null);
                    setError(null);
                    try {
                      const data = await api.put<UserFeishuConfig>(
                        '/api/config/im/feishu',
                        {
                          streamingCard: v,
                        },
                      );
                      setConfig(data);
                      setNotice(`执行进度卡片已${v ? '开启' : '关闭'}`);
                    } catch (err) {
                      setError(getErrorMessage(err, '切换进度卡片失败'));
                    } finally {
                      setSavingStreamingCard(false);
                    }
                  }}
                  aria-label="执行进度卡片"
                />
              </div>
            </div>
            <div className="pt-3 border-t border-border-subtle">
              <div className="flex items-center justify-between gap-4">
                <div className="flex-1">
                  <h4 className="text-xs font-semibold text-foreground">
                    IM 实时解说
                  </h4>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    开启后在 Agent
                    执行每个工具调用时，自动向飞书发送一条自然语言说明（8
                    秒节流）。
                  </p>
                </div>
                <ToggleSwitch
                  checked={config?.imCommentary ?? false}
                  disabled={savingImCommentary}
                  onChange={async (v) => {
                    setSavingImCommentary(true);
                    setNotice(null);
                    setError(null);
                    try {
                      const data = await api.put<UserFeishuConfig>(
                        '/api/config/im/feishu',
                        {
                          imCommentary: v,
                        },
                      );
                      setConfig(data);
                      setNotice(`IM 实时解说已${v ? '开启' : '关闭'}`);
                    } catch (err) {
                      setError(getErrorMessage(err, '切换 IM 解说失败'));
                    } finally {
                      setSavingImCommentary(false);
                    }
                  }}
                  aria-label="IM 实时解说"
                />
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
