import { useState, useCallback, useRef, useEffect } from 'react';
import { Search, X, Loader2 } from 'lucide-react';
import { api } from '../../api/client';
import { useChatStore } from '../../stores/chat';
import { cn } from '@/lib/utils';

interface SearchResult {
  id: string;
  chat_jid: string;
  sender_name: string;
  content: string;
  snippet: string;
  timestamp: string;
  is_from_me: boolean;
}

interface SearchResponse {
  results: SearchResult[];
  total: number;
  hasMore: boolean;
}

interface SearchPanelProps {
  groupJid: string;
}

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

  const maxLen = 60;
  const start = Math.max(0, idx - 20);
  const end = Math.min(content.length, idx + q.length + maxLen - 20);
  const before = (start > 0 ? '...' : '') + content.slice(start, idx);
  const match = content.slice(idx, idx + q.length);
  const after = content.slice(idx + q.length, end) + (end < content.length ? '...' : '');
  return { before, match, after };
}

export function SearchPanel({ groupJid }: SearchPanelProps) {
  const loadMessagesAroundTimestamp = useChatStore((s) => s.loadMessagesAroundTimestamp);
  const [query, setQuery] = useState('');
  const [days, setDays] = useState(7);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [searched, setSearched] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const doSearch = useCallback(
    async (q: string, daysFilter: number, offset = 0) => {
      if (!q.trim()) {
        setResults([]);
        setTotal(0);
        setHasMore(false);
        setSearched(false);
        return;
      }

      const isLoadMore = offset > 0;
      if (isLoadMore) {
        setLoadingMore(true);
      } else {
        setLoading(true);
      }

      try {
        const params = new URLSearchParams({ q, limit: '50', offset: String(offset) });
        if (daysFilter > 0) params.set('days', String(daysFilter));
        const data = await api.get<SearchResponse>(
          `/api/sessions/${encodeURIComponent(groupJid)}/messages/search?${params}`,
        );

        if (isLoadMore) {
          setResults((prev) => [...prev, ...data.results]);
        } else {
          setResults(data.results);
        }
        setTotal(data.total);
        setHasMore(data.hasMore);
        setSearched(true);
      } catch {
        // Error handled by api client
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [groupJid],
  );

  const handleInputChange = useCallback(
    (value: string) => {
      setQuery(value);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        doSearch(value, days);
      }, 300);
    },
    [doSearch, days],
  );

  const handleDaysChange = useCallback(
    (newDays: number) => {
      setDays(newDays);
      if (query.trim()) {
        doSearch(query, newDays);
      }
    },
    [query, doSearch],
  );

  const handleClear = useCallback(() => {
    setQuery('');
    setResults([]);
    setTotal(0);
    setHasMore(false);
    setSearched(false);
    inputRef.current?.focus();
  }, []);

  const handleLoadMore = useCallback(() => {
    if (!loading && !loadingMore && hasMore) {
      doSearch(query, days, results.length);
    }
  }, [loading, loadingMore, hasMore, query, days, results.length, doSearch]);

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

  const renderResultLine = (result: SearchResult) => {
    const excerpt = buildExcerpt(result.content, query);
    if (!excerpt) {
      // No match found in content — show truncated content
      const text = result.content.length > 80 ? result.content.slice(0, 80) + '...' : result.content;
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

  return (
    <div className="flex flex-col h-full">
      {/* Search input */}
      <div className="p-3 border-b border-border">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => handleInputChange(e.target.value)}
            placeholder="搜索聊天记录..."
            className="w-full pl-9 pr-8 py-2 rounded-lg bg-muted/50 border border-border text-sm focus:outline-none focus:ring-2 focus:ring-ring placeholder:text-muted-foreground"
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
          <div className="flex items-center justify-center py-12 text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin mr-2" />
            搜索中...
          </div>
        ) : results.length === 0 && searched ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground text-sm">
            未找到相关消息
          </div>
        ) : results.length === 0 ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground text-sm">
            输入关键词搜索聊天记录
          </div>
        ) : (
          <div>
            {results.map((result) => (
              <div
                key={result.id}
                onClick={() => loadMessagesAroundTimestamp(groupJid, result.timestamp, result.id)}
                className="grid items-center px-3 py-2 hover:bg-accent/50 transition-colors cursor-pointer border-b border-border/50"
                style={{ gridTemplateColumns: '3.5rem 6rem 1fr' }}
              >
                <span className={cn(
                  'text-xs font-medium truncate',
                  result.is_from_me ? 'text-primary' : 'text-foreground',
                )}>
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
            {hasMore && (
              <div className="p-3 text-center">
                <button
                  onClick={handleLoadMore}
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
