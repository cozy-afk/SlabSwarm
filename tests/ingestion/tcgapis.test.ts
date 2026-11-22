import assert from 'node:assert/strict';
import { test } from 'node:test';

const tcgMod = () => import('../../server/ingest/adapters/tcgapis.ts');
const storeMod = () => import('../../server/ingest/store.ts');
const runnerMod = () => import('../../server/ingest/runner.ts');

const KEY = 'tcg-test-key-DO-NOT-PRINT-12345';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const fetchContext = (options: Record<string, unknown> = {}) => ({
  mode: 'backfill' as const,
  since: null,
  cursor: null,
  capturedAt: '2026-11-22T16:00:00.000Z',
  options,
});

test('TCGAPIs adapter is disabled by default and makes zero HTTP calls', async () => {
  const { createTcgapisAdapter } = await tcgMod();
  let calls = 0;
  const adapter = createTcgapisAdapter({
    env: { TCGAPI_KEY: KEY },
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ data: [] });
    },
  });
  const result = await adapter.fetch(fetchContext());
  assert.equal(calls, 0);
  assert.equal(result.items.length, 0);
  assert.equal(result.meta?.skipped, 'TCGAPI_DISABLED');
});

test('enabled adapter with no key makes zero HTTP calls', async () => {
  const { createTcgapisAdapter } = await tcgMod();
  let calls = 0;
  const adapter = createTcgapisAdapter({
    env: { TCGAPI_ENABLED: 'true' },
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ data: [] });
    },
  });
  const result = await adapter.fetch(fetchContext());
  assert.equal(calls, 0);
  assert.equal(result.meta?.skipped, 'TCGAPI_KEY_MISSING');
});

test('enabled adapter uses the key as a server-side header and emits GUIDE candidates', async () => {
  const { createInMemoryRepositories } = await storeMod();
  const { runIngest } = await runnerMod();
  const { createTcgapisAdapter } = await tcgMod();
  const seen: Array<{ url: string; key: string | null }> = [];
  const adapter = createTcgapisAdapter({
    env: { TCGAPI_ENABLED: 'true', TCGAPI_KEY: KEY },
    fetchImpl: async (input, init) => {
      const headers = new Headers(init?.headers);
      seen.push({
        url: String(input),
        key: headers.get('x-api-key'),
      });
      return jsonResponse({
        data: [
          {
            id: 'tcg-1',
            name: 'Pikachu',
            set_name: 'Base',
            number: '025',
            product_type: 'Cards',
            market_price: 42.5,
            game_name: 'pokemon',
          },
        ],
      });
    },
  });
  const repos = createInMemoryRepositories();
  const logs: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(' '));
  console.error = (...args: unknown[]) => logs.push(args.map(String).join(' '));
  let result;
  try {
    result = await runIngest(adapter, repos, {
      mode: 'backfill',
      options: { queries: [{ q: 'pikachu', game: 'pokemon' }] },
    });
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.key, KEY, 'key is sent only as a request header');
  assert.match(seen[0]?.url ?? '', /api\.tcgapi\.dev|tcgapi/);
  assert.equal(result?.run.counts.created, 1);
  assert.equal(result?.candidates[0]?.basis, 'GUIDE', 'market price is a guide, not a sale');
  assert.equal(result?.candidates[0]?.amount, 42.5);
  assert.ok(!JSON.stringify(result?.run).includes(KEY), 'run record must never contain the key');
  assert.ok(!logs.join('\n').includes(KEY), 'adapter must never print the key');
});

test('verifyTcgapiStatus reports status only, never the key or response body', async () => {
  const { verifyTcgapiStatus } = await tcgMod();
  const noKey = await verifyTcgapiStatus({
    env: { TCGAPI_ENABLED: 'true' },
    fetchImpl: async () => jsonResponse({}),
  });
  assert.equal(noKey, 'NO_KEY');

  const disabled = await verifyTcgapiStatus({
    env: { TCGAPI_ENABLED: 'false', TCGAPI_KEY: KEY },
    fetchImpl: async () => jsonResponse({}),
  });
  assert.equal(disabled, 'DISABLED');

  const ok = await verifyTcgapiStatus({
    env: { TCGAPI_ENABLED: 'true', TCGAPI_KEY: KEY },
    fetchImpl: async () => jsonResponse({ data: [] }, 200),
  });
  assert.equal(ok, 'OK');

  const unauthorized = await verifyTcgapiStatus({
    env: { TCGAPI_ENABLED: 'true', TCGAPI_KEY: KEY },
    fetchImpl: async () => jsonResponse({ error: 'invalid key' }, 401),
  });
  assert.equal(unauthorized, 'UNAUTHORIZED');
});

test('TCGAPIs HTTP failures are captured as parse errors without throwing', async () => {
  const { createInMemoryRepositories } = await storeMod();
  const { runIngest } = await runnerMod();
  const { createTcgapisAdapter } = await tcgMod();
  const adapter = createTcgapisAdapter({
    env: { TCGAPI_ENABLED: 'true', TCGAPI_KEY: KEY },
    fetchImpl: async () => jsonResponse({ error: 'oops' }, 500),
  });
  const result = await runIngest(adapter, createInMemoryRepositories(), {
    mode: 'backfill',
    options: { queries: [{ q: 'x', game: 'pokemon' }] },
  });
  assert.equal(result.run.status, 'FAILED');
  assert.ok(result.run.errors.some((e) => /HTTP 500/i.test(e.message)));
  assert.ok(!JSON.stringify(result.run.errors).includes(KEY));
});
