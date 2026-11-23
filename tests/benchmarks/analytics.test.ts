import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { DuckDBInstance } from '@duckdb/node-api';
import { runDiscoverySweep } from '../../server/analytics/discovery.ts';
import { exportAnalyticsParquet } from '../../server/analytics/parquet.ts';
import { runSqlQuery } from '../../server/analytics/sqlLab.ts';
import {
  FIXED_NOW,
  daysAgo,
  makeEvidence,
  makeForecast,
  makeObservation,
  makeScore,
  makeStore,
} from '../analytics/fixtures.ts';

/**
 * Task 5 analytics benchmarks. Timings are printed as machine-readable lines
 * so docs/benchmarks/2026-11-22-analytics.md can record real output. Inputs are
 * deterministic fixtures; every assertion also encodes a global constraint.
 */

const OBSERVATION_COUNT = 240;
const SWEEP = { now: FIXED_NOW };

let lakeDir: string;
let store: ReturnType<typeof makeStore>;
const metrics: Record<string, number> = {};

before(async () => {
  lakeDir = await mkdtemp(path.join(os.tmpdir(), 'slabswarm-analytics-bench-'));
  const observations = Array.from({ length: OBSERVATION_COUNT }, (_, index) =>
    makeObservation({
      id: `bench-obs-${index}`,
      evidenceId: `bench-evidence-${index}`,
      basis: index % 3 === 0 ? 'ASKING' : 'SOLD',
      amount: index % 29 === 0 ? 900 : 100 + (index % 7),
      currency: index % 11 === 0 ? 'EUR' : 'USD',
      marketplace: index % 2 === 0 ? 'ebay' : 'tcgplayer',
      observedAt: daysAgo(index % 28),
    }),
  );
  store = makeStore({
    evidence: observations.slice(0, 12).map((o, index) =>
      makeEvidence({ id: `bench-evidence-${index}`, sourceId: 'ebay', parsedPayload: { game: 'MTG' } }),
    ),
    observations,
    identities: [{ id: 'bench-card', canonicalName: 'Bench Card', game: 'MTG', source: 'ebay' }],
    events: [{ id: 'bench-event', type: 'PRICE_CHANGE', source: 'ebay', game: 'MTG', observedAt: daysAgo(1) }],
    forecasts: [makeForecast({ id: 'bench-forecast' })],
    scores: [makeScore({ id: 'bench-score', forecastId: 'bench-forecast' })],
  });
});

after(async () => {
  await rm(lakeDir, { recursive: true, force: true });
  console.log(`[bench] analytics ${JSON.stringify(metrics)}`);
});

test('query latency: built-in and raw aggregation over 240 observations', async () => {
  const started = performance.now();
  const builtIn = await runSqlQuery(store, { queryId: 'basis_mix' });
  const builtInMs = performance.now() - started;

  const rawStart = performance.now();
  const raw = await runSqlQuery(store, {
    sql: `SELECT basis, currency, COUNT(*) AS n, AVG(amount) AS avgAmount
          FROM observations GROUP BY basis, currency ORDER BY basis, currency`,
  });
  const rawMs = performance.now() - rawStart;

  metrics.queryBuiltInMs = Math.round(builtInMs * 100) / 100;
  metrics.queryRawMs = Math.round(rawMs * 100) / 100;
  console.log(`[bench] query_latency_ms built_in=${metrics.queryBuiltInMs} raw=${metrics.queryRawMs} rows=${raw.rows.length}`);

  assert.ok(builtIn.rows.length >= 4);
  assert.ok(builtInMs < 5000, `built-in query took ${builtInMs}ms`);
  assert.ok(rawMs < 5000, `raw query took ${rawMs}ms`);
});

test('basis preservation: SQL Lab never pools bases or currencies', async () => {
  const result = await runSqlQuery(store, { queryId: 'basis_mix' });
  const rows = result.rows as Array<{ basis: string; currency: string; observations: number }>;
  const total = rows.reduce((sum, row) => sum + row.observations, 0);
  assert.equal(total, OBSERVATION_COUNT);
  assert.ok(rows.every((row) => /^(SOLD|ASKING|OFFER|GUIDE|CLAIM|POPULATION|UNKNOWN)$/.test(row.basis)));
  assert.equal(new Set(rows.map((row) => `${row.basis}|${row.currency}`)).size, rows.length);
  const soldUsd = rows.find((row) => row.basis === 'SOLD' && row.currency === 'USD');
  assert.ok(soldUsd && soldUsd.observations > 0);
  metrics.basisGroups = rows.length;
  console.log(`[bench] basis_preservation groups=${rows.length} observations=${total}`);
});

test('comps correctness: anomalies are basis- and currency-matched only', () => {
  const started = performance.now();
  const result = runDiscoverySweep(store, SWEEP);
  metrics.sweepMs = Math.round((performance.now() - started) * 100) / 100;
  const anomalies = result.findings.filter((finding) => finding.type === 'ANOMALY');
  assert.ok(anomalies.length > 0);
  for (const finding of anomalies) {
    assert.equal(typeof finding.metrics.basis, 'string');
    assert.equal(typeof finding.metrics.currency, 'string');
    assert.ok(!String(finding.metrics.basis).includes('|'));
    assert.match(finding.summary, new RegExp(String(finding.metrics.basis), 'i'));
  }
  console.log(`[bench] comps_correctness anomalies=${anomalies.length} findings=${result.findings.length} sweep_ms=${metrics.sweepMs}`);
});

test('export completeness: seven datasets, exact counts, provenance columns', async () => {
  const started = performance.now();
  const manifest = await exportAnalyticsParquet(store, { lakeDir, now: FIXED_NOW });
  metrics.exportMs = Math.round((performance.now() - started) * 100) / 100;

  const expected = ['evidence', 'observations', 'identities', 'events', 'forecasts', 'scores', 'findings'];
  assert.deepEqual(manifest.datasets.map((d) => d.name), expected);
  assert.equal(manifest.datasets.find((d) => d.name === 'observations')?.rows, OBSERVATION_COUNT);
  assert.equal(manifest.datasets.length, 7);
  assert.ok(manifest.datasets.every((d) => /^([a-f0-9]{64}|UNKNOWN)$/.test(d.checksum)));

  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  try {
    const result = await connection.run(
      `SELECT COUNT(*) AS n, COUNT(DISTINCT basis) AS bases, COUNT(DISTINCT currency) AS currencies
       FROM read_parquet('${lakeDir}/observations/**/*.parquet')`,
    );
    const rows = await result.getRowsJson();
    const [count, bases, currencies] = rows[0] as [string, string, string];
    assert.equal(Number(count), OBSERVATION_COUNT);
    assert.equal(Number(bases), 2);
    assert.equal(Number(currencies), 2);
    metrics.exportedRows = Number(count);
    console.log(`[bench] export_completeness datasets=${manifest.datasets.length} rows=${count} bases=${bases} currencies=${currencies} export_ms=${metrics.exportMs}`);
  } finally {
    instance.closeSync();
  }
});
