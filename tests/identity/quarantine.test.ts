// Task 16: low-confidence matches are quarantined before any canonical/FMV
// write; human QA decisions append provenance-carrying corrections and the
// approval is the only path that can release a quarantined proposal.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MarketBasis } from '../../server/contracts/dataProduct.ts';
import type { FreeFeedRecord } from '../../server/contracts/freeFeed.ts';
import { createRepositories, type Repositories } from '../../server/db/repositories/index.ts';
import { createMemoryStore } from '../../server/db/store.ts';
import type { IngestCandidate } from '../../server/ingest/types.ts';
import { promoteCandidates } from '../../server/ingest/promotion.ts';
import {
  createMatchReviewQueue,
  QaError,
  type MatchReviewQueue,
} from '../../server/identity/qaQueue.ts';
import { promoteToCanonical } from '../../server/identity/resolver.ts';
import { loadFacts } from '../../server/serving/market.ts';

const NOW = '2026-11-23T00:00:00.000Z';
const OBSERVED = '2026-11-22T10:00:00.000Z';
const CAPTURED = '2026-11-23T09:00:00.000Z';

interface Extra {
  title?: string;
  expectedAttributes?: Record<string, string>;
  confidenceFloor?: number;
  qaOverride?: string;
  repositories?: Repositories;
  now?: () => Date;
}

function fixture(
  overrides: Partial<FreeFeedRecord> = {},
  repos?: Repositories,
  extra: Extra = {},
): FreeFeedRecord {
  return {
    sourceId: 'marketplace',
    externalId: 'listing-1',
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
    sourceUrl: 'https://example.test/listing/1',
    license: 'listing terms',
    attribution: 'marketplace listing',
    capturedAt: CAPTURED,
    lineage: ['source:marketplace', 'record:listing-1'],
    confidence: 'LOW',
    repositories: repos,
    now: () => new Date(CAPTURED),
    ...extra,
    ...overrides,
  } as FreeFeedRecord;
}

function quarantined(repos?: Repositories): FreeFeedRecord {
  return fixture(
    {},
    repos,
    {
      title: 'Charizard #4 PSA 10 cert #87654321',
      expectedAttributes: {
        gradingCompany: 'PSA',
        numericGrade: '10',
        certNumber: '12345678',
        cardNumber: '4',
      },
      confidenceFloor: 0.75,
    },
  );
}

function corroborated(repos?: Repositories): FreeFeedRecord {
  return fixture(
    {},
    repos,
    {
      title: 'Charizard #4 PSA 10 cert #12345678',
      expectedAttributes: {
        gradingCompany: 'PSA',
        numericGrade: '10',
        certNumber: '12345678',
        cardNumber: '4',
      },
      confidenceFloor: 0.75,
    },
  );
}

test('a quarantined match writes no card, observation or identity decision', async () => {
  const repos = createRepositories(createMemoryStore());
  const report = await promoteToCanonical(quarantined(repos));

  assert.equal(report.accepted, false);
  assert.equal(report.quarantine?.decision, 'QUARANTINE');
  assert.deepEqual(report.quarantine?.conflicts, ['certNumber']);
  assert.ok(report.reasons.some((reason) => /QUARANTINE/i.test(reason)), report.reasons.join('; '));
  assert.equal(report.card, null);
  assert.equal(report.observation, null);
  assert.equal(report.identityDecision, null);
  assert.deepEqual(await repos.cards.list(), []);
  assert.deepEqual(await repos.marketObservations.list(), []);
  assert.deepEqual(await repos.identityDecisions.list(), []);
});

test('an arbitrary override string cannot release a quarantined match', async () => {
  const repos = createRepositories(createMemoryStore());
  const spoofed = {
    ...(quarantined(repos) as unknown as Record<string, unknown>),
    qaOverride: 'not-a-qa-correction',
  } as unknown as FreeFeedRecord;
  const report = await promoteToCanonical(spoofed);

  assert.equal(report.accepted, false);
  assert.equal(report.quarantine?.decision, 'QUARANTINE');
  assert.deepEqual(await repos.cards.list(), []);
  assert.deepEqual(await repos.marketObservations.list(), []);
});

test('a corroborated title promotes normally and records its hard-attribute provenance', async () => {
  const repos = createRepositories(createMemoryStore());
  const report = await promoteToCanonical(corroborated(repos));

  assert.equal(report.accepted, true, report.reasons.join('; '));
  assert.equal(report.quarantine?.decision, 'ACCEPT');
  assert.equal(report.observation?.amount, 1200);
  assert.equal(report.observation?.basis, 'ASKING');
  const components = (report.observation?.priceComponents ?? {}) as Record<string, unknown>;
  assert.equal(components.hardAttributeDisposition, 'ACCEPT');
  assert.equal(components.hardAttributeScore, report.quarantine?.score);
  const decisions = await repos.identityDecisions.list();
  assert.equal(decisions.length, 1);
  assert.deepEqual(decisions[0]!.scores.hardAttributes, report.quarantine);
});

test('ledger promotion skips quarantined priced candidates and never promotes them', async () => {
  const repos = createRepositories(createMemoryStore());
  const lowConfidence = {
    evidenceId: 'ev-low',
    targetIdentityRef: 'card-1',
    basis: 'ASKING' as MarketBasis,
    amount: 300,
    currency: 'USD',
    observedAt: OBSERVED,
    status: 'RAW' as const,
    parseStatus: 'PARSED' as const,
    sourceId: 'marketplace',
    capturedAt: CAPTURED,
    lineage: ['ev-low'],
    confidence: 'LOW' as const,
    warnings: [],
    priceComponents: { title: 'vintage mystery slab 7' },
  } satisfies IngestCandidate;
  const clean: IngestCandidate = {
    ...lowConfidence,
    evidenceId: 'ev-clean',
    priceComponents: {},
  };
  const result = await promoteCandidates({
    candidates: { list: async () => [lowConfidence, clean] },
    marketObservations: repos.marketObservations,
  }, { now: new Date(CAPTURED) });

  assert.deepEqual(result.quarantined, ['cand-ev-low:card-1:ASKING:300']);
  assert.equal(result.promoted, 1);
  assert.ok(!result.unpromotedPriced.includes('cand-ev-low:card-1:ASKING:300'));
  const observations = await repos.marketObservations.list();
  assert.equal(observations.length, 1);
  assert.equal(observations[0]!.evidenceId, 'ev-clean');
});

test('FMV facts exclude any observation marked as a hard-attribute quarantine', async () => {
  const clean = {
    id: 'obs-clean', evidenceId: 'ev-clean', targetIdentityRef: 'card-1',
    basis: 'ASKING' as MarketBasis, amount: 100, currency: 'USD',
    observedAt: OBSERVED, status: 'RAW' as const,
    priceComponents: {},
  };
  const leaked = {
    ...clean, id: 'obs-quarantined', evidenceId: 'ev-low', amount: 999999,
    priceComponents: { hardAttributeDisposition: 'QUARANTINE' },
  };
  const { facts, warnings } = await loadFacts(
    { list: async () => [clean, leaked] } as never,
    { get: async () => null } as never,
    'card-1',
  );

  assert.deepEqual(facts.map((fact) => fact.id), ['obs-clean']);
  assert.ok(warnings.some((warning) => /quarantine/i.test(warning)), warnings.join('; '));
});

test('the QA queue only accepts quarantined matches and records append-only corrections', async () => {
  const repos = createRepositories(createMemoryStore());
  const qa: MatchReviewQueue = createMatchReviewQueue({
    repositories: repos,
    now: () => new Date(NOW),
    floor: 0.75,
  });

  await assert.rejects(
    () => qa.enqueue(corroborated(repos)),
    (error: unknown) => error instanceof QaError && error.code === 'not_quarantinable',
  );

  const queued = await qa.enqueue(quarantined(repos));
  assert.equal(queued.status, 'PENDING');
  assert.equal(queued.assessment.decision, 'QUARANTINE');
  assert.deepEqual(queued.assessment.conflicts, ['certNumber']);
  assert.equal(queued.provenance.evidenceId, 'marketplace:listing-1');
  assert.deepEqual(await qa.list({ status: 'PENDING' }), [queued]);
  assert.equal((await qa.enqueue(quarantined(repos))).id, queued.id, 'enqueue is idempotent');

  const rejected = await qa.review(queued.id, 'REJECT', {
    reviewer: 'operator-1', note: 'certificate mismatch',
  });
  assert.ok(rejected, 'an existing pending candidate must be reviewable');
  assert.equal(rejected.candidate.status, 'REJECTED');
  assert.equal(rejected.canonical, null);
  assert.equal(rejected.correction.action, 'REJECT');
  assert.equal(rejected.correction.reviewer, 'operator-1');
  assert.equal(rejected.correction.note, 'certificate mismatch');
  assert.equal(rejected.correction.decidedAt, NOW);
  assert.equal(rejected.correction.provenance.evidenceId, 'marketplace:listing-1');
  assert.equal(rejected.correction.provenance.basis, 'ASKING');
  assert.deepEqual(rejected.correction.provenance.lineage, ['source:marketplace', 'record:listing-1']);
  assert.deepEqual(await repos.cards.list(), []);
  assert.deepEqual(await repos.marketObservations.list(), []);

  const before = await qa.listCorrections();
  assert.equal(before.length, 1);
  (before[0] as { note: string | null }).note = 'mutated';
  assert.equal((await qa.listCorrections())[0]!.note, 'certificate mismatch', 'corrections are immutable');
  await assert.rejects(
    () => qa.review(queued.id, 'APPROVE', { reviewer: 'operator-2' }),
    (error: unknown) => error instanceof QaError && error.code === 'already_reviewed',
  );
});

test('QA approval is the only release path and writes one audited canonical observation', async () => {
  const repos = createRepositories(createMemoryStore());
  const qa = createMatchReviewQueue({ repositories: repos, now: () => new Date(NOW), floor: 0.75 });
  const queued = await qa.enqueue(quarantined(repos));

  const before = await promoteToCanonical(quarantined(repos));
  assert.equal(before.accepted, false, 'the same proposal is blocked before approval');

  const approved = await qa.review(queued.id, 'APPROVE', {
    reviewer: 'operator-2', note: 'verified certificate against issuer',
  });
  assert.ok(approved, 'an existing pending candidate must be reviewable');
  assert.equal(approved.candidate.status, 'APPROVED');
  assert.equal(approved.correction.action, 'APPROVE');
  assert.equal(approved.canonical?.accepted, true, approved.canonical?.reasons.join('; '));
  assert.equal(approved.canonical?.observation?.amount, 1200);

  const corrections = await qa.listCorrections({ candidateId: queued.id });
  assert.equal(corrections.length, 1);
  assert.equal(corrections[0]!.id, approved.correction.id);
  assert.match(corrections[0]!.id, /^qa-cor-/);
  assert.equal(corrections[0]!.previousCorrectionId, null);
  const decisions = await repos.identityDecisions.list();
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0]!.scores.qaCorrectionId, approved.correction.id);
  assert.equal((await repos.marketObservations.list()).length, 1);

  // An approved observation must be usable by FMV: its disposition is the
  // human correction, not the original quarantine flag.
  const observation = approved.canonical!.observation!;
  const components = observation.priceComponents as Record<string, unknown>;
  assert.equal(components.hardAttributeDisposition, 'QA_APPROVED');
  assert.equal(components.qaCorrectionId, approved.correction.id);
  const canonicalRow = observation as unknown as Record<string, unknown>;
  const { facts } = await loadFacts(
    // Canonical SQL rows persist the ref as target_identity_id; serving reads
    // the ledger-shaped field, so normalize the shape for this FMV probe.
    { list: async () => [{ ...observation, targetIdentityRef: canonicalRow.targetIdentityId }] } as never,
    { get: async () => null } as never,
    String(canonicalRow.targetIdentityId),
  );
  assert.equal(facts.length, 1, 'an approved match reaches FMV facts');

  await assert.rejects(
    () => qa.review(queued.id, 'APPROVE', { reviewer: 'operator-3' }),
    (error: unknown) => error instanceof QaError && error.code === 'already_reviewed',
  );
});

test('a failed canonical commit leaves the QA candidate pending with no correction', async () => {
  const store = createMemoryStore();
  const base = createRepositories(store);
  const failing: Repositories = {
    ...base,
    marketObservations: {
      ...base.marketObservations,
      async create() {
        throw new Error('observation table unavailable');
      },
    },
    transaction: async <T>(fn: (tx: Repositories) => Promise<T>): Promise<T> =>
      store.transaction(() => fn(failing)),
  };
  const qa = createMatchReviewQueue({ repositories: failing, now: () => new Date(NOW) });
  const queued = await qa.enqueue(quarantined(failing));

  await assert.rejects(
    () => qa.review(queued.id, 'APPROVE', { reviewer: 'operator-1' }),
    (error: unknown) => error instanceof QaError && error.code === 'canonical_failed',
  );
  assert.equal((await qa.get(queued.id))?.status, 'PENDING');
  assert.deepEqual(await qa.listCorrections(), []);
  assert.deepEqual(await base.cards.list(), []);
});
