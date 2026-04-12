import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { type Permission, useAuthStore } from '../../stores/auth';

interface AuthGuardProps {
  children: React.ReactNode;
  requireAdmin?: boolean;
  requiredPermission?: Permission;
  requiredAnyPermissions?: Permission[];
}

export function AuthGuard({
  children,
  requireAdmin,
  requiredPermission,
  requiredAnyPermissions,
}: AuthGuardProps) {
  const { authenticated, checking, checkAuth, user, initialized, hasPermission } = useAuthStore();
  const navigate = useNavigate();
  const checkedRef = useRef(false);
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    if (checkedRef.current) return;
    checkedRef.current = true;
    void checkAuth();
  }, [checkAuth]);

  useEffect(() => {
    if (!checking) {
      setTimedOut(false);
      return;
    }
    const timer = window.setTimeout(() => setTimedOut(true), 12000);
    return () => window.clearTimeout(timer);
  }, [checking]);

  if (checking) {
    if (timedOut) {
      return (
        <div className="min-h-screen bg-background flex items-center justify-center p-6">
          <div className="max-w-md text-center bg-card rounded-xl border border-border p-6">
            <h2 className="text-lg font-semibold text-foreground mb-2">页面初始化超时</h2>
            <p className="text-sm text-slate-600 mb-4">
              后端可能刚启动或浏览器缓存异常，请先刷新页面；若仍失败，重新登录。
            </p>
            <div className="flex items-center justify-center gap-3">
              <button
                onClick={() => window.location.reload()}
                className="px-4 py-2 text-sm rounded-lg bg-primary text-white hover:bg-primary/90"
              >
                刷新页面
              </button>
                <button
                  onClick={() => {
                    navigate('/chat', { replace: true });
                  }}
                className="px-4 py-2 text-sm rounded-lg border border-slate-300 text-slate-700 hover:bg-slate-100"
              >
                返回工作台
              </button>
            </div>
          </div>
        </div>
      );
    }
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="w-16 h-16 text-primary animate-spin mx-auto mb-4" />
          <p className="text-slate-500">加载中...</p>
        </div>
      </div>
    );
  }

  if (initialized === false || !authenticated) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-6">
        <div className="max-w-md text-center bg-card rounded-xl border border-border p-6">
          <h2 className="text-lg font-semibold text-foreground mb-2">本地工作台初始化中</h2>
          <p className="text-sm text-slate-600">
            后端尚未准备好，刷新页面后会自动恢复本地单用户上下文。
          </p>
        </div>
      </div>
    );
  }

  if (requireAdmin && user?.role !== 'admin') {
    return null;
  }

  if (requiredPermission && !hasPermission(requiredPermission)) {
    return null;
  }

  if (requiredAnyPermissions && requiredAnyPermissions.length > 0) {
    const matched = requiredAnyPermissions.some((perm) => hasPermission(perm));
    if (!matched) return null;
  }

  return <>{children}</>;
}
