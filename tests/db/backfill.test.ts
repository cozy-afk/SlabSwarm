import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { backfillJson, backfillJsonFile } from '../../scripts/backfill-json.ts';
import { createMemoryStore } from '../../server/db/store.ts';

const fixturePath = path.resolve(
  import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
  'fixtures/slabgraph-fixture.json',
);
const FIXTURE_RAW = fs.readFileSync(fixturePath, 'utf-8');
const CAPTURED_AT = '2026-11-22T12:00:00.000Z';

async function importFixture() {
  const store = createMemoryStore();
  const report = await backfillJson(FIXTURE_RAW, store, { capturedAt: CAPTURED_AT, source: 'fixture.json' });
  return { store, report };
}

test('backfill reports source/processed/skipped/invalid counts that add up (parity)', async () => {
  const { report } = await importFixture();
  assert.equal(report.parity, true, `parity failed: ${JSON.stringify(report.notes)}`);
  assert.deepEqual(report.sourceCounts, {
    sets: 0, assets: 3, sales: 3, valuations: 1,
    researchSources: 2, researchNotes: 2, marketObservations: 2,
  });
  assert.equal(report.processed.assets, 2);
  assert.equal(report.skipped.assets, 1);
  assert.equal(report.processed.sales, 2);
  assert.equal(report.skipped.researchSources, 1);
  assert.equal(report.skipped.researchNotes, 1);
  assert.equal(report.processed.marketObservations, 1);
  assert.equal(report.invalid.length, 2, 'bad priceUsd and bad basis must be invalid');
  assert.deepEqual(
    report.invalid.map((i) => i.reason).sort(),
    ['invalid basis: MADE_UP', 'invalid or missing priceUsd'].sort(),
  );
  assert.equal(report.imported.cards, 2);
  assert.equal(report.imported.evidence_records, 3);
  assert.equal(report.imported.market_observations, 3);
  assert.equal(report.imported.valuations, 1);
  assert.equal(report.imported.research_notes, 1);
});

test('backfill writes rows carrying source, timestamps, lineage and explicit basis', async () => {
  const { store, report } = await importFixture();
  const evidence = await store.findAll('evidence_records');
  assert.ok(evidence.length >= 3);
  for (const row of evidence) {
    assert.ok(row.sourceId, 'evidence must carry a source');
    assert.ok(row.capturedAt, 'evidence must carry captured_at');
    assert.ok(row.observedAt, 'evidence must carry observed_at');
    assert.ok(row.checksum, 'evidence must carry a checksum');
  }
  const observations = await store.findAll('market_observations');
  // obs-1 duplicates sale-1 (same evidence/target/basis/time) and dedupes onto it.
  assert.equal(observations.length, 2);
  for (const row of observations) {
    assert.match(String(row.basis), /^(SOLD|ASKING|OFFER|GUIDE|CLAIM|POPULATION|UNKNOWN)$/);
    assert.ok(row.lineage, 'observation must carry lineage');
    assert.ok(row.capturedAt, 'observation must carry captured_at');
  }
  const sold = observations.filter((row) => row.basis === 'SOLD');
  assert.equal(sold.length, 2);
  assert.ok(sold.some((row) => row.status === 'CONTESTED'), 'QUARANTINED sale must be CONTESTED');
  assert.match(report.sourceChecksum, /^sha256:[0-9a-f]{64}$/);
});

test('backfill never defaults missing price components to zero', async () => {
  const { store } = await importFixture();
  const observations = await store.findAll('market_observations', { basis: 'SOLD' });
  const quarantined = observations.find((row) => row.status === 'CONTESTED');
  assert.ok(quarantined);
  // The fixture sale has no shipping/fees fields; they stay UNKNOWN, not 0.
  assert.equal(quarantined.priceComponents, null);
  assert.ok(!('shipping_amount' in (quarantined.priceComponents ?? {})));
  const cards = await store.findAll('cards');
  assert.equal(cards.length, 2);
  for (const card of cards) assert.ok(card.rawPayload, 'raw JSON preserved on the card');
});

test('re-running the backfill is idempotent (no duplicate rows)', async () => {
  const store = createMemoryStore();
  const first = await backfillJson(FIXTURE_RAW, store, { capturedAt: CAPTURED_AT });
  const second = await backfillJson(FIXTURE_RAW, store, { capturedAt: CAPTURED_AT });
  assert.equal(first.parity, true);
  assert.equal(second.parity, true);
  assert.deepEqual(first.sourceCounts, second.sourceCounts);
  assert.equal(await store.count('cards'), 2);
  assert.equal(await store.count('evidence_records'), 3);
  assert.equal(await store.count('market_observations'), 2);
  assert.equal(await store.count('research_notes'), 1);
});

test('backfillJsonFile reads the source read-only and preserves its bytes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slabswarm-backfill-'));
  const file = path.join(dir, 'snapshot.json');
  fs.writeFileSync(file, FIXTURE_RAW, 'utf-8');
  const before = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  try {
    const report = await backfillJsonFile(file, createMemoryStore(), { capturedAt: CAPTURED_AT });
    const after = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    assert.equal(after, before, 'source JSON must be byte-identical after backfill');
    assert.equal(report.sourceChecksum, `sha256:${before}`);
    assert.equal(report.parity, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
