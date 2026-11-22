import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { createAnalyticsRouter } from '../../server/analytics/routes.ts';
import { daysAgo, makeObservation, makeStore } from './fixtures.ts';

let lakeDir: string;
let server: Server;
let baseUrl: string;

before(async () => {
  lakeDir = await mkdtemp(path.join(os.tmpdir(), 'slabswarm-analytics-api-'));
  const app = express();
  const store = makeStore({
    observations: [
      makeObservation({ id: 'o-1', basis: 'SOLD', amount: 100, observedAt: daysAgo(1) }),
      makeObservation({ id: 'o-2', basis: 'ASKING', amount: 300, observedAt: daysAgo(1) }),
      makeObservation({ id: 'o-3', basis: 'SOLD', amount: 110, observedAt: daysAgo(1) }),
    ],
  });
  app.use(createAnalyticsRouter({ store, lakeDir }));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(lakeDir, { recursive: true, force: true });
});

async function jsonRequest(route: string, init?: RequestInit): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${route}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

test('GET /api/sql/queries lists stable, read-only built-ins', async () => {
  const { status, body } = await jsonRequest('/api/sql/queries');
  assert.equal(status, 200);
  const queries = body.queries as Array<{ id: string; sql: string }>;
  assert.ok(queries.length >= 4);
  assert.ok(queries.every((q) => /^\s*(SELECT|WITH)\b/i.test(q.sql)));
});

test('POST /api/intelligence/discovery-sweep persists notes readable via GET findings', async () => {
  const sweep = await jsonRequest('/api/intelligence/discovery-sweep', {
    method: 'POST', body: '{}',
  });
  assert.equal(sweep.status, 200);
  assert.ok(Array.isArray(sweep.body.findings));
  const findings = sweep.body.findings as Array<{ type: string }>;
  assert.ok(findings.some((f) => f.type === 'ACTIVE_CARD'));

  const listed = await jsonRequest('/api/intelligence/findings');
  assert.equal(listed.status, 200);
  assert.equal(listed.body.count, findings.length);

  const filtered = await jsonRequest('/api/intelligence/findings?type=ACTIVE_CARD');
  assert.equal(filtered.status, 200);
  assert.ok((filtered.body.findings as Array<{ type: string }>).every((f) => f.type === 'ACTIVE_CARD'));
});

test('POST /api/sql/query returns a result envelope and rejects writes with 403', async () => {
  const ok = await jsonRequest('/api/sql/query', {
    method: 'POST', body: JSON.stringify({ queryId: 'basis_mix' }),
  });
  assert.equal(ok.status, 200);
  const result = ok.body.result as { rows: Array<{ basis: string; observations: number }>; source: string };
  assert.equal(result.source, 'template');
  assert.equal(result.rows.find((row) => row.basis === 'SOLD')?.observations, 2);

  const write = await jsonRequest('/api/sql/query', {
    method: 'POST', body: JSON.stringify({ sql: 'DROP TABLE observations' }),
  });
  assert.equal(write.status, 403);
  assert.equal(write.body.error, 'read_only_violation');
});

test('saved-query endpoints support CRUD and reject write SQL', async () => {
  const rejected = await jsonRequest('/api/sql/saved', {
    method: 'POST', body: JSON.stringify({ name: 'bad', sql: 'DELETE FROM observations' }),
  });
  assert.equal(rejected.status, 403);

  const created = await jsonRequest('/api/sql/saved', {
    method: 'POST',
    body: JSON.stringify({ name: 'Sold basis', sql: 'SELECT basis FROM observations WHERE basis = \'SOLD\'' }),
  });
  assert.equal(created.status, 201);
  const saved = created.body.query as { id: string };
  assert.ok(saved.id);

  const listed = await jsonRequest('/api/sql/saved');
  assert.equal((listed.body.queries as unknown[]).length, 1);

  const run = await jsonRequest('/api/sql/query', {
    method: 'POST', body: JSON.stringify({ savedId: saved.id }),
  });
  assert.equal(run.status, 200);
  assert.equal((run.body.result as { source: string }).source, 'saved');

  const removed = await jsonRequest(`/api/sql/saved/${saved.id}`, { method: 'DELETE' });
  assert.equal(removed.status, 200);
});

test('POST /api/admin/export-parquet returns a six-dataset manifest', async () => {
  const response = await jsonRequest('/api/admin/export-parquet', {
    method: 'POST', body: '{}',
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  const datasets = response.body.datasets as Array<{ name: string; rows: number }>;
  assert.deepEqual(datasets.map((d) => d.name), [
    'evidence', 'observations', 'identities', 'events', 'forecasts', 'scores',
  ]);
  assert.equal((datasets.find((d) => d.name === 'observations')?.rows), 3);
});

test('malformed requests return 400 rather than a server error', async () => {
  const bad = await jsonRequest('/api/intelligence/discovery-sweep', {
    method: 'POST', body: JSON.stringify({ staleDays: -1 }),
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'validation_error');
});
