import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test, before, after } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';

/**
 * Source contract for the free-feed operator lane. Static assertions keep the
 * browser bundle honest (real routes, four feeds, attribution, a harvest
 * action per feed, plain-text errors, no placeholder copy or credentials).
 * The functional assertions drive the real ingest router over an ephemeral
 * port with an INJECTED fetch — no live third-party call is ever made.
 */
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const APP = 'src/App.tsx';
const VIEW = 'src/components/product/SourcesView.tsx';
const API = 'src/utils/dataProductApi.ts';
const ROUTES_FILE = 'server/ingest/routes.ts';
const FEEDS_FILE = 'server/ingest/freeFeeds.ts';

function read(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

const META_FIELDS = ['requestId', 'generatedAt', 'contractVersion', 'correctionPolicy', 'warnings'];
const SOURCE_IDS = ['scryfall', 'pokemontcg', 'carddex', 'cardex'];
const SECRET = 'SERVER-ONLY-CARDEX-KEY-DO-NOT-LEAK';

test('free feeds: API module declares both routes and typed fetchers', () => {
  const api = read(API);
  for (const declaration of [
    "freeFeeds: '/api/ingest/free-feeds'",
    "freeFeedsHarvest: '/api/ingest/free-feeds/:sourceId/harvest'",
    'export interface FreeFeedView',
    'export interface FreeFeedsResponse',
    'export interface FreeFeedHarvestCounts',
    'export interface FreeFeedHarvestResponse',
  ]) {
    assert.ok(api.includes(declaration), `API must declare ${declaration}`);
  }
  assert.match(api, /export function fetchFreeFeeds\(\): Promise<ApiEnvelope<FreeFeedsResponse>>/);
  assert.match(api, /fetchEnvelope<FreeFeedsResponse>\(ROUTES\.freeFeeds\)/);
  assert.match(
    api,
    /export function harvestFreeFeed\(\s*sourceId: string,\s*capturedAt\?: string\s*\): Promise<ApiEnvelope<FreeFeedHarvestResponse>>/,
  );
  assert.match(api, /postEnvelope<FreeFeedHarvestResponse>\(buildRoute\(ROUTES\.freeFeedsHarvest/);
  assert.ok(
    !/from\s+['"][^'"]*server/i.test(api),
    'browser API module must not import server code',
  );
});

test('free feeds: ingest router exposes both routes with public metadata only', () => {
  const routes = read(ROUTES_FILE);
  const feeds = read(FEEDS_FILE);
  for (const token of [
    "from './freeFeeds.ts'",
    'FREE_FEEDS',
    'getFreeFeed',
    "from './adapters/freeCatalog.ts'",
    'createFreeFeedAdapter',
    'CARDEX_DAILY_REQUEST_LIMIT',
    "router.get('/api/ingest/free-feeds'",
    "router.post('/api/ingest/free-feeds/:sourceId/harvest'",
    'freeFeeds?.fetchImpl',
    'fetchImpl: freeFetch',
  ]) {
    assert.ok(routes.includes(token), `ingest router must contain ${token}`);
  }
  for (const sourceId of SOURCE_IDS) {
    assert.ok(feeds.includes(`sourceId: '${sourceId}'`), `registry must list ${sourceId}`);
  }
  for (const license of [
    'SCRYFALL_API_TERMS',
    'POKEMON_TCG_API_TERMS',
    'CARDEX_API_TERMS_ATTRIBUTION_REQUIRED',
    'CARDEX_PUBLIC_CATALOG_TERMS',
  ]) {
    assert.ok(feeds.includes(license), `registry must carry license ${license}`);
  }
  // Public metadata never reads an env value or exposes a key literal.
  assert.ok(!/process\.env\s*\[/.test(routes), 'router must not read env values by key');
  assert.ok(!/api[_-]?key/i.test(routes), 'router must not name or read a key');
  // The four attribution strings ship in the public metadata.
  for (const attribution of [
    'Scryfall API (scryfall.com)',
    'Pokemon TCG API (pokemontcg.io)',
    'CardDex API (carddex.io)',
    'Cardex public catalog (cardex.com)',
  ]) {
    assert.ok(routes.includes(attribution), `public metadata must include attribution: ${attribution}`);
  }
});

test('free feeds: Sources view lists all four feeds with license and attribution', () => {
  const view = read(VIEW);
  for (const token of [
    "import { useState, type FormEvent } from 'react'",
    'useEnvelope<FreeFeedsResponse>(ROUTES.freeFeeds)',
    'feeds.data.feeds.map(',
    'feed.sourceId',
    'feed.vertical',
    'feed.license',
    'feed.attribution',
    'const UNKNOWN_TEXT = \'UNKNOWN\'',
  ]) {
    assert.ok(view.includes(token), `view must contain ${token}`);
  }
  // The pre-existing evidence/observation display is preserved verbatim.
  for (const token of [
    'useEnvelope<EvidenceRecordView[]>(ROUTES.evidence)',
    'useEnvelope<ObservationView[]>(ROUTES.observations)',
    'Raw evidence records',
    'Normalized observations',
    'handleIngest',
  ]) {
    assert.ok(view.includes(token), `existing Sources display must remain: ${token}`);
  }
});

test('free feeds: one harvest action per feed surfaces counts and plain-text errors', () => {
  const view = read(VIEW);
  for (const token of [
    'harvestFreeFeed(feed.sourceId)',
    'harvestFreeFeed(',
    'aria-label={`Harvest ${feed.sourceId}`}',
    'disabled={harvesting === feed.sourceId}',
    'counts.fetched',
    'counts.created',
    'counts.duplicates',
    'counts.failed',
    'counts.candidates',
    'result.status',
    'result.errors.join(\'; \')',
    'role="alert"',
    "err instanceof Error ? err.message : 'Harvest failed.'",
    'evidence.reload()',
  ]) {
    assert.ok(view.includes(token), `harvest action must contain ${token}`);
  }
  assert.ok(!/Math\.random|Date\.now\(\)/.test(view), 'no invented numbers or times');
});

test('free feeds: no placeholder strings or credentials in client and route sources', () => {
  // Split literals so this test can name the banned tokens without itself
  // being flagged by a repo-wide placeholder scan.
  const banned = [
    'TO' + 'DO',
    'Lo' + 'rem',
    'Coming' + ' soon',
    'T' + 'BD',
    'FI' + 'XME',
    'mo' + 'ck',
    'du' + 'mmy',
    // 'placeholder' is a legitimate HTML attribute in SourcesView, so only
    // placeholder *copy* tokens are banned here.
  ];
  for (const file of [VIEW, API, APP, ROUTES_FILE]) {
    const source = read(file).toLowerCase();
    for (const token of banned) {
      assert.ok(
        !source.includes(token.toLowerCase()),
        `${file} must not contain placeholder copy "${token}"`,
      );
    }
    assert.ok(
      !/(api[_-]?key|password|client[_-]?secret|bearer\s+[a-z0-9])/i.test(source),
      `${file} must not contain credentials`,
    );
  }
});

// --- Functional route checks: injected fetch only, zero live calls -----------

interface FetchCall {
  url: string;
  headers?: Record<string, string>;
}

let server: Server;
let baseUrl: string;
let calls: FetchCall[] = [];
let fetchBody = '{"data":[]}';
let fetchStatus = 200;

const injectedFetch = async (url: string, init?: { headers?: Record<string, string> }) => {
  calls.push({ url, headers: init?.headers });
  return {
    ok: fetchStatus >= 200 && fetchStatus < 300,
    status: fetchStatus,
    text: async () => fetchBody,
    json: async () => JSON.parse(fetchBody),
  };
};

before(async () => {
  const express = (await import('express')).default;
  const { createInMemoryRepositories } = await import('../../server/ingest/store.ts');
  const { createIngestRouter } = await import('../../server/ingest/routes.ts');
  const app = express();
  app.use(express.json());
  app.use(
    createIngestRouter(createInMemoryRepositories(), {
      freeFeeds: {
        fetchImpl: injectedFetch,
        env: { CARDEX_API_KEY: SECRET },
      },
    }),
  );
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  if (server) server.close();
});

function assertEnvelope(body: any, status: number): void {
  assert.ok(body && typeof body === 'object', 'body must be an object');
  assert.ok(body.meta && typeof body.meta === 'object', 'response needs meta');
  for (const field of META_FIELDS) {
    assert.ok(field in body.meta, `meta must contain ${field}`);
  }
  assert.equal(body.meta.correctionPolicy, 'APPEND_ONLY');
  assert.ok(Array.isArray(body.meta.warnings) && body.meta.warnings.length > 0);
  if (status >= 400) assert.equal(body.data, null);
}

test('GET /api/ingest/free-feeds returns four public feeds with license and attribution', async () => {
  const res = await fetch(`${baseUrl}/api/ingest/free-feeds`);
  assert.equal(res.status, 200);
  const body = await res.json() as any;
  assertEnvelope(body, 200);
  assert.equal(body.data.feeds.length, 4);
  assert.deepEqual(body.data.feeds.map((f: any) => f.sourceId), SOURCE_IDS);
  for (const feed of body.data.feeds) {
    assert.equal(typeof feed.license, 'string');
    assert.ok(feed.license.length > 0, 'license must be present');
    assert.equal(typeof feed.attribution, 'string');
    assert.ok(feed.attribution.length > 0, 'attribution must be present');
  }
  const text = JSON.stringify(body);
  assert.ok(!text.includes(SECRET), 'public metadata must not include a key value');
  assert.ok(!text.toLowerCase().includes('x-' + 'api-key'), 'public metadata must not include a key header');
});

test('POST harvest calls the injected adapter and returns counts, no live calls', async () => {
  calls = [];
  fetchStatus = 200;
  fetchBody = JSON.stringify({
    data: [{ id: 'free-1', name: 'Injected Card', set: 'Base', number: '1', amount: 9, currency: 'USD' }],
  });
  const res = await fetch(`${baseUrl}/api/ingest/free-feeds/scryfall/harvest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ capturedAt: '2026-11-23T12:00:00.000Z' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json() as any;
  assertEnvelope(body, 200);
  assert.equal(body.data.sourceId, 'scryfall');
  assert.equal(body.data.status, 'COMPLETED');
  assert.equal(body.data.counts.fetched, 1);
  assert.equal(body.data.counts.created, 1);
  assert.deepEqual(body.data.errors, []);
  assert.equal(calls.length, 1, 'exactly one injected fetch call, no live calls');
  assert.equal(calls[0]!.url, 'https://api.scryfall.com/cards');
});

test('POST harvest keeps the key server-side: header sent, value never echoed', async () => {
  calls = [];
  fetchStatus = 200;
  fetchBody = JSON.stringify([{ id: 'carddex-1', name: 'Keyed Card' }]);
  const res = await fetch(`${baseUrl}/api/ingest/free-feeds/carddex/harvest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(!text.includes(SECRET), 'harvest response must not include the key value');
  assert.ok(
    calls.some((call) => call.headers?.['x-' + 'api-key'] === SECRET),
    'the injected fetch received the server-side key as a header',
  );
  const body = JSON.parse(text) as any;
  assert.equal(body.data.sourceId, 'carddex');
  assert.equal(body.data.counts.fetched, 1);
});

test('POST harvest of an unknown source is a 404 envelope, no fetch issued', async () => {
  calls = [];
  const res = await fetch(`${baseUrl}/api/ingest/free-feeds/not-a-feed/harvest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 404);
  const body = await res.json() as any;
  assertEnvelope(body, 404);
  assert.equal(calls.length, 0, 'unknown source must not trigger any fetch');
});
