// A-01 regression: canonical observations must cite an evidence id that
// resolves in evidence_records. Ledger ids are `ev-<uuid>`; canonical rows use
// their own id. These tests use the real repository/resolver/promotion path,
// never a stub repository that could hide the join.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRepositories } from '../../server/db/repositories/index.ts';
import { createMemoryStore } from '../../server/db/store.ts';
import { syncLedgerToPostgres } from '../../server/db/sync.ts';
import { promoteFreeFeedHarvest } from '../../server/ingest/promotion.ts';
import type { IngestRun, StoredEvidenceRecord } from '../../server/ingest/types.ts';

const LEDGER_ID = 'ev-2beb9ebc-9547-46ea-b8ae-4baa1b5d07b1';
const SOURCE_RECORD_ID = 'tcg:price:530626:0:lowPrice';
const CHECKSUM = 'sha256-ledger-evidence-530626';
const OBSERVED_AT = '2026-11-22T10:00:00.000Z';
const CAPTURED_AT = '2026-11-23T09:00:00.000Z';

const ledgerEvidence: StoredEvidenceRecord = {
  id: LEDGER_ID,
  sourceId: 'tcgapis',
  sourceRecordId: SOURCE_RECORD_ID,
  sourceUri: 'https://api.tcgapis.com/products/530626/prices',
  capturedAt: CAPTURED_AT,
  observedAt: OBSERVED_AT,
  checksum: CHECKSUM,
  mimeType: 'application/json',
  license: 'public catalog data',
  rawRef: 'ingest://tcgapis/tcg:price:530626:0:lowPrice',
  trustTier: 'HIGH',
  parseStatus: 'PARSED',
  parsedPayload: {
    record: {
      sourceId: 'tcgapis',
      externalId: '530626',
      vertical: 'TRADING_CARD_GAME',
      property: 'Pokemon',
      set: 'Base Set',
      name: 'Charizard',
      number: '4',
      finish: 'UNKNOWN',
      currency: 'USD',
      amount: 12.5,
      basis: 'GUIDE',
      observedAt: OBSERVED_AT,
      sourceUrl: 'https://api.tcgapis.com/products/530626',
      license: 'public catalog data',
      attribution: 'TCGAPI public catalog',
    },
  },
  lineage: [],
  correctionOf: null,
  correctionReason: null,
};

const run: IngestRun = {
  id: 'run-evidence-integrity',
  sourceId: 'tcgapis',
  adapterId: 'tcgapis',
  mode: 'backfill',
  status: 'COMPLETED',
  startedAt: CAPTURED_AT,
  finishedAt: CAPTURED_AT,
  cursorIn: null,
  cursorOut: null,
  watermarkIn: null,
  watermarkOut: null,
  counts: { fetched: 1, created: 1, duplicates: 0, failed: 0, candidates: 1 },
  errors: [],
  meta: {},
};

test('promoted observation cites an evidence_records id, not the ledger id', async () => {
  const repos = createRepositories(createMemoryStore());
  const report = await promoteFreeFeedHarvest({
    sourceId: 'tcgapis',
    run,
    evidence: [ledgerEvidence],
    capturedAt: CAPTURED_AT,
    knownEvidenceIds: new Set<string>(),
    repositories: repos,
  });
  assert.equal(report.accepted, true, JSON.stringify([...report.reasons, ...report.errors]));

  const observations = await repos.marketObservations.list();
  assert.equal(observations.length, 1);
  const cited = observations[0]!.evidenceId;
  assert.notEqual(cited, LEDGER_ID, 'the ledger id is not a canonical evidence_records id');
  const evidence = await repos.evidence.get(cited);
  assert.ok(evidence, `promoted observation cites unresolvable evidence id ${cited}`);
  assert.equal(evidence.sourceRecordId, SOURCE_RECORD_ID);
  assert.equal(evidence.checksum, CHECKSUM);
});

test('synced observation cites the canonical evidence row matched by source and sourceRecordId', async () => {
  const repos = createRepositories(createMemoryStore());
  const report = await syncLedgerToPostgres(repos, {
    evidence: [{ ...ledgerEvidence } as unknown as Record<string, unknown>],
    observations: [{
      id: 'obs-ledger-1',
      evidenceId: LEDGER_ID,
      targetIdentityRef: 'card-charizard',
      basis: 'GUIDE',
      amount: 12.5,
      currency: 'USD',
      observedAt: OBSERVED_AT,
      status: 'NORMALIZED',
      lineage: [LEDGER_ID],
    }],
  });
  assert.deepEqual(report.errors, []);
  assert.equal(report.observations, 1);

  const observations = await repos.marketObservations.list();
  assert.equal(observations.length, 1);
  const cited = observations[0]!.evidenceId;
  const evidence = await repos.evidence.get(cited);
  assert.ok(evidence, `synced observation cites unresolvable evidence id ${cited}`);
  assert.equal(evidence.sourceRecordId, SOURCE_RECORD_ID);
  assert.equal(evidence.checksum, CHECKSUM);
});
