// The report and serving APIs must read the same canonical repository that
// promotion writes. Today server.ts wires them to the file-backed ingest
// ledger, so newly promoted Postgres observations never reach the report.

import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { Express } from 'express';

import { createInMemoryRepositories } from '../../server/ingest/store.ts';
import { setActiveReportRepositories } from '../../server/intelligence/active-report.ts';

const PASSCODE = 'canonical-source-passcode';
const NOW = '2026-11-23T00:00:00.000Z';
const TARGET = 'CANONICAL-SOURCE-TEST-1';
const DB_TARGET = 'CANONICAL-DB-SHAPE-1';
const originalDataDir = process.env.SLABGRAPH_DATA_DIR;
const originalTestMode = process.env.SLABGRAPH_TEST_MODE;
const originalPasscode = process.env.SLABGRAPH_ADMIN_PASSCODE;

let root: string;
let server: Server;
let baseUrl: string;
let authHeaders: Record<string, string>;
let createApp: typeof import('../../server.ts')['createApp'];

async function post(route: string, body: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: { ...authHeaders, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'slabswarm-canonical-source-'));
  process.env.SLABGRAPH_DATA_DIR = path.join(root, 'data');
  process.env.SLABGRAPH_TEST_MODE = '1';
  process.env.SLABGRAPH_ADMIN_PASSCODE = PASSCODE;
  ({ createApp } = await import(`../../server.ts?canonical=${Date.now()}`));

  const repos = createInMemoryRepositories();
  const evidence = await repos.evidence.create({
    sourceId: 'canonical-source-test',
    sourceRecordId: 'canonical-source-evidence-1',
    capturedAt: NOW,
    observedAt: NOW,
    checksum: 'canonical-source-checksum',
    mimeType: 'application/json',
    rawRef: 'urn:canonical-source:1',
    parsedPayload: { price: 100, name: 'Canonical Test Card' },
    trustTier: 'HIGH',
  });
  await repos.marketObservations.create({
    evidenceId: evidence.id,
    targetIdentityRef: TARGET,
    basis: 'SOLD',
    amount: 100,
    currency: 'USD',
    observedAt: NOW,
    status: 'NORMALIZED',
  } as never);
  for (const amount of [110, 120]) {
    await repos.marketObservations.create({
      evidenceId: evidence.id,
      targetIdentityId: DB_TARGET,
      basis: 'GUIDE',
      amount,
      currency: 'USD',
      observedAt: NOW,
      status: 'NORMALIZED',
    } as never);
  }

  const app: Express = await createApp({ canonicalRepositories: repos } as never);
  const bound = await new Promise<Server>((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1');
    instance.once('listening', () => resolve(instance));
    instance.once('error', reject);
  });
  server = bound;
  baseUrl = `http://127.0.0.1:${(bound.address() as AddressInfo).port}`;
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ passcode: PASSCODE }),
  });
  authHeaders = { authorization: `Bearer ${(await login.json()).token}` };
});

after(async () => {
  setActiveReportRepositories(createInMemoryRepositories());
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (root) await rm(root, { recursive: true, force: true });
  for (const [key, value] of [
    ['SLABGRAPH_DATA_DIR', originalDataDir],
    ['SLABGRAPH_TEST_MODE', originalTestMode],
    ['SLABGRAPH_ADMIN_PASSCODE', originalPasscode],
  ] as Array<[string, string | undefined]>) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('active report reads the injected canonical repository', async () => {
  const response = await fetch(`${baseUrl}/api/intelligence/active-report`, { headers: authHeaders });
  const body = await response.json();
  assert.equal(response.status, 200);
  const cards = body.data?.cards ?? [];
  assert.ok(
    cards.some((card: { id?: string }) => card.id === TARGET),
    `expected canonical observation ${TARGET} in active report, got ids ${cards.map((c: any) => c.id).join(',')}`,
  );
});

test('research run accepts the UI payload and uses canonical evidence', async () => {
  const { status, body } = await post('/api/swarm/research/run', {
    question: 'What does the evidence say about this card?',
    mode: 'EVIDENCE_FIRST',
  });
  assert.ok(status === 200 || status === 201, `research run status ${status}: ${JSON.stringify(body)}`);
  assert.ok(body.data && typeof body.data.id === 'string', 'research run must return an envelope with an id');
  assert.ok(body.meta && typeof body.meta.requestId === 'string', 'research run must use the response envelope');
  assert.equal(body.data.targetId, DB_TARGET);

  const detail = await fetch(`${baseUrl}/api/swarm/runs/${body.data.id}`, { headers: authHeaders });
  const detailBody = await detail.json();
  assert.equal(detail.status, 200);
  assert.ok(detailBody.data && detailBody.data.id === body.data.id);
  assert.ok(detailBody.meta && typeof detailBody.meta.requestId === 'string');
});
