import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { DuckDBInstance } from '@duckdb/node-api';
import { exportAnalyticsParquet } from '../../server/analytics/parquet.ts';
import {
  FIXED_NOW,
  makeEvidence,
  makeForecast,
  makeObservation,
  makeScore,
  makeStore,
} from './fixtures.ts';

let lakeDir: string;

before(async () => {
  lakeDir = await mkdtemp(path.join(os.tmpdir(), 'slabswarm-lake-'));
});

after(async () => {
  await rm(lakeDir, { recursive: true, force: true });
});

function seededStore() {
  const firstObservation = makeObservation({
    id: 'o-1', evidenceId: 'e-1', basis: 'SOLD', amount: 100,
    currency: 'USD', observedAt: '2026-11-20T10:00:00.000Z',
  });
  // The frozen contract has no game field; derived game lives in the payload.
  (firstObservation as unknown as Record<string, unknown>).parsedPayload = { game: 'MTG' };
  return makeStore({
    evidence: [
      makeEvidence({
        id: 'e-1',
        sourceId: 'ebay',
        observedAt: '2026-11-20T10:00:00.000Z',
        parsedPayload: { game: 'MTG' },
      }),
      makeEvidence({
        id: 'e-2',
        sourceId: 'tcgplayer',
        observedAt: '2026-11-21T10:00:00.000Z',
        parsedPayload: { game: 'POK' },
      }),
    ],
    observations: [
      firstObservation,
      makeObservation({
        id: 'o-2', evidenceId: 'e-2', basis: 'ASKING', amount: 250,
        currency: 'USD', observedAt: '2026-11-21T10:00:00.000Z',
        marketplace: 'tcgplayer',
      }),
    ],
    identities: [{
      id: 'id-1', canonicalName: 'Charizard', game: 'POK',
      source: 'tcgplayer', observedAt: '2026-11-21T10:00:00.000Z',
    }],
    events: [{
      id: 'ev-1', type: 'PRICE_CHANGE', targetId: 'id-1',
      source: 'ebay', game: 'MTG', observedAt: '2026-11-20T10:00:00.000Z',
    }],
    forecasts: [makeForecast({ id: 'f-1' })],
    scores: [makeScore({ id: 's-1', forecastId: 'f-1' })],
  });
}

test('export writes all six derived datasets with a manifest and exact row counts', async () => {
  const result = await exportAnalyticsParquet(seededStore(), {
    lakeDir: path.join(lakeDir, 'full'),
    now: FIXED_NOW,
  });

  assert.deepEqual(result.datasets.map((d) => d.name), [
    'evidence', 'observations', 'identities', 'events', 'forecasts', 'scores',
  ]);
  assert.deepEqual(result.datasets.map((d) => d.rows), [2, 2, 1, 1, 1, 1]);
  assert.equal(result.generatedAt, FIXED_NOW.toISOString());
  assert.ok(existsSync(path.join(lakeDir, 'full', 'manifest.json')));
  for (const dataset of result.datasets) {
    assert.ok(existsSync(dataset.path), dataset.path);
    if (dataset.partitionBy.length === 0) assert.match(dataset.path, /\.parquet$/);
    else assert.equal(dataset.path, path.join(lakeDir, 'full', dataset.name));
  }
});

test('evidence, observations, identities and events partition by game/source/observed_date', async () => {
  const result = await exportAnalyticsParquet(seededStore(), {
    lakeDir: path.join(lakeDir, 'partitions'),
    now: FIXED_NOW,
  });
  const byName = new Map(result.datasets.map((d) => [d.name, d]));
  for (const name of ['evidence', 'observations', 'identities', 'events']) {
    assert.deepEqual(byName.get(name)?.partitionBy, ['game', 'source', 'observed_date']);
  }
  for (const name of ['forecasts', 'scores']) {
    assert.deepEqual(byName.get(name)?.partitionBy, []);
  }

  const evidenceTree = await readdir(path.join(lakeDir, 'partitions', 'evidence'), { recursive: true });
  const evidenceFiles = evidenceTree.filter((entry) => String(entry).endsWith('.parquet'));
  assert.equal(evidenceFiles.length, 2);
  assert.ok(evidenceFiles.some((entry) => String(entry).includes('game=MTG')));
  assert.ok(evidenceFiles.some((entry) => String(entry).includes('game=POK')));
  assert.ok(evidenceFiles.some((entry) => String(entry).includes('source=ebay')));
  assert.ok(evidenceFiles.some((entry) => String(entry).includes('observed_date=2026-11-20')));
});

test('Parquet readback preserves explicit basis, currency, provenance and UNKNOWN sentinels', async () => {
  const root = path.join(lakeDir, 'readback');
  await exportAnalyticsParquet(seededStore(), { lakeDir: root, now: FIXED_NOW });
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  try {
    const observations = await connection.run(
      `SELECT id, basis, currency, amount, source, observed_date, confidence, lineage
       FROM read_parquet('${root}/observations/**/*.parquet') ORDER BY id`,
    );
    const rows = await observations.getRowsJson();
    assert.deepEqual(rows.map((row) => row[0]), ['o-1', 'o-2']);
    assert.deepEqual(rows.map((row) => row[1]), ['SOLD', 'ASKING']);
    assert.deepEqual(rows.map((row) => row[2]), ['USD', 'USD']);
    assert.deepEqual(rows.map((row) => row[3]), [100, 250]);
    assert.deepEqual(rows.map((row) => row[4]), ['ebay', 'tcgplayer']);
    assert.deepEqual(rows.map((row) => row[5]), ['2026-11-20', '2026-11-21']);
    // Missing confidence and lineage are explicit UNKNOWN, never 0 or null.
    assert.deepEqual(rows.map((row) => row[6]), ['UNKNOWN', 'UNKNOWN']);
    assert.deepEqual(rows.map((row) => row[7]), ['UNKNOWN', 'UNKNOWN']);

    const evidence = await connection.run(
      `SELECT id, checksum, captured_at, source_uri, license
       FROM read_parquet('${root}/evidence/**/*.parquet') ORDER BY id`,
    );
    const evidenceRows = await evidence.getRowsJson();
    assert.equal(evidenceRows[0][1], 'sha256-e-1');
    assert.equal(evidenceRows[0][2], '2026-11-21T01:00:00.000Z');
    assert.equal(evidenceRows[0][3], 'UNKNOWN');
    assert.equal(evidenceRows[0][4], 'UNKNOWN');

    const scores = await connection.run(
      `SELECT id, forecast_id, error FROM read_parquet('${root}/scores/scores.parquet')`,
    );
    const scoreRows = await scores.getRowsJson();
    assert.deepEqual(scoreRows, [['s-1', 'f-1', '0.05']]);
  } finally {
    instance.closeSync();
  }
});

test('empty snapshot still produces a complete, rebuildable empty lake', async () => {
  const root = path.join(lakeDir, 'empty');
  const first = await exportAnalyticsParquet(makeStore(), { lakeDir: root, now: FIXED_NOW });
  assert.deepEqual(first.datasets.map((d) => d.rows), [0, 0, 0, 0, 0, 0]);
  assert.equal(first.datasets.length, 6);

  const second = await exportAnalyticsParquet(makeStore(), { lakeDir: root, now: FIXED_NOW });
  assert.deepEqual(second.datasets.map((d) => d.rows), first.datasets.map((d) => d.rows));
  const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8')) as {
    contractVersion: string;
  };
  assert.equal(manifest.contractVersion, '2026-11-22.1');
});
