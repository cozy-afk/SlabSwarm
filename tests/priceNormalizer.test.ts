import assert from 'node:assert/strict';
import { test } from 'node:test';

import type {
  MarketBasis,
  PriceComponents,
  ValuationBasisPolicy,
} from '../src/types/graph.ts';
import { normalizePrice } from '../server/priceNormalizer.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A fully-known, single-card SOLD observation in USD. */
function baseInput(overrides: Partial<PriceComponents> = {}): PriceComponents {
  return {
    listed_amount: 100,
    item_amount: 100,
    shipping_amount: 20,
    shipping_included: false,
    shipping_estimated: false,
    shipping_source: 'SELLER_LISTING',
    buyer_premium: 0,
    platform_fee: null,
    seller_fee: null,
    tax_amount: 0,
    fee_basis: 'LISTED_AMOUNT',
    lot_quantity: 1,
    lot_total_amount: 100,
    per_card_allocation_method: 'SINGLE_CARD',
    currency: 'USD',
    fx_rate_to_base: null,
    fx_source: null,
    fx_as_of: null,
    landed_cost_buyer: null,
    net_seller_proceeds: null,
    normalized_item_value: null,
    normalization_reason_codes: [],
    normalization_confidence: 'UNKNOWN',
    ...overrides,
  };
}

/** Deep clone so we can prove the normalizer never mutates its input. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

type WithBasis = PriceComponents & { basis?: MarketBasis };

// ---------------------------------------------------------------------------
// Case 1 — buyer landed cost includes shipping
// ---------------------------------------------------------------------------
test('buyer_landed_cost: listed 100 + shipping 20 = 120', () => {
  const input = withBasis(baseInput(), 'SOLD');
  const before = clone(input);
  const out = normalizePrice(input, 'buyer_landed_cost');

  assert.equal(out.value, 120);
  assert.equal(out.policy, 'buyer_landed_cost');
  assert.equal(out.basis, 'SOLD');
  assert.equal(out.landed_cost_buyer, 120);
  assert.deepEqual(input, before, 'normalizePrice must not mutate its input');
});

// ---------------------------------------------------------------------------
// Case 2 — seller net proceeds is a distinct output (10% seller fee)
// ---------------------------------------------------------------------------
test('seller_net_proceeds: item + shipping - 10% fee = documented formula result', () => {
  const input = withBasis(
    baseInput({ seller_fee: 10, fee_basis: 'LISTED_AMOUNT' }),
    'SOLD',
  );
  const out = normalizePrice(input, 'seller_net_proceeds');

  // Documented formula: fee is 10% of the listed amount (100 * 0.10 = 10).
  // Proceeds = item + buyer-paid shipping - seller fee = 100 + 20 - 10 = 110.
  // Buyer market value (landed cost) is kept separate and is still 120.
  assert.equal(out.value, 110);
  assert.equal(out.net_seller_proceeds, 110);
  assert.equal(out.landed_cost_buyer, 120);
  assert.notEqual(out.value, out.landed_cost_buyer, 'policy outputs must be distinct');
});

// ---------------------------------------------------------------------------
// Case 3 — ASKING cannot silently become a sold comp
// ---------------------------------------------------------------------------
test('ASKING basis is preserved and blocked from sold comps', () => {
  const input = withBasis(baseInput(), 'ASKING');
  const out = normalizePrice(input, 'buyer_landed_cost');

  assert.equal(out.basis, 'ASKING');
  assert.equal(out.eligibleForSoldComps, false);
  assert.ok(
    out.reason_codes.includes('BASIS_NOT_SOLD'),
    'must flag non-SOLD basis',
  );
});

test('SOLD basis is eligible for sold comps', () => {
  const out = normalizePrice(withBasis(baseInput(), 'SOLD'), 'buyer_landed_cost');
  assert.equal(out.eligibleForSoldComps, true);
});

test('missing basis is UNKNOWN, never a factual default, and is not eligible', () => {
  const out = normalizePrice(baseInput(), 'buyer_landed_cost');
  assert.equal(out.basis, 'UNKNOWN');
  assert.equal(out.eligibleForSoldComps, false);
  assert.ok(out.reason_codes.includes('BASIS_UNKNOWN'));
});

// ---------------------------------------------------------------------------
// Case 4 — missing shipping is UNKNOWN (not zero) and lowers confidence
// ---------------------------------------------------------------------------
test('missing shipping stays UNKNOWN and reduces confidence', () => {
  const known = normalizePrice(
    withBasis(baseInput({ seller_fee: 3 }), 'SOLD'),
    'buyer_landed_cost',
  );
  const missing = normalizePrice(
    withBasis(baseInput({ seller_fee: 3, shipping_amount: null, shipping_source: null }), 'SOLD'),
    'buyer_landed_cost',
  );

  assert.ok(
    confidenceRank(missing.confidence) < confidenceRank(known.confidence),
    `expected confidence to drop from ${known.confidence} to ${missing.confidence}`,
  );
  assert.ok(
    missing.reason_codes.includes('SHIPPING_UNKNOWN'),
    'must flag UNKNOWN shipping',
  );
  // The unknown component must not be coerced to a zero contribution.
  assert.equal(missing.components.shipping_amount, null);
  assert.equal(
    missing.landed_cost_buyer,
    null,
    'landed cost cannot be fully computed when shipping is unknown',
  );
});

// ---------------------------------------------------------------------------
// Case 5 — LOT with unknown composition is excluded from single-card comps
// ---------------------------------------------------------------------------
test('LOT with unknown composition is excluded from single-card comps', () => {
  const lot = withBasis(
    baseInput({
      lot_quantity: 3,
      lot_total_amount: 300,
      per_card_allocation_method: 'UNKNOWN_COMPOSITION',
    }),
    'SOLD',
  );
  const out = normalizePrice(lot, 'buyer_landed_cost');

  assert.equal(out.singleCardEligible, false);
  assert.equal(out.eligibleForSoldComps, false);
  assert.ok(out.reason_codes.includes('LOT_UNKNOWN_COMPOSITION'));
  assert.equal(out.normalized_item_value, null);
});

test('LOT with known per-card allocation can enter single-card comps', () => {
  const lot = withBasis(
    baseInput({
      lot_quantity: 3,
      lot_total_amount: 300,
      per_card_allocation_method: 'EQUAL_SPLIT',
    }),
    'SOLD',
  );
  const out = normalizePrice(lot, 'buyer_landed_cost');

  assert.equal(out.singleCardEligible, true);
});

// ---------------------------------------------------------------------------
// Case 6 — FX without source/as-of is rejected
// ---------------------------------------------------------------------------
test('FX conversion without fx_source and fx_as_of is rejected', () => {
  const noSource = withBasis(
    baseInput({ currency: 'EUR', fx_rate_to_base: 1.1, fx_source: null, fx_as_of: '2026-11-22' }),
    'SOLD',
  );
  const out1 = normalizePrice(noSource, 'buyer_landed_cost');
  assert.equal(out1.value, null);
  assert.ok(out1.reason_codes.includes('FX_MISSING_PROVENANCE'));

  const noAsOf = withBasis(
    baseInput({ currency: 'EUR', fx_rate_to_base: 1.1, fx_source: 'ECB', fx_as_of: null }),
    'SOLD',
  );
  const out2 = normalizePrice(noAsOf, 'buyer_landed_cost');
  assert.equal(out2.value, null);
  assert.ok(out2.reason_codes.includes('FX_MISSING_PROVENANCE'));
});

test('FX with source and as-of converts deterministically and keeps policy outputs separate', () => {
  const input = withBasis(
    baseInput({
      currency: 'EUR',
      fx_rate_to_base: 1.1,
      fx_source: 'ECB',
      fx_as_of: '2026-11-22T00:00:00.000Z',
    }),
    'SOLD',
  );
  const out = normalizePrice(input, 'buyer_landed_cost');

  assert.equal(out.value, 132); // 120 * 1.1
  assert.equal(out.valueCurrency, 'BASE');
  assert.equal(out.sourceCurrency, 'EUR');
  // Component outputs stay in the source currency; `value` is the converted,
  // policy-selected output. No silent currency conversion of raw components.
  assert.equal(out.landed_cost_buyer, 120);
});

// ---------------------------------------------------------------------------
// Extra: policy enumeration — every policy names itself
// ---------------------------------------------------------------------------
test('every policy names itself in the output', () => {
  const policies: ValuationBasisPolicy[] = [
    'buyer_landed_cost',
    'seller_net_proceeds',
    'item_only',
    'guide',
    'asking',
    'offer',
    'derived_model',
  ];
  for (const policy of policies) {
    const out = normalizePrice(withBasis(baseInput(), 'SOLD'), policy);
    assert.equal(out.policy, policy);
  }
});

// ---------------------------------------------------------------------------

function withBasis(input: PriceComponents, basis: MarketBasis): WithBasis {
  return { ...input, basis };
}

function confidenceRank(c: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN'): number {
  return { UNKNOWN: 0, LOW: 1, MEDIUM: 2, HIGH: 3 }[c];
}
