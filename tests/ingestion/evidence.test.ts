import assert from 'node:assert/strict';
import { test } from 'node:test';

// Imports are dynamic so a missing module is reported as a failing test
// (RED) rather than a file load error.

const storeMod = () => import('../../server/ingest/store.ts');
const evidenceMod = () => import('../../server/ingest/evidence.ts');

function input(overrides: Record<string, unknown> = {}) {
  return {
    sourceId: 'legacy-graph',
    sourceRecordId: 'asset:1',
    sourceUri: 'https://example.com/asset/1',
    capturedAt: '2026-11-22T12:00:00.000Z',
    observedAt: '2026-11-20T00:00:00.000Z',
    checksum: 'a'.repeat(64),
    mimeType: 'application/json',
    license: null,
    rawRef: 'ingest://legacy-graph/asset:1/' + 'a'.repeat(64),
    parsedPayload: { title: 'Card 1' },
    trustTier: 'UNKNOWN',
    ...overrides,
  };
}

test('evidence repository creates and retrieves a record with parseStatus PENDING', async () => {
  const { createInMemoryRepositories } = await storeMod();
  const repos = createInMemoryRepositories();
  const created = await repos.evidence.create(input() as never);
  assert.ok(created.id);
  assert.equal(created.parseStatus, 'PENDING');
  assert.equal(created.sourceId, 'legacy-graph');
  assert.equal(created.sourceRecordId, 'asset:1');
  assert.equal((await repos.evidence.get(created.id))?.id, created.id);
  assert.equal(await repos.evidence.get('missing'), null);
});

test('evidence list filters by sourceId, sourceRecordId and parseStatus', async () => {
  const { createInMemoryRepositories } = await storeMod();
  const repos = createInMemoryRepositories();
  const a = await repos.evidence.create(input({ sourceRecordId: 'asset:a' }) as never);
  await repos.evidence.create(
    input({ sourceRecordId: 'sale:b', sourceId: 'csv' }) as never,
  );
  assert.deepEqual(
    (await repos.evidence.list({ sourceId: 'legacy-graph' })).map((e) => e.id),
    [a.id],
  );
  assert.equal((await repos.evidence.list({ sourceRecordId: 'sale:b' })).length, 1);
  assert.equal((await repos.evidence.list({ parseStatus: 'PARSED' })).length, 0);
});

test('evidence create is idempotent by source + native id + checksum', async () => {
  const { createInMemoryRepositories } = await storeMod();
  const repos = createInMemoryRepositories();
  const first = await repos.evidence.create(input() as never);
  const second = await repos.evidence.create(input() as never);
  assert.equal(second.id, first.id, 'identical source+id+checksum must dedupe');
  assert.equal((await repos.evidence.list({})).length, 1);
});

test('a new checksum for the same source + native id appends a new evidence record', async () => {
  const { createInMemoryRepositories } = await storeMod();
  const repos = createInMemoryRepositories();
  const first = await repos.evidence.create(input() as never);
  const corrected = await repos.evidence.create(
    input({ checksum: 'b'.repeat(64), parsedPayload: { title: 'Corrected' } }) as never,
  );
  assert.notEqual(corrected.id, first.id);
  assert.equal((await repos.evidence.list({})).length, 2);
  assert.deepEqual((await repos.evidence.get(corrected.id))?.parsedPayload, {
    title: 'Corrected',
  });
  assert.deepEqual((await repos.evidence.get(first.id))?.parsedPayload, { title: 'Card 1' });
});

test('raw evidence is immutable: stored records are frozen and returned copies cannot mutate them', async () => {
  const { createInMemoryRepositories } = await storeMod();
  const repos = createInMemoryRepositories();
  const created = await repos.evidence.create(input() as never);
  assert.equal(Object.isFrozen(created), true);
  assert.equal(Object.isFrozen(created.parsedPayload), true);
  const copy = { ...created, parsedPayload: { ...created.parsedPayload } };
  (copy.parsedPayload as Record<string, unknown>).title = 'HACKED';
  assert.equal(
    ((await repos.evidence.get(created.id))?.parsedPayload as Record<string, unknown>).title,
    'Card 1',
  );
});

test('appendCorrection appends a linked record and leaves the original untouched', async () => {
  const { createInMemoryRepositories } = await storeMod();
  const { createEvidenceService } = await evidenceMod();
  const repos = createInMemoryRepositories();
  const original = await repos.evidence.create(input() as never);
  const svc = createEvidenceService(repos);
  const correction = await svc.appendCorrection(original.id, {
    checksum: 'c'.repeat(64),
    parsedPayload: { title: 'Corrected title' },
    correctionReason: 'source update',
  });
  assert.ok(correction);
  assert.notEqual(correction.id, original.id);
  assert.equal((await repos.evidence.get(original.id))?.id, original.id);
  assert.deepEqual((await repos.evidence.get(original.id))?.parsedPayload, {
    title: 'Card 1',
  });
  assert.equal((correction as unknown as { correctionOf: string }).correctionOf, original.id);
  assert.deepEqual((correction as unknown as { lineage: string[] }).lineage, [original.id]);
});

test('computeChecksum is canonical: key order does not change the digest', async () => {
  const { computeChecksum } = await evidenceMod();
  const a = computeChecksum({ b: 2, a: { d: 4, c: 3 } });
  const b = computeChecksum({ a: { c: 3, d: 4 }, b: 2 });
  assert.match(a, /^[a-f0-9]{64}$/);
  assert.equal(a, b);
  assert.notEqual(a, computeChecksum({ a: 1 }));
});

test('validateEvidenceInput rejects missing required fields and keeps unknown license as null', async () => {
  const { validateEvidenceInput } = await evidenceMod();
  assert.throws(() => validateEvidenceInput({ ...input(), sourceId: '' }), /sourceId/i);
  assert.throws(() => validateEvidenceInput({ ...input(), checksum: '' }), /checksum/i);
  assert.throws(() => validateEvidenceInput({ ...input(), observedAt: undefined }), /observedAt/i);
  assert.throws(() => validateEvidenceInput({ ...input(), capturedAt: undefined }), /capturedAt/i);
  const parsed = validateEvidenceInput(input({ license: undefined }));
  assert.equal(parsed.license, null);
  assert.equal(parsed.trustTier, 'UNKNOWN');
});
