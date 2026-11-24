// A-01 repair: orphan observations are repaired only by exact provenance,
// never by guessing. The report must name every row that cannot be matched.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRepositories } from '../../server/db/repositories/index.ts';
import { createMemoryStore, type MemoryStore, type Row } from '../../server/db/store.ts';
import { repairEvidenceRefs } from '../../scripts/repair-evidence-refs.ts';

const LEDGER_ID = 'ev-2beb9ebc-9547-46ea-b8ae-4baa1b5d07b1';
const SOURCE_RECORD_ID = 'tcg:price:530626:0:lowPrice';
const CHECKSUM = 'sha256-ledger-evidence-530626';
const OBSERVED_AT = '2026-11-22T10:00:00.000Z';

function ledgerRow(id: string, sourceRecordId: string, checksum: string) {
  return {
    id,
    sourceId: 'tcgapis',
    sourceRecordId,
    checksum,
    observedAt: OBSERVED_AT,
    capturedAt: OBSERVED_AT,
    mimeType: 'application/json',
    rawRef: `ingest://tcgapis/${sourceRecordId}`,
    parsedPayload: { record: { externalId: '530626' } },
  } as unknown as Record<string, unknown>;
}

test('repair falls back to exact source + sourceRecordId when checksum and externalId are absent', async () => {
  const store = createMemoryStore() as MemoryStore;
  const repos = createRepositories(store);
  const canonical = await repos.evidence.create({
    sourceId: 'carddex',
    sourceRecordId: 'carddex:price:99',
    checksum: 'sha256-canonical-carddex-99',
    capturedAt: OBSERVED_AT,
    observedAt: OBSERVED_AT,
    mimeType: 'application/json',
    rawRef: 'ingest://carddex/carddex:price:99',
  });
  const orphan = await repos.marketObservations.create({
    evidenceId: 'ev-no-checksum',
    targetIdentityRef: 'card-99',
    basis: 'GUIDE',
    amount: 9,
    currency: 'USD',
    observedAt: OBSERVED_AT,
  });
  const updateEvidenceRef = async (observationId: string, evidenceId: string) => {
    const row = store.rows.get('market_observations')?.find((item) => item.id === observationId);
    assert.ok(row);
    row.evidenceId = evidenceId;
  };
  const ledgerEvidence = [{
    id: 'ev-no-checksum',
    sourceId: 'carddex',
    sourceRecordId: 'carddex:price:99',
    observedAt: OBSERVED_AT,
  }] as unknown as Record<string, unknown>[];

  const report = await repairEvidenceRefs({
    repositories: repos, ledgerEvidence, updateEvidenceRef, apply: true,
  });
  assert.equal(report.repaired, 1, JSON.stringify(report.failures));
  assert.equal((await repos.marketObservations.get(orphan.id))?.evidenceId, canonical.id);
  assert.match(report.repairs[0]?.matchedBy ?? '', /source.*sourceRecordId/i);

  // A second row with the same source + sourceRecordId makes the fallback
  // ambiguous; it must be reported, never guessed.
  await repos.evidence.create({
    sourceId: 'carddex',
    sourceRecordId: 'carddex:price:99',
    checksum: 'sha256-canonical-carddex-99-second',
    capturedAt: OBSERVED_AT,
    observedAt: OBSERVED_AT,
    mimeType: 'application/json',
    rawRef: 'ingest://carddex/carddex:price:99/second',
  });
  const ambiguous = await repos.marketObservations.create({
    evidenceId: 'ev-ambiguous',
    targetIdentityRef: 'card-99',
    basis: 'GUIDE',
    amount: 11,
    currency: 'USD',
    observedAt: OBSERVED_AT,
  });
  const second = await repairEvidenceRefs({
    repositories: repos,
    ledgerEvidence: [{
      id: 'ev-ambiguous', sourceId: 'carddex', sourceRecordId: 'carddex:price:99',
    }] as unknown as Record<string, unknown>[],
    updateEvidenceRef,
    apply: true,
  });
  assert.equal(second.repaired, 0);
  assert.equal(second.failures.length, 1);
  assert.equal(second.failures[0]?.observationId, ambiguous.id);
  assert.match(second.failures[0]?.reason ?? '', /ambiguous/i);
});

test('duplicate ledger provenance is disambiguated by exact observation timestamp', async () => {
  const store = createMemoryStore() as MemoryStore;
  const repos = createRepositories(store);
  const EARLY = '2026-11-23T07:14:22.351Z';
  const LATE = '2026-11-24T00:09:49.916Z';
  const NEITHER = '2026-11-25T00:00:00.000Z';
  const sourceId = 'pokemontcg';
  const sourceRecordId = 'dp5-70';
  const rawRef = `${sourceId}:${sourceRecordId}`;

  const earlyCanonical = await repos.evidence.create({
    sourceId, sourceRecordId, checksum: 'sha256-early',
    capturedAt: EARLY, observedAt: EARLY, mimeType: 'application/json',
    rawRef: `ingest://${rawRef}/early`,
  });
  await repos.evidence.create({
    sourceId, sourceRecordId, checksum: 'sha256-late',
    capturedAt: LATE, observedAt: LATE, mimeType: 'application/json',
    rawRef: `ingest://${rawRef}/late`,
  });
  const orphan = await repos.marketObservations.create({
    evidenceId: rawRef, targetIdentityRef: 'card-dp5-70', basis: 'GUIDE',
    amount: 12, currency: 'USD', observedAt: EARLY,
  });
  const noTimestampMatch = await repos.marketObservations.create({
    evidenceId: rawRef, targetIdentityRef: 'card-dp5-70', basis: 'GUIDE',
    amount: 13, currency: 'USD', observedAt: NEITHER,
  });
  const updateEvidenceRef = async (observationId: string, evidenceId: string) => {
    const row = store.rows.get('market_observations')?.find((item) => item.id === observationId);
    assert.ok(row);
    row.evidenceId = evidenceId;
  };
  const ledgerEvidence = [
    {
      id: 'ev-1a1b0000-0000-4000-8000-000000000001', sourceId, sourceRecordId,
      checksum: 'sha256-early', observedAt: EARLY, capturedAt: EARLY,
      mimeType: 'application/json', rawRef: `ingest://${rawRef}/early`,
    },
    {
      id: 'ev-b3a30000-0000-4000-8000-000000000002', sourceId, sourceRecordId,
      checksum: 'sha256-late', observedAt: LATE, capturedAt: LATE,
      mimeType: 'application/json', rawRef: `ingest://${rawRef}/late`,
    },
  ] as unknown as Record<string, unknown>[];

  const report = await repairEvidenceRefs({
    repositories: repos, ledgerEvidence, updateEvidenceRef, apply: true,
  });
  assert.equal(report.repaired, 1, JSON.stringify(report.failures));
  assert.equal((await repos.marketObservations.get(orphan.id))?.evidenceId, earlyCanonical.id);
  assert.match(report.repairs[0]?.tieBrokenBy ?? '', /observedAt/i);
  assert.equal(report.failures.length, 1, 'the row with no matching timestamp still fails closed');
  assert.equal(report.failures[0]?.observationId, noTimestampMatch.id);
  assert.match(report.failures[0]?.reason ?? '', /ambiguous/i);
});

test('repair maps orphan refs by exact source + sourceRecordId, reports unmatched rows and is idempotent', async () => {
  const store = createMemoryStore() as MemoryStore;
  const repos = createRepositories(store);
  const canonical = await repos.evidence.create({
    sourceId: 'tcgapis',
    sourceRecordId: SOURCE_RECORD_ID,
    checksum: CHECKSUM,
    capturedAt: OBSERVED_AT,
    observedAt: OBSERVED_AT,
    mimeType: 'application/json',
    rawRef: `ingest://tcgapis/${SOURCE_RECORD_ID}`,
  });
  const orphan = await repos.marketObservations.create({
    evidenceId: LEDGER_ID,
    targetIdentityRef: 'card-charizard',
    basis: 'GUIDE',
    amount: 12.5,
    currency: 'USD',
    observedAt: OBSERVED_AT,
  });
  const unmatched = await repos.marketObservations.create({
    evidenceId: 'ev-no-ledger-row',
    targetIdentityRef: 'card-charizard',
    basis: 'GUIDE',
    amount: 13,
    currency: 'USD',
    observedAt: OBSERVED_AT,
  });

  const updateEvidenceRef = async (observationId: string, evidenceId: string) => {
    const row: Row | undefined = store.rows.get('market_observations')
      ?.find((candidate) => candidate.id === observationId);
    assert.ok(row, `observation ${observationId} exists`);
    row.evidenceId = evidenceId;
  };
  const options = {
    repositories: repos,
    ledgerEvidence: [ledgerRow(LEDGER_ID, SOURCE_RECORD_ID, CHECKSUM)],
    updateEvidenceRef,
    apply: true,
  };

  const first = await repairEvidenceRefs(options);
  assert.equal(first.repaired, 1);
  assert.equal((await repos.marketObservations.get(orphan.id))?.evidenceId, canonical.id);
  assert.equal((await repos.evidence.get((await repos.marketObservations.get(orphan.id))!.evidenceId))?.id, canonical.id);
  assert.equal(first.failures.length, 1, 'the unmatched row stays visible in the failure report');
  assert.equal(first.failures[0]?.observationId, unmatched.id);
  assert.match(first.failures[0]?.reason ?? '', /ledger/i);

  const second = await repairEvidenceRefs(options);
  assert.equal(second.repaired, 0, 'rerun performs no further writes');
  assert.equal(second.alreadyResolved >= 1, true);
  assert.equal(second.failures.length, 1, 'unmatched rows remain reported on every run');
  assert.deepEqual(second.repairs, []);
});
