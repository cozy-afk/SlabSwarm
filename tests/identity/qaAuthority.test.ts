// Task 16 round 1 review fixes:
//  (1) a server-side gate must enqueue its own QA review item;
//  (2) release authority must be server-issued, never proposal-supplied.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MarketBasis } from '../../server/contracts/dataProduct.ts';
import type { FreeFeedRecord } from '../../server/contracts/freeFeed.ts';
import { createRepositories } from '../../server/db/repositories/index.ts';
import { createMemoryStore } from '../../server/db/store.ts';
import { promoteCandidates } from '../../server/ingest/promotion.ts';
import type { IngestCandidate } from '../../server/ingest/types.ts';
import { createMatchReviewQueue } from '../../server/identity/qaQueue.ts';
import { promoteToCanonical } from '../../server/identity/resolver.ts';

const NOW = '2026-11-23T00:00:00.000Z';
const OBSERVED = '2026-11-22T10:00:00.000Z';
const CAPTURED = '2026-11-23T09:00:00.000Z';
const FORGED_ID = 'qa-cor-0123456789abcdef';

function quarantined(): FreeFeedRecord {
  return {
    sourceId: 'marketplace',
    externalId: 'listing-auto',
    vertical: 'SPORTS_CARD',
    property: 'Pokemon',
    set: 'Base Set',
    name: 'Charizard',
    number: '4',
    finish: 'UNKNOWN',
    currency: 'USD',
    amount: 1200,
    basis: 'ASKING' as MarketBasis,
    observedAt: OBSERVED,
    sourceUrl: 'https://example.test/listing/auto',
    license: 'listing terms',
    attribution: 'marketplace listing',
    capturedAt: CAPTURED,
    lineage: ['source:marketplace', 'record:listing-auto'],
    confidence: 'LOW',
    title: 'Charizard #4 PSA 10 cert #87654321',
    expectedAttributes: {
      gradingCompany: 'PSA', numericGrade: '10',
      certNumber: '12345678', cardNumber: '4',
    },
    confidenceFloor: 0.75,
  } as FreeFeedRecord;
}

function lowConfidenceCandidate(): IngestCandidate {
  return {
    evidenceId: 'ev-auto',
    targetIdentityRef: 'card-1',
    basis: 'ASKING' as MarketBasis,
    amount: 300,
    currency: 'USD',
    observedAt: OBSERVED,
    status: 'RAW',
    parseStatus: 'PARSED',
    sourceId: 'marketplace',
    capturedAt: CAPTURED,
    lineage: ['ev-auto'],
    confidence: 'LOW',
    warnings: [],
    priceComponents: { title: 'vintage mystery slab 7' },
  };
}

test('a quarantined canonical promotion automatically creates a QA review item', async () => {
  const repos = createRepositories(createMemoryStore());
  const qa = createMatchReviewQueue({ repositories: repos, now: () => new Date(NOW), floor: 0.75 });
  qa.attachToHost();
  try {
    const report = await promoteToCanonical(quarantined() as FreeFeedRecord & { repositories?: unknown });
    assert.equal(report.accepted, false);
    assert.equal(report.quarantine?.decision, 'QUARANTINE');

    const queue = await qa.list({ status: 'PENDING' });
    assert.equal(queue.length, 1, 'the gate must enqueue, not just return a reason string');
    assert.equal(report.quarantineReviewId, queue[0]!.id);
    assert.equal(queue[0]!.origin, 'GATE');
    assert.equal((queue[0]!.proposal as unknown as Record<string, unknown>).title,
      (quarantined() as unknown as Record<string, unknown>).title);
    assert.deepEqual(queue[0]!.assessment, report.quarantine);
    assert.equal(queue[0]!.provenance.evidenceId, 'marketplace:listing-auto');
    assert.deepEqual(await repos.cards.list(), []);
  } finally {
    qa.detachFromHost();
  }
});

test('a quarantined ledger candidate automatically creates a QA review item', async () => {
  const repos = createRepositories(createMemoryStore());
  const qa = createMatchReviewQueue({ repositories: repos, now: () => new Date(NOW), floor: 0.75 });
  qa.attachToHost();
  try {
    const result = await promoteCandidates({
      candidates: { list: async () => [lowConfidenceCandidate()] },
      marketObservations: repos.marketObservations,
    });
    assert.equal(result.quarantined.length, 1);
    assert.equal(result.qaReviewIds.length, 1, 'the ledger gate must enqueue too');
    const queue = await qa.list({ status: 'PENDING' });
    assert.equal(queue.length, 1);
    assert.equal(queue[0]!.id, result.qaReviewIds[0]);
    assert.equal(queue[0]!.title, 'vintage mystery slab 7');
    assert.equal(queue[0]!.origin, 'GATE');
    assert.deepEqual(await repos.marketObservations.list(), []);
  } finally {
    qa.detachFromHost();
  }
});

test('an upstream proposal with a well-formed qaOverride cannot release quarantine', async () => {
  const repos = createRepositories(createMemoryStore());
  const forged = {
    ...(quarantined() as unknown as Record<string, unknown>),
    qaOverride: FORGED_ID,
    repositories: repos,
  } as unknown as FreeFeedRecord;

  const report = await promoteToCanonical(forged);
  assert.equal(report.accepted, false, 'proposal-supplied authority must be ignored');
  assert.equal(report.quarantine?.decision, 'QUARANTINE');
  assert.deepEqual(await repos.cards.list(), []);
  assert.deepEqual(await repos.marketObservations.list(), []);
});

test('a well-formed authority id with no recorded human APPROVE cannot release quarantine', async () => {
  const repos = createRepositories(createMemoryStore());
  const report = await promoteToCanonical({
    ...(quarantined() as unknown as Record<string, unknown>),
    repositories: repos,
  } as unknown as FreeFeedRecord, { approvalAuthority: FORGED_ID });
  assert.equal(report.accepted, false, 'an unissued host authority must be rejected');
  assert.equal(report.quarantine?.decision, 'QUARANTINE');
  assert.deepEqual(await repos.cards.list(), []);
});

test('a REJECT correction id is not approval authority', async () => {
  const repos = createRepositories(createMemoryStore());
  const qa = createMatchReviewQueue({ repositories: repos, now: () => new Date(NOW), floor: 0.75 });
  qa.attachToHost();
  try {
    await promoteToCanonical(quarantined());
    const queued = (await qa.list({ status: 'PENDING' }))[0]!;
    const rejected = await qa.review(queued.id, 'REJECT', { reviewer: 'operator-1' });
    assert.ok(rejected);
    assert.equal(rejected.correction.action, 'REJECT');

    // The same well-formed id now exists server-side, but it records a REJECT.
    const report = await promoteToCanonical({
      ...(quarantined() as unknown as Record<string, unknown>),
      repositories: repos,
    } as unknown as FreeFeedRecord, { approvalAuthority: rejected.correction.id });
    assert.equal(report.accepted, false);
    assert.deepEqual(await repos.cards.list(), []);
  } finally {
    qa.detachFromHost();
  }
});

test('the internal review path issues real authority and records its correction', async () => {
  const repos = createRepositories(createMemoryStore());
  const qa = createMatchReviewQueue({ repositories: repos, now: () => new Date(NOW), floor: 0.75 });
  qa.attachToHost();
  try {
    await promoteToCanonical(quarantined());
    const queued = (await qa.list({ status: 'PENDING' }))[0]!;
    const approved = await qa.review(queued.id, 'APPROVE', { reviewer: 'operator-2' });
    assert.ok(approved);
    assert.equal(approved.canonical?.accepted, true, approved.canonical?.reasons.join('; '));
    const decisions = await repos.identityDecisions.list();
    assert.equal(decisions[0]!.scores.qaCorrectionId, approved.correction.id);
    const corrections = await qa.listCorrections({ candidateId: queued.id });
    assert.equal(corrections[0]!.action, 'APPROVE');
    assert.equal(corrections[0]!.canonical?.accepted, true);
  } finally {
    qa.detachFromHost();
  }
});
