import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import express from 'express';

import { createInMemoryRepositories } from '../../server/ingest/store.ts';
import { createIngestRouter } from '../../server/routes/ingest.ts';

let server: Server;
let baseUrl: string;
let fullId: string;

before(async () => {
  const repos = createInMemoryRepositories();
  for (let i = 0; i < 120; i += 1) {
    const { record } = await repos.evidence.createIdempotent({
      sourceId: 'bulk',
      sourceRecordId: `record-${i}`,
      capturedAt: '2026-11-24T00:00:00.000Z',
      observedAt: '2026-11-24T00:00:00.000Z',
      checksum: `checksum-${i}`,
      mimeType: 'application/json',
      rawRef: `raw://bulk/${i}`,
      parsedPayload: { blob: 'x'.repeat(500) },
    });
    if (i === 0) fullId = record.id;
  }

  const app = express();
  app.use(express.json());
  app.use(createIngestRouter(repos));
  server = await new Promise<Server>((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1');
    instance.once('listening', () => resolve(instance));
    instance.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('GET /api/evidence is bounded and omits raw payloads from the list', async () => {
  const body = await (await fetch(`${baseUrl}/api/evidence`)).json();
  assert.ok(Array.isArray(body.evidence));
  assert.ok(body.evidence.length <= 100, `expected at most 100 rows, got ${body.evidence.length}`);
  assert.equal(
    body.evidence.some((row: Record<string, unknown>) => 'parsedPayload' in row),
    false,
    'list rows must omit parsedPayload',
  );
});

test('GET /api/evidence honours an explicit limit', async () => {
  const body = await (await fetch(`${baseUrl}/api/evidence?limit=5`)).json();
  assert.equal(body.evidence.length, 5);
});

test('GET /api/evidence/:id still exposes the full raw record', async () => {
  const body = await (await fetch(`${baseUrl}/api/evidence/${fullId}`)).json();
  assert.ok(body.evidence.parsedPayload);
});
