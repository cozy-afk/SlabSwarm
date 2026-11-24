// A-01 round-1 review: any caller of promoteToCanonical — including QA APPROVE
// re-approval — must write an observation whose evidence_id resolves in
// evidence_records. Resolution happens at the persistence boundary, not only
// when the free-feed harvest shim supplies a canonical id.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRepositories } from '../../server/db/repositories/index.ts';
import { createMemoryStore } from '../../server/db/store.ts';
import { createMatchReviewQueue } from '../../server/identity/qaQueue.ts';

const OBSERVED_AT = '2026-11-22T10:00:00.000Z';
const CAPTURED_AT = '2026-11-23T09:00:00.000Z';
const LEDGER_ID = 'ev-3a2f6d5c-1111-4bbb-8ddd-000000000001';
const SOURCE_RECORD_ID = 'listing:qa:530626';
const EXTERNAL_ID = 'listing-530626';

test('QA APPROVE re-promotion resolves canonical evidence from exact provenance', async () => {
  const repos = createRepositories(createMemoryStore());
  // Canonical evidence was projected earlier from the immutable ledger row:
  // same sourceId, sourceRecordId, checksum and parsedPayload.record.externalId.
  const canonical = await repos.evidence.create({
    sourceId: 'marketplace',
    sourceRecordId: SOURCE_RECORD_ID,
    checksum: 'sha256-qa-listing-530626',
    capturedAt: CAPTURED_AT,
    observedAt: OBSERVED_AT,
    mimeType: 'application/json',
    rawRef: `ingest://marketplace/${SOURCE_RECORD_ID}`,
    parsedPayload: { record: { externalId: EXTERNAL_ID } },
  });

  const qa = createMatchReviewQueue({ repositories: repos, now: () => new Date(CAPTURED_AT), floor: 0.75 });
  const queued = await qa.enqueue({
    sourceId: 'marketplace',
    externalId: EXTERNAL_ID,
    vertical: 'SPORTS_CARD',
    property: 'Pokemon',
    set: 'Base Set',
    name: 'Charizard',
    number: '4',
    finish: 'UNKNOWN',
    currency: 'USD',
    amount: 1200,
    basis: 'ASKING',
    observedAt: OBSERVED_AT,
    sourceUrl: 'https://example.test/listing/530626',
    license: 'listing terms',
    attribution: 'marketplace listing',
    capturedAt: CAPTURED_AT,
    lineage: ['source:marketplace', `run:run-1`, `evidence:${LEDGER_ID}`],
    confidence: 'LOW',
    title: 'Charizard #4 PSA 10 cert #87654321',
    expectedAttributes: {
      gradingCompany: 'PSA', numericGrade: '10', certNumber: '12345678', cardNumber: '4',
    },
    confidenceFloor: 0.75,
  } as never);
  assert.equal(queued.status, 'PENDING');

  const approved = await qa.review(queued.id, 'APPROVE', { reviewer: 'operator-1' });
  assert.ok(approved, 'the queued match exists');
  assert.equal(approved.canonical?.accepted, true, approved.canonical?.reasons.join('; '));

  const observations = await repos.marketObservations.list();
  assert.equal(observations.length, 1);
  const cited = observations[0]!.evidenceId;
  assert.equal(cited, canonical.id, 'the boundary must resolve the canonical id, never sourceId:externalId');
  const resolved = await repos.evidence.get(cited);
  assert.ok(resolved, `QA re-promotion cites unresolvable evidence id ${cited}`);
  assert.equal(resolved.sourceRecordId, SOURCE_RECORD_ID);
});
