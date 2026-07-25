/**
 * External knowledge ingestion API.
 *
 * Callers submit untrusted source material. The MemoryOrchestrator processes it
 * through the durable write queue and extracts reusable, non-personal knowledge.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { Hono } from 'hono';
import { z } from 'zod';

import { DATA_DIR } from '../config.js';
import { getMemoryWriteQueueRecord } from '../db.js';
import { getLocalWorkbenchAuthUser } from '../local-user.js';
import { logger } from '../logger.js';
import { ensureMemoryDir, type MemoryOrchestrator } from '../memory-agent.js';
import { getSystemSettings } from '../runtime-config.js';
import type { Variables } from '../web-context.js';

const MAX_EXTERNAL_KNOWLEDGE_BYTES = 100 * 1024;
const MAX_EXTERNAL_SOURCE_BYTES = 16 * 1024;
const MAX_EXTERNAL_REQUEST_BYTES =
  MAX_EXTERNAL_KNOWLEDGE_BYTES + MAX_EXTERNAL_SOURCE_BYTES + 8 * 1024;
const TOKEN_ENV_NAMES = [
  'HAPPYCLAW_EXTERNAL_KNOWLEDGE_TOKEN',
  'HAPPYCLAW_EXTERNAL_MEMORY_TOKEN',
] as const;

const ExternalKnowledgeSourceSchema = z.union([
  z.string().max(2000),
  z.record(z.string(), z.unknown()),
]);

const ExternalKnowledgeIngestSchema = z.object({
  content: z.string().min(1),
  source: ExternalKnowledgeSourceSchema.optional(),
  scope: z.literal('global').optional().default('global'),
  dedupe_key: z.string().min(1).max(500).optional(),
  wait: z.boolean().optional().default(false),
  workspace_folder: z.string().min(1).max(200).optional(),
  chat_jid: z.string().min(1).max(300).optional(),
});

type ExternalKnowledgeIngest = z.infer<typeof ExternalKnowledgeIngestSchema>;
type ExternalKnowledgeQueueResult = {
  success?: boolean;
  response?: string;
  error?: string;
  touchedFiles?: string[];
};

type ExternalKnowledgeOrchestrator = Pick<
  MemoryOrchestrator,
  'enqueueExternalKnowledge'
>;

let orchestrator: ExternalKnowledgeOrchestrator | null = null;

export function injectExternalKnowledgeDeps(deps: {
  orchestrator: ExternalKnowledgeOrchestrator;
}): void {
  orchestrator = deps.orchestrator;
}

const externalKnowledgeRoutes = new Hono<{ Variables: Variables }>();

function configuredTokens(): string[] {
  return TOKEN_ENV_NAMES.flatMap((name) =>
    (process.env[name] || '')
      .split(',')
      .map((token) => token.trim())
      .filter(Boolean),
  );
}

function tokensEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function checkExternalAuth(c: {
  req: { header: (name: string) => string | undefined };
}): 'ok' | 'not_configured' | 'unauthorized' {
  const tokens = configuredTokens();
  if (tokens.length === 0) return 'not_configured';
  const match = c.req.header('Authorization')?.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  if (!token) return 'unauthorized';
  return tokens.some((configured) => tokensEqual(configured, token))
    ? 'ok'
    : 'unauthorized';
}

function ownerKeyForExternalIngest(): string {
  const ownerKey =
    process.env.HAPPYCLAW_EXTERNAL_KNOWLEDGE_OWNER?.trim() ||
    getLocalWorkbenchAuthUser().id;
  if (
    ownerKey.length > 200 ||
    ownerKey === '.' ||
    ownerKey === '..' ||
    ownerKey.includes('/') ||
    ownerKey.includes('\\') ||
    ownerKey.includes('\0')
  ) {
    throw new Error('Invalid external knowledge owner');
  }
  return ownerKey;
}

function sourceToText(source: unknown): string {
  if (source === undefined || source === null) return 'external';
  if (typeof source === 'string') return source;
  return JSON.stringify(source, null, 2);
}

function parseJsonObject(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseQueueResult(raw: string | null): ExternalKnowledgeQueueResult {
  const parsed = parseJsonObject(raw);
  return {
    success: typeof parsed.success === 'boolean' ? parsed.success : undefined,
    response: typeof parsed.response === 'string' ? parsed.response : undefined,
    error: typeof parsed.error === 'string' ? parsed.error : undefined,
    touchedFiles: Array.isArray(parsed.touchedFiles)
      ? parsed.touchedFiles.filter(
          (item): item is string => typeof item === 'string',
        )
      : undefined,
  };
}

function serializeQueueRecord(
  record: NonNullable<ReturnType<typeof getMemoryWriteQueueRecord>>,
  duplicate = false,
) {
  const payload = parseJsonObject(record.payload);
  const result = parseQueueResult(record.result_json);
  const status =
    record.status === 'done'
      ? 'success'
      : record.status === 'dropped' || record.status === 'obsolete'
        ? 'error'
        : 'pending';
  return {
    duplicate,
    accepted: status === 'pending',
    request_id: record.id,
    kind: 'external_knowledge_ingest' as const,
    status,
    mode: 'extract_knowledge_only' as const,
    created_at: record.created_at,
    updated_at: record.updated_at,
    input_file:
      typeof payload.externalInputFile === 'string'
        ? payload.externalInputFile
        : undefined,
    response: result.response,
    error: result.error || record.last_error || undefined,
    touched_files: result.touchedFiles,
  };
}

function writeIncomingMaterial(
  ownerKey: string,
  materialId: string,
  payload: ExternalKnowledgeIngest,
): string {
  const relativePath = path.posix.join(
    'external-knowledge',
    ownerKey,
    'incoming',
    materialId,
    'material.md',
  );
  const fullPath = path.join(DATA_DIR, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  const content = [
    '# External Knowledge Ingest Material',
    '',
    `material_id: ${materialId}`,
    `created_at: ${new Date().toISOString()}`,
    `scope: ${payload.scope}`,
    payload.workspace_folder
      ? `workspace_folder: ${payload.workspace_folder}`
      : null,
    payload.chat_jid ? `chat_jid: ${payload.chat_jid}` : null,
    '',
    '## Source (untrusted)',
    '',
    sourceToText(payload.source),
    '',
    '## Raw Material (untrusted)',
    '',
    payload.content,
    '',
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
  const temporaryPath = `${fullPath}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporaryPath, content, {
    encoding: 'utf-8',
    mode: 0o600,
  });
  fs.renameSync(temporaryPath, fullPath);
  return relativePath;
}

function removeIncomingMaterial(relativePath: string): void {
  const fullPath = path.join(DATA_DIR, ...relativePath.split('/'));
  try {
    fs.unlinkSync(fullPath);
    fs.rmdirSync(path.dirname(fullPath));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTEMPTY') {
      logger.warn(
        { error, relativePath },
        'Failed to remove duplicate external knowledge material',
      );
    }
  }
}

function getExternalQueueRecord(requestId: string, ownerKey: string) {
  const record = getMemoryWriteQueueRecord(requestId);
  if (
    !record ||
    record.owner_key !== ownerKey ||
    record.kind !== 'external_knowledge_ingest'
  ) {
    return null;
  }
  return record;
}

async function waitForQueueCompletion(
  requestId: string,
  ownerKey: string,
): Promise<ReturnType<typeof getExternalQueueRecord>> {
  const timeoutMs = getSystemSettings().memorySendTimeout + 5_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const record = getExternalQueueRecord(requestId, ownerKey);
    if (
      !record ||
      record.status === 'done' ||
      record.status === 'dropped' ||
      record.status === 'obsolete'
    ) {
      return record;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return getExternalQueueRecord(requestId, ownerKey);
}

externalKnowledgeRoutes.get('/requests/:requestId', (c) => {
  const auth = checkExternalAuth(c);
  if (auth === 'not_configured') {
    return c.json(
      { error: 'External knowledge ingest token is not configured' },
      503,
    );
  }
  if (auth === 'unauthorized') {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const requestId = c.req.param('requestId');
  if (!z.string().uuid().safeParse(requestId).success) {
    return c.json({ error: 'Invalid request id' }, 400);
  }

  let ownerKey: string;
  try {
    ownerKey = ownerKeyForExternalIngest();
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : String(error) },
      503,
    );
  }
  const record = getExternalQueueRecord(requestId, ownerKey);
  if (!record) return c.json({ error: 'Request not found' }, 404);
  return c.json(serializeQueueRecord(record));
});

externalKnowledgeRoutes.post('/ingest', async (c) => {
  const auth = checkExternalAuth(c);
  if (auth === 'not_configured') {
    return c.json(
      { error: 'External knowledge ingest token is not configured' },
      503,
    );
  }
  if (auth === 'unauthorized') {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  if (!orchestrator) {
    return c.json({ error: 'Memory orchestrator not initialized' }, 503);
  }

  const declaredLength = Number(c.req.header('Content-Length') || 0);
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_EXTERNAL_REQUEST_BYTES
  ) {
    return c.json({ error: 'Request body is too large' }, 413);
  }
  const rawBody = await c.req.text();
  if (Buffer.byteLength(rawBody, 'utf-8') > MAX_EXTERNAL_REQUEST_BYTES) {
    return c.json({ error: 'Request body is too large' }, 413);
  }
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return c.json({ error: 'Invalid JSON request body' }, 400);
  }
  const validation = ExternalKnowledgeIngestSchema.safeParse(body);
  if (!validation.success) {
    return c.json(
      { error: 'Invalid request body', details: validation.error.format() },
      400,
    );
  }
  const payload = validation.data;
  if (
    Buffer.byteLength(payload.content, 'utf-8') > MAX_EXTERNAL_KNOWLEDGE_BYTES
  ) {
    return c.json(
      {
        error: `content is too large; max ${MAX_EXTERNAL_KNOWLEDGE_BYTES} bytes`,
      },
      413,
    );
  }
  const source = sourceToText(payload.source);
  if (Buffer.byteLength(source, 'utf-8') > MAX_EXTERNAL_SOURCE_BYTES) {
    return c.json(
      {
        error: `source is too large; max ${MAX_EXTERNAL_SOURCE_BYTES} bytes`,
      },
      413,
    );
  }

  let ownerKey: string;
  try {
    ownerKey = ownerKeyForExternalIngest();
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : String(error) },
      503,
    );
  }

  ensureMemoryDir(ownerKey);
  const materialId = crypto.randomUUID();
  const inputFile = writeIncomingMaterial(ownerKey, materialId, payload);
  const dedupKey = payload.dedupe_key
    ? crypto.createHash('sha256').update(payload.dedupe_key).digest('hex')
    : undefined;

  let queued: ReturnType<
    ExternalKnowledgeOrchestrator['enqueueExternalKnowledge']
  >;
  try {
    queued = orchestrator.enqueueExternalKnowledge(
      ownerKey,
      {
        externalInputFile: inputFile,
        source,
        workspaceFolder: payload.workspace_folder,
        chatJid: payload.chat_jid,
      },
      dedupKey,
    );
  } catch (error) {
    removeIncomingMaterial(inputFile);
    logger.error({ error, ownerKey }, 'Failed to enqueue external knowledge');
    return c.json({ error: 'Failed to enqueue external knowledge' }, 500);
  }

  if (queued.duplicate) {
    removeIncomingMaterial(inputFile);
  }

  let record = getExternalQueueRecord(queued.requestId, ownerKey);
  if (!record) {
    return c.json({ error: 'External knowledge queue record not found' }, 500);
  }
  if (payload.wait && record.status !== 'done' && record.status !== 'dropped') {
    record =
      (await waitForQueueCompletion(queued.requestId, ownerKey)) || record;
  }

  const response = serializeQueueRecord(record, queued.duplicate);
  if (record.status === 'done') return c.json(response, 200);
  if (record.status === 'dropped' || record.status === 'obsolete') {
    return c.json(response, 502);
  }
  return c.json(response, 202);
});

export default externalKnowledgeRoutes;
