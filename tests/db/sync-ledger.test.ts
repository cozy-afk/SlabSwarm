import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRepositories } from '../../server/db/repositories/index.ts';
import { createMemoryStore } from '../../server/db/store.ts';
import { syncLedgerToPostgres } from '../../server/db/sync.ts';

const evidence = [
  {
    id: 'ev-1',
    sourceId: 'tcgapis',
    sourceRecordId: 'tcg:card:1',
    sourceUri: 'https://api.tcgapis.com/api/v2/cards/1',
    capturedAt: '2026-11-22T10:00:00.000Z',
    observedAt: '2026-11-22T10:00:00.000Z',
    checksum: 'abc123',
    mimeType: 'application/json',
    rawRef: 'ingest://tcgapis/tcg:card:1/abc123',
    parsedPayload: {
      name: 'Example Card',
      gameName: 'Pokemon',
      expansionName: 'Base Set',
      recordKind: 'card',
    },
    parseStatus: 'PARSED' as const,
    lineage: ['ev-1'],
  },
  {
    id: 'ev-2',
    sourceId: 'tcgapis',
    sourceRecordId: 'tcg:price:1',
    capturedAt: '2026-11-22',
    observedAt: '2026-11-22',
    checksum: 'def456',
    mimeType: 'application/json',
    rawRef: 'ingest://tcgapis/tcg:price:1/def456',
    parsedPayload: { targetIdentityRef: 'tcg:card:1', basis: 'GUIDE', amount: 4.5, currency: 'USD' },
    parseStatus: 'PARSED' as const,
    lineage: ['ev-2'],
  },
];

const observations = [
  {
    id: 'obs-1',
    evidenceId: 'ev-2',
    targetIdentityRef: 'tcg:card:1',
    basis: 'GUIDE' as const,
    amount: 4.5,
    currency: 'USD',
    observedAt: '2026-11-22T10:01:00.000Z',
    capturedAt: '2026-11-22T10:01:00.000Z',
    status: 'NORMALIZED' as const,
    lineage: ['ev-2'],
    confidence: 'HIGH',
  },
];

test('sync writes evidence, ledger-derived cards and observations to Postgres repos', async () => {
  const repos = createRepositories(createMemoryStore());
  const first = await syncLedgerToPostgres(repos, { evidence, observations });
  assert.equal(first.evidence, 2);
  assert.equal(first.cards, 1);
  assert.equal(first.observations, 1);
  assert.deepEqual(first.errors, []);

  const cards = await repos.cards.list();
  assert.equal(cards.length, 1);
  assert.equal(cards[0].name, 'Example Card');
  assert.equal(cards[0].identityKey, 'tcg:card:1');
  assert.equal((cards[0].facets as Record<string, unknown>).gameName, 'Pokemon');
  assert.equal((await repos.evidence.list()).length, 2);
  const stored = await repos.evidence.list();
  const dated = stored.find((row) => row.sourceRecordId === 'tcg:price:1');
  assert.equal(dated?.observedAt, '2026-11-22T00:00:00.000Z');
  assert.equal((await repos.marketObservations.list()).length, 1);
});

test('sync is idempotent and skips observation rows without an evidence id', async () => {
  const repos = createRepositories(createMemoryStore());
  await syncLedgerToPostgres(repos, { evidence, observations });
  const second = await syncLedgerToPostgres(repos, { evidence, observations });
  assert.equal(second.evidence, 2);
  assert.equal(second.cards, 1);
  assert.equal(second.observations, 1);

  const invalid = await syncLedgerToPostgres(repos, {
    evidence: [],
    observations: [{ ...observations[0], id: 'obs-bad', evidenceId: '' }],
  });
  assert.equal(invalid.observations, 0);
  assert.equal(invalid.errors.length, 1);
});
