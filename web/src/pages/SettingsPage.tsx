import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Menu } from 'lucide-react';

import { useAuthStore } from '../stores/auth';
import { SettingsNav } from '../components/settings/SettingsNav';
import { ClaudeProviderSection } from '../components/settings/ClaudeProviderSection';
import { CodexProviderSection } from '../components/settings/CodexProviderSection';
import { ProfileSection } from '../components/settings/ProfileSection';
import { AboutSection } from '../components/settings/AboutSection';
import { AppearanceSection } from '../components/settings/AppearanceSection';
import { SystemSettingsSection } from '../components/settings/SystemSettingsSection';
import { UserChannelsSection } from '../components/settings/UserChannelsSection';
import { SessionsPage } from './GroupsPage';
import { MemoryPage } from './MemoryPage';
import { RunnersPage } from './RunnersPage';
import { SkillsPage } from './SkillsPage';
import { McpServersPage } from './McpServersPage';
import { BindingsSection } from '../components/settings/BindingsSection';
import { AgentDefinitionsPage } from './AgentDefinitionsPage';
import type { SettingsTab } from '../components/settings/types';

const VALID_TABS: SettingsTab[] = ['claude', 'codex', 'runners', 'appearance', 'system', 'profile', 'my-channels', 'sessions', 'memory', 'skills', 'mcp-servers', 'agent-definitions', 'about', 'bindings'];
const SYSTEM_TABS: SettingsTab[] = ['claude', 'codex', 'runners', 'appearance', 'system'];
const FULLPAGE_TABS: SettingsTab[] = ['sessions', 'memory', 'runners', 'skills', 'mcp-servers', 'agent-definitions', 'bindings'];

export function SettingsPage() {
  const { user: currentUser } = useAuthStore();
  const [searchParams, setSearchParams] = useSearchParams();
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [navOpen, setNavOpen] = useState(false);

  const hasSystemConfigPermission =
    currentUser?.role === 'admin' || !!currentUser?.permissions.includes('manage_system_config');
  const mustChangePassword = !!currentUser?.must_change_password;
  const canManageSystemConfig = hasSystemConfigPermission && !mustChangePassword;

  const defaultTab: SettingsTab = canManageSystemConfig ? 'runners' : 'profile';

  const activeTab = useMemo((): SettingsTab => {
    if (mustChangePassword) return 'profile';
    const rawParam = searchParams.get('tab');
    const normalized = rawParam === 'groups' ? 'sessions' : rawParam;
    if (normalized && (VALID_TABS as string[]).includes(normalized)) {
      const tab = normalized as SettingsTab;
      if (SYSTEM_TABS.includes(tab) && !canManageSystemConfig) return defaultTab;
      return tab;
    }
    return defaultTab;
  }, [searchParams, canManageSystemConfig, mustChangePassword, defaultTab]);

  const handleTabChange = useCallback((tab: SettingsTab) => {
    setNotice(null);
    setError(null);
    setNavOpen(false);
    setSearchParams({ tab }, { replace: true });
  }, [setSearchParams]);

  // Mobile horizontal tab bar
  const mobileTabs = useMemo(() => {
    const tabs: { key: SettingsTab; label: string }[] = [];
    tabs.push({ key: 'profile', label: '个人资料' });
    tabs.push({ key: 'my-channels', label: '消息渠道' });
    if (canManageSystemConfig) {
      tabs.push({ key: 'runners', label: 'Runners' });
      tabs.push({ key: 'claude', label: 'Claude' });
      tabs.push({ key: 'codex', label: 'Codex' });
      tabs.push({ key: 'appearance', label: '外观' });
      tabs.push({ key: 'system', label: '系统' });
    }
    tabs.push({ key: 'sessions', label: '会话' });
    tabs.push({ key: 'memory', label: '记忆' });
    tabs.push({ key: 'skills', label: '技能' });
    tabs.push({ key: 'mcp-servers', label: 'MCP' });
    tabs.push({ key: 'agent-definitions', label: 'Agent' });
    tabs.push({ key: 'bindings', label: 'IM 绑定' });
    tabs.push({ key: 'about', label: '关于' });
    return tabs;
  }, [canManageSystemConfig]);

  const tabBarRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = tabBarRef.current;
    if (!container) return;
    const activeEl = container.querySelector('[data-active="true"]');
    if (activeEl) {
      activeEl.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
    }
  }, [activeTab]);

  const sectionTitle: Record<SettingsTab, string> = {
    claude: 'Claude 兼容桥接',
    codex: 'Codex 兼容桥接',
    runners: 'Runner 注册表',
    appearance: '外观设置（全局默认）',
    system: '系统参数',
    profile: '个人资料',
    'my-channels': '消息渠道',
    sessions: '会话管理',
    memory: '记忆管理',
    skills: '技能管理',
    'mcp-servers': 'MCP 服务器',
    'agent-definitions': 'Agent 定义',
    about: '关于',
    bindings: 'IM 绑定',
  };

  return (
    <div className="min-h-full bg-background flex flex-col lg:flex-row">
      {/* Mobile header */}
      <div
        className="lg:hidden sticky top-0 z-10 flex items-center bg-background border-b border-border px-4 h-12"
      >
        <button
          onClick={() => setNavOpen(true)}
          className="p-1.5 -ml-1.5 rounded-lg hover:bg-slate-100 transition-colors"
          aria-label="打开导航"
        >
          <Menu className="w-5 h-5 text-slate-600" />
        </button>
        <span className="ml-3 text-sm font-semibold text-slate-900 truncate">{sectionTitle[activeTab]}</span>
      </div>

      {/* Mobile horizontal tab bar */}
      <div
        ref={tabBarRef}
        className="lg:hidden flex items-center gap-1 px-3 py-2 overflow-x-auto bg-background border-b border-border [touch-action:pan-x] [&::-webkit-scrollbar]:hidden"
        style={{ scrollbarWidth: 'none', WebkitOverflowScrolling: 'touch' } as React.CSSProperties}
      >
        {mobileTabs.map((tab) => {
          const isActive = activeTab === tab.key;
          const disabled = mustChangePassword && tab.key !== 'profile';
          return (
            <button
              key={tab.key}
              data-active={isActive}
              onClick={() => !disabled && handleTabChange(tab.key)}
              disabled={disabled}
              className={`flex-shrink-0 px-3 py-1.5 rounded-full text-xs font-medium transition-colors whitespace-nowrap cursor-pointer ${
                isActive
                  ? 'bg-primary text-white'
                  : disabled
                    ? 'text-slate-300'
                    : 'text-slate-500 hover:bg-slate-100 hover:text-slate-700'
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      <SettingsNav
        activeTab={activeTab}
        onTabChange={handleTabChange}
        canManageSystemConfig={canManageSystemConfig}
        mustChangePassword={mustChangePassword}
        open={navOpen}
        onOpenChange={setNavOpen}
      />

      <div className="flex-1 min-w-0 overflow-visible lg:overflow-y-auto">
        {FULLPAGE_TABS.includes(activeTab) ? (
          <>
            {activeTab === 'sessions' && <SessionsPage />}
            {activeTab === 'memory' && <MemoryPage />}
            {activeTab === 'runners' && <RunnersPage />}
            {activeTab === 'skills' && <SkillsPage />}
            {activeTab === 'mcp-servers' && <McpServersPage />}
            {activeTab === 'agent-definitions' && <AgentDefinitionsPage />}
            {activeTab === 'bindings' && <BindingsSection />}
          </>
        ) : (
          <div className="p-4 lg:p-8">
            <div className="max-w-3xl mx-auto space-y-6">
              <div>
                <h1 className="text-2xl font-bold text-slate-900">{sectionTitle[activeTab]}</h1>
              </div>

              {mustChangePassword && (
                <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-800">
                  检测到首次登录或管理员重置密码，请先完成"修改密码"，其余关键操作会被暂时限制。
                </div>
              )}

              {(notice || error) && (
                <div className="bg-card rounded-xl border border-border p-4 space-y-1">
                  {notice && <div className="text-sm text-green-600">{notice}</div>}
                  {error && <div className="text-sm text-red-600">{error}</div>}
                </div>
              )}

              <div className="bg-card rounded-xl border border-border p-6">
                {activeTab === 'claude' && <ClaudeProviderSection setNotice={setNotice} setError={setError} />}
                {activeTab === 'codex' && <CodexProviderSection setNotice={setNotice} setError={setError} />}
                {activeTab === 'appearance' && <AppearanceSection setNotice={setNotice} setError={setError} />}
                {activeTab === 'system' && <SystemSettingsSection setNotice={setNotice} setError={setError} />}
                {activeTab === 'profile' && <ProfileSection setNotice={setNotice} setError={setError} />}
                {activeTab === 'my-channels' && <UserChannelsSection setNotice={setNotice} setError={setError} />}
                {activeTab === 'about' && <AboutSection />}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
