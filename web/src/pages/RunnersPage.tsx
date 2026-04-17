import { useEffect, useMemo, useState } from 'react';
import { Cpu, Loader2, Plus, Save, Trash2 } from 'lucide-react';

import { api } from '../api/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

interface RunnerInfo {
  id: string;
  label: string;
  can_serve_memory: boolean;
  compatibility: {
    chat: string;
    memory: string;
    im: string;
    observability: string;
  };
  capabilities: {
    sessionResume: string;
    interrupt: string;
    toolStreaming: string;
    midQueryPush: boolean;
    backgroundTasks: boolean;
  };
  lifecycle: {
    archivalTrigger: string[];
    contextShrinkTrigger: string;
    hookStreaming: string;
  };
  prompt_contract: {
    mode: string;
    dynamicContextReload: string;
  };
  degradation_reasons: string[];
}

interface RunnerProfileItem {
  id: string;
  runner_id: string;
  name: string;
  config_json: string;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

const EMPTY_PROFILE_FORM = {
  id: '',
  name: '',
  config_json: '{}',
  is_default: false,
};

export function RunnersPage() {
  const [runners, setRunners] = useState<RunnerInfo[]>([]);
  const [profiles, setProfiles] = useState<RunnerProfileItem[]>([]);
  const [selectedRunnerId, setSelectedRunnerId] = useState<string>('');
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);
  const [profileForm, setProfileForm] = useState(EMPTY_PROFILE_FORM);
  const [loading, setLoading] = useState(true);
  const [profilesLoading, setProfilesLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadRunners = async () => {
    const data = await api.get<{ runners: RunnerInfo[] }>('/api/sessions/runners');
    setRunners(data.runners);
    setSelectedRunnerId((prev) =>
      data.runners.some((runner) => runner.id === prev)
        ? prev
        : (data.runners[0]?.id || ''),
    );
  };

  const loadProfiles = async (runnerId: string) => {
    if (!runnerId) {
      setProfiles([]);
      return;
    }
    setProfilesLoading(true);
    try {
      const data = await api.get<{ profiles: RunnerProfileItem[] }>(
        `/api/sessions/runner-profiles?${new URLSearchParams({ runner_id: runnerId })}`,
      );
      setProfiles(data.profiles);
    } finally {
      setProfilesLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([loadRunners()])
      .then(() => {
        if (cancelled) return;
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : '加载 runner 信息失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!selectedRunnerId) {
      setProfiles([]);
      return;
    }
    loadProfiles(selectedRunnerId).catch((err) => {
      setError(err instanceof Error ? err.message : '加载 runner profile 失败');
    });
  }, [selectedRunnerId]);

  const selectedRunner = useMemo(
    () => runners.find((runner) => runner.id === selectedRunnerId) || null,
    [runners, selectedRunnerId],
  );

  const resetForm = () => {
    setEditingProfileId(null);
    setProfileForm(EMPTY_PROFILE_FORM);
  };

  const startCreate = () => {
    setNotice(null);
    setError(null);
    setEditingProfileId(null);
    setProfileForm({
      id: '',
      name: '',
      config_json: '{}',
      is_default: profiles.length === 0,
    });
  };

  const startEdit = (profile: RunnerProfileItem) => {
    setNotice(null);
    setError(null);
    setEditingProfileId(profile.id);
    setProfileForm({
      id: profile.id,
      name: profile.name,
      config_json: profile.config_json,
      is_default: profile.is_default,
    });
  };

  const saveProfile = async () => {
    if (!profileForm.name.trim()) {
      setError('Profile 名称不能为空');
      return;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      JSON.parse(profileForm.config_json || '{}');
      if (editingProfileId) {
        await api.patch(`/api/sessions/runner-profiles/${encodeURIComponent(editingProfileId)}`, {
          runner_id: selectedRunnerId,
          name: profileForm.name.trim(),
          config_json: profileForm.config_json || '{}',
          is_default: profileForm.is_default,
        });
        setNotice('Runner profile 已更新');
      } else {
        await api.post('/api/sessions/runner-profiles', {
          runner_id: selectedRunnerId,
          name: profileForm.name.trim(),
          config_json: profileForm.config_json || '{}',
          is_default: profileForm.is_default,
        });
        setNotice('Runner profile 已创建');
      }
      await loadProfiles(selectedRunnerId);
      resetForm();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存 runner profile 失败');
    } finally {
      setSaving(false);
    }
  };

  const removeProfile = async (profile: RunnerProfileItem) => {
    if (!confirm(`确定删除 profile「${profile.name}」吗？`)) return;
    setError(null);
    setNotice(null);
    try {
      await api.delete(`/api/sessions/runner-profiles/${encodeURIComponent(profile.id)}`);
      if (editingProfileId === profile.id) resetForm();
      await loadProfiles(selectedRunnerId);
      setNotice('Runner profile 已删除');
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除 runner profile 失败');
    }
  };

  return (
    <div className="min-h-full bg-background p-4 lg:p-8">
      <div className="max-w-6xl mx-auto space-y-4">
        <div className="bg-card rounded-xl border border-border p-6">
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 bg-brand-100 rounded-lg">
              <Cpu className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-foreground">Runner 注册表</h1>
              <p className="text-sm text-slate-500 mt-0.5">
                管理 runner 能力矩阵，以及 session 与 memory 可选的 profile。
              </p>
            </div>
          </div>
        </div>

        {(notice || error) && (
          <div className="bg-card rounded-xl border border-border p-4 space-y-1">
            {notice && <div className="text-sm text-green-600">{notice}</div>}
            {error && <div className="text-sm text-red-600">{error}</div>}
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-12 text-slate-500">
            <Loader2 className="w-5 h-5 animate-spin mr-2" />
            加载中...
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              {runners.map((runner) => (
                <div key={runner.id} className="bg-card rounded-xl border border-border p-5 space-y-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-lg font-semibold text-foreground">{runner.label}</div>
                      <div className="text-xs font-mono text-slate-500 mt-1">{runner.id}</div>
                    </div>
                    <div className="text-right text-xs text-slate-500 space-y-1">
                      <div>chat: {runner.compatibility.chat}</div>
                      <div>IM: {runner.compatibility.im}</div>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div className="rounded-lg bg-muted/40 px-3 py-2">
                      会话恢复
                      <div className="mt-1 text-foreground font-medium">{runner.capabilities.sessionResume}</div>
                    </div>
                    <div className="rounded-lg bg-muted/40 px-3 py-2">
                      中断能力
                      <div className="mt-1 text-foreground font-medium">{runner.capabilities.interrupt}</div>
                    </div>
                    <div className="rounded-lg bg-muted/40 px-3 py-2">
                      工具流
                      <div className="mt-1 text-foreground font-medium">{runner.capabilities.toolStreaming}</div>
                    </div>
                    <div className="rounded-lg bg-muted/40 px-3 py-2">
                      Memory Runner
                      <div className="mt-1 text-foreground font-medium">
                        {runner.can_serve_memory ? '支持' : '不支持'}
                      </div>
                    </div>
                  </div>

                  <div className="text-xs text-slate-500 space-y-1">
                    <div>归档触发: {runner.lifecycle.archivalTrigger.join(' / ') || 'none'}</div>
                    <div>上下文收缩: {runner.lifecycle.contextShrinkTrigger}</div>
                    <div>Hook 可观测性: {runner.lifecycle.hookStreaming}</div>
                    <div>Prompt 模式: {runner.prompt_contract.mode}</div>
                    <div>上下文刷新: {runner.prompt_contract.dynamicContextReload}</div>
                    <div>中途注入: {runner.capabilities.midQueryPush ? '支持' : '不支持'}</div>
                    <div>后台任务: {runner.capabilities.backgroundTasks ? '支持' : '不支持'}</div>
                  </div>

                  {runner.degradation_reasons.length > 0 && (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 space-y-1">
                      <div className="text-xs font-medium text-amber-700">退化说明</div>
                      {runner.degradation_reasons.map((reason) => (
                        <div key={reason} className="text-xs text-amber-700">
                          {reason}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-[1.2fr_0.8fr] gap-4">
              <div className="bg-card rounded-xl border border-border p-5 space-y-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-lg font-semibold text-foreground">Runner Profiles</div>
                    <div className="text-sm text-slate-500 mt-0.5">
                      这些 profile 会出现在 session 与 memory 配置里。
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <select
                      value={selectedRunnerId}
                      onChange={(e) => {
                        setSelectedRunnerId(e.target.value);
                        resetForm();
                      }}
                      className="h-9 rounded-md border border-border bg-background px-3 text-sm"
                    >
                      {runners.map((runner) => (
                        <option key={runner.id} value={runner.id}>
                          {runner.label}
                        </option>
                      ))}
                    </select>
                    <Button size="sm" variant="outline" onClick={startCreate}>
                      <Plus className="w-4 h-4" />
                      新建
                    </Button>
                  </div>
                </div>

                {profilesLoading ? (
                  <div className="flex items-center justify-center py-8 text-slate-500">
                    <Loader2 className="w-4 h-4 animate-spin mr-2" />
                    加载 profile 中...
                  </div>
                ) : profiles.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-slate-500">
                    当前 runner 还没有 profile。
                  </div>
                ) : (
                  <div className="space-y-3">
                    {profiles.map((profile) => (
                      <div
                        key={profile.id}
                        className={`rounded-lg border px-4 py-3 ${
                          editingProfileId === profile.id
                            ? 'border-primary bg-brand-50/40'
                            : 'border-border'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <div className="text-sm font-medium text-foreground">
                              {profile.name}
                              {profile.is_default ? ' · 默认' : ''}
                            </div>
                            <div className="text-xs text-slate-500 font-mono mt-1">
                              {profile.id}
                            </div>
                            <div className="text-xs text-slate-400 mt-1">
                              更新于 {new Date(profile.updated_at).toLocaleString('zh-CN')}
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <Button size="sm" variant="outline" onClick={() => startEdit(profile)}>
                              编辑
                            </Button>
                            <Button size="sm" variant="outline" onClick={() => removeProfile(profile)}>
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="bg-card rounded-xl border border-border p-5 space-y-4">
                <div>
                  <div className="text-lg font-semibold text-foreground">
                    {editingProfileId ? '编辑 Profile' : '新建 Profile'}
                  </div>
                  <div className="text-sm text-slate-500 mt-0.5">
                    `config_json` 只放 runner 行为配置，不放应用代管凭据。
                  </div>
                </div>

                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">
                      名称
                    </label>
                    <Input
                      value={profileForm.name}
                      onChange={(e) =>
                        setProfileForm((prev) => ({ ...prev, name: e.target.value }))
                      }
                      placeholder={selectedRunner ? `${selectedRunner.label} Profile` : 'Profile 名称'}
                    />
                  </div>

                  <label className="flex items-center gap-2 text-sm text-slate-600">
                    <input
                      type="checkbox"
                      checked={profileForm.is_default}
                      onChange={(e) =>
                        setProfileForm((prev) => ({ ...prev, is_default: e.target.checked }))
                      }
                      className="w-4 h-4 rounded border-slate-300"
                    />
                    设为当前 runner 的默认 profile
                  </label>

                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">
                      config_json
                    </label>
                    <Textarea
                      value={profileForm.config_json}
                      onChange={(e) =>
                        setProfileForm((prev) => ({ ...prev, config_json: e.target.value }))
                      }
                      className="min-h-[220px] font-mono text-xs"
                      placeholder="{}"
                    />
                  </div>

                  <div className="flex items-center gap-2">
                    <Button size="sm" onClick={saveProfile} disabled={saving}>
                      {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
                      保存
                    </Button>
                    <Button size="sm" variant="outline" onClick={resetForm} disabled={saving}>
                      清空
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
