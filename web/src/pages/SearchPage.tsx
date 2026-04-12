import { useCallback, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, X, Loader2 } from 'lucide-react';
import { useSearchStore, type GlobalSearchResult } from '../stores/search';
import { cn } from '@/lib/utils';

const TIME_RANGES = [
  { days: 3, label: '3天' },
  { days: 7, label: '7天' },
  { days: 30, label: '30天' },
  { days: 0, label: '全部' },
] as const;

/** Build a single-line excerpt around the first match of query in content */
function buildExcerpt(content: string, query: string): { before: string; match: string; after: string } | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const lower = content.toLowerCase();
  const idx = lower.indexOf(q);
  if (idx < 0) return null;

  const maxLen = 80;
  const start = Math.max(0, idx - 25);
  const end = Math.min(content.length, idx + q.length + maxLen - 25);
  const before = (start > 0 ? '...' : '') + content.slice(start, idx);
  const match = content.slice(idx, idx + q.length);
  const after = content.slice(idx + q.length, end) + (end < content.length ? '...' : '');
  return { before, match, after };
}

export function SearchPage() {
  const navigate = useNavigate();
  const {
    query,
    days,
    results,
    total,
    hasMore,
    loading,
    loadingMore,
    searched,
    setQuery,
    setDays,
    search,
    loadMore,
    clear,
  } = useSearchStore();

  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleInputChange = useCallback(
    (value: string) => {
      setQuery(value);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        search(value);
      }, 300);
    },
    [setQuery, search],
  );

  const handleDaysChange = useCallback(
    (newDays: number) => {
      setDays(newDays);
      if (query.trim()) {
        search(query, newDays);
      }
    },
    [query, setDays, search],
  );

  const handleClear = useCallback(() => {
    clear();
    inputRef.current?.focus();
  }, [clear]);

  const handleResultClick = useCallback(
    (result: GlobalSearchResult) => {
      const sessionSlug = result.session_id || result.session_folder || result.group_folder;
      if (sessionSlug) {
        navigate(`/chat/${encodeURIComponent(sessionSlug)}?highlightId=${encodeURIComponent(result.id)}&ts=${encodeURIComponent(result.timestamp)}`);
      }
    },
    [navigate],
  );

  const formatTime = (ts: string) => {
    const d = new Date(ts);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const isYesterday = d.toDateString() === yesterday.toDateString();

    const time = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

    if (isToday) return time;
    if (isYesterday) return `昨天 ${time}`;
    if (d.getFullYear() === now.getFullYear()) {
      return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' }) + ' ' + time;
    }
    return d.toLocaleDateString('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' }) + ' ' + time;
  };

  const renderResultLine = (result: GlobalSearchResult) => {
    const excerpt = buildExcerpt(result.content, query);
    if (!excerpt) {
      const text = result.content.length > 100 ? result.content.slice(0, 100) + '...' : result.content;
      return <span className="text-muted-foreground">{text}</span>;
    }
    return (
      <>
        <span className="text-muted-foreground">{excerpt.before}</span>
        <mark className="bg-yellow-200 dark:bg-yellow-800 text-foreground rounded-sm px-0.5">{excerpt.match}</mark>
        <span className="text-muted-foreground">{excerpt.after}</span>
      </>
    );
  };

  // Group results by session
  const grouped = results.reduce<Record<string, { name: string; results: GlobalSearchResult[] }>>(
    (acc, result) => {
      const key = result.session_id || result.session_folder || result.group_folder || 'unknown';
      if (!acc[key]) {
        acc[key] = {
          name: result.session_name || result.group_name || result.session_folder || result.group_folder || key,
          results: [],
        };
      }
      acc[key].results.push(result);
      return acc;
    },
    {},
  );

  return (
    <div className="flex flex-col h-full max-w-3xl mx-auto w-full">
      {/* Header */}
      <div className="p-4 lg:p-6 border-b border-border">
        <h1 className="text-lg font-semibold mb-3">全局搜索</h1>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => handleInputChange(e.target.value)}
            placeholder="搜索所有会话的聊天记录..."
            className="w-full pl-9 pr-8 py-2.5 rounded-lg bg-muted/50 border border-border text-sm focus:outline-none focus:ring-2 focus:ring-ring placeholder:text-muted-foreground"
          />
          {query && (
            <button
              onClick={handleClear}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-accent text-muted-foreground cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
        <div className="flex gap-1.5 mt-2">
          {TIME_RANGES.map((r) => (
            <button
              key={r.days}
              onClick={() => handleDaysChange(r.days)}
              className={cn(
                'px-2.5 py-0.5 text-xs rounded-full border transition-colors cursor-pointer',
                days === r.days
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-transparent text-muted-foreground border-border hover:bg-accent',
              )}
            >
              {r.label}
            </button>
          ))}
        </div>
        {searched && (
          <div className="mt-2 text-xs text-muted-foreground">
            {loading ? '搜索中...' : `找到 ${total} 条结果`}
          </div>
        )}
      </div>

      {/* Results */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {loading && results.length === 0 ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin mr-2" />
            搜索中...
          </div>
        ) : results.length === 0 && searched ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground text-sm">
            未找到相关消息
          </div>
        ) : results.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
            <Search className="w-12 h-12 mb-3 opacity-30" />
            <p className="text-sm">输入关键词搜索所有会话的聊天记录</p>
          </div>
        ) : (
          <div>
            {Object.entries(grouped).map(([folder, group]) => (
              <div key={folder}>
                <div className="sticky top-0 z-10 px-4 py-1.5 bg-muted/80 backdrop-blur-sm border-b border-border">
                  <span className="text-xs font-medium text-muted-foreground">
                    {group.name}
                  </span>
                  <span className="text-xs text-muted-foreground ml-1">
                    ({group.results.length})
                  </span>
                </div>
                {group.results.map((result) => (
                  <div
                    key={result.id}
                    onClick={() => handleResultClick(result)}
                    className="grid items-center px-4 py-2 hover:bg-accent/50 transition-colors cursor-pointer border-b border-border/50"
                    style={{ gridTemplateColumns: '5rem 7rem 1fr' }}
                  >
                    <span
                      className={cn(
                        'text-xs font-medium truncate',
                        result.is_from_me ? 'text-primary' : 'text-foreground',
                      )}
                    >
                      {result.is_from_me ? 'AI' : result.sender_name}
                    </span>
                    <span className="text-xs text-muted-foreground text-right tabular-nums">
                      {formatTime(result.timestamp)}
                    </span>
                    <span className="text-sm truncate min-w-0 pl-2 ml-1 border-l border-border/50">
                      {renderResultLine(result)}
                    </span>
                  </div>
                ))}
              </div>
            ))}
            {hasMore && (
              <div className="p-4 text-center">
                <button
                  onClick={loadMore}
                  disabled={loadingMore}
                  className="text-sm text-primary hover:underline disabled:opacity-50 cursor-pointer"
                >
                  {loadingMore ? (
                    <span className="flex items-center justify-center">
                      <Loader2 className="w-4 h-4 animate-spin mr-1" />
                      加载中...
                    </span>
                  ) : (
                    `加载更多 (已显示 ${results.length}/${total})`
                  )}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
