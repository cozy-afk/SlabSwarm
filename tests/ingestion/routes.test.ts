import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';

const storeMod = () => import('../../server/ingest/store.ts');
const routesMod = () => import('../../server/routes/ingest.ts');

let server: Server;
let baseUrl: string;

const snapshot = {
  updatedAt: '2026-11-22T15:12:35.619Z',
  assets: [{ id: 'A1', title: 'Card One', releaseYear: 2025 }],
  sales: [
    {
      id: 'S1',
      assetId: 'A1',
      rawTitle: 'https://example.com/sale',
      priceUsd: 100,
      marketplaceId: 'ebay_sold',
      date: '2026-11-20',
      status: 'VERIFIED',
    },
  ],
};

before(async () => {
  const { createInMemoryRepositories } = await storeMod();
  const { createIngestRouter } = await routesMod();
  const app = express();
  app.use(express.json());
  app.use(createIngestRouter(createInMemoryRepositories()));
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

test('GET /api/evidence and /api/ingest/runs start empty', async () => {
  const evidence = await (await fetch(`${baseUrl}/api/evidence`)).json();
  assert.deepEqual(evidence.evidence, []);
  const runs = await (await fetch(`${baseUrl}/api/ingest/runs`)).json();
  assert.deepEqual(runs.runs, []);
});

test('POST /api/ingest/manual then GET evidence list and by id', async () => {
  const res = await fetch(`${baseUrl}/api/ingest/manual`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text: 'PSA 10 card listed at $300',
      sourceUrl: 'https://example.com/listing',
      observedAt: '2026-11-18',
      source: 'operator',
      basis: 'ASKING',
      amount: 300,
      currency: 'USD',
    }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  const id = body.evidence?.[0]?.id;
  assert.ok(id);

  const list = await (await fetch(`${baseUrl}/api/evidence?sourceId=manual`)).json();
  assert.ok(list.evidence.some((e: { id: string }) => e.id === id));
  const one = await fetch(`${baseUrl}/api/evidence/${id}`);
  assert.equal(one.status, 200);
  assert.equal(((await one.json()) as { evidence: { id: string } }).evidence.id, id);
  const runs = await (await fetch(`${baseUrl}/api/ingest/runs`)).json();
  assert.ok(runs.runs.length >= 1);
  const run = await (await fetch(`${baseUrl}/api/ingest/runs/${body.run.id}`)).json();
  assert.equal(run.run.id, body.run.id);
});

test('GET evidence/runs by unknown id returns 404; malformed manual input returns 400', async () => {
  assert.equal((await fetch(`${baseUrl}/api/evidence/nope`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/api/ingest/runs/nope`)).status, 404);
  const res = await fetch(`${baseUrl}/api/ingest/manual`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '' }),
  });
  assert.equal(res.status, 400);
});

test('POST /api/ingest/csv preview does not write; non-preview ingests', async () => {
  const csv = 'title,price,date,basis,currency\nCard A,120,2026-11-20,SOLD,USD\nCard B,,2026-11-20,,USD\n';
  const previewRes = await fetch(`${baseUrl}/api/ingest/csv`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ csv, preview: true }),
  });
  assert.equal(previewRes.status, 200);
  const preview = await previewRes.json();
  assert.equal(preview.preview.totalRows, 2);
  assert.equal(preview.preview.rows[0].basis, 'SOLD');
  assert.equal(preview.preview.rows[1].price, null);
  const before = await (await fetch(`${baseUrl}/api/evidence`)).json();
  assert.ok(!before.evidence.some((e: { sourceId: string }) => e.sourceId === 'csv'));

  const ingestRes = await fetch(`${baseUrl}/api/ingest/csv`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ csv }),
  });
  assert.equal(ingestRes.status, 200);
  const ingested = await ingestRes.json();
  assert.ok(ingested.run.counts.created >= 1);
});

test('POST /api/intelligence/harvest-legacy harvests evidence and is idempotent', async () => {
  const post = () =>
    fetch(`${baseUrl}/api/intelligence/harvest-legacy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'backfill', snapshot }),
    });
  const first = await post();
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  assert.equal(firstBody.run.counts.created, 2);
  const second = await post();
  const secondBody = await second.json();
  assert.equal(secondBody.run.counts.created, 0);
  assert.equal(secondBody.run.counts.duplicates, 2);
});

test('GET /api/ingest/adapters lists registered adapters', async () => {
  const body = await (await fetch(`${baseUrl}/api/ingest/adapters`)).json();
  assert.ok(Array.isArray(body.adapters));
  for (const id of ['legacy-graph', 'csv', 'manual', 'tcgapis']) {
    assert.ok(body.adapters.includes(id), `${id} must be registered`);
  }
});
