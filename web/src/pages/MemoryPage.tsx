import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ArrowLeft, BookOpen, ChevronDown, ChevronRight, Download, Loader2, Moon, Play, RefreshCw, Save, Settings } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '../api/client';
import { useGroupsStore } from '../stores/groups';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useMediaQuery } from '@/hooks/useMediaQuery';

type MemoryType = 'global' | 'heartbeat' | 'session' | 'date' | 'conversation';

interface MemorySource {
  path: string;
  label: string;
  type: MemoryType;
  writable: boolean;
  exists: boolean;
  updatedAt: string | null;
  size: number;
  ownerName?: string;
  folder?: string;
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

const MEMORY_TYPES: MemoryType[] = ['global', 'heartbeat', 'session', 'date', 'conversation'];
const FOLDER_SUB_GROUPED: Set<MemoryType> = new Set(['session', 'date', 'conversation']);

function getErrorMessage(err: unknown, fallback: string): string {
  if (typeof err === 'object' && err !== null && 'message' in err) {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === 'string' && msg.trim()) return msg;
  }
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

function typeLabel(type: MemoryType): string {
  switch (type) {
    case 'global': return '全局记忆';
    case 'heartbeat': return '每日心跳';
    case 'session': return '会话记忆';
    case 'date': return '日期记忆';
    case 'conversation': return '对话归档';
    default: return '其他';
  }
}

function SourceItem({
  source,
  active,
  hit,
  onSelect,
}: {
  source: MemorySource;
  active: boolean;
  hit?: MemorySearchHit;
  onSelect: (path: string) => void;
}) {
  // Show filename part only (strip folder prefix from label)
  const displayLabel = source.label.includes(' / ')
    ? source.label.split(' / ').slice(1).join(' / ')
    : source.label;
  return (
    <button
      onClick={() => onSelect(source.path)}
      className={`w-full text-left rounded-lg border px-3 py-2 transition-colors ${
        active
          ? 'border-primary bg-brand-50'
          : 'border-border hover:bg-muted/50'
      }`}
    >
      <div className="text-sm font-medium text-foreground truncate">
        {displayLabel}
      </div>
      <div className="text-[11px] text-muted-foreground truncate mt-0.5">
        {source.path}
      </div>
      <div className="text-[11px] mt-1 text-muted-foreground">
        {source.writable ? '可编辑' : '只读'} · {source.exists ? `${source.size} B` : '文件不存在'}
      </div>
      {hit && (
        <div className="text-[11px] mt-1 text-primary truncate">
          命中 {hit.hits} 次 · {hit.snippet}
        </div>
      )}
    </button>
  );
}

function subGroupByFolder(items: MemorySource[]): Record<string, MemorySource[]> {
  const map: Record<string, MemorySource[]> = {};
  for (const source of items) {
    const folder = source.folder || 'unknown';
    if (!map[folder]) map[folder] = [];
    map[folder].push(source);
  }
  return map;
}

export function MemoryPage() {
  const [searchParams] = useSearchParams();
  const folderParam = searchParams.get('folder');

  const [sources, setSources] = useState<MemorySource[]>([]);
  const storeGroups = useGroupsStore((s) => s.groups);
  const loadGroups = useGroupsStore((s) => s.loadGroups);
  useEffect(() => {
    if (Object.keys(storeGroups).length === 0) loadGroups();
  }, [loadGroups, storeGroups]);
  const folderNames = useMemo(() => {
    const map: Record<string, string> = {};
    for (const info of Object.values(storeGroups)) {
      if (info.folder && info.name && !map[info.folder]) {
        map[info.folder] = info.name;
      }
    }
    return map;
  }, [storeGroups]);
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

  const [memoryStatus, setMemoryStatus] = useState<{
    enabled: boolean;
    lastGlobalSleep: string | null;
    lastSessionWrapupAt: string | null;
    pendingWrapupsCount: number;
    canTriggerWrapup: boolean;
    canTriggerGlobalSleep: boolean;
    hasActiveSession: boolean;
    wrapupInProgress: boolean;
    globalSleepInProgress: boolean;
  } | null>(null);
  const [triggeringWrapup, setTriggeringWrapup] = useState(false);
  const [triggeringGlobalSleep, setTriggeringGlobalSleep] = useState(false);
  const [showTimeouts, setShowTimeouts] = useState(false);
  const [timeoutValues, setTimeoutValues] = useState<{
    memoryQueryTimeout: number;
    memoryGlobalSleepTimeout: number;
    memorySendTimeout: number;
  } | null>(null);
  const [timeoutLoading, setTimeoutLoading] = useState(false);
  const [timeoutSaving, setTimeoutSaving] = useState(false);
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
    const groups: Record<MemoryType, MemorySource[]> = {
      global: [],
      heartbeat: [],
      session: [],
      date: [],
      conversation: [],
    };
    for (const source of filteredSources) {
      if (groups[source.type]) groups[source.type].push(source);
      else groups[source.type] = [source];
    }
    return groups;
  }, [filteredSources]);

  // Collapsed state: type-level and folder sub-group level
  const [collapsedTypes, setCollapsedTypes] = useState<Record<string, boolean>>({
    global: true,
    heartbeat: true,
    session: true,
    date: true,
    conversation: true,
  });
  const [collapsedFolders, setCollapsedFolders] = useState<Record<string, boolean>>({});

  const toggleType = (type: string) =>
    setCollapsedTypes((prev) => ({ ...prev, [type]: !prev[type] }));
  const toggleFolder = (folder: string) =>
    setCollapsedFolders((prev) => ({ ...prev, [folder]: !prev[folder] }));

  // Auto-expand type/folder containing the selected file
  useEffect(() => {
    if (!selectedPath) return;
    const selected = sources.find((s) => s.path === selectedPath);
    if (!selected) return;
    setCollapsedTypes((prev) => ({ ...prev, [selected.type]: false }));
    if (FOLDER_SUB_GROUPED.has(selected.type)) {
      const folder = selected.folder || 'unknown';
      setCollapsedFolders((prev) => ({ ...prev, [folder]: false }));
    }
  }, [selectedPath, sources]);

  const loadFile = useCallback(async (path: string) => {
    setLoadingFile(true);
    try {
      const data = await api.get<MemoryFile>(
        `/api/memory/file?${new URLSearchParams({ path })}`,
      );
      setSelectedPath(path);
      setContent(data.content);
      setInitialContent(data.content);
      setFileMeta(data);
    } catch (err) {
      toast.error(getErrorMessage(err, '加载记忆文件失败'));
    } finally {
      setLoadingFile(false);
    }
  }, []);

  const loadSources = useCallback(async () => {
    setLoadingSources(true);
    try {
      const data = await api.get<{ sources: MemorySource[] }>('/api/memory/sources');
      setSources(data.sources);

      const available = new Set(data.sources.map((s) => s.path));
      let nextSelected = selectedPath && available.has(selectedPath) ? selectedPath : null;

      if (!nextSelected) {
        // If folder param provided, try to find matching session CLAUDE.md first
        if (folderParam) {
          nextSelected =
            data.sources.find(
              (s) => s.type === 'session' && s.path.includes(`/${folderParam}/`) && s.path.endsWith('CLAUDE.md'),
            )?.path || null;
        }
      }

      if (!nextSelected) {
        // Default: global CLAUDE.md → first session CLAUDE.md → first available
        nextSelected =
          data.sources.find((s) => s.type === 'global')?.path ||
          data.sources.find((s) => s.type === 'session' && s.path.endsWith('CLAUDE.md'))?.path ||
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
      toast.error(getErrorMessage(err, '加载记忆源失败'));
    } finally {
      setLoadingSources(false);
    }
  }, [loadFile, selectedPath, folderParam]);

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
      await Promise.all([loadSources(), loadMemoryStatus()]);
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

  const loadMemoryStatus = useCallback(async () => {
    try {
      const data = await api.get<{
        enabled: boolean;
        lastGlobalSleep: string | null;
        lastSessionWrapupAt: string | null;
        pendingWrapupsCount: number;
        canTriggerWrapup: boolean;
        canTriggerGlobalSleep: boolean;
        hasActiveSession: boolean;
        wrapupInProgress: boolean;
        globalSleepInProgress: boolean;
      }>('/api/memory/status');
      setMemoryStatus(data);
    } catch {
      setMemoryStatus(null);
    }
  }, []);

  const handleTriggerWrapup = async () => {
    setTriggeringWrapup(true);
    setError(null);
    setNotice(null);
    try {
      await api.post<{ success: boolean; message: string }>('/api/memory/trigger-wrapup');
      setNotice('会话整理已触发');
      await loadMemoryStatus();
    } catch (err) {
      setError(getErrorMessage(err, '触发会话整理失败'));
    } finally {
      setTriggeringWrapup(false);
    }
  };

  const handleTriggerGlobalSleep = async () => {
    if (!confirm('深度整理可能需要几分钟，确定要执行吗？')) return;
    setTriggeringGlobalSleep(true);
    setError(null);
    setNotice(null);
    try {
      await api.post<{ success: boolean; message: string }>('/api/memory/trigger-global-sleep', undefined, 360000);
      setNotice('深度整理已完成');
      await loadMemoryStatus();
    } catch (err) {
      setError(getErrorMessage(err, '深度整理失败'));
    } finally {
      setTriggeringGlobalSleep(false);
    }
  };

  const handleStopActiveSessions = async () => {
    if (!confirm('这将停止所有活跃的 Agent 会话，确定吗？')) return;
    setError(null);
    setNotice(null);
    try {
      const result = await api.post<{ stopped: number; message: string }>('/api/memory/stop-active-sessions');
      setNotice(result.message);
      await loadMemoryStatus();
    } catch (err) {
      setError(getErrorMessage(err, '停止会话失败'));
    }
  };

  const loadTimeoutSettings = useCallback(async () => {
    setTimeoutLoading(true);
    try {
      const data = await api.get<{
        memoryQueryTimeout: number;
        memoryGlobalSleepTimeout: number;
        memorySendTimeout: number;
      }>('/api/config/system');
      setTimeoutValues({
        memoryQueryTimeout: data.memoryQueryTimeout,
        memoryGlobalSleepTimeout: data.memoryGlobalSleepTimeout,
        memorySendTimeout: data.memorySendTimeout,
      });
    } catch (err) {
      toast.error(getErrorMessage(err, '加载超时设置失败'));
    } finally {
      setTimeoutLoading(false);
    }
  }, []);

  const handleSaveTimeouts = async () => {
    if (!timeoutValues) return;
    setTimeoutSaving(true);
    setError(null);
    setNotice(null);
    try {
      const data = await api.put<{
        memoryQueryTimeout: number;
        memoryGlobalSleepTimeout: number;
        memorySendTimeout: number;
      }>('/api/config/system', timeoutValues);
      setTimeoutValues({
        memoryQueryTimeout: data.memoryQueryTimeout,
        memoryGlobalSleepTimeout: data.memoryGlobalSleepTimeout,
        memorySendTimeout: data.memorySendTimeout,
      });
      setNotice('超时设置已保存');
    } catch (err) {
      setError(getErrorMessage(err, '保存超时设置失败'));
    } finally {
      setTimeoutSaving(false);
    }
  };

  useEffect(() => {
    loadSources();
    loadMemoryMode();
    loadMemoryStatus();
  }, [loadSources, loadMemoryMode, loadMemoryStatus]);

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
    try {
      const data = await api.put<MemoryFile>('/api/memory/file', {
        path: selectedPath,
        content,
      });
      setContent(data.content);
      setInitialContent(data.content);
      setFileMeta(data);
      toast.success('已保存');
      await loadSources();
    } catch (err) {
      toast.error(getErrorMessage(err, '保存记忆文件失败'));
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

  // Render a list of sources, optionally sub-grouped by folder
  const renderSourceList = (type: MemoryType, items: MemorySource[]) => {
    if (!FOLDER_SUB_GROUPED.has(type)) {
      return items.map((source) => (
        <SourceItem
          key={source.path}
          source={source}
          active={source.path === selectedPath}
          hit={searchHits[source.path]}
          onSelect={handleSelectSource}
        />
      ));
    }

    const byFolder = subGroupByFolder(items);
    return Object.entries(byFolder).map(([folder, folderItems]) => {
      const isFolderCollapsed = collapsedFolders[folder] !== false;
      return (
        <div key={folder}>
          <button
            onClick={() => toggleFolder(folder)}
            className="flex items-center gap-1 w-full text-left text-[11px] font-medium text-muted-foreground py-1 hover:text-foreground transition-colors"
          >
            {isFolderCollapsed ? <ChevronRight className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            {folderNames[folder] || folder}
            <span className="text-muted-foreground/60 ml-1">({folderItems.length})</span>
          </button>
          {!isFolderCollapsed && (
            <div className="space-y-1 ml-3">
              {folderItems.map((source) => (
                <SourceItem
                  key={source.path}
                  source={source}
                  active={source.path === selectedPath}
                  hit={searchHits[source.path]}
                  onSelect={handleSelectSource}
                />
              ))}
            </div>
          )}
        </div>
      );
    });
  };

  return (
    <div className="min-h-full bg-background p-4 lg:p-8">
      <div className="max-w-7xl mx-auto space-y-4">
        <Card>
          <CardContent>
            <div className="flex items-center gap-3 mb-3">
              <div className="p-2 bg-brand-100 rounded-lg">
                <BookOpen className="w-5 h-5 text-primary" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-foreground">记忆管理</h1>
                <p className="text-sm text-muted-foreground mt-0.5">
                  管理全局记忆、心跳摘要、会话记忆、日期记忆与对话归档。
                </p>
              </div>
            </div>

            {!modeLoading && (
              <div className="mt-4 pt-4 border-t border-border space-y-3">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <div className="text-sm font-medium text-foreground">AI 记忆系统</div>
                    <div className="text-xs text-muted-foreground mt-0.5">
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
                      memoryMode === 'agent' ? 'bg-primary' : 'bg-muted'
                    }`}
                  >
                    <span
                      className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-background shadow ring-0 transition duration-200 ease-in-out ${
                        memoryMode === 'agent' ? 'translate-x-5' : 'translate-x-0'
                      }`}
                    />
                  </button>
                </div>

                {memoryMode === 'agent' && (
                  <div className="space-y-3">
                    <div className="flex flex-wrap items-center gap-3">
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
                        <span className="text-xs text-muted-foreground">
                          导入 {importResult.imported.length} · 跳过 {importResult.skipped.length}
                          {importResult.errors.length > 0 ? ` · 失败 ${importResult.errors.length}` : ''}
                        </span>
                      )}
                    </div>

                    {memoryStatus?.enabled && (
                      <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-2.5">
                        <div className="text-xs font-medium text-foreground">记忆系统状态</div>
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs text-muted-foreground">
                          <div>
                            <span className="text-muted-foreground/80">上次会话整理：</span>
                            {memoryStatus.lastSessionWrapupAt
                              ? new Date(memoryStatus.lastSessionWrapupAt).toLocaleString('zh-CN')
                              : '从未执行'}
                          </div>
                          <div>
                            <span className="text-muted-foreground/80">上次深度整理：</span>
                            {memoryStatus.lastGlobalSleep
                              ? new Date(memoryStatus.lastGlobalSleep).toLocaleString('zh-CN')
                              : '从未执行'}
                          </div>
                          <div>
                            <span className="text-muted-foreground/80">待整理记录：</span>
                            {memoryStatus.pendingWrapupsCount} 个
                          </div>
                        </div>
                        <div className="flex flex-wrap items-center gap-2 pt-0.5">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={handleTriggerWrapup}
                            disabled={triggeringWrapup || !memoryStatus.canTriggerWrapup}
                          >
                            {triggeringWrapup || memoryStatus.wrapupInProgress ? (
                              <Loader2 className="size-3.5 animate-spin" />
                            ) : (
                              <Play className="w-3.5 h-3.5" />
                            )}
                            {memoryStatus.wrapupInProgress && !triggeringWrapup ? '会话整理中…' : '会话整理'}
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={handleTriggerGlobalSleep}
                            disabled={triggeringGlobalSleep || !memoryStatus.canTriggerGlobalSleep}
                          >
                            {triggeringGlobalSleep || memoryStatus.globalSleepInProgress ? (
                              <Loader2 className="size-3.5 animate-spin" />
                            ) : (
                              <Moon className="w-3.5 h-3.5" />
                            )}
                            {memoryStatus.globalSleepInProgress && !triggeringGlobalSleep ? '深度整理中…' : '深度整理'}
                          </Button>
                          {memoryStatus.hasActiveSession && (
                            <button
                              type="button"
                              onClick={handleStopActiveSessions}
                              className="text-[11px] text-amber-600 underline underline-offset-2 hover:text-amber-700"
                              title="点击停止活跃会话以进行深度整理"
                            >
                              有活跃会话（点击停止）
                            </button>
                          )}
                          {triggeringGlobalSleep && (
                            <span className="text-[11px] text-muted-foreground">深度整理中，可能需要几分钟……</span>
                          )}
                        </div>
                      </div>
                    )}

                    <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-3">
                      <button
                        type="button"
                        onClick={() => {
                          const next = !showTimeouts;
                          setShowTimeouts(next);
                          if (next && !timeoutValues && !timeoutLoading) {
                            void loadTimeoutSettings();
                          }
                        }}
                        className="flex w-full items-center justify-between text-left"
                      >
                        <div className="flex items-center gap-2">
                          <Settings className="size-4 text-muted-foreground" />
                          <div>
                            <div className="text-xs font-medium text-foreground">超时设置</div>
                            <div className="text-[11px] text-muted-foreground">
                              调整记忆检索、发送与深度整理的超时时间
                            </div>
                          </div>
                        </div>
                        {showTimeouts ? (
                          <ChevronDown className="size-4 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="size-4 text-muted-foreground" />
                        )}
                      </button>

                      {showTimeouts && (
                        <div className="space-y-3 border-t border-border pt-3">
                          {timeoutLoading || !timeoutValues ? (
                            <div className="flex items-center gap-2 text-xs text-muted-foreground">
                              <Loader2 className="size-3.5 animate-spin" />
                              正在加载超时设置...
                            </div>
                          ) : (
                            <>
                              <div className="grid gap-3 sm:grid-cols-3">
                                <div className="space-y-1">
                                  <label className="text-xs font-medium text-foreground">检索超时</label>
                                  <Input
                                    type="number"
                                    min={10}
                                    max={300}
                                    step={5}
                                    value={Math.round(timeoutValues.memoryQueryTimeout / 1000)}
                                    onChange={(e) => {
                                      const seconds = Number(e.target.value);
                                      if (!Number.isFinite(seconds)) return;
                                      setTimeoutValues((prev) =>
                                        prev
                                          ? {
                                              ...prev,
                                              memoryQueryTimeout: Math.max(10, Math.min(300, seconds)) * 1000,
                                            }
                                          : prev,
                                      );
                                    }}
                                  />
                                  <div className="text-[11px] text-muted-foreground">10 到 300 秒</div>
                                </div>
                                <div className="space-y-1">
                                  <label className="text-xs font-medium text-foreground">发送超时</label>
                                  <Input
                                    type="number"
                                    min={30}
                                    max={300}
                                    step={10}
                                    value={Math.round(timeoutValues.memorySendTimeout / 1000)}
                                    onChange={(e) => {
                                      const seconds = Number(e.target.value);
                                      if (!Number.isFinite(seconds)) return;
                                      setTimeoutValues((prev) =>
                                        prev
                                          ? {
                                              ...prev,
                                              memorySendTimeout: Math.max(30, Math.min(300, seconds)) * 1000,
                                            }
                                          : prev,
                                      );
                                    }}
                                  />
                                  <div className="text-[11px] text-muted-foreground">30 到 300 秒</div>
                                </div>
                                <div className="space-y-1">
                                  <label className="text-xs font-medium text-foreground">深度整理超时</label>
                                  <Input
                                    type="number"
                                    min={60}
                                    max={600}
                                    step={30}
                                    value={Math.round(timeoutValues.memoryGlobalSleepTimeout / 1000)}
                                    onChange={(e) => {
                                      const seconds = Number(e.target.value);
                                      if (!Number.isFinite(seconds)) return;
                                      setTimeoutValues((prev) =>
                                        prev
                                          ? {
                                              ...prev,
                                              memoryGlobalSleepTimeout:
                                                Math.max(60, Math.min(600, seconds)) * 1000,
                                            }
                                          : prev,
                                      );
                                    }}
                                  />
                                  <div className="text-[11px] text-muted-foreground">60 到 600 秒</div>
                                </div>
                              </div>
                              <div className="flex justify-end">
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={handleSaveTimeouts}
                                  disabled={timeoutSaving}
                                >
                                  {timeoutSaving ? (
                                    <Loader2 className="size-3.5 animate-spin" />
                                  ) : (
                                    <Save className="size-3.5" />
                                  )}
                                  保存超时设置
                                </Button>
                              </div>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {(notice || error) && (
                  <div className="space-y-1">
                    {notice ? <div className="text-xs text-emerald-600">{notice}</div> : null}
                    {error ? <div className="text-xs text-destructive">{error}</div> : null}
                  </div>
                )}
              </div>
            )}

            <div className="text-xs text-muted-foreground">
              已加载记忆源: {sources.length}
            </div>
          </CardContent>
        </Card>

        <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-4">
          {(!isMobile || !showContent) && (
          <Card>
            <CardContent>
              <div className="mb-3">
              <Input
                type="text"
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                placeholder="搜索记忆源（路径 + 全文）"
              />
              <div className="mt-1 text-[11px] text-muted-foreground">
                {keyword.trim()
                  ? searchingContent
                    ? '正在做全文检索...'
                    : `全文命中：${Object.keys(searchHits).length} 个文件`
                  : '可按文件名、路径或内容关键词检索'}
              </div>
            </div>

            <div className="space-y-2 max-h-[calc(100dvh-280px)] lg:max-h-[560px] overflow-auto pr-1">
              {MEMORY_TYPES.map((type) => {
                const items = groupedSources[type];
                if (items.length === 0) return null;
                const isCollapsed = !!collapsedTypes[type];
                return (
                  <div key={type}>
                    <button
                      onClick={() => toggleType(type)}
                      className="flex items-center gap-1 w-full text-left text-xs font-semibold text-muted-foreground mb-1 hover:text-foreground transition-colors"
                    >
                      {isCollapsed ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                      {typeLabel(type)} ({items.length})
                    </button>
                    {!isCollapsed && (
                      <div className="space-y-1 ml-1">
                        {renderSourceList(type, items)}
                      </div>
                    )}
                  </div>
                );
              })}

              {!loadingSources && filteredSources.length === 0 && (
                <div className="text-sm text-muted-foreground">没有匹配的记忆源</div>
              )}
              </div>
            </CardContent>
          </Card>
          )}

          {(!isMobile || showContent) && (
          <Card>
            <CardContent>
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
                    <div className="text-xs text-muted-foreground mt-1">
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

                    {dirty && <span className="text-sm text-warning">有未保存修改</span>}
                  </div>
                </>
              ) : (
                <div className="text-sm text-muted-foreground">暂无可用记忆源</div>
              )}
            </CardContent>
          </Card>
          )}
        </div>
      </div>
    </div>
  );
}
