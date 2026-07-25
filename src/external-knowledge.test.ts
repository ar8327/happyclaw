import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const originalCwd = process.cwd();
const originalToken = process.env.HAPPYCLAW_EXTERNAL_KNOWLEDGE_TOKEN;
const originalOwner = process.env.HAPPYCLAW_EXTERNAL_KNOWLEDGE_OWNER;
const fixtureRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happyclaw-external-knowledge-'),
);

process.chdir(fixtureRoot);
process.env.HAPPYCLAW_EXTERNAL_KNOWLEDGE_TOKEN = 'fixture-token';
process.env.HAPPYCLAW_EXTERNAL_KNOWLEDGE_OWNER = 'fixture-owner';

try {
  const database = await import('./db.js');
  database.initDatabase();
  try {
    const routeModule = await import('./routes/external-knowledge.js');
    routeModule.injectExternalKnowledgeDeps({
      orchestrator: {
        enqueueExternalKnowledge(ownerKey, payload, dedupKey) {
          const job = database.enqueueMemoryWrite({
            ownerKey,
            kind: 'external_knowledge_ingest',
            payload,
            dedupKey,
          });
          const stored = JSON.parse(job.payload) as {
            externalInputFile?: string;
          };
          return {
            requestId: job.id,
            duplicate: stored.externalInputFile !== payload.externalInputFile,
          };
        },
      },
    });

    const unauthorized = await routeModule.default.request('/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'fixture' }),
    });
    assert.equal(unauthorized.status, 401);

    const requestBody = {
      content: 'AgentDock 的外部知识导入使用持久化队列。',
      source: { type: 'test', uri: 'fixture://knowledge' },
      dedupe_key: 'fixture-dedupe-key',
    };
    const first = await routeModule.default.request('/ingest', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer fixture-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });
    assert.equal(first.status, 202);
    const firstBody = (await first.json()) as {
      request_id: string;
      status: string;
      input_file: string;
      duplicate: boolean;
    };
    assert.equal(firstBody.status, 'pending');
    assert.equal(firstBody.duplicate, false);
    assert.match(firstBody.request_id, /^[0-9a-f-]{36}$/);

    const inputPath = path.join(
      fixtureRoot,
      'data',
      ...firstBody.input_file.split('/'),
    );
    assert.equal(fs.existsSync(inputPath), true);
    assert.match(
      fs.readFileSync(inputPath, 'utf-8'),
      /Raw Material \(untrusted\)/,
    );

    const duplicatePending = await routeModule.default.request('/ingest', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer fixture-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });
    assert.equal(duplicatePending.status, 202);
    const duplicatePendingBody = (await duplicatePending.json()) as {
      request_id: string;
      duplicate: boolean;
    };
    assert.equal(duplicatePendingBody.request_id, firstBody.request_id);
    assert.equal(duplicatePendingBody.duplicate, true);

    database.completeMemoryWrite(firstBody.request_id, 'done', {
      success: true,
      response: '已提取一条知识',
      touchedFiles: ['knowledge/external-api.md'],
    });

    const status = await routeModule.default.request(
      `/requests/${firstBody.request_id}`,
      {
        headers: { Authorization: 'Bearer fixture-token' },
      },
    );
    assert.equal(status.status, 200);
    const statusBody = (await status.json()) as {
      status: string;
      response: string;
      touched_files: string[];
    };
    assert.equal(statusBody.status, 'success');
    assert.equal(statusBody.response, '已提取一条知识');
    assert.deepEqual(statusBody.touched_files, ['knowledge/external-api.md']);

    const duplicateDone = await routeModule.default.request('/ingest', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer fixture-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });
    assert.equal(duplicateDone.status, 200);
    const duplicateDoneBody = (await duplicateDone.json()) as {
      request_id: string;
      duplicate: boolean;
      status: string;
    };
    assert.equal(duplicateDoneBody.request_id, firstBody.request_id);
    assert.equal(duplicateDoneBody.duplicate, true);
    assert.equal(duplicateDoneBody.status, 'success');

    const tooLarge = await routeModule.default.request('/ingest', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer fixture-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: 'x'.repeat(100 * 1024 + 1) }),
    });
    assert.equal(tooLarge.status, 413);

    process.env.HAPPYCLAW_EXTERNAL_KNOWLEDGE_OWNER = '../escape';
    const invalidOwner = await routeModule.default.request('/ingest', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer fixture-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: 'fixture' }),
    });
    assert.equal(invalidOwner.status, 503);
  } finally {
    database.closeDatabase();
  }
} finally {
  process.chdir(originalCwd);
  if (originalToken === undefined) {
    delete process.env.HAPPYCLAW_EXTERNAL_KNOWLEDGE_TOKEN;
  } else {
    process.env.HAPPYCLAW_EXTERNAL_KNOWLEDGE_TOKEN = originalToken;
  }
  if (originalOwner === undefined) {
    delete process.env.HAPPYCLAW_EXTERNAL_KNOWLEDGE_OWNER;
  } else {
    process.env.HAPPYCLAW_EXTERNAL_KNOWLEDGE_OWNER = originalOwner;
  }
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}

console.log('external knowledge ingest tests passed');
