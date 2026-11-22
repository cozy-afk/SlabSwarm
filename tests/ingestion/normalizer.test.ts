import assert from 'node:assert/strict';
import { test } from 'node:test';

const normalizerMod = () => import('../../server/ingest/normalizer.ts');

const evidence = {
  id: 'ev-1',
  sourceId: 'legacy-graph',
  sourceRecordId: 'sale:1',
  capturedAt: '2026-11-22T12:00:00.000Z',
  observedAt: '2026-11-20T00:00:00.000Z',
  checksum: 'a'.repeat(64),
  mimeType: 'application/json',
  rawRef: 'ingest://legacy-graph/sale:1',
  parseStatus: 'PARSED' as const,
  lineage: [],
  correctionOf: null,
  correctionReason: null,
};

const raw = (payload: Record<string, unknown>, observedAt = '2026-11-20T00:00:00.000Z') => ({
  nativeId: 'sale:1',
  observedAt,
  payload,
  sourceUri: null,
  checksum: 'a'.repeat(64),
  mimeType: 'application/json',
});

test('normalizer never defaults a missing basis to SOLD and emits UNKNOWN with a warning', async () => {
  const { normalizeRawItem } = await normalizerMod();
  const out = normalizeRawItem(raw({ price: 100 }), evidence);
  assert.equal(out.basis, 'UNKNOWN');
  assert.equal(out.evidenceId, 'ev-1');
  assert.ok(out.warnings.includes('BASIS_UNKNOWN'));
});

test('normalizer preserves an explicitly supplied basis', async () => {
  const { normalizeRawItem } = await normalizerMod();
  for (const basis of ['SOLD', 'ASKING', 'GUIDE', 'CLAIM', 'OFFER', 'POPULATION'] as const) {
    const out = normalizeRawItem(raw({ price: 100, basis }), evidence);
    assert.equal(out.basis, basis);
  }
});

test('normalizer rejects an invalid basis to UNKNOWN instead of guessing', async () => {
  const { normalizeRawItem } = await normalizerMod();
  const out = normalizeRawItem(raw({ price: 100, basis: 'TOTALLY_SOLD' }), evidence);
  assert.equal(out.basis, 'UNKNOWN');
  assert.ok(out.warnings.includes('BASIS_INVALID'));
});

test('missing price, shipping, fees, FX, grade and condition stay UNKNOWN (null), never zero', async () => {
  const { normalizeRawItem } = await normalizerMod();
  const out = normalizeRawItem(raw({ basis: 'SOLD', title: 'Card' }), evidence);
  assert.equal(out.amount, null);
  assert.equal(out.currency, 'UNKNOWN');
  const components = out.priceComponents as Record<string, unknown>;
  assert.equal(components.shipping_amount, null);
  assert.equal(components.fees, null);
  assert.equal(components.fx_rate_to_base, null);
  assert.equal(components.fx_source, null);
  assert.equal(components.grade, null);
  assert.equal(components.condition, null);
  assert.ok(out.warnings.includes('AMOUNT_UNKNOWN'));
  assert.ok(out.warnings.includes('CURRENCY_UNKNOWN'));
});

test('zero and negative prices are UNKNOWN, not a free card', async () => {
  const { normalizeRawItem } = await normalizerMod();
  for (const price of [0, -5, '100', NaN]) {
    const out = normalizeRawItem(raw({ price, basis: 'SOLD' }), evidence);
    assert.equal(out.amount, null, `price ${String(price)} must be UNKNOWN`);
  }
});

test('candidate carries source, observed_at, captured_at, lineage and confidence', async () => {
  const { normalizeRawItem } = await normalizerMod();
  const out = normalizeRawItem(raw({ price: 250, currency: 'USD', basis: 'SOLD' }), evidence);
  assert.equal(out.sourceId, 'legacy-graph');
  assert.equal(out.observedAt, '2026-11-20T00:00:00.000Z');
  assert.equal(out.capturedAt, '2026-11-22T12:00:00.000Z');
  assert.deepEqual(out.lineage, ['ev-1']);
  assert.equal(out.confidence, 'UNKNOWN');
  assert.equal(out.status, 'RAW');
  assert.equal(out.amount, 250);
});

test('explicit confidence and target identity are preserved', async () => {
  const { normalizeRawItem } = await normalizerMod();
  const out = normalizeRawItem(
    raw({ price: 10, basis: 'CLAIM', confidence: 'HIGH', targetIdentityRef: 'card:42' }),
    evidence,
  );
  assert.equal(out.confidence, 'HIGH');
  assert.equal(out.targetIdentityRef, 'card:42');
});

test('a malformed payload never throws and falls back to safe UNKNOWN values', async () => {
  const { normalizeRawItem } = await normalizerMod();
  const out = normalizeRawItem(raw({ price: { nope: true }, basis: 42 }), evidence);
  assert.equal(out.basis, 'UNKNOWN');
  assert.equal(out.amount, null);
  assert.ok(Array.isArray(out.warnings));
});
