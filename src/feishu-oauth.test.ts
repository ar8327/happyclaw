import assert from 'node:assert/strict';
import {
  buildOAuthUrl,
  parseFeishuDocUrl,
  readFeishuDocument,
} from './feishu-oauth.js';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function testOAuthRequestsSheetReadScope(): void {
  const url = new URL(
    buildOAuthUrl('app-id', 'https://example.test/callback', 'state'),
  );
  const scopes = new Set((url.searchParams.get('scope') || '').split(' '));
  assert.equal(scopes.has('sheets:spreadsheet:readonly'), true);
}

function testSheetUrlParsing(): void {
  assert.deepEqual(
    parseFeishuDocUrl(
      'https://tenant.larksuite.com/sheets/shtExample?sheet=sheet123',
    ),
    {
      token: 'shtExample',
      type: 'sheet',
      sheetId: 'sheet123',
    },
  );
  assert.deepEqual(
    parseFeishuDocUrl(
      'https://tenant.larksuite.com/wiki/wikiExample?sheet=sheet456',
    ),
    {
      token: 'wikiExample',
      type: 'wiki',
      sheetId: 'sheet456',
    },
  );
}

async function testWikiSheetRead(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const requestedUrls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    requestedUrls.push(url);
    if (url.includes('/wiki/v2/spaces/get_node')) {
      return jsonResponse({
        code: 0,
        data: {
          node: {
            space_id: 'space-1',
            node_token: 'wikiExample',
            obj_token: 'shtExample',
            obj_type: 'sheet',
            title: '设备状态表',
          },
        },
      });
    }
    if (url.includes('/metainfo')) {
      return jsonResponse({
        code: 0,
        data: {
          properties: { title: '设备状态表' },
          sheets: [
            {
              sheetId: 'otherSheet',
              title: '说明',
              index: 0,
              rowCount: 20,
              columnCount: 4,
            },
            {
              sheetId: 'sheet123',
              title: '人工状态',
              index: 1,
              rowCount: 200,
              columnCount: 4,
            },
          ],
        },
      });
    }
    if (url.includes('/values/sheet123')) {
      return jsonResponse({
        code: 0,
        data: {
          valueRange: {
            range: 'sheet123!A1:C3',
            values: [
              ['设备号', '状态', '备注'],
              ['A0001', '备用机', '研发\n测试'],
              ['A0002', '送修维修中', { text: '等待配件' }],
            ],
          },
        },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;

  try {
    const result = await readFeishuDocument(
      'user-token',
      'https://tenant.larksuite.com/wiki/wikiExample?sheet=sheet123',
    );
    assert.equal(result.title, '设备状态表');
    assert.equal(
      result.content,
      '设备号\t状态\t备注\nA0001\t备用机\t研发\\n测试\nA0002\t送修维修中\t等待配件',
    );
    assert.equal(
      requestedUrls.some((url) => url.includes('/values/sheet123?')),
      true,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
}

testOAuthRequestsSheetReadScope();
testSheetUrlParsing();
await testWikiSheetRead();
console.log('feishu oauth sheet tests passed');
