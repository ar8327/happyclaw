import { useEffect, useState, useCallback } from 'react';
import { useLogsStore, type LogEntry, type LogSection } from '../stores/logs';
import { useChatStore } from '../stores/chat';
import { RefreshCw, ScrollText, Download, ChevronDown, ChevronRight, X, ArrowLeft } from 'lucide-react';
import { PageHeader } from '@/components/common/PageHeader';
import { SkeletonCardList } from '@/components/common/Skeletons';
import { EmptyState } from '@/components/common/EmptyState';
import { Button } from '@/components/ui/button';
import { withBasePath } from '@/utils/url';

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1000);
  return `${min}m ${sec}s`;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function formatTimestamp(ts: string): string {
  if (!ts) return '-';
  try {
    const d = new Date(ts);
    return d.toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return ts;
  }
}

function StatusBadge({ exitCode }: { exitCode: number | null }) {
  if (exitCode === null) {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-yellow-100 text-yellow-700">
        超时
      </span>
    );
  }
  if (exitCode === 0) {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-700">
        成功
      </span>
    );
  }
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-700">
      错误 ({exitCode})
    </span>
  );
}

function TypeBadge({ prefix }: { prefix: string }) {
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-700">
      {prefix === 'host' ? '宿主机' : '容器'}
    </span>
  );
}

function LogEntryRow({
  entry,
  isSelected,
  onClick,
}: {
  entry: LogEntry;
  isSelected: boolean;
  onClick: () => void;
}) {
  return (
    <tr
      className={`cursor-pointer transition-colors ${
        isSelected ? 'bg-brand-50' : 'hover:bg-muted/50'
      }`}
      onClick={onClick}
    >
      <td className="px-4 py-3 text-sm text-foreground whitespace-nowrap">
        {formatTimestamp(entry.timestamp)}
      </td>
      <td className="px-4 py-3 text-sm text-muted-foreground whitespace-nowrap">
        {formatDuration(entry.duration)}
      </td>
      <td className="px-4 py-3">
        <StatusBadge exitCode={entry.exitCode} />
      </td>
      <td className="px-4 py-3">
        <TypeBadge prefix={entry.filePrefix} />
      </td>
      <td className="px-4 py-3 text-sm text-muted-foreground max-w-[200px] truncate">
        {entry.agentName || entry.agentId || '-'}
      </td>
      <td className="px-4 py-3 text-sm text-muted-foreground whitespace-nowrap">
        {formatFileSize(entry.fileSize)}
      </td>
    </tr>
  );
}

function CollapsibleSection({
  section,
  defaultOpen,
}: {
  section: LogSection;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen ?? false);

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-4 py-2.5 bg-muted/50 hover:bg-muted text-sm font-medium text-foreground transition-colors"
      >
        {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        {section.name}
      </button>
      {open && (
        <pre className="px-4 py-3 text-xs leading-relaxed overflow-x-auto max-h-[600px] overflow-y-auto bg-background text-foreground whitespace-pre-wrap break-words">
          {section.content || '(empty)'}
        </pre>
      )}
    </div>
  );
}

function LogDetailPanel({
  folder,
  onClose,
}: {
  folder: string;
  onClose: () => void;
}) {
  const { selectedLog, loadingDetail } = useLogsStore();

  if (loadingDetail) {
    return (
      <div className="p-6">
        <SkeletonCardList count={3} />
      </div>
    );
  }

  if (!selectedLog) return null;

  const downloadUrl = withBasePath(
    `/api/logs/${encodeURIComponent(folder)}/${encodeURIComponent(selectedLog.filename)}/raw`,
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3 min-w-0">
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-muted transition-colors text-muted-foreground lg:hidden"
          >
            <ArrowLeft size={18} />
          </button>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-foreground truncate">
              {selectedLog.filename}
            </h3>
            <p className="text-xs text-muted-foreground">
              {formatFileSize(selectedLog.fileSize)}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <a
            href={downloadUrl}
            download
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-border hover:bg-muted transition-colors"
          >
            <Download size={14} />
            下载原始文件
          </a>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-muted transition-colors text-muted-foreground hidden lg:block"
          >
            <X size={18} />
          </button>
        </div>
      </div>

      <div className="space-y-2">
        {selectedLog.sections.map((section, i) => (
          <CollapsibleSection
            key={section.name}
            section={section}
            defaultOpen={i === 0 || section.name === 'Input'}
          />
        ))}
      </div>
    </div>
  );
}

export function LogsPage() {
  const {
    entries,
    total,
    selectedFolder,
    selectedLog,
    loading,
    error,
    loadEntries,
    loadDetail,
    clearDetail,
    setSelectedFolder,
  } = useLogsStore();
  const { groups, loadGroups } = useChatStore();

  // Derive unique folders from groups
  const folders = Object.entries(groups).reduce(
    (acc, [, group]) => {
      if (!acc.find((f) => f.folder === group.folder)) {
        acc.push({ folder: group.folder, name: group.name });
      }
      return acc;
    },
    [] as Array<{ folder: string; name: string }>,
  );

  useEffect(() => {
    loadGroups();
  }, [loadGroups]);

  // Auto-select first folder
  useEffect(() => {
    if (!selectedFolder && folders.length > 0) {
      const folder = folders[0].folder;
      setSelectedFolder(folder);
      loadEntries(folder);
    }
  }, [folders.length, selectedFolder, setSelectedFolder, loadEntries]);

  const handleFolderChange = useCallback(
    (folder: string) => {
      setSelectedFolder(folder);
      clearDetail();
      loadEntries(folder);
    },
    [setSelectedFolder, clearDetail, loadEntries],
  );

  const handleEntryClick = useCallback(
    (entry: LogEntry) => {
      if (selectedFolder) {
        loadDetail(selectedFolder, entry.filename);
      }
    },
    [selectedFolder, loadDetail],
  );

  const handleLoadMore = useCallback(() => {
    if (selectedFolder) {
      loadEntries(selectedFolder, entries.length);
    }
  }, [selectedFolder, entries.length, loadEntries]);

  const hasMore = entries.length < total;

  return (
    <div className="min-h-full bg-background">
      <div className="max-w-7xl mx-auto p-6">
        <PageHeader
          title="执行日志"
          subtitle={selectedFolder ? `${total} 条日志` : undefined}
          className="mb-6"
          actions={
            <Button
              variant="outline"
              onClick={() => selectedFolder && loadEntries(selectedFolder)}
              disabled={loading || !selectedFolder}
            >
              <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
              刷新
            </Button>
          }
        />

        {/* Folder selector */}
        {folders.length > 0 && (
          <div className="mb-4">
            <select
              value={selectedFolder || ''}
              onChange={(e) => handleFolderChange(e.target.value)}
              className="px-3 py-2 text-sm rounded-lg border border-border bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            >
              {folders.map((f) => (
                <option key={f.folder} value={f.folder}>
                  {f.name} ({f.folder})
                </option>
              ))}
            </select>
          </div>
        )}

        {error && (
          <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 flex items-center justify-between">
            <span className="text-sm text-red-700">{error}</span>
            <button
              onClick={() => useLogsStore.setState({ error: null })}
              className="p-1 text-red-400 hover:text-red-600 rounded transition-colors"
            >
              <X size={16} />
            </button>
          </div>
        )}

        {loading && entries.length === 0 ? (
          <SkeletonCardList count={6} />
        ) : entries.length === 0 && selectedFolder ? (
          <EmptyState
            icon={ScrollText}
            title="该群组还没有执行日志"
          />
        ) : (
          <div className="flex flex-col lg:flex-row gap-6">
            {/* Log entries table */}
            <div className={`${selectedLog ? 'hidden lg:block lg:w-1/2' : 'w-full'} min-w-0`}>
              <div className="border border-border rounded-lg overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-border text-sm">
                    <thead className="bg-muted">
                      <tr>
                        <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">时间</th>
                        <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">耗时</th>
                        <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">状态</th>
                        <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">类型</th>
                        <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">Agent</th>
                        <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">大小</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {entries.map((entry) => (
                        <LogEntryRow
                          key={entry.filename}
                          entry={entry}
                          isSelected={selectedLog?.filename === entry.filename}
                          onClick={() => handleEntryClick(entry)}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>

                {hasMore && (
                  <div className="p-3 text-center border-t border-border">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleLoadMore}
                      disabled={loading}
                    >
                      {loading ? '加载中...' : `加载更多 (${entries.length}/${total})`}
                    </Button>
                  </div>
                )}
              </div>
            </div>

            {/* Log detail panel */}
            {selectedLog && selectedFolder && (
              <div className="w-full lg:w-1/2 min-w-0">
                <div className="border border-border rounded-lg p-4">
                  <LogDetailPanel
                    folder={selectedFolder}
                    onClose={clearDetail}
                  />
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
