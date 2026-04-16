/**
 * Feishu OAuth 2.0 Client for user_access_token.
 *
 * Provides OAuth authorization flow and document reading capabilities
 * using the Feishu Open Platform API.
 *
 * This module is independent from feishu.ts (which handles IM connections).
 * OAuth tokens are stored in the global IM config file.
 */

import crypto from 'crypto';
import { logger } from './logger.js';
import {
  getImFeishuOAuthTokens,
  saveImFeishuOAuthTokens,
  getImFeishuConfig,
  getSystemSettings,
} from './runtime-config.js';

// ─── Types ──────────────────────────────────────────────────────────

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // Unix timestamp ms
  scopes: string;
}

export interface WikiNode {
  spaceId: string;
  nodeToken: string;
  objToken: string;
  objType: string;
  title: string;
}

// ─── OAuth State Management (in-memory, 10-min expiry) ──────────────

interface OAuthStateEntry {
  sessionHash: string;
  createdAt: number;
}

const oauthStates = new Map<string, OAuthStateEntry>();
const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function hashSessionToken(sessionToken: string): string {
  return crypto.createHash('sha256').update(sessionToken).digest('hex');
}

/** Generate a new OAuth state token and bind it to the current auth session. */
export function createOAuthState(sessionToken: string): string {
  // Cleanup expired states
  const now = Date.now();
  for (const [key, entry] of oauthStates) {
    if (now - entry.createdAt > STATE_TTL_MS) {
      oauthStates.delete(key);
    }
  }

  const state = crypto.randomBytes(32).toString('hex');
  oauthStates.set(state, {
    sessionHash: hashSessionToken(sessionToken),
    createdAt: now,
  });
  return state;
}

/** Validate and consume an OAuth state token for the current auth session. */
export function consumeOAuthState(
  state: string,
  expectedSessionToken?: string,
): boolean {
  const entry = oauthStates.get(state);
  if (!entry) return false;

  if (Date.now() - entry.createdAt > STATE_TTL_MS) {
    oauthStates.delete(state); // expired — safe to clean up
    return false;
  }

  if (
    expectedSessionToken
    && entry.sessionHash !== hashSessionToken(expectedSessionToken)
  ) {
    return false; // mismatch — don't consume
  }

  oauthStates.delete(state);
  return true;
}

// ─── OAuth URLs & Token Exchange ────────────────────────────────────

const FEISHU_AUTH_BASE = 'https://accounts.feishu.cn/open-apis/authen/v1/authorize';
/** Get the Feishu API base URL from system settings. */
function getFeishuApiBase(): string {
  const domain = getSystemSettings().feishuApiDomain || 'open.feishu.cn';
  return `https://${domain}/open-apis`;
}


/** Generic Feishu API response shape. */
interface FeishuApiResponse {
  code?: number;
  msg?: string;
  error?: string;
  error_description?: string;
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  data?: {
    content?: string;
    node?: {
      space_id?: string;
      node_token?: string;
      obj_token?: string;
      obj_type?: string;
      title?: string;
    };
  };
}

const DEFAULT_SCOPES =
  'wiki:wiki:readonly docx:document:readonly search:docs:read contact:user.base:readonly drive:drive.metadata:readonly space:document:retrieve offline_access';

/**
 * Build the Feishu OAuth authorization URL.
 */
export function buildOAuthUrl(
  appId: string,
  redirectUri: string,
  state: string,
  scopes?: string,
): string {
  const params = new URLSearchParams({
    client_id: appId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: scopes || DEFAULT_SCOPES,
    state,
  });
  return `${FEISHU_AUTH_BASE}?${params.toString()}`;
}

/**
 * Exchange authorization code for access + refresh tokens.
 */
export async function exchangeCodeForTokens(
  appId: string,
  appSecret: string,
  code: string,
  redirectUri: string,
): Promise<OAuthTokens> {
  const tokenUrl = `${getFeishuApiBase()}/authen/v2/oauth/token`;
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: appId,
      client_secret: appSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });

  const data = (await res.json()) as FeishuApiResponse;

  if (data.code && data.code !== 0) {
    throw new Error(
      `Feishu OAuth error: ${data.error || data.code} - ${data.error_description || data.msg || 'Unknown error'}`,
    );
  }

  if (!data.access_token) {
    throw new Error('Feishu OAuth: no access_token in response');
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || '',
    expiresAt: Date.now() + (data.expires_in || 7200) * 1000,
    scopes: data.scope || '',
  };
}

/**
 * Refresh an expired access token using a refresh token.
 */
export async function refreshAccessToken(
  appId: string,
  appSecret: string,
  refreshToken: string,
): Promise<OAuthTokens> {
  const tokenUrl = `${getFeishuApiBase()}/authen/v2/oauth/token`;
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: appId,
      client_secret: appSecret,
      refresh_token: refreshToken,
    }),
  });

  const data = (await res.json()) as FeishuApiResponse;

  if (data.code && data.code !== 0) {
    throw new Error(
      `Feishu token refresh error: ${data.error || data.code} - ${data.error_description || data.msg || 'Unknown error'}`,
    );
  }

  if (!data.access_token) {
    throw new Error('Feishu token refresh: no access_token in response');
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    expiresAt: Date.now() + (data.expires_in || 7200) * 1000,
    scopes: data.scope || '',
  };
}

/**
 * Get a valid access token for a user, auto-refreshing if needed.
 * Returns null if the user has not authorized OAuth.
 */
export async function getValidAccessToken(
  _sessionScope?: string,
): Promise<string | null> {
  const tokens = getImFeishuOAuthTokens();
  if (!tokens || !tokens.accessToken) return null;

  // Token still valid (with 5-min buffer)
  if (tokens.expiresAt > Date.now() + 5 * 60 * 1000) {
    return tokens.accessToken;
  }

  // Need to refresh
  if (!tokens.refreshToken) {
    logger.warn('Feishu OAuth: token expired and no refresh token');
    return null;
  }

  const config = getImFeishuConfig();
  if (!config?.appId || !config?.appSecret) {
    logger.warn('Feishu OAuth: cannot refresh, missing app credentials');
    return null;
  }

  try {
    const newTokens = await refreshAccessToken(
      config.appId,
      config.appSecret,
      tokens.refreshToken,
    );

    // Save the new tokens
    saveImFeishuOAuthTokens({
      accessToken: newTokens.accessToken,
      refreshToken: newTokens.refreshToken,
      expiresAt: newTokens.expiresAt,
      scopes: newTokens.scopes,
    });

    logger.info('Feishu OAuth: token refreshed successfully');
    return newTokens.accessToken;
  } catch (err) {
    logger.error({ err }, 'Feishu OAuth: token refresh failed');
    return null;
  }
}

// ─── Document Reading API ───────────────────────────────────────────


/**
 * Parse a Feishu URL to extract the document/wiki token.
 * Supports:
 *   - Wiki: https://xxx.feishu.cn/wiki/{token}
 *   - Docs: https://xxx.feishu.cn/docx/{token}
 *   - Lark Office: https://xxx.larkoffice.com/wiki/{token}
 */
export function parseFeishuDocUrl(url: string): {
  token: string;
  type: 'wiki' | 'docx' | 'unknown';
} | null {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);

    if (parts.length >= 2) {
      const docType = parts[parts.length - 2];
      const token = parts[parts.length - 1].split('?')[0];

      if (docType === 'wiki') return { token, type: 'wiki' };
      if (docType === 'docx') return { token, type: 'docx' };

      // Fallback: try last segment as token
      return { token, type: 'unknown' };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve a wiki node token to get the actual document ID and metadata.
 */
export async function getWikiNode(
  accessToken: string,
  nodeToken: string,
): Promise<WikiNode> {
  const res = await fetch(
    `${getFeishuApiBase()}/wiki/v2/spaces/get_node?token=${encodeURIComponent(nodeToken)}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  );

  const data = (await res.json()) as FeishuApiResponse;

  if (data.code !== 0) {
    throw new Error(
      `Feishu Wiki API error (${data.code}): ${data.msg || 'Unknown error'}`,
    );
  }

  const node = data.data?.node;
  if (!node) {
    throw new Error('Feishu Wiki API: no node data in response');
  }

  return {
    spaceId: node.space_id || '',
    nodeToken: node.node_token || nodeToken,
    objToken: node.obj_token || '',
    objType: node.obj_type || '',
    title: node.title || '',
  };
}

/**
 * Get document content as plain text.
 */
export async function getDocumentRawContent(
  accessToken: string,
  documentId: string,
): Promise<string> {
  const res = await fetch(
    `${getFeishuApiBase()}/docx/v1/documents/${encodeURIComponent(documentId)}/raw_content`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  );

  const data = (await res.json()) as FeishuApiResponse;

  if (data.code !== 0) {
    throw new Error(
      `Feishu Document API error (${data.code}): ${data.msg || 'Unknown error'}`,
    );
  }

  return data.data?.content || '';
}

/**
 * Read a Feishu document/wiki from URL.
 * Handles both wiki pages (resolve node → get content) and direct docx.
 */
export async function readFeishuDocument(
  accessToken: string,
  url: string,
): Promise<{ title: string; content: string }> {
  const parsed = parseFeishuDocUrl(url);
  if (!parsed) {
    throw new Error(`无法解析飞书文档 URL: ${url}`);
  }

  let documentId = parsed.token;
  let title = '';

  if (parsed.type === 'wiki' || parsed.type === 'unknown') {
    // For wiki pages, resolve node to get actual document ID
    try {
      const node = await getWikiNode(accessToken, parsed.token);
      documentId = node.objToken;
      title = node.title;

      if (node.objType !== 'docx' && node.objType !== 'doc') {
        return {
          title: node.title,
          content: `此文档类型为 ${node.objType}，当前仅支持读取 docx 类型的文档。`,
        };
      }
    } catch (err) {
      // If wiki resolution fails for 'unknown' type, try as direct docx
      if (parsed.type === 'unknown') {
        documentId = parsed.token;
      } else {
        throw err;
      }
    }
  }

  const content = await getDocumentRawContent(accessToken, documentId);
  return { title, content };
}

// ─── Document Search API ────────────────────────────────────────────

export interface SearchResult {
  docToken: string;
  title: string;
  url: string;
  docType: string;
  owner: string;
  createTime: string;
  updateTime: string;
  preview: string;
}

export interface SearchResponse {
  results: SearchResult[];
  hasMore: boolean;
  total: number;
}

const VALID_DOC_TYPES = ['doc', 'docx', 'sheet', 'bitable', 'mindnote', 'wiki', 'slide'] as const;
export type FeishuDocType = (typeof VALID_DOC_TYPES)[number];

/** Check if a string is a valid Feishu doc type. */
export function isValidDocType(t: string): t is FeishuDocType {
  return (VALID_DOC_TYPES as readonly string[]).includes(t);
}

/**
 * Search Feishu documents using the suite/docs-api/search endpoint.
 * Requires search:docs:read scope.
 */
export async function searchFeishuDocs(
  accessToken: string,
  query: string,
  options?: {
    count?: number; // max results per page (default 20, max 50)
    offset?: number; // pagination offset
    ownerIds?: string[]; // filter by owner user IDs
    docTypes?: string[]; // filter by doc type
  },
): Promise<SearchResponse> {
  const count = Math.min(Math.max(options?.count ?? 20, 1), 50);
  const offset = options?.offset ?? 0;

  // Build request body for the search API
  const body: Record<string, unknown> = {
    search_key: query,
    count,
    offset,
  };

  if (options?.ownerIds?.length) {
    body.owner_ids = options.ownerIds;
  }
  if (options?.docTypes?.length) {
    // Only pass valid doc types
    const validTypes = options.docTypes.filter(isValidDocType);
    if (validTypes.length) {
      body.docs_types = validTypes;
    }
  }

  const res = await fetch(`${getFeishuApiBase()}/suite/docs-api/search/object`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = await res.json() as {
    code?: number;
    msg?: string;
    data?: {
      docs_entities?: Array<{
        docs_token?: string;
        docs_type?: string;
        title?: string;
        owner_id?: string;
        create_time?: string;
        update_time?: string;
        preview?: string;
      }>;
      has_more?: boolean;
      total?: number;
    };
  };

  if (data.code !== 0) {
    throw new Error(
      `Feishu Search API error (${data.code}): ${data.msg || 'Unknown'}`,
    );
  }

  const entities = data.data?.docs_entities || [];
  return {
    results: entities.map((e) => ({
      docToken: e.docs_token || '',
      title: (e.title || '').replace(/<[^>]*>/g, ''), // strip HTML highlight tags
      url: buildDocUrl(e.docs_token || '', e.docs_type || 'docx'),
      docType: e.docs_type || 'unknown',
      owner: e.owner_id || '',
      createTime: e.create_time || '',
      updateTime: e.update_time || '',
      preview: (e.preview || '').replace(/<[^>]*>/g, ''),
    })),
    hasMore: data.data?.has_more || false,
    total: data.data?.total || entities.length,
  };
}

/**
 * Search Feishu Wiki nodes.
 * Requires wiki:wiki:readonly scope.
 * Uses POST /wiki/v2/nodes/search with query in request body.
 */
export async function searchFeishuWiki(
  accessToken: string,
  query: string,
  options?: {
    pageSize?: number;
    pageToken?: string;
  },
): Promise<SearchResponse> {
  const pageSize = Math.min(Math.max(options?.pageSize ?? 20, 1), 50);

  // Build query params for pagination
  const params = new URLSearchParams();
  params.set('page_size', String(pageSize));
  if (options?.pageToken) {
    params.set('page_token', options.pageToken);
  }

  const res = await fetch(
    `${getFeishuApiBase()}/wiki/v2/nodes/search?${params.toString()}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query }),
    },
  );

  const data = await res.json() as {
    code?: number;
    msg?: string;
    data?: {
      items?: Array<{
        space_id?: string;
        node_token?: string;
        obj_token?: string;
        obj_type?: string;
        title?: string;
        url?: string;
      }>;
      has_more?: boolean;
      page_token?: string;
    };
  };

  if (data.code !== 0) {
    throw new Error(
      `Feishu Wiki Search API error (${data.code}): ${data.msg || 'Unknown'}`,
    );
  }

  const items = data.data?.items || [];
  return {
    results: items.map((item) => ({
      docToken: item.node_token || '',
      title: item.title || '',
      url: item.url || buildDocUrl(item.node_token || '', 'wiki'),
      docType: item.obj_type || 'wiki',
      owner: '',
      createTime: '',
      updateTime: '',
      preview: '',
    })),
    hasMore: data.data?.has_more || false,
    total: items.length, // Wiki API doesn't return total count
  };
}

// ─── User Info API ──────────────────────────────────────────────────

/**
 * Batch resolve Feishu open_ids to user names.
 * Uses GET /open-apis/contact/v3/users/:user_id (user_id_type=open_id).
 * Returns a map of open_id → display name. Unknown IDs are omitted.
 */
export async function batchResolveUserNames(
  accessToken: string,
  openIds: string[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  // Deduplicate and filter empty
  const unique = [...new Set(openIds.filter((id) => id))];
  if (unique.length === 0) return result;

  // Fetch in parallel (max 20 concurrent to avoid rate limiting)
  const batchSize = 20;
  for (let i = 0; i < unique.length; i += batchSize) {
    const batch = unique.slice(i, i + batchSize);
    const promises = batch.map(async (openId) => {
      try {
        const resp = await fetch(
          `https://open.feishu.cn/open-apis/contact/v3/users/${openId}?user_id_type=open_id`,
          {
            headers: { Authorization: `Bearer ${accessToken}` },
          },
        );
        const data = (await resp.json()) as {
          code?: number;
          data?: { user?: { name?: string } };
        };
        if (data.code === 0 && data.data?.user?.name) {
          result.set(openId, data.data.user.name);
        }
      } catch {
        // Silently skip failed lookups
      }
    });
    await Promise.all(promises);
  }

  return result;
}

/** Build a Feishu document URL from token and type. Uses configurable domain from system settings. */
export function buildDocUrl(token: string, docType: string): string {
  const typeMap: Record<string, string> = {
    doc: 'docs',
    docx: 'docx',
    sheet: 'sheets',
    bitable: 'base',
    mindnote: 'mindnotes',
    wiki: 'wiki',
    slide: 'slides',
  };
  const pathSegment = typeMap[docType] || 'docx';
  const domain = getSystemSettings().feishuDocDomain || 'larkoffice.com';
  return `https://${domain}/${pathSegment}/${token}`;
}
