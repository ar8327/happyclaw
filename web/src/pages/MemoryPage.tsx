import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, BookOpen, Download, Loader2, RefreshCw, Save } from 'lucide-react';
import { api } from '../api/client';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { useMediaQuery } from '@/hooks/useMediaQuery';

interface MemorySource {
  path: string;
  label: string;
  scope: 'user-global' | 'agent-memory' | 'main' | 'flow' | 'session';
  kind: 'claude' | 'note' | 'session';
  writable: boolean;
  exists: boolean;
  updatedAt: string | null;
  size: number;
  ownerName?: string;
}

interface MemoryFile {
  path: string;
  content: string;
  updatedAt: string | null;
  size: number;
  writable: boolean;
}

interface MemorySearchHit {
  path: string;
  hits: number;
  snippet: string;
}

function getErrorMessage(err: unknown, fallback: string): string {
  if (typeof err === 'object' && err !== null && 'message' in err) {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === 'string' && msg.trim()) return msg;
  }
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

function scopeLabel(scope: MemorySource['scope']): string {
  switch (scope) {
    case 'agent-memory':
      return 'AI 记忆系统';
    case 'user-global':
      return '我的全局记忆';
    case 'main':
      return '主会话';
    case 'flow':
      return '会话流';
    case 'session':
      return '自动记忆';
    default:
      return '其他';
  }
}

export function MemoryPage() {
  const [sources, setSources] = useState<MemorySource[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [initialContent, setInitialContent] = useState('');
  const [fileMeta, setFileMeta] = useState<MemoryFile | null>(null);
  const [keyword, setKeyword] = useState('');
  const [searchHits, setSearchHits] = useState<Record<string, MemorySearchHit>>({});

  const [loadingSources, setLoadingSources] = useState(true);
  const [loadingFile, setLoadingFile] = useState(false);
  const [saving, setSaving] = useState(false);
  const [searchingContent, setSearchingContent] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [memoryMode, setMemoryMode] = useState<'legacy' | 'agent'>('legacy');
  const [modeLoading, setModeLoading] = useState(true);
  const [modeSaving, setModeSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{
    imported: string[];
    skipped: string[];
    errors: string[];
  } | null>(null);

  const isMobile = useMediaQuery('(max-width: 1023px)');
  const [showContent, setShowContent] = useState(false);

  const dirty = useMemo(() => content !== initialContent, [content, initialContent]);

  const filteredSources = useMemo(() => {
    const text = keyword.trim().toLowerCase();
    if (!text) return sources;
    return sources.filter((s) =>
      `${s.label} ${s.path}`.toLowerCase().includes(text) || Boolean(searchHits[s.path]),
    );
  }, [sources, keyword, searchHits]);

  const groupedSources = useMemo(() => {
    const groups: Record<MemorySource['scope'], MemorySource[]> = {
      'agent-memory': [],
      'user-global': [],
      main: [],
      flow: [],
      session: [],
    };
    for (const source of filteredSources) {
      groups[source.scope].push(source);
    }
    return groups;
  }, [filteredSources]);

  const loadFile = useCallback(async (path: string) => {
    setLoadingFile(true);
    setError(null);
    setNotice(null);
    try {
      const data = await api.get<MemoryFile>(
        `/api/memory/file?${new URLSearchParams({ path })}`,
      );
      setSelectedPath(path);
      setContent(data.content);
      setInitialContent(data.content);
      setFileMeta(data);
    } catch (err) {
      setError(getErrorMessage(err, '加载记忆文件失败'));
    } finally {
      setLoadingFile(false);
    }
  }, []);

  const loadSources = useCallback(async () => {
    setLoadingSources(true);
    setError(null);
    try {
      const data = await api.get<{ sources: MemorySource[] }>('/api/memory/sources');
      setSources(data.sources);

      const available = new Set(data.sources.map((s) => s.path));
      let nextSelected = selectedPath && available.has(selectedPath) ? selectedPath : null;

      if (!nextSelected) {
        // Default: first user-global CLAUDE.md, then main, then first available
        nextSelected =
          data.sources.find((s) => s.scope === 'user-global' && s.kind === 'claude')?.path ||
          data.sources.find((s) => s.scope === 'main' && s.kind === 'claude')?.path ||
          data.sources[0]?.path ||
          null;
      }

      if (nextSelected) {
        await loadFile(nextSelected);
      } else {
        setSelectedPath(null);
        setContent('');
        setInitialContent('');
        setFileMeta(null);
      }
    } catch (err) {
      setError(getErrorMessage(err, '加载记忆源失败'));
    } finally {
      setLoadingSources(false);
    }
  }, [loadFile, selectedPath]);

  const loadMemoryMode = useCallback(async () => {
    setModeLoading(true);
    try {
      const data = await api.get<{ memoryMode: 'legacy' | 'agent' }>(
        '/api/config/user-im/memory',
      );
      setMemoryMode(data.memoryMode);
    } catch {
      setMemoryMode('legacy');
    } finally {
      setModeLoading(false);
    }
  }, []);

  const handleToggleMode = async () => {
    const newMode = memoryMode === 'legacy' ? 'agent' : 'legacy';
    setModeSaving(true);
    setError(null);
    setNotice(null);
    try {
      const data = await api.put<{ memoryMode: 'legacy' | 'agent' }>(
        '/api/config/user-im/memory',
        { memoryMode: newMode },
      );
      setMemoryMode(data.memoryMode);
      setNotice(newMode === 'agent' ? '已切换到 AI 记忆系统，下次启动会话时生效' : '已切换到传统记忆系统');
      await loadSources();
    } catch (err) {
      setError(getErrorMessage(err, '切换记忆模式失败'));
    } finally {
      setModeSaving(false);
    }
  };

  const handleImportLegacy = async () => {
    if (!confirm('确定要将旧记忆数据导入到新记忆系统？已存在的文件不会被覆盖。')) return;
    setImporting(true);
    setError(null);
    setNotice(null);
    setImportResult(null);
    try {
      const result = await api.post<{
        imported: string[];
        skipped: string[];
        errors: string[];
      }>('/api/config/user-im/memory/import-legacy');
      setImportResult(result);
      if (result.imported.length > 0) {
        setNotice(`成功导入 ${result.imported.length} 个文件`);
        await loadSources();
      } else if (result.skipped.length > 0) {
        setNotice('所有文件已存在，无需重复导入');
      }
      if (result.errors.length > 0) {
        setError(`${result.errors.length} 个文件导入失败`);
      }
    } catch (err) {
      setError(getErrorMessage(err, '导入旧记忆数据失败'));
    } finally {
      setImporting(false);
    }
  };

  useEffect(() => {
    loadSources();
    loadMemoryMode();
  }, [loadSources, loadMemoryMode]);

  useEffect(() => {
    const q = keyword.trim();
    if (!q) {
      setSearchHits({});
      setSearchingContent(false);
      return;
    }

    const timer = window.setTimeout(async () => {
      setSearchingContent(true);
      try {
        const data = await api.get<{ hits: MemorySearchHit[] }>(
          `/api/memory/search?${new URLSearchParams({ q, limit: '120' })}`,
        );
        const next: Record<string, MemorySearchHit> = {};
        for (const hit of data.hits) {
          next[hit.path] = hit;
        }
        setSearchHits(next);
      } catch {
        setSearchHits({});
      } finally {
        setSearchingContent(false);
      }
    }, 280);

    return () => {
      window.clearTimeout(timer);
    };
  }, [keyword]);

  const handleSelectSource = async (path: string) => {
    if (path === selectedPath && isMobile) {
      // Mobile: re-tap selected item to show content panel
      setShowContent(true);
      return;
    }
    if (path === selectedPath) return;
    if (dirty && !confirm('当前有未保存修改，切换会丢失。是否继续？')) {
      return;
    }
    await loadFile(path);
    if (isMobile) setShowContent(true);
  };

  const handleSave = async () => {
    if (!selectedPath || !fileMeta?.writable) return;

    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const data = await api.put<MemoryFile>('/api/memory/file', {
        path: selectedPath,
        content,
      });
      setContent(data.content);
      setInitialContent(data.content);
      setFileMeta(data);
      setNotice('已保存');
      await loadSources();
    } catch (err) {
      setError(getErrorMessage(err, '保存记忆文件失败'));
    } finally {
      setSaving(false);
    }
  };

  const handleReloadFile = async () => {
    if (!selectedPath) return;
    if (dirty && !confirm('当前有未保存修改，重新加载会覆盖。是否继续？')) {
      return;
    }
    await loadFile(selectedPath);
  };

  const updatedText = fileMeta?.updatedAt
    ? new Date(fileMeta.updatedAt).toLocaleString('zh-CN')
    : '未记录';

  return (
    <div className="min-h-full bg-background p-4 lg:p-8">
      <div className="max-w-7xl mx-auto space-y-4">
        <div className="bg-card rounded-xl border border-border p-6">
          <div className="flex items-center gap-3 mb-3">
            <div className="p-2 bg-brand-100 rounded-lg">
              <BookOpen className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-foreground">记忆管理</h1>
              <p className="text-sm text-slate-500 mt-0.5">
                管理个人全局记忆、主会话记忆、各会话流记忆，以及可读取的自动记忆文件。
              </p>
            </div>
          </div>

          {!modeLoading && (
            <div className="mt-3 pt-3 border-t border-border space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium text-foreground">AI 记忆系统</div>
                  <div className="text-xs text-slate-500 mt-0.5">
                    {memoryMode === 'agent'
                      ? '使用 Memory Agent 自动整理和检索记忆'
                      : '使用传统 CLAUDE.md 记忆系统'}
                  </div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={memoryMode === 'agent'}
                  disabled={modeSaving}
                  onClick={handleToggleMode}
                  className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:opacity-50 ${
                    memoryMode === 'agent' ? 'bg-primary' : 'bg-slate-200'
                  }`}
                >
                  <span
                    className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                      memoryMode === 'agent' ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>

              {memoryMode === 'agent' && (
                <div className="flex items-center gap-3">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleImportLegacy}
                    disabled={importing}
                  >
                    {importing ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Download className="w-4 h-4" />
                    )}
                    导入旧记忆数据
                  </Button>
                  {importResult && (
                    <span className="text-xs text-slate-500">
                      导入 {importResult.imported.length} · 跳过{' '}
                      {importResult.skipped.length}
                      {importResult.errors.length > 0 &&
                        ` · 失败 ${importResult.errors.length}`}
                    </span>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="text-xs text-slate-500 mt-3">
            已加载记忆源: {sources.length}
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-4">
          {(!isMobile || !showContent) && (
          <div className="bg-card rounded-xl border border-border p-4">
            <div className="mb-3">
              <Input
                type="text"
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                placeholder="搜索记忆源（路径 + 全文）"
              />
              <div className="mt-1 text-[11px] text-slate-500">
                {keyword.trim()
                  ? searchingContent
                    ? '正在做全文检索...'
                    : `全文命中：${Object.keys(searchHits).length} 个文件`
                  : '可按文件名、路径或内容关键词检索'}
              </div>
            </div>

            <div className="space-y-4 max-h-[calc(100dvh-280px)] lg:max-h-[560px] overflow-auto pr-1">
              {(['agent-memory', 'user-global', 'main', 'flow', 'session'] as const).map((scope) => {
                const items = groupedSources[scope];
                if (items.length === 0) return null;
                return (
                  <div key={scope}>
                    <div className="text-xs font-semibold text-slate-500 mb-2">
                      {scopeLabel(scope)} ({items.length})
                    </div>
                    <div className="space-y-1">
                      {items.map((source) => {
                        const active = source.path === selectedPath;
                        const hit = searchHits[source.path];
                        return (
                          <button
                            key={source.path}
                            onClick={() => handleSelectSource(source.path)}
                            className={`w-full text-left rounded-lg border px-3 py-2 transition-colors ${
                              active
                                ? 'border-primary bg-brand-50'
                                : 'border-border hover:bg-muted/50'
                            }`}
                          >
                            <div className="text-sm font-medium text-foreground truncate">
                              {source.label}
                            </div>
                            <div className="text-[11px] text-slate-500 truncate mt-0.5">
                              {source.path}
                            </div>
                            <div className="text-[11px] mt-1 text-slate-500">
                              {source.writable ? '可编辑' : '只读'} · {source.exists ? `${source.size} B` : '文件不存在'}
                            </div>
                            {hit && (
                              <div className="text-[11px] mt-1 text-primary truncate">
                                命中 {hit.hits} 次 · {hit.snippet}
                              </div>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}

              {!loadingSources && filteredSources.length === 0 && (
                <div className="text-sm text-slate-500">没有匹配的记忆源</div>
              )}
            </div>
          </div>
          )}

          {(!isMobile || showContent) && (
          <div className="bg-card rounded-xl border border-border p-4 lg:p-6">
            {selectedPath ? (
              <>
                {isMobile && (
                  <button
                    onClick={() => setShowContent(false)}
                    className="flex items-center gap-1 text-sm text-primary mb-3 hover:underline"
                  >
                    <ArrowLeft className="w-4 h-4" />
                    返回列表
                  </button>
                )}
                <div className="mb-3">
                  <div className="text-sm font-semibold text-foreground break-all">{selectedPath}</div>
                  <div className="text-xs text-slate-500 mt-1">
                    最近更新时间: {updatedText} · 字节数: {new TextEncoder().encode(content).length} · {fileMeta?.writable ? '可编辑' : '只读'}
                  </div>
                </div>

                <Textarea
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  className="min-h-[calc(100dvh-380px)] lg:min-h-[460px] resize-y p-4 font-mono text-sm leading-6 disabled:bg-muted"
                  placeholder={loadingFile ? '正在加载...' : '此记忆源暂无内容'}
                  disabled={loadingFile || saving || !fileMeta?.writable}
                />

                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <Button
                    onClick={handleSave}
                    disabled={loadingFile || saving || !fileMeta?.writable || !dirty}
                  >
                    {saving && <Loader2 className="size-4 animate-spin" />}
                    <Save className="w-4 h-4" />
                    保存
                  </Button>

                  <Button
                    variant="outline"
                    onClick={handleReloadFile}
                    disabled={loadingFile || saving}
                  >
                    <RefreshCw className="w-4 h-4" />
                    重新加载当前
                  </Button>

                  <Button
                    variant="outline"
                    onClick={loadSources}
                    disabled={loadingSources || loadingFile || saving}
                  >
                    <RefreshCw className="w-4 h-4" />
                    刷新记忆源
                  </Button>

                  {dirty && <span className="text-sm text-amber-600">有未保存修改</span>}
                  {notice && <span className="text-sm text-green-600">{notice}</span>}
                  {error && <span className="text-sm text-red-600">{error}</span>}
                </div>
              </>
            ) : (
              <div className="text-sm text-slate-500">暂无可用记忆源</div>
            )}
          </div>
          )}
        </div>
      </div>
    </div>
  );
}
