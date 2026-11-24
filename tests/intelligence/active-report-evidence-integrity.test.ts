// A-01 regression: an active report must never present an unresolved evidence
// id as evidence-backed. Through the production buildActiveReport path with
// real canonical repositories, unresolved refs are excluded and warned about.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRepositories } from '../../server/db/repositories/index.ts';
import { createMemoryStore } from '../../server/db/store.ts';
import { buildActiveReport } from '../../server/intelligence/active-report.ts';

const NOW = new Date('2026-11-24T00:00:00.000Z');
const ORPHAN_ID = 'ev-2beb9ebc-9547-46ea-b8ae-4baa1b5d07b1';

test('report figures ignore observations whose evidence refs are unresolved', async () => {
  const repos = createRepositories(createMemoryStore());
  const evidence = await repos.evidence.create({
    sourceId: 'tcgapis',
    sourceRecordId: 'tcg:price:good',
    capturedAt: '2026-11-22T10:01:00.000Z',
    observedAt: '2026-11-22T10:00:00.000Z',
    checksum: 'sha256-good',
    mimeType: 'application/json',
    rawRef: 'ingest://tcgapis/tcg:price:good',
  });
  for (const amount of [10, 20, 30]) {
    await repos.marketObservations.create({
      evidenceId: ORPHAN_ID,
      targetIdentityRef: 'card-orphan',
      basis: 'GUIDE',
      amount,
      currency: 'USD',
      observedAt: '2026-11-22T10:00:00.000Z',
      status: 'NORMALIZED',
    });
  }
  for (const amount of [100, 110, 120]) {
    await repos.marketObservations.create({
      evidenceId: evidence.id,
      targetIdentityRef: 'card-good',
      basis: 'GUIDE',
      amount,
      currency: 'USD',
      observedAt: '2026-11-22T10:00:00.000Z',
      status: 'NORMALIZED',
    });
  }

  const result = await buildActiveReport({ now: NOW, repositories: repos, limit: 10 });
  assert.deepEqual(result.data.cards.map((card) => card.id), ['card-good']);
  assert.deepEqual(result.data.cards[0]!.priceBand, {
    low: 100, mid: 110, high: 120, currency: 'USD', basis: 'GUIDE',
  });
  const warnings = (result.meta as unknown as Record<string, unknown>).evidenceWarnings as string[];
  assert.ok(
    warnings.some((warning) => warning.includes(ORPHAN_ID) && /excluded/i.test(warning)),
    `the excluded orphan-backed figures must be disclosed: ${JSON.stringify(warnings)}`,
  );
});

test('active report excludes unresolved evidence refs and warns explicitly', async () => {
  const repos = createRepositories(createMemoryStore());
  const evidence = await repos.evidence.create({
    sourceId: 'tcgapis',
    sourceRecordId: 'tcg:price:530626:0:lowPrice',
    capturedAt: '2026-11-22T10:01:00.000Z',
    observedAt: '2026-11-22T10:00:00.000Z',
    checksum: 'sha256-resolvable',
    mimeType: 'application/json',
    rawRef: 'ingest://tcgapis/tcg:price:530626:0:lowPrice',
    parsedPayload: { name: 'Charizard' },
  });
  for (const [evidenceId, amount] of [[evidence.id, 12.5], [ORPHAN_ID, 13]] as const) {
    await repos.marketObservations.create({
      evidenceId,
      targetIdentityRef: 'card-charizard',
      basis: 'GUIDE',
      amount,
      currency: 'USD',
      observedAt: '2026-11-22T10:00:00.000Z',
      status: 'NORMALIZED',
    });
  }

  const result = await buildActiveReport({ now: NOW, repositories: repos, limit: 10 });
  const ids = result.data.cards.flatMap((card) => card.evidence.map((ref) => ref.id));
  assert.ok(ids.includes(evidence.id), 'the resolvable ref is still cited');
  assert.ok(
    !ids.includes(ORPHAN_ID),
    `unresolved evidence id ${ORPHAN_ID} must not be presented as evidence-backed`,
  );
  const warnings = (result.meta as unknown as Record<string, unknown>).evidenceWarnings;
  assert.ok(Array.isArray(warnings), 'report meta must expose evidenceWarnings');
  assert.ok(
    (warnings as string[]).some((warning) => warning.includes(ORPHAN_ID) && /unresolved|excluded/i.test(warning)),
    `meta must explicitly warn about the excluded ref: ${JSON.stringify(warnings)}`,
  );
});
