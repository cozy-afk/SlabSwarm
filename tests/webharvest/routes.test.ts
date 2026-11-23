import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';

import { createRepositories } from '../../server/db/repositories/index.ts';
import { createMemoryStore } from '../../server/db/store.ts';
import { createWebHarvestStore } from '../../server/webharvest/store.ts';
import { mountWebHarvestRouter } from '../../server/webharvest/routes.ts';

const SOURCE = {
  id: 'route-source',
  name: 'Route Fixture Source',
  url: 'https://example.invalid/catalog.json',
  kind: 'json' as const,
  enabled: true,
  license: 'CC-BY-4.0',
  respectRobots: true,
  rateLimitMs: 1000,
};

function payload(overrides: Record<string, unknown> = {}) {
  return {
    id: 'route-cand-1',
    sourceId: 'route-source',
    evidenceId: 'route-ev-1',
    name: 'Route Card',
    set: 'Base Set',
    game: 'Route TCG',
    number: '007',
    basis: 'GUIDE',
    amount: 12,
    currency: 'USD',
    observedAt: '2026-11-21T10:00:00.000Z',
    capturedAt: '2026-11-21T10:01:00.000Z',
    license: 'CC-BY-4.0',
    confidence: 'LOW',
    warnings: [],
    ...overrides,
  };
}

let server: Server;
let baseUrl: string;
let store: Awaited<ReturnType<typeof createWebHarvestStore>>;
let repositories: ReturnType<typeof createRepositories>;

const META_FIELDS = ['requestId', 'generatedAt', 'contractVersion', 'correctionPolicy', 'warnings'];

function assertEnvelope(body: any, status: number): void {
  assert.ok(body && typeof body === 'object', 'body must be an object');
  assert.ok(body.meta && typeof body.meta === 'object', 'response needs meta');
  for (const field of META_FIELDS) {
    assert.ok(field in body.meta, `meta must contain ${field}`);
  }
  assert.equal(body.meta.contractVersion, '2026-11-22.1');
  assert.equal(body.meta.correctionPolicy, 'APPEND_ONLY');
  assert.ok(Array.isArray(body.meta.warnings));
  if (status >= 400) assert.equal(body.data, null);
}

function post(path: string, body: unknown): Promise<{ status: number; body: any }> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, body: await res.json() }));
}

before(async () => {
  repositories = createRepositories(createMemoryStore());
  store = createWebHarvestStore({ sources: [SOURCE], repositories });
  const app = express();
  app.use(express.json());
  mountWebHarvestRouter(app, { store });
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

test('GET /api/web-harvest/sources returns the allowlist in a five-field-meta envelope', async () => {
  const res = await fetch(`${baseUrl}/api/web-harvest/sources`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assertEnvelope(body, res.status);
  assert.deepEqual(body.data.sources, [SOURCE]);
});

test('GET /api/web-harvest/review-queue starts empty with zero counts', async () => {
  const res = await fetch(`${baseUrl}/api/web-harvest/review-queue`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assertEnvelope(body, res.status);
  assert.deepEqual(body.data.candidates, []);
  assert.deepEqual(body.data.counts, { PENDING: 0, APPROVED: 0, REJECTED: 0 });
});

test('POST /api/web-harvest/candidates enqueues without any canonical write', async () => {
  const { status, body } = await post('/api/web-harvest/candidates', payload());
  assert.equal(status, 200);
  assertEnvelope(body, status);
  assert.equal(body.data.enqueued, 1);
  assert.equal(body.data.candidates[0].status, 'PENDING');

  const queue = await (await fetch(`${baseUrl}/api/web-harvest/review-queue`)).json();
  assert.equal(queue.data.counts.PENDING, 1);
  assert.deepEqual(await repositories.cards.list(), []);
  assert.deepEqual(await repositories.marketObservations.list(), []);
});

test('POST /api/web-harvest/review APPROVE writes one card and one observation', async () => {
  const { status, body } = await post('/api/web-harvest/review', {
    candidateId: 'route-cand-1',
    action: 'APPROVE',
    note: 'operator verified',
  });
  assert.equal(status, 200);
  assertEnvelope(body, status);
  assert.equal(body.data.candidate.status, 'APPROVED');
  assert.equal(body.data.candidate.reviewNote, 'operator verified');
  assert.equal(body.meta.provenance.source, 'route-source');
  assert.equal(body.meta.provenance.confidence, 'LOW');

  const cards = await repositories.cards.list();
  const observations = await repositories.marketObservations.list();
  assert.equal(cards.length, 1);
  assert.equal(observations.length, 1);
  assert.equal((cards[0].facets as Record<string, unknown>).confidence, 'LOW');
  assert.equal(observations[0].basis, 'GUIDE');
  assert.equal(observations[0].amount, 12);
});

test('POST /api/web-harvest/review REJECT leaves no canonical row', async () => {
  await post('/api/web-harvest/candidates', payload({ id: 'route-cand-2', evidenceId: 'route-ev-2' }));
  const { status, body } = await post('/api/web-harvest/review', {
    candidateId: 'route-cand-2',
    action: 'REJECT',
  });
  assert.equal(status, 200);
  assertEnvelope(body, status);
  assert.equal(body.data.candidate.status, 'REJECTED');
  assert.equal(body.data.card, null);
  assert.equal(body.data.observation, null);
  assert.equal((await repositories.cards.list()).length, 1);
  assert.equal((await repositories.marketObservations.list()).length, 1);
  const queue = await (await fetch(`${baseUrl}/api/web-harvest/review-queue?status=REJECTED`)).json();
  assert.deepEqual(queue.data.candidates.map((c: { id: string }) => c.id), ['route-cand-2']);
});

test('review input errors return plain error envelopes with the same five meta fields', async () => {
  const unknown = await post('/api/web-harvest/review', { candidateId: 'nope', action: 'APPROVE' });
  assert.equal(unknown.status, 404);
  assertEnvelope(unknown.body, unknown.status);
  assert.equal(unknown.body.data, null);
  assert.ok(unknown.body.error);
  assert.equal(unknown.body.code, 'not_found');

  const badAction = await post('/api/web-harvest/review', { candidateId: 'route-cand-1', action: 'DELETE' });
  assert.equal(badAction.status, 400);
  assertEnvelope(badAction.body, badAction.status);
  assert.equal(badAction.body.code, 'validation_error');

  const badCandidate = await post('/api/web-harvest/candidates', { name: 'not a candidate' });
  assert.equal(badCandidate.status, 400);
  assertEnvelope(badCandidate.body, badCandidate.status);
});
