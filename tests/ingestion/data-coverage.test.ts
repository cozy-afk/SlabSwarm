// Data coverage is a read-only census of the durable ledger. Promotion must
// finish every priced candidate; catalog rows with no amount stay unpromoted.
// No network, no model, no mutation from the snapshot itself.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildCoverageSnapshot } from '../../scripts/data-coverage.ts';
import { promoteCandidates } from '../../server/ingest/promotion.ts';
import { createInMemoryRepositories } from '../../server/ingest/store.ts';
import type { IngestCandidate, IngestRepositories } from '../../server/ingest/types.ts';

const OBSERVED_AT = '2026-11-20T10:00:00.000Z';
const CAPTURED_AT = '2026-11-22T18:00:00.000Z';

function candidate(overrides: Partial<IngestCandidate> = {}): IngestCandidate {
  const evidenceId = overrides.evidenceId ?? 'ev-guide';
  return {
    evidenceId,
    targetIdentityRef: 'tcg:fixture-guide',
    basis: 'GUIDE',
    amount: 42.5,
    currency: 'USD',
    marketplace: null,
    observedAt: OBSERVED_AT,
    sourceId: 'fixture-a',
    capturedAt: CAPTURED_AT,
    lineage: [evidenceId],
    confidence: 'MEDIUM',
    priceComponents: { listed_amount: 42.5, currency: 'USD' },
    status: 'RAW',
    parseStatus: 'PARSED',
    warnings: [],
    ...overrides,
  };
}

/** Priced GUIDE (unpromoted), catalog-only row, and already-promoted SOLD. */
async function fixture(): Promise<IngestRepositories> {
  const repos = createInMemoryRepositories();
  const rows = [
    candidate({ evidenceId: 'ev-guide' }),
    candidate({
      evidenceId: 'ev-catalog',
      targetIdentityRef: 'cat:fixture-1',
      basis: 'UNKNOWN',
      amount: null,
      currency: 'UNKNOWN',
      sourceId: 'fixture-b',
      warnings: ['AMOUNT_UNKNOWN'],
    }),
    candidate({
      evidenceId: 'ev-sold',
      targetIdentityRef: 'sale:fixture-1',
      basis: 'SOLD',
      amount: 99,
      sourceId: 'fixture-a',
    }),
  ];
  for (const row of rows) {
    await repos.evidence.createIdempotent({
      sourceId: row.sourceId,
      sourceRecordId: row.evidenceId,
      capturedAt: row.capturedAt,
      observedAt: row.observedAt,
      checksum: `sum-${row.evidenceId}`,
      mimeType: 'application/json',
      trustTier: 'UNKNOWN',
      parseStatus: 'PENDING',
      rawRef: `raw/${row.evidenceId}`,
    });
    await repos.candidates.create(row);
  }
  // SOLD is already canonical; its key must be recognised as a duplicate.
  const prePromoted = {
    evidenceId: 'ev-sold',
    targetIdentityRef: 'sale:fixture-1',
    basis: 'SOLD' as const,
    amount: 99,
    currency: 'USD',
    observedAt: OBSERVED_AT,
    status: 'NORMALIZED' as const,
    sourceId: 'fixture-a',
    capturedAt: CAPTURED_AT,
    lineage: ['ev-sold', 'cand-preexisting'],
    confidence: 'MEDIUM',
  };
  await repos.marketObservations.create(prePromoted);
  return repos;
}

test('promotion leaves no priced candidate without an observation and counts catalog-only rows', async () => {
  const repos = await fixture();
  const promotion = await promoteCandidates(repos);
  assert.deepEqual(
    {
      candidatesSeen: promotion.candidatesSeen,
      promoted: promotion.promoted,
      duplicates: promotion.duplicates,
      skipped: promotion.skipped,
    },
    { candidatesSeen: 3, promoted: 1, duplicates: 1, skipped: 1 },
  );
  assert.deepEqual(promotion.unpromotedPriced, []);

  const snapshot = await buildCoverageSnapshot(repos);
  assert.equal(snapshot.pricedCandidates, 2);
  assert.equal(snapshot.promotedObservations, 2);
  assert.equal(snapshot.pricedWithoutObservation, 0);
  assert.equal(snapshot.catalogOnly, 1);
  assert.ok(snapshot.catalogOnly >= 1);
  assert.equal(snapshot.duplicateObservationKeys, 0);
});

test('coverage preserves basis and source counts', async () => {
  const repos = await fixture();
  await promoteCandidates(repos);
  const snapshot = await buildCoverageSnapshot(repos);
  assert.deepEqual(snapshot.byBasis, { GUIDE: 1, UNKNOWN: 1, SOLD: 1 });
  assert.deepEqual(snapshot.bySource, { 'fixture-a': 2, 'fixture-b': 1 });
});

test('coverage reports parseStatus, trustTier and canonical table counts', async () => {
  const repos = await fixture();
  await promoteCandidates(repos);
  const snapshot = await buildCoverageSnapshot(repos);
  assert.deepEqual(snapshot.byParseStatus, { PENDING: 3 });
  assert.deepEqual(snapshot.byTrustTier, { UNKNOWN: 3 });
  assert.deepEqual(snapshot.tables, {
    evidence: 3,
    candidates: 3,
    observations: 2,
    runs: 0,
  });
});

test('PENDING priced candidates are promoted and the snapshot never mutates the ledger', async () => {
  const repos = await fixture();
  await repos.candidates.create(candidate({
    evidenceId: 'ev-pending',
    targetIdentityRef: 'ask:fixture-1',
    basis: 'ASKING',
    amount: 12,
    parseStatus: 'PENDING',
  }));
  const readLedger = async () => JSON.stringify({
    evidence: await repos.evidence.list(),
    candidates: await repos.candidates.list(),
    observations: await repos.marketObservations.list(),
  });
  const before = await readLedger();

  const first = await buildCoverageSnapshot(repos);
  assert.equal(first.pricedCandidates, 3);
  assert.equal(first.pricedWithoutObservation, 2);
  assert.equal(await readLedger(), before, 'buildCoverageSnapshot must be read-only');

  const promotion = await promoteCandidates(repos);
  assert.equal(promotion.promoted, 2);
  assert.deepEqual(promotion.unpromotedPriced, [], 'guard: no priced PARSED/PENDING candidate is left behind');
  const after = await buildCoverageSnapshot(repos);
  assert.equal(after.pricedWithoutObservation, 0);
  assert.equal(after.byBasis.ASKING, 1);
});
