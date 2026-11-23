// Task 5: Parquet lake manifest and evidence-backed active report.
// Synthetic fixtures only: no live third-party calls, no canonical writes by
// the exporter, no invented paths, row counts or checksums.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import express from 'express';
import { runDiscoverySweep } from '../../server/analytics/discovery.ts';
import {
  exportCanonicalLake,
  LAKE_DATASET_NAMES,
  readLakeManifest,
  type ParquetExportResult,
} from '../../server/analytics/parquet.ts';
import { createAnalyticsRouter } from '../../server/analytics/routes.ts';
import { createAnalyticsStore } from '../../server/analytics/store.ts';
import { createInMemoryRepositories } from '../../server/ingest/store.ts';
import type { IngestRepositories } from '../../server/ingest/types.ts';
import {
  makeEvidence,
  makeObservation,
} from './fixtures.ts';
import { createRepositories } from '../../server/db/repositories/index.ts';
import { createMemoryStore } from '../../server/db/store.ts';
import { buildActiveReport } from '../../server/intelligence/active-report.ts';
import { createWebHarvestRouter } from '../../server/webharvest/routes.ts';
import { createWebHarvestStore } from '../../server/webharvest/store.ts';

const NOW = new Date('2026-11-22T00:00:00.000Z');
const OBSERVED_AT = '2026-11-21T00:00:00.000Z';
const TARGET = 'card-alpha';

const SOURCE = {
  id: 'lake-test-source',
  name: 'Lake Test Source',
  url: 'https://example.invalid/catalog.json',
  kind: 'json' as const,
  enabled: true,
  license: 'CC-BY-4.0',
  respectRobots: true,
  rateLimitMs: 1000,
};

let lakeRoot: string;
let lakeDir: string;
let server: Server;
let baseUrl: string;
let seededFindingCount = 0;

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function jsonRequest(route: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${route}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  return { status: response.status, body: await response.json() };
}

function candidate(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    sourceId: SOURCE.id,
    evidenceId: `lake-ev-${id}`,
    name: 'Lake Candidate',
    set: 'Base Set',
    game: 'TestGame',
    number: '007',
    basis: 'GUIDE',
    amount: 12,
    currency: 'USD',
    observedAt: OBSERVED_AT,
    capturedAt: '2026-11-21T00:01:00.000Z',
    license: 'CC-BY-4.0',
    confidence: 'LOW',
    warnings: [],
    ...overrides,
  };
}

function assertManifestShapes(manifest: ParquetExportResult): void {
  assert.deepEqual(
    manifest.datasets.map((dataset) => dataset.name),
    LAKE_DATASET_NAMES,
  );
  assert.equal(manifest.datasets.length, 7);
  for (const dataset of manifest.datasets) {
    assert.equal(typeof dataset.rows, 'number');
    assert.ok(Number.isInteger(dataset.rows) && dataset.rows >= 0);
    if (dataset.files.length === 0) {
      assert.equal(dataset.rows, 0, `${dataset.name} has no files only when empty`);
      assert.equal(dataset.checksum, 'UNKNOWN', `${dataset.name} has no invented checksum`);
      continue;
    }
    assert.match(dataset.checksum, /^[a-f0-9]{64}$/, dataset.name);
    for (const file of dataset.files) {
      assert.match(file.path, /\.parquet$/);
      assert.match(file.sha256, /^[a-f0-9]{64}$/);
    }
  }
  for (const name of ['findings']) {
    assert.ok((manifest.datasets.find((dataset) => dataset.name === name)?.files.length ?? 0) > 0,
      `${name} always writes a Parquet file`);
  }
}

before(async () => {
  lakeRoot = await mkdtemp(path.join(os.tmpdir(), 'slabswarm-lake-report-'));
  lakeDir = path.join(lakeRoot, 'route');

  const evidence = [
    makeEvidence({ id: 'e-1', sourceId: 'ebay', observedAt: OBSERVED_AT, parsedPayload: { game: 'MTG' } }),
    makeEvidence({ id: 'e-2', sourceId: 'ebay', observedAt: OBSERVED_AT, parsedPayload: { game: 'MTG' } }),
    makeEvidence({ id: 'e-3', sourceId: 'ebay', observedAt: OBSERVED_AT, parsedPayload: { game: 'MTG' } }),
  ];
  const observations = evidence.map((record, index) =>
    makeObservation({
      id: `o-${index + 1}`,
      evidenceId: record.id,
      targetIdentityRef: TARGET,
      basis: 'SOLD',
      amount: 100 + index,
      currency: 'USD',
      observedAt: OBSERVED_AT,
      parsedPayload: { game: 'MTG' },
    } as any),
  );
  const store = createAnalyticsStore({
    evidence,
    observations,
    identities: [{ id: TARGET, canonicalName: 'Card Alpha', game: 'MTG', source: 'ebay', observedAt: OBSERVED_AT }],
  });
  seededFindingCount = runDiscoverySweep(store, {
    now: NOW, activeWindowDays: 30, staleDays: 30, minActiveObservations: 3,
  }).findings.length;

  const app = express();
  app.use(createAnalyticsRouter({ store, lakeDir }));
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (lakeRoot) await rm(lakeRoot, { recursive: true, force: true });
});

test('admin export writes seven datasets with real paths, row counts and sha256 checksums', async () => {
  assert.ok(seededFindingCount > 0, 'the seeded sweep produced findings');
  const { status, body } = await jsonRequest('/api/admin/export-parquet', {
    method: 'POST', body: '{}',
  });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  const manifest = body.data as ParquetExportResult;
  assertManifestShapes(manifest);

  const byName = new Map(manifest.datasets.map((dataset) => [dataset.name, dataset]));
  assert.equal(byName.get('evidence')?.rows, 3);
  assert.equal(byName.get('observations')?.rows, 3);
  assert.equal(byName.get('identities')?.rows, 1);
  assert.equal(byName.get('findings')?.rows, seededFindingCount);
  for (const name of ['evidence', 'observations', 'identities']) {
    assert.ok((byName.get(name)?.files.length ?? 0) > 0, `${name} has at least one Parquet file`);
  }

  for (const dataset of manifest.datasets) {
    assert.equal((await stat(dataset.path)).isDirectory() || (await stat(dataset.path)).isFile(), true);
    for (const file of dataset.files) {
      assert.equal(sha256(await readFile(file.path)), file.sha256, file.path);
      const bytes = (await stat(file.path)).size;
      assert.equal(file.bytes, bytes);
    }
  }

  const onDisk = await readLakeManifest(lakeDir);
  assert.deepEqual(onDisk, manifest, 'the on-disk manifest is the manifest the report will cite');
  assert.ok(existsInLake(manifest, 'evidence'));
  assert.ok(existsInLake(manifest, 'observations'));
  assert.ok(existsInLake(manifest, 'findings'));

  const again = await jsonRequest('/api/admin/export-parquet', { method: 'POST', body: '{}' });
  assert.equal(again.status, 200);
  const rebuilt = again.body.data as ParquetExportResult;
  assert.deepEqual(
    rebuilt.datasets.map((dataset) => dataset.checksum),
    manifest.datasets.map((dataset) => dataset.checksum),
    'a rebuild of the same snapshot is byte-identical',
  );
});

function existsInLake(manifest: ParquetExportResult, name: string): boolean {
  return manifest.datasets.some((dataset) => dataset.name === name && dataset.rows > 0);
}

test('SQL Lab stays read-only while the findings query reads the lake-backed dataset', async () => {
  for (const sql of ['DROP TABLE observations', 'INSERT INTO observations VALUES (1)', 'SELECT 1; DELETE FROM evidence']) {
    const { status, body } = await jsonRequest('/api/sql/query', {
      method: 'POST', body: JSON.stringify({ sql }),
    });
    assert.equal(status, 403, sql);
    assert.equal(body.error, 'read_only_violation');
  }
  const saved = await jsonRequest('/api/sql/saved', {
    method: 'POST', body: JSON.stringify({ name: 'unsafe', sql: 'DELETE FROM observations' }),
  });
  assert.equal(saved.status, 403);

  const read = await jsonRequest('/api/sql/query', {
    method: 'POST', body: JSON.stringify({ queryId: 'finding_summary' }),
  });
  assert.equal(read.status, 200);
  assert.equal(read.body.result.source, 'template');
  assert.ok((read.body.result.rows as unknown[]).length > 0, 'findings are queryable');
});

async function seedIngest(): Promise<IngestRepositories> {
  const repos = createInMemoryRepositories();
  for (let index = 1; index <= 3; index += 1) {
    const evidence = await repos.evidence.create({
      sourceId: 'ebay',
      sourceRecordId: `lake-report-${index}`,
      capturedAt: '2026-11-21T00:01:00.000Z',
      observedAt: OBSERVED_AT,
      checksum: `sha256-lake-report-${index}`,
      mimeType: 'application/json',
      rawRef: `raw/lake-report-${index}.json`,
      parsedPayload: { game: 'MTG', name: 'Card Alpha', set: 'Base Set' },
    });
    await repos.marketObservations.create({
      evidenceId: evidence.id,
      targetIdentityRef: TARGET,
      basis: 'SOLD',
      amount: 100 + index,
      currency: 'USD',
      marketplace: 'ebay',
      observedAt: OBSERVED_AT,
      status: 'NORMALIZED',
    });
  }
  return repos;
}

test('active report cites canonical evidence ids and carries the seven-dataset lake manifest', async () => {
  const repos = await seedIngest();
  const evidenceIds = (await repos.evidence.list()).map((record) => record.id);
  assert.equal(evidenceIds.length, 3);
  const reportLakeDir = path.join(lakeRoot, 'report');
  const manifest = await exportCanonicalLake(repos, { lakeDir: reportLakeDir, now: NOW });
  assertManifestShapes(manifest);
  const observations = manifest.datasets.find((dataset) => dataset.name === 'observations');
  assert.equal(observations?.rows, 3);

  const report = await buildActiveReport({
    now: NOW,
    repositories: repos,
    lakeManifest: manifest,
  });
  assert.equal(report.data.cards.length, 1);
  const cited = report.data.cards[0].evidence.map((ref) => ref.id);
  assert.ok(cited.length > 0);
  for (const id of cited) {
    assert.ok(evidenceIds.includes(id), `${id} is a canonical evidence id`);
  }
  assert.deepEqual(report.meta.lakeManifest, manifest);
  assertManifestShapes(report.meta.lakeManifest as ParquetExportResult);
});

test('an approved harvest rebuilds the lake; a rejection does not', async () => {
  const repositories = createRepositories(createMemoryStore());
  const harvestStore = createWebHarvestStore({ sources: [SOURCE], repositories, now: () => NOW });
  const harvestLakeDir = path.join(lakeRoot, 'harvest');
  let exportCount = 0;
  const exported: { manifest: ParquetExportResult | null } = { manifest: null };
  const router = createWebHarvestRouter({
    store: harvestStore,
    now: () => NOW,
    onApproved: async () => {
      exportCount += 1;
      exported.manifest = await exportCanonicalLake(repositories, {
        lakeDir: harvestLakeDir,
        store: createAnalyticsStore(),
        now: NOW,
      });
      return exported.manifest;
    },
  });

  const app = express();
  app.use(express.json());
  app.use(router);
  const harvestServer = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => harvestServer.once('listening', () => resolve()));
  const port = (harvestServer.address() as AddressInfo).port;
  const post = async (route: string, body: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };

  try {
    const queued = await post('/api/web-harvest/candidates', candidate('approved-1'));
    assert.equal(queued.status, 200);
    const approved = await post('/api/web-harvest/review', {
      candidateId: 'approved-1', action: 'APPROVE', note: 'verified fixture',
    });
    assert.equal(approved.status, 200);
    assert.equal(exportCount, 1, 'approval triggers exactly one lake export');
    assert.ok(exported.manifest);
    assertManifestShapes(exported.manifest);
    assert.equal(
      exported.manifest.datasets.find((dataset) => dataset.name === 'observations')?.rows,
      1,
      'the newly approved observation is in the lake',
    );

    assert.equal((await post('/api/web-harvest/candidates', candidate('rejected-1'))).status, 200);
    const rejected = await post('/api/web-harvest/review', {
      candidateId: 'rejected-1', action: 'REJECT', note: 'unverified fixture',
    });
    assert.equal(rejected.status, 200);
    assert.equal(exportCount, 1, 'a rejection does not trigger an export');
  } finally {
    await new Promise<void>((resolve) => harvestServer.close(() => resolve()));
  }
});
