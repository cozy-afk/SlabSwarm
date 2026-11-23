// Task 19: the web-harvest review router is mounted by server.ts behind the
// existing operator gate, and its approved-harvest hook rebuilds the lake.
// Drives createApp() itself, not a bare router. No live third-party calls and
// no live Postgres: canonical repositories and the lake root are injected.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { Express } from 'express';

import {
  exportCanonicalLake,
  readLakeManifest,
  type CanonicalLakeOptions,
  type CanonicalLakeSource,
  type ParquetExportResult,
} from '../../server/analytics/parquet.ts';
import { createRepositories } from '../../server/db/repositories/index.ts';
import { createMemoryStore } from '../../server/db/store.ts';

const PASSCODE = 'task19-operator-passcode';
const NOW = '2026-11-23T00:00:00.000Z';

const SOURCE = {
  id: 'mounted-source',
  name: 'Mounted App Fixture Source',
  url: 'https://example.invalid/catalog.json',
  kind: 'json' as const,
  enabled: true,
  license: 'CC-BY-4.0',
  respectRobots: true,
  rateLimitMs: 1000,
};

function candidate(id: string) {
  return {
    id,
    sourceId: SOURCE.id,
    evidenceId: `mounted-ev-${id}`,
    name: `Mounted Card ${id}`,
    set: 'Base Set',
    game: 'TestGame',
    number: '007',
    basis: 'GUIDE',
    amount: 12,
    currency: 'USD',
    observedAt: NOW,
    capturedAt: NOW,
    license: 'CC-BY-4.0',
    confidence: 'LOW',
    warnings: [],
  };
}

const originalDataDir = process.env.SLABGRAPH_DATA_DIR;
const originalTestMode = process.env.SLABGRAPH_TEST_MODE;
const originalPasscode = process.env.SLABGRAPH_ADMIN_PASSCODE;
const originalLakeDir = process.env.SLABSWARM_LAKE_DIR;

let root: string;
let lakeDir: string;
let failLakeDir: string;
let createApp: typeof import('../../server.ts')['createApp'];
let app: Express;
let server: Server;
let baseUrl: string;
let authHeaders: Record<string, string>;
let repositories: ReturnType<typeof createRepositories>;
let exporterCalls: Array<{ source: CanonicalLakeSource; options?: CanonicalLakeOptions }>;

async function listen(target: Express): Promise<{ server: Server; baseUrl: string }> {
  const instance = target.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    instance.once('listening', () => resolve());
    instance.once('error', reject);
  });
  return {
    server: instance,
    baseUrl: `http://127.0.0.1:${(instance.address() as AddressInfo).port}`,
  };
}

async function post(url: string, route: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${url}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function get(url: string, route: string, headers: Record<string, string> = {}) {
  const response = await fetch(`${url}${route}`, { headers });
  return { status: response.status, body: await response.json() };
}

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'slabswarm-mounted-harvest-'));
  lakeDir = path.join(root, 'lake');
  failLakeDir = path.join(root, 'failed-lake');
  process.env.SLABGRAPH_DATA_DIR = path.join(root, 'data');
  process.env.SLABGRAPH_TEST_MODE = '1';
  process.env.SLABGRAPH_ADMIN_PASSCODE = PASSCODE;
  delete process.env.SLABSWARM_LAKE_DIR;

  ({ createApp } = await import(`../../server.ts?mounted=${Date.now()}`));
  repositories = createRepositories(createMemoryStore());
  exporterCalls = [];
  const realExport = exportCanonicalLake;
  const countingExporter = async (source: CanonicalLakeSource, options?: CanonicalLakeOptions) => {
    exporterCalls.push({ source, options });
    return realExport(source, options);
  };
  app = await createApp({
    webHarvestRepositories: repositories,
    lakeExporter: countingExporter,
    lakeDir,
  });
  const bound = await listen(app);
  server = bound.server;
  baseUrl = bound.baseUrl;

  const login = await post(baseUrl, '/api/auth/login', { passcode: PASSCODE });
  assert.equal(login.status, 200, 'operator login must succeed');
  authHeaders = { authorization: `Bearer ${login.body.token}` };
});

after(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (root) await rm(root, { recursive: true, force: true });
  for (const [key, value] of [
    ['SLABGRAPH_DATA_DIR', originalDataDir],
    ['SLABGRAPH_TEST_MODE', originalTestMode],
    ['SLABGRAPH_ADMIN_PASSCODE', originalPasscode],
    ['SLABSWARM_LAKE_DIR', originalLakeDir],
  ] as Array<[string, string | undefined]>) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('the mounted review router sits behind the existing operator gate', async () => {
  const anonymous = await post(baseUrl, '/api/web-harvest/candidates', candidate('gate-1'));
  assert.equal(anonymous.status, 401, 'an unauthenticated review request is rejected by the operator gate');
  assert.match(anonymous.body.error, /Operator authentication required/);
  assert.equal(exporterCalls.length, 0, 'a rejected request never reaches the export hook');

  const authorized = await post(baseUrl, '/api/web-harvest/candidates', candidate('gate-1'), authHeaders);
  assert.equal(authorized.status, 200, 'the same request succeeds with an operator session');
});

test('in the mounted app APPROVE triggers exactly one real lake export and REJECT triggers none', async () => {
  const queued = await post(baseUrl, '/api/web-harvest/candidates', candidate('approve-1'), authHeaders);
  assert.equal(queued.status, 200);
  const callsBefore = exporterCalls.length;

  const approved = await post(baseUrl, '/api/web-harvest/review', {
    candidateId: 'approve-1', action: 'APPROVE', note: 'verified mounted fixture',
  }, authHeaders);
  assert.equal(approved.status, 200);
  assert.equal(approved.body.data.candidate.status, 'APPROVED', 'canonical approval commits');
  assert.equal(exporterCalls.length, callsBefore + 1, 'APPROVE triggers exactly one export');
  assert.equal(exporterCalls.at(-1)?.options?.lakeDir, lakeDir, 'the export writes to the configured lake root');
  assert.equal(approved.body.meta.lakeExport.ok, true, 'the operator sees a successful export in the response');
  assert.ok(exporterCalls.at(-1)?.options, 'the exporter received canonical lake options');
  const result = approved.body.meta.lakeExport as ParquetExportResult;
  assert.equal(
    result.datasets.find((dataset) => dataset.name === 'observations')?.rows,
    1,
    'the newly approved observation is in the rebuilt lake',
  );
  const onDisk = await readLakeManifest(lakeDir);
  assert.notEqual(onDisk, 'UNKNOWN', 'the export wrote a real manifest to the configured lake root');
  assert.equal((onDisk as ParquetExportResult).datasets.find(
    (dataset) => dataset.name === 'observations',
  )?.rows, 1, 'the on-disk lake carries the approved observation');
  assert.equal((await repositories.cards.list()).length, 1, 'the canonical card was committed');
  assert.equal((await repositories.marketObservations.list()).length, 1, 'the canonical observation was committed');

  await post(baseUrl, '/api/web-harvest/candidates', candidate('reject-1'), authHeaders);
  const callsAfterApprove = exporterCalls.length;
  const rejected = await post(baseUrl, '/api/web-harvest/review', {
    candidateId: 'reject-1', action: 'REJECT', note: 'unverified mounted fixture',
  }, authHeaders);
  assert.equal(rejected.status, 200);
  assert.equal(rejected.body.data.candidate.status, 'REJECTED');
  assert.equal(exporterCalls.length, callsAfterApprove, 'REJECT never triggers an export');
  assert.equal(rejected.body.meta.lakeExport, undefined, 'a rejection carries no export signal');
  assert.equal((await repositories.cards.list()).length, 1, 'a rejection writes no canonical card');
  assert.equal((await repositories.marketObservations.list()).length, 1, 'a rejection writes no observation');
});

test('a failed post-approval export is recorded and surfaced without rolling back the approval', async () => {
  const failingRepositories = createRepositories(createMemoryStore());
  let failingCalls = 0;
  const failingApp = await createApp({
    webHarvestRepositories: failingRepositories,
    lakeExporter: async () => {
      failingCalls += 1;
      throw new Error('simulated lake write failure');
    },
    lakeDir: failLakeDir,
  });
  const bound = await listen(failingApp);
  try {
    await post(bound.baseUrl, '/api/web-harvest/candidates', candidate('failed-1'), authHeaders);
    const approved = await post(bound.baseUrl, '/api/web-harvest/review', {
      candidateId: 'failed-1', action: 'APPROVE', note: 'failed lake export',
    }, authHeaders);

    assert.equal(approved.status, 200, 'a failed lake export is not reported as a failed approval');
    assert.equal(approved.body.data.candidate.status, 'APPROVED', 'the canonical approval stays committed');
    assert.equal(failingCalls, 1, 'the failing export hook ran exactly once');
    assert.equal((await failingRepositories.cards.list()).length, 1, 'the canonical card survives the export failure');
    assert.equal((await failingRepositories.marketObservations.list()).length, 1, 'the observation survives the failure');
    assert.equal(approved.body.meta.lakeExport.ok, false, 'the approval response surfaces the failed export');
    assert.match(approved.body.meta.lakeExport.error, /simulated lake write failure/);

    const status = await get(bound.baseUrl, '/api/admin/web-harvest/lake-export', authHeaders);
    assert.equal(status.status, 200, 'the operator status endpoint is behind the gate');
    assert.equal(status.body.data.last.ok, false, 'the failure is recorded for later operator inspection');
    assert.equal(status.body.data.last.candidateId, 'failed-1');
    assert.match(status.body.data.last.error, /simulated lake write failure/);

    const anonymousStatus = await get(bound.baseUrl, '/api/admin/web-harvest/lake-export');
    assert.equal(anonymousStatus.status, 401, 'the export status endpoint is not public');
  } finally {
    await new Promise<void>((resolve) => bound.server.close(() => resolve()));
  }
});
