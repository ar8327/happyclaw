/**
 * Agent execution log routes.
 * Provides APIs to list, view, and download agent run logs stored in data/groups/{folder}/logs/.
 */
import { Hono } from 'hono';
import fs from 'node:fs';
import path from 'node:path';

import { GROUPS_DIR } from '../config.js';
import { getJidsByFolder, getRegisteredGroup } from '../db.js';
import { logger } from '../logger.js';
import { authMiddleware } from '../middleware/auth.js';
import type { AuthUser } from '../types.js';
import { canAccessGroup, type Variables } from '../web-context.js';

const logsRoutes = new Hono<{ Variables: Variables }>();

// ─── Helpers ──────────────────────────────────────────────────────────

/** Check if the authenticated user can access logs for the given folder. */
function canAccessFolder(user: AuthUser, folder: string): boolean {
  if (user.role === 'admin') return true;
  const jids = getJidsByFolder(folder);
  for (const jid of jids) {
    const group = getRegisteredGroup(jid);
    if (group && canAccessGroup(user, group)) return true;
  }
  return false;
}

/** Validate a log filename (no path traversal, must end with .log). */
function isValidLogFilename(filename: string): boolean {
  return (
    /^[a-zA-Z0-9._-]+\.log$/.test(filename) &&
    !filename.includes('..') &&
    !filename.includes('/')
  );
}

interface LogEntryMeta {
  filename: string;
  timestamp: string;
  duration: number;
  exitCode: number | null;
  filePrefix: string;
  agentId?: string;
  agentName?: string;
  fileSize: number;
}

/** Parse the header section (first ~15 lines) of a log file to extract metadata. */
function parseLogHeader(
  headerLines: string[],
  filename: string,
  fileSize: number,
): LogEntryMeta {
  const meta: LogEntryMeta = {
    filename,
    timestamp: '',
    duration: 0,
    exitCode: null,
    filePrefix: filename.startsWith('host')
      ? 'host'
      : filename.startsWith('memory')
        ? 'memory'
        : 'container',
    fileSize,
  };

  for (const line of headerLines) {
    const [key, ...rest] = line.split(': ');
    const value = rest.join(': ').trim();
    switch (key?.trim()) {
      case 'Timestamp':
        meta.timestamp = value;
        break;
      case 'Duration': {
        const ms = parseInt(value, 10);
        if (!isNaN(ms)) meta.duration = ms;
        break;
      }
      case 'Exit Code':
        meta.exitCode = value === 'null' ? null : parseInt(value, 10);
        break;
      case 'Agent ID':
        meta.agentId = value;
        break;
      case 'Agent Name':
        meta.agentName = value;
        break;
      case 'Type':
        if (!meta.agentName) meta.agentName = value;
        break;
    }
  }

  return meta;
}

/** Read first N lines from a file efficiently. */
function readFirstLines(filePath: string, maxLines: number): string[] {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(4096);
    const bytesRead = fs.readSync(fd, buf);
    const text = buf.toString('utf8', 0, bytesRead);
    return text.split('\n').slice(0, maxLines);
  } finally {
    fs.closeSync(fd);
  }
}

interface LogSection {
  name: string;
  content: string;
}

const SECTION_CONTENT_LIMIT = 512 * 1024; // 500KB per section

/** Parse a log file into named sections. */
function parseLogSections(content: string): LogSection[] {
  const sections: LogSection[] = [];
  const sectionRegex = /^=== (.+?) ===$/gm;
  let match: RegExpExecArray | null;
  const markers: Array<{ name: string; start: number }> = [];

  while ((match = sectionRegex.exec(content)) !== null) {
    markers.push({ name: match[1], start: match.index + match[0].length + 1 });
  }

  for (let i = 0; i < markers.length; i++) {
    const start = markers[i].start;
    const end =
      i + 1 < markers.length
        ? markers[i + 1].start - markers[i + 1].name.length - 7
        : content.length;
    let sectionContent = content.slice(start, end).trim();
    if (sectionContent.length > SECTION_CONTENT_LIMIT) {
      sectionContent =
        sectionContent.slice(0, SECTION_CONTENT_LIMIT) +
        `\n... (truncated, ${sectionContent.length - SECTION_CONTENT_LIMIT} chars omitted)`;
    }
    sections.push({ name: markers[i].name, content: sectionContent });
  }

  return sections;
}

// ─── Routes ───────────────────────────────────────────────────────────

/**
 * GET /api/logs/:groupFolder — List log files for a group (paginated).
 */
logsRoutes.get('/:groupFolder', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const folder = c.req.param('groupFolder');

  if (!canAccessFolder(user, folder)) {
    return c.json({ error: '无权访问该群组的日志' }, 403);
  }

  const logsDir = path.join(GROUPS_DIR, folder, 'logs');
  if (!fs.existsSync(logsDir)) {
    return c.json({ entries: [], total: 0 });
  }

  const offsetRaw = parseInt(c.req.query('offset') || '0', 10);
  const limitRaw = parseInt(c.req.query('limit') || '50', 10);
  const offset = Number.isFinite(offsetRaw) ? Math.max(0, offsetRaw) : 0;
  const limit = Number.isFinite(limitRaw)
    ? Math.min(Math.max(1, limitRaw), 200)
    : 50;

  try {
    const allFiles = fs
      .readdirSync(logsDir)
      .filter((f) => f.endsWith('.log'))
      .sort()
      .reverse(); // newest first (filenames contain timestamps)

    const total = allFiles.length;
    const pageFiles = allFiles.slice(offset, offset + limit);

    const entries: LogEntryMeta[] = [];
    for (const filename of pageFiles) {
      try {
        const filePath = path.join(logsDir, filename);
        const stat = fs.statSync(filePath);
        const headerLines = readFirstLines(filePath, 15);
        entries.push(parseLogHeader(headerLines, filename, stat.size));
      } catch (err) {
        logger.warn({ filename, err }, 'Failed to parse log file header');
      }
    }

    return c.json({ entries, total });
  } catch (err) {
    logger.error({ folder, err }, 'Failed to list log files');
    return c.json({ error: '读取日志目录失败' }, 500);
  }
});

/**
 * GET /api/logs/:groupFolder/:filename — Get parsed log file content.
 */
logsRoutes.get('/:groupFolder/:filename', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const folder = c.req.param('groupFolder');
  const filename = c.req.param('filename');

  if (!canAccessFolder(user, folder)) {
    return c.json({ error: '无权访问该群组的日志' }, 403);
  }

  if (!isValidLogFilename(filename)) {
    return c.json({ error: '无效的日志文件名' }, 400);
  }

  const filePath = path.join(GROUPS_DIR, folder, 'logs', filename);
  if (!fs.existsSync(filePath)) {
    return c.json({ error: '日志文件不存在' }, 404);
  }

  try {
    const stat = fs.statSync(filePath);
    const content = fs.readFileSync(filePath, 'utf8');
    const sections = parseLogSections(content);

    return c.json({
      filename,
      fileSize: stat.size,
      sections,
    });
  } catch (err) {
    logger.error({ folder, filename, err }, 'Failed to read log file');
    return c.json({ error: '读取日志文件失败' }, 500);
  }
});

/**
 * GET /api/logs/:groupFolder/:filename/raw — Download raw log file.
 */
logsRoutes.get('/:groupFolder/:filename/raw', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const folder = c.req.param('groupFolder');
  const filename = c.req.param('filename');

  if (!canAccessFolder(user, folder)) {
    return c.json({ error: '无权访问该群组的日志' }, 403);
  }

  if (!isValidLogFilename(filename)) {
    return c.json({ error: '无效的日志文件名' }, 400);
  }

  const filePath = path.join(GROUPS_DIR, folder, 'logs', filename);
  if (!fs.existsSync(filePath)) {
    return c.json({ error: '日志文件不存在' }, 404);
  }

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return new Response(content, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    logger.error({ folder, filename, err }, 'Failed to read raw log file');
    return c.json({ error: '下载日志文件失败' }, 500);
  }
});

export default logsRoutes;
