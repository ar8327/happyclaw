/**
 * Internal HTTP endpoints for Feishu document reading.
 *
 * These endpoints are called by agent-runner (inside containers or host processes)
 * to read Feishu documents using the user's OAuth access token.
 *
 * Authentication: Bearer token (HAPPYCLAW_INTERNAL_TOKEN), same as memory-agent.
 * Reuses the internal token from memory-agent-routes.
 */

import { Hono } from 'hono';
import type { Variables } from '../web-context.js';
import { logger } from '../logger.js';
import {
  getValidAccessToken,
  readFeishuDocument,
  parseFeishuDocUrl,
  searchFeishuDocs,
  searchFeishuWiki,
  batchResolveUserNames,
} from '../feishu-oauth.js';

let internalToken: string | null = null;

/**
 * Inject dependencies at startup.
 * Called from src/index.ts after internal token is generated.
 */
export function injectFeishuApiDeps(deps: { token: string }): void {
  internalToken = deps.token;
}

const feishuApiRoutes = new Hono<{ Variables: Variables }>();

// Bearer token middleware for internal endpoints
function checkInternalAuth(c: {
  req: { header: (name: string) => string | undefined };
}): boolean {
  if (!internalToken) return false;
  const auth = c.req.header('Authorization');
  if (!auth) return false;
  const token = auth.replace(/^Bearer\s+/i, '');
  return token === internalToken;
}

/**
 * POST /api/internal/feishu/read-document
 * Read a Feishu document or wiki page.
 *
 * Body: { userId: string, url: string }
 * Returns: { title: string, content: string }
 */
feishuApiRoutes.post('/read-document', async (c) => {
  if (!checkInternalAuth(c)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const body = await c.req.json().catch(() => null);
  if (
    !body ||
    typeof body.userId !== 'string' ||
    typeof body.url !== 'string'
  ) {
    return c.json(
      { error: 'Invalid request: userId and url required' },
      400,
    );
  }

  const { userId, url } = body as { userId: string; url: string };

  // Validate URL format
  const parsed = parseFeishuDocUrl(url);
  if (!parsed) {
    return c.json(
      { error: '无法解析飞书文档 URL。支持的格式：https://xxx.feishu.cn/wiki/xxx 或 https://xxx.feishu.cn/docx/xxx' },
      400,
    );
  }

  // Get valid access token (auto-refreshes if needed)
  const accessToken = await getValidAccessToken(userId);
  if (!accessToken) {
    return c.json(
      {
        error: '未授权飞书文档访问。请在设置页面完成飞书 OAuth 授权。',
        code: 'OAUTH_REQUIRED',
      },
      401,
    );
  }

  try {
    const result = await readFeishuDocument(accessToken, url);
    return c.json({
      title: result.title,
      content: result.content,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : '读取飞书文档失败';
    logger.error({ err, userId, url }, 'Failed to read Feishu document');

    // Check for permission errors
    if (message.includes('1770032') || message.includes('403')) {
      return c.json(
        { error: '没有权限访问此文档。请确认文档已对你开放阅读权限。' },
        403,
      );
    }

    return c.json({ error: message }, 500);
  }
});

/**
 * POST /api/internal/feishu/search
 * Search Feishu documents and wiki pages.
 *
 * Body: { userId: string, query: string, count?: number, offset?: number, docTypes?: string[], searchWiki?: boolean }
 * Returns: { results: SearchResult[], hasMore: boolean, total: number }
 */
feishuApiRoutes.post('/search', async (c) => {
  if (!checkInternalAuth(c)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const body = await c.req.json().catch(() => null);
  if (
    !body ||
    typeof body.userId !== 'string' ||
    typeof body.query !== 'string'
  ) {
    return c.json(
      { error: 'Invalid request: userId and query required' },
      400,
    );
  }

  const {
    userId,
    query: rawQuery,
    count,
    offset,
    docTypes,
    searchWiki: doSearchWiki,
  } = body as {
    userId: string;
    query: string;
    count?: number;
    offset?: number;
    docTypes?: string[];
    searchWiki?: boolean;
  };

  const query = rawQuery.trim();
  if (!query) {
    return c.json(
      { error: '搜索关键词不能为空' },
      400,
    );
  }

  // Clamp count to [1, 50]
  const safeCount = Math.min(Math.max(typeof count === 'number' ? count : 20, 1), 50);
  const safeOffset = Math.max(typeof offset === 'number' ? offset : 0, 0);

  // Validate docTypes whitelist
  const VALID_DOC_TYPES = new Set(['doc', 'docx', 'sheet', 'bitable', 'mindnote', 'slide', 'wiki']);
  const safeDocTypes = Array.isArray(docTypes)
    ? docTypes.filter((t): t is string => typeof t === 'string' && VALID_DOC_TYPES.has(t))
    : undefined;

  // Get valid access token (auto-refreshes if needed)
  const accessToken = await getValidAccessToken(userId);
  if (!accessToken) {
    return c.json(
      {
        error: '未授权飞书文档访问。请在设置页面完成飞书 OAuth 授权。',
        code: 'OAUTH_REQUIRED',
      },
      401,
    );
  }

  try {
    // Search cloud docs
    const docResults = await searchFeishuDocs(accessToken, query, {
      count: safeCount,
      offset: safeOffset,
      docTypes: safeDocTypes,
    });

    // Optionally also search wiki
    let wikiResults = { results: [] as typeof docResults.results, hasMore: false, total: 0 };
    if (doSearchWiki) {
      try {
        wikiResults = await searchFeishuWiki(accessToken, query, {
          pageSize: safeCount,
        });
      } catch (err) {
        logger.warn({ err, userId }, 'Wiki search failed, returning doc results only');
      }
    }

    // Merge results, dedup by docToken
    const seen = new Set<string>();
    const merged = [];
    for (const r of [...docResults.results, ...wikiResults.results]) {
      if (!seen.has(r.docToken)) {
        seen.add(r.docToken);
        merged.push(r);
      }
    }

    // Resolve owner open_ids to display names
    const ownerIds = merged.map((r) => r.owner).filter(Boolean);
    let ownerNames = new Map<string, string>();
    if (ownerIds.length > 0) {
      try {
        ownerNames = await batchResolveUserNames(accessToken, ownerIds);
      } catch (err) {
        logger.warn({ err, userId }, 'Failed to resolve owner names, returning open_ids');
      }
    }

    // Replace owner open_ids with display names where available
    const enriched = merged.map((r) => ({
      ...r,
      owner: ownerNames.get(r.owner) || r.owner,
    }));

    return c.json({
      results: enriched,
      hasMore: docResults.hasMore || wikiResults.hasMore,
      total: enriched.length,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : '搜索飞书文档失败';
    logger.error({ err, userId, query }, 'Failed to search Feishu documents');

    if (message.includes('99991663') || message.includes('99991668')) {
      return c.json(
        { error: '搜索权限不足。请在飞书应用中启用 search:docs:read 权限，并重新授权。' },
        403,
      );
    }

    return c.json({ error: message }, 500);
  }
});

export default feishuApiRoutes;
