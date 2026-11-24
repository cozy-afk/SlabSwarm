import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { WebHarvestCandidate } from '../../server/contracts/webHarvest.ts';
import { createRepositories } from '../../server/db/repositories/index.ts';
import { createMemoryStore } from '../../server/db/store.ts';
import { createWebHarvestStore } from '../../server/webharvest/store.ts';
import { seedCanonicalEvidence } from '../identity/evidence-fixture.ts';

const SOURCE = {
  id: 'fixture-source',
  name: 'Fixture Public Source',
  url: 'https://example.invalid/catalog.json',
  kind: 'json' as const,
  enabled: true,
  license: 'CC-BY-4.0',
  respectRobots: true,
  rateLimitMs: 1000,
};

function candidate(overrides: Partial<WebHarvestCandidate> = {}): WebHarvestCandidate {
  return {
    id: 'cand-1',
    sourceId: 'fixture-source',
    evidenceId: 'ev-1',
    name: 'Arcane Artifact',
    set: 'Base Set',
    game: 'Arcane TCG',
    number: '001',
    basis: 'ASKING',
    amount: 42.5,
    currency: 'USD',
    observedAt: '2026-11-20T10:00:00.000Z',
    capturedAt: '2026-11-20T10:05:00.000Z',
    license: 'CC-BY-4.0',
    confidence: 'LOW',
    warnings: ['price guide, not a sale'],
    ...overrides,
  };
}

function fixture(options: { sources?: typeof SOURCE[] } = {}) {
  const repositories = createRepositories(createMemoryStore());
  const store = createWebHarvestStore({
    sources: options.sources ?? [SOURCE],
    repositories,
  });
  return { store, repositories };
}

test('review queue starts empty and exposes the injected operator allowlist', async () => {
  const { store } = fixture();
  assert.deepEqual(await store.listSources(), [SOURCE]);
  assert.deepEqual(await store.listCandidates(), []);
});

test('enqueue stores a PENDING candidate with its provenance and is idempotent', async () => {
  const { store } = fixture();
  const input = candidate();
  const first = await store.enqueue(input);
  assert.equal(first.status, 'PENDING');
  assert.equal(first.sourceId, 'fixture-source');
  assert.equal(first.evidenceId, 'ev-1');
  assert.equal(first.observedAt, '2026-11-20T10:00:00.000Z');
  assert.equal(first.capturedAt, '2026-11-20T10:05:00.000Z');
  assert.equal(first.basis, 'ASKING');
  assert.equal(first.currency, 'USD');
  assert.equal(first.confidence, 'LOW');
  assert.deepEqual(first.warnings, ['price guide, not a sale']);

  const again = await store.enqueue(input);
  assert.equal(again.id, first.id);
  assert.equal((await store.listCandidates()).length, 1);
});

test('no approval means no canonical card or observation write', async () => {
  const { store, repositories } = fixture();
  await store.enqueue(candidate());
  assert.equal((await store.listCandidates({ status: 'PENDING' })).length, 1);
  assert.deepEqual(await repositories.cards.list(), []);
  assert.deepEqual(await repositories.marketObservations.list(), []);
});

test('approval writes one LOW-confidence card and one evidence-backed observation with candidate provenance', async () => {
  const { store, repositories } = fixture();
  const canonicalId = await seedCanonicalEvidence(repositories, SOURCE.id, 'ev-1');
  const queued = await store.enqueue(candidate({ confidence: 'MEDIUM' }));

  const result = await store.review(queued.id, 'APPROVE', 'checked against source');
  assert.ok(result);
  assert.equal(result.candidate.status, 'APPROVED');
  assert.equal(result.candidate.reviewNote, 'checked against source');
  assert.ok(result.candidate.reviewedAt);

  const cards = await repositories.cards.list();
  const observations = await repositories.marketObservations.list();
  assert.equal(cards.length, 1);
  assert.equal(observations.length, 1);

  const card = cards[0] as unknown as Record<string, unknown>;
  const facets = card.facets as Record<string, any>;
  assert.equal(card.name, 'Arcane Artifact');
  assert.equal(facets.confidence, 'LOW');
  assert.equal(facets.source, 'fixture-source');
  assert.equal(facets.game, 'Arcane TCG');
  assert.equal(facets.set, 'Base Set');
  assert.equal(facets.number, '001');
  assert.equal(facets.basis, 'ASKING');
  assert.equal(facets.currency, 'USD');
  assert.equal(facets.observed_at, '2026-11-20T10:00:00.000Z');
  assert.equal(facets.captured_at, '2026-11-20T10:05:00.000Z');
  assert.deepEqual(facets.lineage, [
    'web-harvest',
    'source:fixture-source',
    'evidence:ev-1',
  ]);
  assert.equal(facets.reportedConfidence, 'MEDIUM');

  const observation = observations[0] as unknown as Record<string, unknown>;
  assert.equal(observation.evidenceId, canonicalId);
  assert.ok(await repositories.evidence.get(observation.evidenceId as string));
  assert.equal(observation.targetIdentityId, card.id);
  assert.equal(observation.basis, 'ASKING');
  assert.equal(observation.amount, 42.5);
  assert.equal(observation.currency, 'USD');
  assert.equal(observation.observedAt, '2026-11-20T10:00:00.000Z');
  assert.equal(observation.marketplace, 'fixture-source');
  const components = observation.priceComponents as Record<string, any>;
  assert.equal(components.source, 'fixture-source');
  assert.equal(components.observed_at, '2026-11-20T10:00:00.000Z');
  assert.equal(components.captured_at, '2026-11-20T10:05:00.000Z');
  assert.deepEqual(components.lineage, [
    'web-harvest',
    'source:fixture-source',
    'evidence:ev-1',
  ]);
  assert.equal(components.confidence, 'LOW');
  assert.equal(components.reportedConfidence, 'MEDIUM');

  assert.equal(result.provenance.source, 'fixture-source');
  assert.equal(result.provenance.confidence, 'LOW');
  assert.deepEqual((await store.listCandidates({ status: 'APPROVED' })).map((c) => c.id), [queued.id]);
});

test('rejection removes the candidate from the pending queue and writes nothing canonical', async () => {
  const { store, repositories } = fixture();
  const queued = await store.enqueue(candidate({ id: 'cand-reject', evidenceId: 'ev-reject' }));
  const result = await store.review(queued.id, 'REJECT', 'basis unsupported');

  assert.ok(result);
  assert.equal(result.candidate.status, 'REJECTED');
  assert.equal(result.candidate.reviewNote, 'basis unsupported');
  assert.equal(result.card, null);
  assert.equal(result.observation, null);
  assert.equal((await store.listCandidates({ status: 'PENDING' })).length, 0);
  assert.deepEqual(await repositories.cards.list(), []);
  assert.deepEqual(await repositories.marketObservations.list(), []);
});

test('approval fails closed when no unique canonical evidence row exists', async () => {
  const { store, repositories } = fixture();
  const queued = await store.enqueue(candidate({
    id: 'cand-unresolved', evidenceId: 'ev-unresolved', name: 'Unresolved Evidence Card',
  }));
  await assert.rejects(
    () => store.review(queued.id, 'APPROVE'),
    /canonical evidence/i,
    'an unresolvable candidate id must never become a canonical observation',
  );
  assert.equal((await store.listCandidates({ status: 'PENDING' })).length, 1);
  assert.deepEqual(await repositories.cards.list(), []);
  assert.deepEqual(await repositories.marketObservations.list(), []);
});

test('a decided candidate cannot be reviewed a second time', async () => {
  const { store } = fixture();
  const queued = await store.enqueue(candidate());
  await store.review(queued.id, 'REJECT');
  await assert.rejects(() => store.review(queued.id, 'APPROVE'), /already been reviewed/i);
});

test('missing basis or amount writes the LOW-confidence card but no invented observation', async () => {
  const { store, repositories } = fixture();
  for (const reference of ['ev-unknown-amount', 'ev-unknown-basis']) {
    await seedCanonicalEvidence(repositories, SOURCE.id, reference);
  }
  const noAmount = await store.enqueue(candidate({
    id: 'cand-unknown-amount',
    evidenceId: 'ev-unknown-amount',
    name: 'Unknown Amount Card',
    amount: 'UNKNOWN',
  }));
  const noBasis = await store.enqueue(candidate({
    id: 'cand-unknown-basis',
    evidenceId: 'ev-unknown-basis',
    name: 'Unknown Basis Card',
    basis: 'UNKNOWN',
  }));

  await store.review(noAmount.id, 'APPROVE');
  await store.review(noBasis.id, 'APPROVE');

  const cards = await repositories.cards.list();
  const observations = await repositories.marketObservations.list();
  assert.equal(cards.length, 2);
  assert.equal(observations.length, 0);
  for (const card of cards) {
    assert.equal((card.facets as Record<string, unknown>).confidence, 'LOW');
  }
});

test('approval of an unknown candidate returns null without writing anything', async () => {
  const { store, repositories } = fixture();
  assert.equal(await store.review('missing', 'APPROVE'), null);
  assert.deepEqual(await repositories.cards.list(), []);
  assert.deepEqual(await repositories.marketObservations.list(), []);
});
