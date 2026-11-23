// Contract regression: every route the product UI reads with useEnvelope()
// must answer with the shared { data, meta } envelope. Three routes drifted:
// /api/observations and GET /api/forecasts were never implemented, and
// /api/learning/state still answers with the bare legacy body.

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

const PASSCODE = 'contract-test-passcode';
const originalDataDir = process.env.SLABGRAPH_DATA_DIR;
const originalTestMode = process.env.SLABGRAPH_TEST_MODE;
const originalPasscode = process.env.SLABGRAPH_ADMIN_PASSCODE;

let root: string;
let server: Server;
let baseUrl: string;
let authHeaders: Record<string, string>;
let createApp: typeof import('../../server.ts')['createApp'];

async function get(route: string): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${route}`, { headers: authHeaders });
  return { status: response.status, body: await response.json() };
}

function assertEnvelope(body: any, route: string): void {
  assert.ok(body && typeof body === 'object' && !Array.isArray(body), `${route}: expected object`);
  assert.ok('data' in body, `${route}: missing data`);
  assert.ok('meta' in body, `${route}: missing meta`);
  for (const field of ['requestId', 'generatedAt', 'contractVersion', 'correctionPolicy', 'warnings']) {
    assert.ok(field in body.meta, `${route}: missing meta.${field}`);
  }
}

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'slabswarm-contract-'));
  process.env.SLABGRAPH_DATA_DIR = path.join(root, 'data');
  process.env.SLABGRAPH_TEST_MODE = '1';
  process.env.SLABGRAPH_ADMIN_PASSCODE = PASSCODE;
  setActiveReportRepositories(createInMemoryRepositories());
  ({ createApp } = await import(`../../server.ts?contract=${Date.now()}`));
  const app: Express = await createApp();
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
  const loginBody = await login.json();
  assert.equal(login.status, 200);
  authHeaders = { authorization: `Bearer ${loginBody.token}` };
});

after(async () => {
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

for (const route of ['/api/observations', '/api/forecasts', '/api/learning/state']) {
  test(`${route} returns the shared data+meta envelope`, async () => {
    const { status, body } = await get(route);
    assert.equal(status, 200, `${route}: expected 200, got ${status}: ${JSON.stringify(body)}`);
    assertEnvelope(body, route);
  });
}
