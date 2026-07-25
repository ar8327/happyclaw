import { useMemo } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { Monitor, Moon, Sun } from 'lucide-react';

import { useAuthStore } from '../../stores/auth';
import { useTheme } from '../../hooks/useTheme';
import { EmojiAvatar } from '../common/EmojiAvatar';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { baseNavItems } from './nav-items';

export function NavRail() {
  const user = useAuthStore((s) => s.user);
  const navigate = useNavigate();
  const navItems = useMemo(() => baseNavItems, []);
  const { mode, toggle } = useTheme();

  const userInitial = (user?.display_name || user?.username || '?')[0].toUpperCase();

  const ModeIcon = mode === 'light' ? Sun : mode === 'dark' ? Moon : Monitor;
  const modeLabel =
    mode === 'light' ? '亮色（点击切换到暗色）'
    : mode === 'dark' ? '暗色（点击跟随系统）'
    : '跟随系统（点击切换到亮色）';

  return (
    <TooltipProvider delayDuration={200}>
      <nav className="w-16 h-full bg-sidebar border-r border-sidebar-border flex flex-col items-center py-4 gap-1.5">
        {/* Logo */}
        <div className="w-10 h-10 rounded-xl overflow-hidden mb-2 flex-shrink-0 shadow-sm">
          <img
            src={`${import.meta.env.BASE_URL}icons/icon-192.png`}
            alt="AgentDock"
            className="w-full h-full object-cover"
          />
        </div>

        {navItems.map(({ path, icon: Icon, label }) => (
          <Tooltip key={path}>
            <TooltipTrigger asChild>
              <NavLink
                to={path}
                className={({ isActive }) =>
                  `group relative w-12 h-12 rounded-xl flex flex-col items-center justify-center gap-0.5 transition-all duration-200 ${
                    isActive
                      ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
                      : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground active:scale-95'
                  }`
                }
              >
                {({ isActive }) => (
                  <>
                    {/* 左侧激活指示条 */}
                    <span
                      className={`absolute left-0 top-1/2 -translate-y-1/2 w-0.5 rounded-r-full bg-primary transition-all duration-200 ${
                        isActive ? 'h-6 opacity-100' : 'h-0 opacity-0'
                      }`}
                    />
                    <Icon className="w-5 h-5" />
                    <span className="text-[10px] leading-none">{label}</span>
                  </>
                )}
              </NavLink>
            </TooltipTrigger>
            <TooltipContent side="right">{label}</TooltipContent>
          </Tooltip>
        ))}

        <div className="flex-1" />

        <div className="flex flex-col items-center gap-1.5 mb-1">
          {/* 明暗快捷切换 */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={toggle}
                aria-label={modeLabel}
                className="w-9 h-9 rounded-xl flex items-center justify-center text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground active:scale-95 transition-all cursor-pointer"
              >
                <ModeIcon className="w-4.5 h-4.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">{modeLabel}</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => navigate('/settings?tab=profile')}
                className="rounded-xl ring-2 ring-transparent hover:ring-primary/40 transition-all cursor-pointer"
              >
                <EmojiAvatar
                  emoji={user?.avatar_emoji}
                  color={user?.avatar_color}
                  fallbackChar={userInitial}
                  size="md"
                  className="w-9 h-9"
                />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">
              {user?.display_name || user?.username}
            </TooltipContent>
          </Tooltip>
        </div>
      </nav>
    </TooltipProvider>
  );
}
