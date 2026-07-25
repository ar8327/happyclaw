import { useEffect, useMemo } from 'react';
import { ChevronLeft, ChevronRight, RefreshCw, Users } from 'lucide-react';
import { useSessionsStore } from '../stores/sessions';
import { SessionCard } from '../components/sessions/SessionCard';
import { PageHeader } from '@/components/common/PageHeader';
import { SearchInput } from '@/components/common/SearchInput';
import { SkeletonCardGrid } from '@/components/common/Skeletons';
import { EmptyState } from '@/components/common/EmptyState';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

function getVisiblePages(page: number, totalPages: number): number[] {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  }
  const start = Math.max(1, Math.min(page - 2, totalPages - 4));
  return Array.from({ length: 5 }, (_, index) => start + index);
}

export function SessionsPage() {
  const {
    sessions,
    loading,
    error,
    query,
    page,
    total,
    totalPages,
    loadSessions,
    setQuery,
    setPage,
  } = useSessionsStore();

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  const sessionCards = Object.entries(sessions).map(([jid, info]) => ({
    jid,
    ...info,
  }));
  const visiblePages = useMemo(
    () => getVisiblePages(page, totalPages),
    [page, totalPages],
  );

  return (
    <div className="min-h-full bg-background p-4 lg:p-8">
      <div className="max-w-7xl mx-auto">
        <PageHeader
          title="会话管理"
          subtitle={`${total} 个已注册会话`}
          className="mb-6"
        />

        <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder="按名称、ID 或工作目录搜索..."
            debounce={250}
            className="w-full sm:max-w-md"
          />
          {totalPages > 0 && (
            <span className="text-sm text-muted-foreground whitespace-nowrap">
              第 {page} / {totalPages} 页
            </span>
          )}
        </div>

        {error && (
          <div className="mb-5 flex items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3">
            <span className="text-sm text-destructive">
              会话加载失败：{error}
            </span>
            <Button variant="outline" size="sm" onClick={() => loadSessions()}>
              <RefreshCw className="size-4" />
              重试
            </Button>
          </div>
        )}

        {loading && <SkeletonCardGrid />}

        {!loading && !error && sessionCards.length === 0 && (
          <EmptyState
            icon={Users}
            title={query ? '没有匹配的会话' : '暂无会话'}
            description={
              query
                ? '换一个名称、会话 ID 或目录关键词试试'
                : '当前还没有可展示的会话'
            }
          />
        )}

        {!loading && sessionCards.length > 0 && (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {sessionCards.map((session) => (
                <SessionCard key={session.jid} session={session} />
              ))}
            </div>

            {totalPages > 1 && (
              <nav
                className="mt-8 flex items-center justify-center gap-1"
                aria-label="会话分页"
              >
                <Button
                  variant="outline"
                  size="icon-sm"
                  disabled={page <= 1 || loading}
                  onClick={() => setPage(page - 1)}
                  aria-label="上一页"
                >
                  <ChevronLeft className="size-4" />
                </Button>
                {visiblePages[0] > 1 && (
                  <span className="px-1 text-muted-foreground">…</span>
                )}
                {visiblePages.map((pageNumber) => (
                  <button
                    key={pageNumber}
                    type="button"
                    disabled={loading}
                    onClick={() => setPage(pageNumber)}
                    className={cn(
                      'size-8 rounded-md text-sm transition-colors',
                      pageNumber === page
                        ? 'bg-primary text-primary-foreground'
                        : 'hover:bg-accent text-muted-foreground hover:text-foreground',
                    )}
                    aria-current={pageNumber === page ? 'page' : undefined}
                  >
                    {pageNumber}
                  </button>
                ))}
                {visiblePages.at(-1)! < totalPages && (
                  <span className="px-1 text-muted-foreground">…</span>
                )}
                <Button
                  variant="outline"
                  size="icon-sm"
                  disabled={page >= totalPages || loading}
                  onClick={() => setPage(page + 1)}
                  aria-label="下一页"
                >
                  <ChevronRight className="size-4" />
                </Button>
              </nav>
            )}
          </>
        )}
      </div>
    </div>
  );
}
