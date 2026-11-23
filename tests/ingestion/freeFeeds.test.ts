// Free catalog feed adapters: tests use injected fetch only. No live
// third-party call, no real key and no key material in fixtures or output.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { computeChecksum, validateEvidenceInput } from '../../server/ingest/evidence.ts';
import { createInMemoryRepositories } from '../../server/ingest/store.ts';
import { runIngest } from '../../server/ingest/runner.ts';
import type { FreeFeedConfig } from '../../server/contracts/freeFeed.ts';

interface FakeResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

function respond(body: unknown, status = 200): FakeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

const CAPTURED_AT = '2026-11-23T12:00:00.000Z';
const fetchContext = (options: Record<string, unknown> = {}) => ({
  mode: 'backfill' as const,
  since: null,
  cursor: null,
  capturedAt: CAPTURED_AT,
  options: { sleep: async () => {}, ...options },
});

function configFor(sourceId: string, configs: FreeFeedConfig[]): FreeFeedConfig {
  const config = configs.find((entry) => entry.sourceId === sourceId);
  assert.ok(config, `missing FREE_FEEDS config for ${sourceId}`);
  return config;
}

test('Scryfall /cards maps to catalog records with amount and basis UNKNOWN', async () => {
  const { FREE_FEEDS } = await import('../../server/ingest/freeFeeds.ts');
  const { createFreeFeedAdapter, toEvidenceInput } = await import(
    '../../server/ingest/adapters/freeCatalog.ts'
  );
  const config = configFor('scryfall', FREE_FEEDS);
  const body = {
    data: [
      {
        id: 'scry-1',
        name: 'Black Lotus',
        set_name: 'Limited Edition Alpha',
        collector_number: '232',
        game: 'magic',
        finishes: ['nonfoil'],
        // A price present in the payload must not be invented into a fact by
        // a catalog-only feed.
        prices: { usd: '50000.00', eur: '48000.00' },
        scryfall_uri: 'https://scryfall.com/card/lea/232/black-lotus',
        released_at: '1993-08-05',
      },
    ],
  };
  const adapter = createFreeFeedAdapter(config);
  const result = await adapter.fetch(
    fetchContext({
      paths: ['/cards'],
      fetchImpl: async (url: string) => {
        assert.match(url, /\/cards$/);
        return respond(body);
      },
    }),
  );
  assert.equal(result.items.length, 1);
  const item = result.items[0]!;
  assert.equal(item.payload.recordKind, 'CATALOG_CARD');
  assert.equal(item.payload.basis, 'UNKNOWN');
  assert.equal(item.payload.price, null, 'no price is invented for a catalog record');
  assert.equal(item.payload.amount, null);
  assert.equal(item.payload.currency, 'UNKNOWN');
  assert.equal((item.payload.record as Record<string, unknown>).amount, 'UNKNOWN');
  assert.equal(item.payload.license, config.license);
  assert.equal(item.checksum, computeChecksum(JSON.stringify(body)), 'raw bytes are checksummed');
  assert.equal(item.payload.rawResponse, JSON.stringify(body), 'raw response bytes preserved');

  const evidenceInput = toEvidenceInput(
    item.payload.record as never,
    JSON.stringify(body),
    CAPTURED_AT,
  );
  assert.equal(validateEvidenceInput(evidenceInput).sourceId, 'scryfall');
  assert.equal(evidenceInput.parsedPayload?.recordKind, 'CATALOG_CARD');
});

test('Scryfall bulk export arrays map to catalog records with no invented price', async () => {
  const { FREE_FEEDS } = await import('../../server/ingest/freeFeeds.ts');
  const { createFreeFeedAdapter } = await import(
    '../../server/ingest/adapters/freeCatalog.ts'
  );
  const config = configFor('scryfall', FREE_FEEDS);
  const bulk = [
    { id: 'bulk-1', name: 'Anchor Slug', set_name: 'Zendikar', collector_number: '1' },
    { id: 'bulk-2', name: 'Bulk Card', set: 'dom', number: '2' },
  ];
  const adapter = createFreeFeedAdapter(config);
  const result = await adapter.fetch(
    fetchContext({
      paths: ['/bulk-data'],
      fetchImpl: async () => respond(bulk),
    }),
  );
  assert.equal(result.items.length, 2);
  for (const item of result.items) {
    assert.equal(item.payload.recordKind, 'CATALOG_CARD');
    assert.equal(item.payload.basis, 'UNKNOWN');
    assert.equal(item.payload.price, null);
  }
  assert.equal((result.items[0]!.payload.record as Record<string, unknown>).externalId, 'bulk-1');
  assert.equal((result.items[1]!.payload.record as Record<string, unknown>).externalId, 'bulk-2');
});

test('Pokemon TCG API preserves USD and EUR prices and their source URLs', async () => {
  const { FREE_FEEDS } = await import('../../server/ingest/freeFeeds.ts');
  const { createFreeFeedAdapter } = await import(
    '../../server/ingest/adapters/freeCatalog.ts'
  );
  const config = configFor('pokemontcg', FREE_FEEDS);
  const body = {
    data: [
      {
        id: 'base1-4',
        name: 'Charizard',
        set: { id: 'base1', name: 'Base' },
        number: '4',
        tcgplayer: {
          url: 'https://www.tcgplayer.com/product/4386',
          prices: { normal: { market: 412.5 } },
        },
        cardmarket: {
          url: 'https://www.cardmarket.com/en/Pokemon/Products/Singles/Base/Charizard',
          prices: { averageSellPrice: 390.25 },
        },
      },
      {
        id: 'base1-2',
        name: 'Blastoise',
        set: { name: 'Base' },
        number: '2',
        cardmarket: {
          url: 'https://www.cardmarket.com/en/Pokemon/Products/Singles/Base/Blastoise',
          prices: { averageSellPrice: 188.75 },
        },
      },
    ],
  };
  const adapter = createFreeFeedAdapter(config);
  const result = await adapter.fetch(
    fetchContext({ paths: ['/v2/cards'], fetchImpl: async () => respond(body) }),
  );
  assert.equal(result.items.length, 2);
  const usd = result.items[0]!;
  const eur = result.items[1]!;
  assert.equal(usd.payload.recordKind, 'PRICE_GUIDE');
  assert.equal(usd.payload.basis, 'GUIDE');
  assert.equal(usd.payload.price, 412.5);
  assert.equal(usd.payload.currency, 'USD');
  assert.equal(usd.payload.source, 'pokemontcg');
  assert.equal(usd.sourceUri, 'https://www.tcgplayer.com/product/4386');
  assert.equal(eur.payload.currency, 'EUR');
  assert.equal(eur.payload.price, 188.75);
  assert.equal(
    eur.sourceUri,
    'https://www.cardmarket.com/en/Pokemon/Products/Singles/Base/Blastoise',
  );
  assert.ok(!result.items.some((item) => item.payload.basis === 'SOLD'));
});

test('CardDex writes GUIDE prices with license, attribution and a server-side key', async () => {
  const { FREE_FEEDS } = await import('../../server/ingest/freeFeeds.ts');
  const { createFreeFeedAdapter } = await import(
    '../../server/ingest/adapters/freeCatalog.ts'
  );
  const config = configFor('carddex', FREE_FEEDS);
  assert.equal(config.attributionRequired, true);
  assert.equal(config.apiKeyEnv, 'CARDEX_API_KEY');
  const key = 'carddex-server-only-key-DO-NOT-PRINT';
  const body = {
    data: [
      {
        id: 'cd-1',
        name: 'Example Card',
        set: 'Series 1',
        number: '12',
        price: 87.25,
        currency: 'USD',
        observedAt: '2026-11-23T09:00:00.000Z',
      },
    ],
  };
  let seenKey: string | null = null;
  const adapter = createFreeFeedAdapter(config);
  const result = await adapter.fetch(
    fetchContext({
      paths: ['/cards'],
      env: { CARDEX_API_KEY: key },
      fetchImpl: async (url: string, init?: { headers?: Record<string, string> }) => {
        assert.ok(!String(url).includes(key), 'key must never appear in a URL');
        seenKey = new Headers(init?.headers).get('x-api-key');
        return respond(body);
      },
    }),
  );
  assert.equal(seenKey, key, 'key is read from the config-named env var and sent as a header');
  assert.equal(result.items.length, 1);
  const item = result.items[0]!;
  assert.equal(item.payload.recordKind, 'PRICE_GUIDE');
  assert.equal(item.payload.basis, 'GUIDE');
  assert.equal(item.payload.price, 87.25);
  assert.equal(item.payload.license, config.license);
  const record = item.payload.record as Record<string, unknown>;
  assert.equal(record.license, config.license);
  assert.match(String(record.attribution), /CardDex/i);
  assert.ok(!JSON.stringify(result).includes(key), 'run data must never contain the key');
});

test('Cardex keyless adapter enforces the 100-request daily cap and per-request delay', async () => {
  const { FREE_FEEDS } = await import('../../server/ingest/freeFeeds.ts');
  const { createFreeFeedAdapter, CARDEX_DAILY_REQUEST_LIMIT } = await import(
    '../../server/ingest/adapters/freeCatalog.ts'
  );
  const config = configFor('cardex', FREE_FEEDS);
  assert.equal(CARDEX_DAILY_REQUEST_LIMIT, 100);
  let calls = 0;
  let sawKeyHeader = false;
  const waits: number[] = [];
  const paths = Array.from({ length: 150 }, (_, index) => `/cards/${index + 1}`);
  const adapter = createFreeFeedAdapter(config);
  const result = await adapter.fetch(
    fetchContext({
      paths,
      env: { CARDEX_API_KEY: 'must-not-be-sent-to-cardex' },
      sleep: async (ms: number) => {
        waits.push(ms);
      },
      fetchImpl: async (_url: string, init?: { headers?: Record<string, string> }) => {
        calls += 1;
        if (new Headers(init?.headers).has('x-api-key')) sawKeyHeader = true;
        return respond({ data: [] });
      },
    }),
  );
  assert.equal(calls, 100, 'request counter stops the run at the published 100/day cap');
  assert.equal(result.meta?.requestsIssued, 100);
  assert.equal(result.meta?.dailyCapReached, true);
  assert.equal(sawKeyHeader, false, 'cardex reads no key at all');
  assert.equal(waits.length, 99, 'per-request delay is applied between issued requests');
  assert.ok(waits.every((ms) => ms === config.rateLimitMs));
});

test('Cardex 100/day cap persists across two fetch calls on one adapter instance', async () => {
  const { FREE_FEEDS } = await import('../../server/ingest/freeFeeds.ts');
  const { createFreeFeedAdapter, CARDEX_DAILY_REQUEST_LIMIT } = await import(
    '../../server/ingest/adapters/freeCatalog.ts'
  );
  const config = configFor('cardex', FREE_FEEDS);
  let calls = 0;
  const fetchImpl: () => Promise<FakeResponse> = async () => {
    calls += 1;
    return respond({ data: [] });
  };
  const adapter = createFreeFeedAdapter(config);
  const firstPaths = Array.from({ length: 60 }, (_, index) => `/cards/${index + 1}`);
  const secondPaths = Array.from({ length: 60 }, (_, index) => `/cards/${index + 61}`);

  const first = await adapter.fetch(fetchContext({ paths: firstPaths, fetchImpl }));
  const second = await adapter.fetch(fetchContext({ paths: secondPaths, fetchImpl }));

  assert.equal(first.meta?.requestsIssued, 60);
  assert.equal(first.meta?.dailyRequestsIssued, 60);
  assert.equal(second.meta?.requestsIssued, 40, 'the second call only gets the remaining allowance');
  assert.equal(second.meta?.dailyRequestsIssued, CARDEX_DAILY_REQUEST_LIMIT);
  assert.equal(second.meta?.dailyCapReached, true);
  assert.equal(calls, 100, 'two calls in one day must never exceed the 100/day cap');

  const third = await adapter.fetch(fetchContext({ paths: ['/cards/extra'], fetchImpl }));
  assert.equal(third.meta?.requestsIssued, 0, 'the counter is not reset by another call');
  assert.equal(calls, 100);
});

test('a 429 stops the run with a sanitized error containing no key, URL credential or body', async () => {
  const { createFreeFeedAdapter } = await import(
    '../../server/ingest/adapters/freeCatalog.ts'
  );
  const { FREE_FEEDS } = await import('../../server/ingest/freeFeeds.ts');
  const config = configFor('carddex', FREE_FEEDS);
  const key = 'carddex-secret-429-DO-NOT-LEAK';
  const bodyMarker = 'SECRET_RESPONSE_BODY_MARKER';
  const adapter = createFreeFeedAdapter(config);
  const result = await runIngest(adapter, createInMemoryRepositories(), {
    mode: 'backfill',
    options: {
      paths: ['/cards'],
      env: { CARDEX_API_KEY: key },
      fetchImpl: async () =>
        respond(
          { error: bodyMarker, hint: `key=${key}`, url: 'https://user:pass@host.invalid/x' },
          429,
        ),
    },
  });
  assert.equal(result.run.status, 'FAILED', 'a 429 stops the run');
  assert.ok(
    result.run.errors.some((error) => /429/.test(error.message)),
    'the sanitized error names the status',
  );
  const serialized = JSON.stringify(result.run);
  assert.ok(!serialized.includes(key), 'no key in the run record');
  assert.ok(!serialized.includes(bodyMarker), 'no response body in the run record');
  assert.ok(!serialized.includes('user:pass'), 'no URL credential in the run record');
});

test('no TCGAPI_KEY is read by any free feed; CardDex uses only apiKeyEnv', async () => {
  const { FREE_FEEDS } = await import('../../server/ingest/freeFeeds.ts');
  const { createFreeFeedAdapter } = await import(
    '../../server/ingest/adapters/freeCatalog.ts'
  );
  assert.equal(FREE_FEEDS.length, 4);
  assert.ok(FREE_FEEDS.every((config) => config.apiKeyEnv !== 'TCGAPI_KEY'));
  const tcgKey = 'tcgapi-key-DO-NOT-READ';
  const carddexKey = 'carddex-key-from-apiKeyEnv';
  const seen: string[] = [];
  for (const config of FREE_FEEDS) {
    const adapter = createFreeFeedAdapter(config);
    await adapter.fetch(
      fetchContext({
        paths: ['/cards'],
        env: { TCGAPI_KEY: tcgKey, CARDEX_API_KEY: carddexKey },
        fetchImpl: async (_url: string, init?: { headers?: Record<string, string> }) => {
          const headers = new Headers(init?.headers);
          seen.push(headers.get('x-api-key') ?? '');
          return respond({ data: [] });
        },
      }),
    );
  }
  assert.ok(!seen.includes(tcgKey), 'TCGAPI_KEY is never read');
  assert.ok(seen.includes(carddexKey), 'only the config-named env var is read');
  const missingLicense = createFreeFeedAdapter({ ...configFor('scryfall', FREE_FEEDS), license: '' });
  let calls = 0;
  const disabled = await missingLicense.fetch(
    fetchContext({ paths: ['/cards'], fetchImpl: async () => { calls += 1; return respond({ data: [] }); } }),
  );
  assert.equal(calls, 0, 'a config with no license disables the feed');
  assert.equal(disabled.items.length, 0);
});
