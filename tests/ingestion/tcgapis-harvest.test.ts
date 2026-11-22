import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const harvestMod = () => import('../../server/ingest/tcgapis-harvest.ts');
const storeMod = () => import('../../server/ingest/store.ts');

const KEY = 'tcg-harvest-key-DO-NOT-PRINT-67890';
const CAPTURED_AT = '2026-11-22T12:00:00.000Z';

interface FakeResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

function jsonResponse(body: unknown, status = 200): FakeResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function catalog(gameCount = 1, expansionCount = 1, cardCount = 1) {
  const games = Array.from({ length: gameCount }, (_, i) => ({
    categoryId: i + 1,
    name: `Game ${i + 1}`,
  }));
  const expansions = Array.from({ length: expansionCount }, (_, i) => ({
    groupId: i + 10,
    name: `Set ${i + 1}`,
  }));
  const cards = Array.from({ length: cardCount }, (_, i) => ({
    productId: 100 + i,
    name: `Card ${i + 1}`,
    number: String(i + 1),
    expansionName: 'Set 1',
    gameName: 'Game 1',
  }));
  return { games, expansions, cards };
}

function fixture(options: {
  gameCount?: number;
  expansionCount?: number;
  cardCount?: number;
  priceBody?: (productId: string) => unknown;
  saleBody?: (productId: string) => unknown;
  fail?: { path: string; status: number; body: unknown };
} = {}) {
  const { games, expansions, cards } = catalog(
    options.gameCount ?? 1,
    options.expansionCount ?? 1,
    options.cardCount ?? 1,
  );
  const seen: Array<{ url: string; key: string | null }> = [];
  const fetchImpl = async (url: string, init?: { headers?: Record<string, string> }) => {
    const path = new URL(url).pathname;
    seen.push({ url, key: init?.headers?.['x-api-key'] ?? null });
    if (options.fail && path === options.fail.path) {
      return jsonResponse(options.fail.body, options.fail.status);
    }
    if (path === '/api/v2/games') return jsonResponse({ success: true, data: games });
    const expansionMatch = path.match(/^\/api\/v2\/expansions\/(\d+)$/);
    if (expansionMatch) return jsonResponse({ success: true, data: expansions });
    const cardsMatch = path.match(/^\/api\/v2\/cards\/(\d+)$/);
    if (cardsMatch) return jsonResponse({ success: true, data: cards });
    const priceMatch = path.match(/^\/api\/v2\/prices\/(\d+)$/);
    if (priceMatch) {
      const body = options.priceBody?.(priceMatch[1]) ?? {
        success: true,
        data: {
          productId: Number(priceMatch[1]),
          prices: { Normal: { marketPrice: 12.5, lowPrice: 8 } },
          last_updated: '2026-11-19T10:00:00Z',
        },
      };
      return jsonResponse(body);
    }
    const salesMatch = path.match(/^\/api\/v2\/sales-history\/(\d+)$/);
    if (salesMatch) {
      const body = options.saleBody?.(salesMatch[1]) ?? {
        success: true,
        data: {
          sales: [
            { price: 5, currency: 'USD', date: '2026-11-18T00:00:00Z' },
            { price: 7, currency: 'USD', date: '2026-11-17T00:00:00Z' },
          ],
        },
      };
      return jsonResponse(body);
    }
    return jsonResponse({ success: false, error: 'unknown path' }, 404);
  };
  return { fetchImpl, seen, cards, games, expansions };
}

const env = (overrides: Record<string, string | undefined> = {}) => ({
  TCGAPI_ENABLED: 'true',
  TCGAPI_KEY: KEY,
  TCGAPI_HARVEST_CREDIT_BUDGET: '60',
  ...overrides,
});

test('disabled flag (including the default) makes zero HTTP calls and spends nothing', async () => {
  const { runTcgapisHarvest } = await harvestMod();
  const { createInMemoryRepositories } = await storeMod();
  for (const testEnv of [env({ TCGAPI_ENABLED: 'false' }), { TCGAPI_KEY: KEY }]) {
    const repos = createInMemoryRepositories();
    let calls = 0;
    const result = await runTcgapisHarvest({
      repos,
      env: testEnv,
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({});
      },
    });
    assert.equal(calls, 0);
    assert.equal(result.creditsSpent, 0);
    assert.equal(result.evidenceWritten, 0);
    assert.equal(result.stoppedAtBudget, false);
    assert.deepEqual(result.errors, []);
    assert.equal((await repos.evidence.list({})).length, 0);
  }
});

test('credit budget stops the chain before exceeding the cap', async () => {
  const { runTcgapisHarvest } = await harvestMod();
  const { createInMemoryRepositories } = await storeMod();
  const f = fixture({ cardCount: 20 }); // 20 candidate products
  const result = await runTcgapisHarvest({
    repos: createInMemoryRepositories(),
    env: env(),
    budget: 5,
    fetchImpl: f.fetchImpl,
  });
  assert.equal(f.cards.length, 20);
  assert.ok(result.creditsSpent <= 5, `spend ${result.creditsSpent} exceeded budget 5`);
  assert.equal(result.creditsSpent, 4); // expansions 1 + cards 1 + prices 2
  assert.equal(result.stoppedAtBudget, true);
  assert.equal(f.seen.length, 4); // games, expansions, cards, one price call
  assert.ok(result.cards >= 1 && result.cards <= 20, 'only products visited before the cap are counted');
  assert.ok(result.prices >= 1);
  assert.ok(f.seen.every((call) => call.key === KEY), 'key sent only as x-api-key header');
  assert.ok(!JSON.stringify(result).includes(KEY));
});

test('price-guide evidence keeps GUIDE basis, source currency and source timestamp', async () => {
  const { runTcgapisHarvest } = await harvestMod();
  const { createInMemoryRepositories } = await storeMod();
  const f = fixture({
    priceBody: (productId) => ({
      success: true,
      data: {
        productId: Number(productId),
        prices: { Foil: { marketPrice: 42, directLowPrice: 30 } },
        currency: 'EUR',
        last_updated: '2026-11-14T08:30:00Z',
      },
    }),
  });
  const repos = createInMemoryRepositories();
  const result = await runTcgapisHarvest({
    repos,
    env: env(),
    includeSalesHistory: false,
    fetchImpl: f.fetchImpl,
  });
  assert.deepEqual(result.errors, []);
  assert.ok(result.prices >= 2);
  const guides = await repos.candidates.list({ basis: 'GUIDE' });
  const evidenceRows = await repos.evidence.list({ sourceId: 'tcgapis' });
  const marketEvidence = evidenceRows.find(
    (row) => (row.parsedPayload as Record<string, unknown>)?.priceField === 'marketPrice',
  );
  assert.ok(marketEvidence, 'marketPrice must be emitted as a GUIDE evidence record');
  const market = guides.find((candidate) => candidate.evidenceId === marketEvidence.id);
  assert.ok(market, 'marketPrice must be emitted as a GUIDE candidate');
  assert.equal(market?.amount, 42);
  assert.equal(market?.currency, 'EUR', 'original currency must be preserved');
  assert.equal(market?.observedAt, '2026-11-14T08:30:00Z', 'source timestamp must be preserved');
  assert.equal(market?.basis, 'GUIDE');
  assert.equal(market?.sourceId, 'tcgapis');
  assert.equal((marketEvidence.parsedPayload as Record<string, unknown>)?.basis, 'GUIDE');
  assert.equal((marketEvidence.parsedPayload as Record<string, unknown>)?.currency, 'EUR');
  assert.equal((await repos.candidates.list({ basis: 'SOLD' })).length, 0);
  assert.ok(!JSON.stringify(result).includes(KEY));
});

test('two runs over the same payloads write one evidence row per source + id + checksum', async () => {
  const { runTcgapisHarvest } = await harvestMod();
  const { createInMemoryRepositories } = await storeMod();
  const f = fixture({ cardCount: 2 });
  const repos = createInMemoryRepositories();
  const first = await runTcgapisHarvest({
    repos,
    env: env(),
    capturedAt: CAPTURED_AT,
    includeSalesHistory: false,
    fetchImpl: f.fetchImpl,
  });
  const rows = await repos.evidence.list({});
  const firstRow = rows[0];
  assert.ok(firstRow);
  const before = JSON.stringify(firstRow);
  assert.ok(first.evidenceWritten > 0);

  const second = await runTcgapisHarvest({
    repos,
    env: env(),
    capturedAt: CAPTURED_AT,
    includeSalesHistory: false,
    fetchImpl: f.fetchImpl,
  });
  assert.equal(second.evidenceWritten, 0, 'rerun must not create new evidence');
  assert.equal((await repos.evidence.list({})).length, rows.length);
  assert.equal(JSON.stringify(await repos.evidence.get(firstRow.id)), before, 'first row unchanged');
});

test('HTTP 403 TRIAL_CREDITS_USED stops with a safe error and no retry', async () => {
  const { runTcgapisHarvest } = await harvestMod();
  const { createInMemoryRepositories } = await storeMod();
  const f = fixture({
    fail: {
      path: '/api/v2/games',
      status: 403,
      body: { success: false, error: { code: 'TRIAL_CREDITS_USED' } },
    },
  });
  const repos = createInMemoryRepositories();
  const result = await runTcgapisHarvest({ repos, env: env(), fetchImpl: f.fetchImpl });
  assert.equal(f.seen.length, 1, 'no retry after trial credits exhaustion');
  assert.ok(
    result.errors.some((message) => message.includes('TRIAL_CREDITS_USED')),
    'safe error string must describe the credit exhaustion',
  );
  assert.ok(result.errors.every((message) => !message.includes(KEY)));
  assert.ok(!JSON.stringify(result).includes(KEY));
  assert.equal(result.evidenceWritten, 0);
  assert.equal((await repos.evidence.list({})).length, 0);
});

test('sales are SOLD, keep their own currency and are never summed with guides', async () => {
  const { runTcgapisHarvest } = await harvestMod();
  const { createInMemoryRepositories } = await storeMod();
  const f = fixture({
    priceBody: (productId) => ({
      success: true,
      data: { prices: { Normal: { marketPrice: 12.5 } }, currency: 'EUR', last_updated: '2026-11-19T10:00:00Z' },
    }),
    saleBody: () => ({
      success: true,
      data: {
        sales: [
          { price: 5, currency: 'USD', date: '2026-11-18T00:00:00Z' },
          { price: 7, currency: 'USD', date: '2026-11-17T00:00:00Z' },
        ],
      },
    }),
  });
  const repos = createInMemoryRepositories();
  const result = await runTcgapisHarvest({ repos, env: env(), fetchImpl: f.fetchImpl });
  assert.deepEqual(result.errors, []);
  assert.equal(result.sales, 2);
  const sold = await repos.candidates.list({ basis: 'SOLD' });
  assert.deepEqual(sold.map((candidate) => candidate.amount).sort(), [5, 7]);
  assert.ok(sold.every((candidate) => candidate.currency === 'USD'));
  assert.ok(sold.every((candidate) => candidate.observedAt?.startsWith('2026-11-1')));
  const guides = await repos.candidates.list({ basis: 'GUIDE' });
  assert.ok(guides.length >= 1);
  assert.ok(guides.every((candidate) => candidate.currency === 'EUR'));
  assert.ok(!guides.some((candidate) => candidate.amount === 12));
});

test('the harvest never persists the API key to the durable ledger', async () => {
  const { runTcgapisHarvest } = await harvestMod();
  const { createDurableRepositories } = await storeMod();
  const dir = mkdtempSync(join(tmpdir(), 'tcg-harvest-ledger-'));
  try {
    const filePath = join(dir, 'ingest-store.json');
    const f = fixture({ cardCount: 2 });
    const result = await runTcgapisHarvest({
      repos: createDurableRepositories({ filePath }),
      env: env(),
      includeSalesHistory: false,
      fetchImpl: f.fetchImpl,
    });
    assert.ok(result.evidenceWritten > 0);
    const persisted = readFileSync(filePath, 'utf8');
    assert.ok(!persisted.includes(KEY), 'ledger must not contain the key');
    assert.ok(!JSON.stringify(result).includes(KEY));
    assert.ok(f.seen.every((call) => call.key === KEY), 'key is only ever an HTTP header');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
