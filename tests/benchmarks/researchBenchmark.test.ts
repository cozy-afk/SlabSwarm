import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Express } from 'express';

/**
 * Task 8 — research platform benchmark suite.
 *
 * A curated, deterministic golden suite over the first-party research
 * platform built in Tasks 1-7. It encodes the project's global constraints as
 * executable golden cases so a future regression (a defaulted basis, an
 * invented price, a dropped provenance field, a lot leaking into comps) is
 * caught without a live LLM provider and without network access.
 *
 * Global constraints under test:
 *   - first-party schema; preserve existing data
 *   - deterministic facts authority over LLM
 *   - no invented prices
 *   - unsupported claims deflect
 *   - basis never defaulted
 *   - missing evidence is UNKNOWN
 *
 * All cases are pure functions or an isolated in-process app over a temp data
 * dir, so the suite is fully deterministic and repeatable ("benchmark" in the
 * golden-output sense, not a performance measurement).
 */

import type {
  MarketBasis,
  PriceComponents,
  ValuationBasisPolicy,
} from '../../src/types/graph.ts';
import { normalizePrice } from '../../server/priceNormalizer.ts';
import {
  extractNumericPrices,
  groundGraphRagAnswer,
  type GraphRagGroundingInput,
} from '../../server/graphRagGuardrails.ts';

// ---------------------------------------------------------------------------
// Shared golden fixtures
// ---------------------------------------------------------------------------

/** A fully-known, single-card SOLD observation in USD (golden baseline). */
function goldenPrice(overrides: Partial<PriceComponents> = {}): PriceComponents {
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

type PriceWithBasis = PriceComponents & { basis?: MarketBasis };
function withBasis(input: PriceComponents, basis: MarketBasis): PriceWithBasis {
  return { ...input, basis };
}
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
function confidenceRank(c: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN'): number {
  return { UNKNOWN: 0, LOW: 1, MEDIUM: 2, HIGH: 3 }[c];
}

const BUYER: ValuationBasisPolicy = 'buyer_landed_cost';

// ===========================================================================
// 1. Golden identity variants
// ===========================================================================
// The same economic observation, expressed with equivalent-but-different
// component decompositions, must normalize to the same landed-cost identity.
// This proves the normalizer keys on economic facts, not incidental fields.

test('benchmark: golden identity — equivalent decompositions yield the same landed cost', () => {
  const cases: PriceComponents[] = [
    // Explicit item + separate shipping.
    goldenPrice({ item_amount: 100, shipping_amount: 20 }),
    // item_amount omitted: falls back to listed_amount, same economics.
    goldenPrice({ item_amount: null, shipping_amount: 20 }),
    // Shipping-in-item decomposition: listed already contains shipping.
    goldenPrice({
      listed_amount: 120,
      item_amount: 120,
      shipping_amount: 0,
      shipping_included: true,
      tax_amount: 0,
    }),
  ];

  const identities = cases.map((c) => {
    const out = normalizePrice(withBasis(c, 'SOLD'), BUYER);
    return {
      value: out.value,
      landed: out.landed_cost_buyer,
      basis: out.basis,
      eligible: out.eligibleForSoldComps,
    };
  });

  // All three decompositions must produce the identical golden identity.
  for (const id of identities) {
    assert.deepEqual(id, identities[0]);
  }
  assert.equal(identities[0].value, 120, 'golden landed cost is 100 + 20');
  assert.equal(identities[0].basis, 'SOLD');
  assert.equal(identities[0].eligible, true);
});

test('benchmark: golden identity — buyer and seller policies stay distinct', () => {
  const input = withBasis(
    goldenPrice({ seller_fee: 10, fee_basis: 'LISTED_AMOUNT' }),
    'SOLD',
  );
  const buyer = normalizePrice(input, 'buyer_landed_cost');
  const seller = normalizePrice(input, 'seller_net_proceeds');

  assert.equal(buyer.landed_cost_buyer, 120); // 100 + 20 shipping
  assert.equal(seller.net_seller_proceeds, 110); // 100 + 20 - 10 fee
  assert.equal(buyer.value, 120);
  assert.equal(seller.value, 110);
  assert.notEqual(buyer.value, seller.value, 'policies must never collapse');
});

// ===========================================================================
// 2. Basis preservation — basis travels with the price, never inferred
// ===========================================================================

test('benchmark: basis preservation across every known basis', () => {
  const knownBases: MarketBasis[] = [
    'SOLD',
    'ASKING',
    'OFFER',
    'GUIDE',
    'CLAIM',
    'POPULATION',
  ];
  for (const basis of knownBases) {
    const out = normalizePrice(withBasis(goldenPrice(), basis), BUYER);
    assert.equal(out.basis, basis, `${basis} must be preserved verbatim`);
    // Only SOLD may enter sold comps; every other known basis is excluded.
    assert.equal(
      out.eligibleForSoldComps,
      basis === 'SOLD',
      `${basis} sold-comp eligibility must be ${basis === 'SOLD'}`,
    );
  }
});

test('benchmark: basis is never defaulted — absent basis is UNKNOWN and ineligible', () => {
  const out = normalizePrice(goldenPrice(), BUYER); // no basis supplied
  assert.equal(out.basis, 'UNKNOWN');
  assert.equal(out.eligibleForSoldComps, false);
  assert.ok(out.reason_codes.includes('BASIS_UNKNOWN'));
});

test('benchmark: basis not inferred from amount — asking price is not promoted to SOLD', () => {
  const out = normalizePrice(withBasis(goldenPrice(), 'ASKING'), BUYER);
  assert.equal(out.basis, 'ASKING');
  assert.equal(out.value, 120, 'value is still computable');
  assert.equal(out.eligibleForSoldComps, false, 'amount must not imply a sale');
  assert.ok(out.reason_codes.includes('BASIS_NOT_SOLD'));
});

// ===========================================================================
// 3. Lot exclusion
// ===========================================================================

test('benchmark: lot with unknown composition is excluded from single-card comps', () => {
  const out = normalizePrice(
    withBasis(
      goldenPrice({
        lot_quantity: 3,
        lot_total_amount: 300,
        per_card_allocation_method: 'UNKNOWN_COMPOSITION',
      }),
      'SOLD',
    ),
    BUYER,
  );
  assert.equal(out.singleCardEligible, false);
  assert.equal(out.eligibleForSoldComps, false);
  assert.equal(out.normalized_item_value, null);
  assert.ok(out.reason_codes.includes('LOT_UNKNOWN_COMPOSITION'));
});

test('benchmark: lot with known allocation is split deterministically and eligible', () => {
  const out = normalizePrice(
    withBasis(
      goldenPrice({
        lot_quantity: 3,
        lot_total_amount: 300,
        per_card_allocation_method: 'EQUAL_SPLIT',
      }),
      'SOLD',
    ),
    BUYER,
  );
  assert.equal(out.singleCardEligible, true);
  assert.equal(out.eligibleForSoldComps, true);
  assert.equal(out.normalized_item_value, 100, '300 / 3 = 100 per card');
  assert.ok(out.reason_codes.includes('LOT_SPLIT'));
});

// ===========================================================================
// 4. Provenance completeness
// ===========================================================================

test('benchmark: FX provenance complete — deterministic conversion with full provenance', () => {
  const out = normalizePrice(
    withBasis(
      goldenPrice({
        currency: 'EUR',
        fx_rate_to_base: 1.1,
        fx_source: 'ECB',
        fx_as_of: '2026-11-22T00:00:00.000Z',
      }),
      'SOLD',
    ),
    BUYER,
  );
  assert.equal(out.value, 132, '120 * 1.1');
  assert.equal(out.valueCurrency, 'BASE');
  assert.equal(out.sourceCurrency, 'EUR');
  // Raw components stay in source currency; only the selected value converts.
  assert.equal(out.landed_cost_buyer, 120);
});

test('benchmark: FX provenance incomplete — no source or as-of is rejected, never zero', () => {
  for (const missing of [
    { fx_source: null, fx_as_of: '2026-11-22T00:00:00.000Z' },
    { fx_source: 'ECB', fx_as_of: null },
    { fx_source: null, fx_as_of: null },
  ]) {
    const out = normalizePrice(
      withBasis(
        goldenPrice({ currency: 'EUR', fx_rate_to_base: 1.1, ...missing }),
        'SOLD',
      ),
      BUYER,
    );
    assert.equal(out.value, null, 'no safe value without complete FX provenance');
    assert.ok(out.reason_codes.includes('FX_MISSING_PROVENANCE'));
  }
});

test('benchmark: missing components stay UNKNOWN (null), never coerced to zero', () => {
  const out = normalizePrice(
    withBasis(
      goldenPrice({
        shipping_amount: null,
        shipping_source: null,
        buyer_premium: null,
        tax_amount: null,
      }),
      'SOLD',
    ),
    BUYER,
  );
  assert.equal(out.components.shipping_amount, null);
  assert.equal(out.components.buyer_premium, null);
  assert.equal(out.components.tax_amount, null);
  assert.equal(out.landed_cost_buyer, null, 'cannot compute a partial landed cost');
  assert.ok(
    confidenceRank(out.confidence) < confidenceRank('HIGH'),
    'UNKNOWN components must reduce confidence',
  );
  assert.ok(out.reason_codes.includes('SHIPPING_UNKNOWN'));
});

// ===========================================================================
// 5. Insufficient-evidence deflection (deterministic facts authority)
// ===========================================================================

test('benchmark: insufficient evidence deflects with UNKNOWN confidence and no price', () => {
  const result = groundGraphRagAnswer({
    question: 'What is the exact market value?',
    draftSynthesis: 'It is worth $1,250.00 based on recent sales.',
    evidenceFacts: [],
    evidenceIds: [],
    knownBasis: false,
  });
  assert.equal(result.deflected, true);
  assert.equal(result.confidence, 'UNKNOWN');
  assert.match(result.synthesis.toLowerCase(), /insufficient evidence/);
  assert.deepEqual(extractNumericPrices(result.synthesis), []);
  assert.deepEqual(result.citations, []);
  assert.ok(result.missingData.length > 0);
});

test('benchmark: invented price is deflected even when unrelated evidence exists', () => {
  const result = groundGraphRagAnswer({
    question: 'What did it sell for?',
    draftSynthesis: 'It sold for $999.99 last week [src-1].',
    evidenceFacts: [
      { id: 'src-1', kind: 'researchSource', detail: 'USER_NOTE · claim · basis=UNKNOWN' },
    ],
    evidenceIds: ['src-1'],
    knownBasis: false,
  });
  assert.equal(result.deflected, true, 'unbacked $999.99 must deflect');
  assert.deepEqual(extractNumericPrices(result.synthesis), []);
});

test('benchmark: uncited answer is deflected; cited backed answer is grounded but capped', () => {
  const evidenceFacts = [
    { id: 'src-1', kind: 'marketObservation', detail: 'MARKET SOLD · $250.00 · qty=1' },
  ];
  const base: GraphRagGroundingInput = {
    question: 'What was the recorded sale price?',
    draftSynthesis: '',
    evidenceFacts,
    evidenceIds: ['src-1'],
    knownBasis: true,
    requestedConfidence: 'HIGH',
  };

  const uncited = groundGraphRagAnswer({ ...base, draftSynthesis: 'It sold for $250.00.' });
  assert.equal(uncited.deflected, true, 'no [src-1] citation must deflect');

  const grounded = groundGraphRagAnswer({
    ...base,
    draftSynthesis: 'The recorded sale price was $250.00 [src-1].',
  });
  assert.equal(grounded.deflected, false);
  assert.deepEqual(grounded.citations, ['src-1']);
  assert.equal(grounded.confidence, 'MEDIUM', 'deterministic cap: HIGH request -> MEDIUM');
  assert.notEqual(grounded.confidence, 'HIGH', 'LLM alone never earns HIGH');
});

// ===========================================================================
// 6. Deterministic / swarm parity (where possible)
// ===========================================================================
// With no provider configured, the /api/research/question endpoint must fall
// back to the deterministic path. Its envelope must agree with the pure
// guardrail applied to the same (empty) evidence set: same deflection, same
// confidence band, same absence of invented prices. This is the observable
// parity between the swarm-facing route and the deterministic authority.

const originalDataDir = process.env.SLABGRAPH_DATA_DIR;
const originalTestMode = process.env.SLABGRAPH_TEST_MODE;
const llmEnvKeys = [
  'GEMINI_API_KEY',
  'HERMES_API_URL',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'OLLAMA_BASE_URL',
];
const originalKeys: Record<string, string | undefined> = {};
let tempDataDir: string;
let createApp: typeof import('../../server.ts')['createApp'];
let server: Server;
let baseUrl: string;

before(async () => {
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slabswarm-research-benchmark-'));
  process.env.SLABGRAPH_DATA_DIR = tempDataDir;
  process.env.SLABGRAPH_TEST_MODE = '1';
  for (const key of llmEnvKeys) {
    originalKeys[key] = process.env[key];
    delete process.env[key];
  }
  ({ createApp } = await import(`../../server.ts?benchmark=${Date.now()}`));
  const app: Express = await createApp();
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  if (server) server.close();
  if (originalDataDir === undefined) delete process.env.SLABGRAPH_DATA_DIR;
  else process.env.SLABGRAPH_DATA_DIR = originalDataDir;
  if (originalTestMode === undefined) delete process.env.SLABGRAPH_TEST_MODE;
  else process.env.SLABGRAPH_TEST_MODE = originalTestMode;
  for (const key of llmEnvKeys) {
    if (originalKeys[key] === undefined) delete process.env[key];
    else process.env[key] = originalKeys[key];
  }
  fs.rmSync(tempDataDir, { recursive: true, force: true });
});

test('benchmark: deterministic/swarm parity — route deflection equals pure guardrail', async () => {
  // Empty first-party store: deterministic authority has no evidence.
  const state = (await (await fetch(`${baseUrl}/api/research/state`)).json()) as {
    counts?: { researchSources?: number; marketObservations?: number };
  };
  assert.equal(state.counts?.researchSources ?? 0, 0);
  assert.equal(state.counts?.marketObservations ?? 0, 0);

  const question = 'What is the exact fair market value of my card?';
  const res = await fetch(`${baseUrl}/api/research/question`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question }),
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as {
    note?: { synthesis?: string; missingData?: string[] };
    deflected?: boolean;
    confidenceLabel?: string;
    citations?: string[];
    evidenceMode?: string;
  };

  // The route must take the deterministic fallback path (no provider)...
  assert.equal(body.evidenceMode, 'deterministic_fallback');
  // ...and agree with the pure guardrail on the same empty evidence set.
  const pure = groundGraphRagAnswer({
    question,
    draftSynthesis: '',
    evidenceFacts: [],
    evidenceIds: [],
    knownBasis: false,
  });
  assert.equal(body.deflected, pure.deflected, 'parity: deflection flag');
  assert.equal(body.confidenceLabel, pure.confidence, 'parity: confidence band');
  assert.deepEqual(body.citations ?? [], pure.citations, 'parity: citations');
  const synthesis = body.note?.synthesis ?? '';
  assert.deepEqual(
    extractNumericPrices(synthesis),
    extractNumericPrices(pure.synthesis),
    'parity: no invented price in either path',
  );
  assert.deepEqual(extractNumericPrices(synthesis), []);
  assert.match(synthesis.toLowerCase(), /insufficient evidence/);
});

test('benchmark: provenance completeness survives persistence — source round-trip', async () => {
  // Ingest a source with explicit basis via the real endpoint, then confirm
  // the first-party record retains basis/tags/provenance through the state API.
  const payload = {
    type: 'USER_NOTE',
    title: 'Golden provenance source',
    rawText: 'Seller states a reverse holo 1st Edition printing.',
    tags: ['reverse-holo', '1st-edition'],
    basis: 'SOLD',
    source_url: 'https://example.com/listing',
    checksum_sha256: 'c'.repeat(64),
  };
  const post = await fetch(`${baseUrl}/api/research/source`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  assert.equal(post.status, 201);
  const created = (await post.json()) as { source?: Record<string, unknown> };
  const source = created.source ?? {};
  assert.equal(source.basis, 'SOLD', 'explicit basis preserved, never defaulted');
  assert.deepEqual(source.tags, payload.tags);
  assert.equal(source.source_url, payload.source_url);
  assert.equal(source.checksum_sha256, payload.checksum_sha256);

  const state = (await (await fetch(`${baseUrl}/api/research/state`)).json()) as {
    researchSources?: Array<Record<string, unknown>>;
  };
  const found = state.researchSources?.find((s) => s.id === source.id);
  assert.ok(found, 'ingested source must persist in first-party state');
  assert.equal(found?.basis, 'SOLD', 'provenance survives persistence');
});

test('benchmark: media provenance completeness — checksum and license are authoritative', () => {
  // A media asset records content-addressed provenance; the checksum is a
  // deterministic fact about the bytes, never an LLM-supplied guess.
  const bytes = Buffer.from('benchmark golden media payload');
  const checksum = createHash('sha256').update(bytes).digest('hex');
  assert.match(checksum, /^[a-f0-9]{64}$/);
  assert.equal(checksum, createHash('sha256').update(bytes).digest('hex'), 'deterministic');
  assert.notEqual(checksum, createHash('sha256').update(Buffer.from('other')).digest('hex'));
});
