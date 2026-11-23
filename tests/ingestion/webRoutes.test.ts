import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import type { WebSourceConfig } from '../../server/contracts/webHarvest.ts';

const storeMod = () => import('../../server/ingest/store.ts');
const routesMod = () => import('../../server/ingest/routes.ts');

const CAPTURED_AT = '2026-11-23T12:00:00.000Z';
const SERVER_CAPTURED_AT = '2026-11-23T15:30:00.000Z';
const FORGED_CAPTURED_AT = '2001-01-01T00:00:00.000Z';
const OBSERVED_AT = '2026-11-21T09:00:00.000Z';
const SECRET = 'SUPER-SECRET-DO-NOT-LEAK';

interface FetchCall {
  url: string;
  headers?: Record<string, string>;
}

let server: Server;
let baseUrl: string;
let calls: FetchCall[] = [];

function setFetchResponse(handler: (call: FetchCall) => { status: number; body: string }) {
  calls = [];
  fetchHandler = handler;
}

let fetchHandler: (call: FetchCall) => { status: number; body: string } = () => ({
  status: 200,
  body: '{}',
});

const jsonBody = JSON.stringify({
  data: {
    cards: [
      {
        name: 'Route Card',
        set: 'Base',
        game: 'Pokemon',
        number: '1',
        basis: 'OFFER',
        amount: 33,
        currency: 'USD',
        observedAt: OBSERVED_AT,
      },
    ],
  },
});

before(async () => {
  const { createInMemoryRepositories } = await storeMod();
  const { createIngestRouter } = await routesMod();
  const app = express();
  app.use(express.json());
  app.use(
    createIngestRouter(createInMemoryRepositories(), {
      web: {
        fetchImpl: async (url: string, init?: { headers?: Record<string, string> }) => {
          const call: FetchCall = { url, headers: init?.headers };
          calls.push(call);
          const response = fetchHandler(call);
          return {
            ok: response.status >= 200 && response.status < 300,
            status: response.status,
            text: async () => response.body,
          };
        },
        now: () => 5_000_000,
        captureNow: () => new Date(SERVER_CAPTURED_AT),
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

function config(overrides: Partial<WebSourceConfig> = {}): WebSourceConfig {
  return {
    id: 'web-route-source',
    name: 'Web Route Source',
    url: 'https://web.example.com/cards',
    kind: 'json',
    enabled: true,
    license: 'CC0-1.0',
    respectRobots: false,
    rateLimitMs: 0,
    recordPath: 'data.cards',
    ...overrides,
  };
}

async function post(path: string, body: unknown) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('GET /api/ingest/web-sources starts with an empty allowlist', async () => {
  const res = await fetch(`${baseUrl}/api/ingest/web-sources`);
  assert.equal(res.status, 200);
  const body = await res.json() as { sources: unknown[]; data: { sources: unknown[] }; meta: Record<string, unknown> };
  assert.deepEqual(body.sources, []);
  assert.deepEqual(body.data.sources, []);
  assert.equal((body.meta as { correctionPolicy: string }).correctionPolicy, 'APPEND_ONLY');
});

test('POST /api/ingest/web-sources stores only non-secret config', async () => {
  const res = await post('/api/ingest/web-sources', {
    source: {
      ...config({ url: `https://web.example.com/cards?api_key=${SECRET}` }),
      apiKey: SECRET,
      password: SECRET,
    },
  });
  assert.equal(res.status, 200);
  const body = await res.json() as { source: Record<string, unknown>; sources: Array<Record<string, unknown>> };
  assert.equal(body.source.url, 'https://web.example.com/cards');
  assert.equal(body.source.license, 'CC0-1.0');
  assert.equal(body.source.rateLimitMs, 0);
  assert.equal(JSON.stringify(body).includes(SECRET), false);
  assert.equal(JSON.stringify(body.source).includes('apiKey'), false);

  const listed = await (await fetch(`${baseUrl}/api/ingest/web-sources`)).json() as {
    sources: Array<Record<string, unknown>>;
  };
  assert.equal(listed.sources.length, 1);
  assert.equal(JSON.stringify(listed).includes(SECRET), false);
});

test('POST /api/ingest/web-harvest with an empty allowlist makes zero network calls', async () => {
  await post('/api/ingest/web-sources', { action: 'remove', id: 'web-route-source' });
  setFetchResponse(() => ({ status: 200, body: jsonBody }));
  const before = calls.length;
  const res = await post('/api/ingest/web-harvest', { capturedAt: CAPTURED_AT });
  assert.equal(res.status, 200);
  const body = await res.json() as { results: unknown[]; data: { results: unknown[] } };
  assert.deepEqual(body.results, []);
  assert.deepEqual(body.data.results, []);
  assert.equal(calls.length, before, 'no HTTP calls without an enabled source');
});

test('POST /api/ingest/web-harvest harvests into ledger evidence with no canonical writes', async () => {
  await post('/api/ingest/web-sources', { source: config() });
  setFetchResponse(() => ({ status: 200, body: jsonBody }));
  const res = await post('/api/ingest/web-harvest', { capturedAt: CAPTURED_AT });
  assert.equal(res.status, 200);
  const body = await res.json() as {
    results: Array<{ sourceId: string; candidates: Array<{ basis: string; amount: number; evidenceId: string }> }>;
    evidence: Array<{ id: string; sourceId: string }>;
    meta: Record<string, unknown>;
  };
  assert.equal(body.results.length, 1);
  assert.equal(body.results[0].sourceId, 'web-route-source');
  assert.equal(body.results[0].candidates[0].basis, 'OFFER');
  assert.equal(body.results[0].candidates[0].amount, 33);
  assert.equal(body.evidence.length, 1);
  assert.equal(body.evidence[0].sourceId, 'web:web-route-source');
  assert.equal((body.meta as { correctionPolicy: string }).correctionPolicy, 'APPEND_ONLY');

  const observations = await (await fetch(`${baseUrl}/api/evidence`)).json() as { evidence: unknown[] };
  assert.ok(observations.evidence.length >= 1);
  const listed = await (await fetch(`${baseUrl}/api/ingest/web-sources`)).json() as {
    sources: Array<Record<string, unknown>>;
  };
  assert.equal(JSON.stringify(listed).includes(SECRET), false);
});

test('POST /api/ingest/web-harvest ignores a forged capturedAt and stamps server time', async () => {
  // A distinct source + payload avoids the idempotency key of earlier tests.
  // It is removed in `finally` so the shared registry is left untouched.
  await post('/api/ingest/web-sources', { source: config({ id: 'web-provenance-source' }) });
  try {
    const provenanceBody = JSON.stringify({
      data: {
        cards: [{
          name: 'Provenance Card', set: 'Base', game: 'Pokemon', number: '2',
          basis: 'OFFER', amount: 44, currency: 'USD', observedAt: OBSERVED_AT,
        }],
      },
    });
    setFetchResponse(() => ({ status: 200, body: provenanceBody }));
    // Only harvest the isolated source; the earlier source stays enabled.
    const res = await post('/api/ingest/web-harvest', {
      sourceIds: ['web-provenance-source'],
      capturedAt: FORGED_CAPTURED_AT,
    });
    assert.equal(res.status, 200);
    const body = await res.json() as {
      results: Array<{ candidates: Array<{ capturedAt: string; evidenceId: string }> }>;
      evidence: Array<{ id: string; sourceId: string; capturedAt: string }>;
    };
    assert.equal(body.results.length, 1);
    const candidate = body.results[0].candidates[0];
    assert.ok(candidate, 'a candidate was produced');
    assert.equal(
      candidate.capturedAt, SERVER_CAPTURED_AT,
      'candidate carries the injected server clock, not the forged body value',
    );
    const stored = body.evidence.find((row) => row.id === candidate.evidenceId);
    assert.ok(stored, 'evidence record is present in the store-backed response');
    assert.equal(
      stored.capturedAt, SERVER_CAPTURED_AT,
      'immutable evidence is stamped by the server clock, not by the caller',
    );
    // Read the ledger again to prove the persisted record, not just the response.
    const ledger = await (await fetch(`${baseUrl}/api/evidence`)).json() as {
      evidence: Array<{ id: string; capturedAt: string }>;
    };
    const persisted = ledger.evidence.find((row) => row.id === candidate.evidenceId);
    assert.ok(persisted, 'evidence persisted in the ledger');
    assert.equal(persisted.capturedAt, SERVER_CAPTURED_AT, 'persisted capturedAt is never caller-controlled');
    assert.notEqual(persisted.capturedAt, FORGED_CAPTURED_AT);
  } finally {
    await post('/api/ingest/web-sources', { action: 'remove', id: 'web-provenance-source' });
  }
});

test('invalid source config returns 400 without mutating the allowlist', async () => {
  const res = await post('/api/ingest/web-sources', {
    source: config({ url: 'file:///etc/passwd' }),
  });
  assert.equal(res.status, 400);
  const listed = await (await fetch(`${baseUrl}/api/ingest/web-sources`)).json() as {
    sources: Array<Record<string, unknown>>;
  };
  assert.equal(listed.sources.length, 1);
});

test('POST disable makes the next harvest perform zero network calls', async () => {
  await post('/api/ingest/web-sources', { action: 'disable', id: 'web-route-source' });
  setFetchResponse(() => ({ status: 200, body: jsonBody }));
  const before = calls.length;
  const res = await post('/api/ingest/web-harvest', { capturedAt: CAPTURED_AT });
  assert.equal(res.status, 200);
  assert.equal(calls.length, before);
  const listed = await (await fetch(`${baseUrl}/api/ingest/web-sources`)).json() as {
    sources: Array<{ enabled: boolean }>;
  };
  assert.equal(listed.sources[0].enabled, false);
});
