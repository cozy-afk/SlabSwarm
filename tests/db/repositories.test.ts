import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMemoryStore } from '../../server/db/store.ts';
import { createRepositories } from '../../server/db/repositories/index.ts';
import { ValidationError } from '../../server/db/validation.ts';
import type {
  EvidenceRecordInput,
  MarketObservationInput,
  RepositoryBundle,
} from '../../server/contracts/dataProduct.ts';

function evidence(overrides: Partial<EvidenceRecordInput> = {}): EvidenceRecordInput {
  return {
    sourceId: 'legacy-sales',
    sourceRecordId: 'sale-1',
    sourceUri: 'file://slabgraph-db.json#sales/0',
    capturedAt: '2026-11-22T10:00:00.000Z',
    observedAt: '2026-11-20T09:00:00.000Z',
    checksum: 'sha256:abc',
    mimeType: 'application/json',
    license: 'first-party',
    rawRef: 'raw_payloads/sale-1',
    parsedPayload: { priceUsd: 100 },
    trustTier: 'MEDIUM',
    ...overrides,
  };
}

function observation(overrides: Partial<MarketObservationInput> = {}): MarketObservationInput {
  return {
    evidenceId: 'evidence-1',
    targetIdentityRef: 'card-1',
    basis: 'SOLD',
    amount: 120,
    currency: 'USD',
    marketplace: 'ebay',
    observedAt: '2026-11-21T00:00:00.000Z',
    priceComponents: { listed_amount: 100, shipping_amount: 20 },
    ...overrides,
  };
}

test('evidence repository creates, gets and lists records using shared contract types', async () => {
  const repos = createRepositories(createMemoryStore());
  const created = await repos.evidence.create(evidence());
  assert.ok(created.id, 'created evidence must have an id');
  assert.equal(created.parseStatus, 'PENDING');
  assert.equal(created.sourceRecordId, 'sale-1');
  assert.deepEqual(created.parsedPayload, { priceUsd: 100 });
  assert.equal((await repos.evidence.get(created.id))?.id, created.id);
  assert.equal((await repos.evidence.list({ sourceId: 'legacy-sales' })).length, 1);
  assert.equal((await repos.evidence.list({ sourceId: 'other' })).length, 0);
  assert.equal(await repos.evidence.get('missing'), null);
});

test('evidence repository rejects records without a source key or checksum', async () => {
  const repos = createRepositories(createMemoryStore());
  await assert.rejects(
    repos.evidence.create(evidence({ sourceRecordId: '' })),
    ValidationError,
  );
  await assert.rejects(repos.evidence.create(evidence({ checksum: '' })), ValidationError);
});

test('evidence upsert is idempotent by source, native record and checksum', async () => {
  const repos = createRepositories(createMemoryStore());
  const first = await repos.evidence.upsert(evidence());
  const second = await repos.evidence.upsert(
    evidence({ parsedPayload: { priceUsd: 130 }, observedAt: '2026-11-22T00:00:00.000Z' }),
  );
  assert.equal(first.id, second.id, 'upsert of the same source key must not duplicate');
  assert.deepEqual(second.parsedPayload, { priceUsd: 130 });
  assert.equal((await repos.evidence.list()).length, 1);
});

test('market observation repository requires an explicit valid basis', async () => {
  const repos = createRepositories(createMemoryStore());
  const missing = observation();
  delete (missing as Partial<MarketObservationInput>).basis;
  await assert.rejects(repos.marketObservations.create(missing), ValidationError);
  await assert.rejects(
    repos.marketObservations.create(observation({ basis: 'MADE_UP' as never })),
    ValidationError,
  );
  const explicitUnknown = await repos.marketObservations.create(
    observation({ basis: 'UNKNOWN', priceComponents: undefined }),
  );
  assert.equal(explicitUnknown.basis, 'UNKNOWN');
});

test('market observation repository does not default missing price components to zero', async () => {
  const repos = createRepositories(createMemoryStore());
  const created = await repos.marketObservations.create(observation({ priceComponents: undefined }));
  assert.notEqual(
    (created.priceComponents as Record<string, unknown> | undefined)?.shipping_amount,
    0,
    'missing shipping must not become zero',
  );
  assert.ok(created.priceComponents == null, 'missing components must stay UNKNOWN');
  const unknownBasis = await repos.marketObservations.create(
    observation({ basis: 'UNKNOWN', currency: 'EUR', marketplace: null }),
  );
  assert.equal(unknownBasis.marketplace, null);
  assert.equal(unknownBasis.amount, 120);
});

test('market observation repository rejects non-finite amounts', async () => {
  const repos = createRepositories(createMemoryStore());
  await assert.rejects(
    repos.marketObservations.create(observation({ amount: Number.NaN })),
    ValidationError,
  );
  await assert.rejects(
    repos.marketObservations.create(observation({ amount: -1 })),
    ValidationError,
  );
});

test('market observation list filters by basis/status/target and sorts newest first', async () => {
  const repos = createRepositories(createMemoryStore());
  await repos.marketObservations.create(
    observation({ basis: 'SOLD', status: 'NORMALIZED', targetIdentityRef: 'card-1', observedAt: '2026-11-01T00:00:00.000Z' }),
  );
  await repos.marketObservations.create(
    observation({ basis: 'ASKING', status: 'RAW', targetIdentityRef: 'card-2', observedAt: '2026-11-22T00:00:00.000Z' }),
  );
  const all = await repos.marketObservations.list();
  assert.equal(all[0].observedAt, '2026-11-22T00:00:00.000Z');
  assert.equal((await repos.marketObservations.list({ basis: 'ASKING' })).length, 1);
  assert.equal((await repos.marketObservations.list({ status: 'NORMALIZED' })).length, 1);
  assert.equal((await repos.marketObservations.list({ targetIdentityRef: 'card-2' })).length, 1);
});

test('card repository preserves JSONB facets and upserts by identity key', async () => {
  const repos = createRepositories(createMemoryStore());
  const first = await repos.cards.create({
    name: 'Charizard',
    identityKey: 'base-1-4',
    setId: 'base',
    cardNumber: '4',
    facets: { grade: 'PSA 10', language: 'EN' },
    rawPayload: { title: 'Charizard 1st Edition' },
  });
  const second = await repos.cards.upsert({
    name: 'Charizard',
    identityKey: 'base-1-4',
    facets: { grade: 'PSA 9' },
  });
  assert.equal(first.id, second.id);
  assert.deepEqual(second.facets, { grade: 'PSA 9' });
  assert.deepEqual((await repos.cards.get(first.id))?.rawPayload, {
    title: 'Charizard 1st Edition',
  });
  assert.equal((await repos.cards.list({ cardNumber: '4' })).length, 1);
});

test('forecast repository stores contract forecast bands and status', async () => {
  const repos = createRepositories(createMemoryStore());
  const created = await repos.forecasts.create({
    targetType: 'CARD',
    targetId: 'card-1',
    horizonDays: 30,
    scenario: 'baseline',
    priceBands: { low: 90, base: 120, high: 160, currency: 'USD' },
    demandPressure: 'MEDIUM',
    supplyPressure: 'LOW',
    drivers: ['pop report'],
    invalidators: ['reprint'],
    evidenceIds: ['evidence-1'],
    confidence: 'MEDIUM',
  });
  assert.equal(created.status, 'HYPOTHESIS');
  assert.equal(created.priceBands.base, 120);
  assert.equal((await repos.forecasts.get(created.id))?.horizonDays, 30);
  assert.equal((await repos.forecasts.list({ targetId: 'card-1' })).length, 1);
  const updated = await repos.forecasts.upsert({ ...created, status: 'SCORED' });
  assert.equal(updated.status, 'SCORED');
});

test('learning and jobs repositories provide typed create/get/list/upsert', async () => {
  const repos = createRepositories(createMemoryStore());
  const event = await repos.learning.create({
    kind: 'SOURCE_TRUST_UPDATE',
    targetId: 'legacy-sales',
    score: 0.8,
    payload: { sampleSize: 21 },
  });
  assert.equal(event.kind, 'SOURCE_TRUST_UPDATE');
  assert.equal((await repos.learning.get(event.id))?.score, 0.8);
  assert.equal((await repos.learning.list({ kind: 'SOURCE_TRUST_UPDATE' })).length, 1);

  const job = await repos.jobs.create({ kind: 'BACKFILL', payload: { source: 'slabgraph-db.json' } });
  assert.equal(job.status, 'PENDING');
  assert.equal((await repos.jobs.get(job.id))?.kind, 'BACKFILL');
  assert.equal((await repos.jobs.list({ status: 'PENDING' })).length, 1);
  const claimed = await repos.jobs.upsert({ ...job, status: 'RUNNING', attempts: 1 });
  assert.equal(claimed.status, 'RUNNING');
  assert.equal(claimed.attempts, 1);
});

test('repository bundle satisfies the shared contract shape verbatim', () => {
  const bundle: RepositoryBundle = createRepositories(createMemoryStore());
  for (const key of ['create', 'get', 'list'] as const) {
    assert.equal(typeof bundle.evidence[key], 'function');
    assert.equal(typeof bundle.marketObservations[key], 'function');
  }
});
