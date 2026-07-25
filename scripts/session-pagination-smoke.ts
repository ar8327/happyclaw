import assert from 'node:assert/strict';

interface SessionSummary {
  id: string;
  name: string;
  folder: string;
  lastMessage?: string;
}

interface SessionListResponse {
  sessions: Record<string, SessionSummary>;
  pagination: {
    page: number;
    page_size: number;
    total: number;
    total_pages: number;
    has_next: boolean;
    has_previous: boolean;
  };
  query: string;
}

interface SessionOptionsResponse {
  sessions: Array<{
    id: string;
    name: string;
    folder: string;
    kind: 'main' | 'workspace';
  }>;
}

const baseUrl = (
  process.env.HAPPYCLAW_BASE_URL ||
  process.env.AGENTDOCK_BASE_URL ||
  'http://127.0.0.1:3000'
)
  .trim()
  .replace(/\/+$/, '');
const cookie = process.env.HAPPYCLAW_AUTH_COOKIE?.trim();
const pageSize = 7;

async function fetchJson<T>(
  path: string,
): Promise<{ data: T; durationMs: number; bytes: number }> {
  const startedAt = performance.now();
  const response = await fetch(`${baseUrl}${path}`, {
    headers: cookie ? { cookie } : undefined,
    signal: AbortSignal.timeout(8_000),
  });
  const body = await response.text();
  const durationMs = performance.now() - startedAt;
  assert.equal(
    response.ok,
    true,
    `${path} returned ${response.status}: ${body.slice(0, 500)}`,
  );
  return {
    data: JSON.parse(body) as T,
    durationMs,
    bytes: Buffer.byteLength(body),
  };
}

const listPath = '/api/sessions?kinds=main%2Cworkspace';
const first = await fetchJson<SessionListResponse>(
  `${listPath}&page=1&page_size=${pageSize}`,
);
const firstIds = Object.keys(first.data.sessions);
assert.equal(first.data.pagination.page, 1);
assert.equal(first.data.pagination.page_size, pageSize);
assert.ok(firstIds.length <= pageSize);
assert.equal(
  first.data.pagination.total_pages,
  Math.ceil(first.data.pagination.total / pageSize),
);
assert.equal(
  first.data.pagination.has_next,
  first.data.pagination.total > pageSize,
);
assert.equal(first.data.pagination.has_previous, false);
for (const session of Object.values(first.data.sessions)) {
  assert.ok(
    (session.lastMessage?.length || 0) <= 500,
    `session ${session.id} returned an unbounded message preview`,
  );
}

if (first.data.pagination.total > pageSize) {
  const second = await fetchJson<SessionListResponse>(
    `${listPath}&page=2&page_size=${pageSize}`,
  );
  const secondIds = Object.keys(second.data.sessions);
  assert.equal(second.data.pagination.page, 2);
  assert.equal(second.data.pagination.has_previous, true);
  assert.deepEqual(
    secondIds.filter((id) => firstIds.includes(id)),
    [],
    'adjacent pages must not contain duplicate sessions',
  );
}

const expectedLastPage = Math.max(1, first.data.pagination.total_pages);
const outOfRange = await fetchJson<SessionListResponse>(
  `${listPath}&page=1000000&page_size=${pageSize}`,
);
assert.equal(
  outOfRange.data.pagination.page,
  expectedLastPage,
  'out-of-range requests must resolve to the final valid page',
);

const sample = Object.values(first.data.sessions)[0];
if (sample) {
  const search = await fetchJson<SessionListResponse>(
    `${listPath}&page=1&page_size=${pageSize}&q=${encodeURIComponent(sample.id)}`,
  );
  assert.ok(
    search.data.sessions[sample.id],
    `search by exact session ID must return ${sample.id}`,
  );

  const direct = await fetchJson<{ session: SessionSummary }>(
    `/api/sessions/${encodeURIComponent(sample.id)}`,
  );
  assert.equal(direct.data.session.id, sample.id);
}

const options = await fetchJson<SessionOptionsResponse>(
  '/api/sessions/options',
);
assert.equal(
  options.data.sessions.length,
  first.data.pagination.total,
  'lightweight options and paginated list must expose the same authorized set',
);

console.log(
  [
    'session pagination smoke passed',
    `total=${first.data.pagination.total}`,
    `first_page=${first.durationMs.toFixed(1)}ms/${first.bytes}B`,
    `out_of_range=${outOfRange.durationMs.toFixed(1)}ms/${outOfRange.bytes}B`,
    `options=${options.durationMs.toFixed(1)}ms/${options.bytes}B`,
  ].join(' '),
);
