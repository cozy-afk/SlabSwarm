import assert from 'node:assert/strict';
import { test } from 'node:test';

import type {
  IdentityDecision,
  MarketObservation,
  MediaAssetNode,
  PriceComponents,
  ResearchNoteNode,
  ResearchObservationNode,
  ResearchProjectionNode,
  ResearchSourceNode,
  ValuationBasisPolicy,
} from '../src/types/graph.ts';

// Compile-time assertions: these object literals must satisfy the first-party
// schema types. `tsc --noEmit` is the gate; the runtime assertions below ensure
// the literal values survive type stripping and are exercised by the test runner.

const claimSource = {
  id: 'src-claim-1',
  type: 'USER_NOTE',
  title: 'Seller claim from listing screenshot',
  rawText: 'I pulled this reverse holo from a 1st Edition pack.',
  tags: ['reverse-holo', '1st-edition'],
  basis: 'CLAIM' as const,
  capturedAt: '2026-11-22T00:00:00.000Z',
} satisfies ResearchSourceNode;

const slabMedia = {
  id: 'media-slab-1',
  kind: 'SLAB_LABEL' as const,
  target_type: 'PrintingInstance',
  target_id: 'instance-1',
  uri: 'data/media/slab-1.jpg',
  checksum_sha256: 'a'.repeat(64),
  mime_type: 'image/jpeg',
  license: 'USER_SUPPLIED',
  source_record_id: 'src-claim-1',
  observed_at: '2026-11-22T00:00:00.000Z',
  captured_at: '2026-11-22T00:00:00.000Z',
} satisfies MediaAssetNode;

const priceComponents = {
  listed_amount: 100,
  item_amount: 100,
  shipping_amount: null,
  shipping_included: false,
  shipping_estimated: true,
  shipping_source: 'UNKNOWN',
  buyer_premium: null,
  platform_fee: null,
  seller_fee: null,
  tax_amount: null,
  fee_basis: 'UNKNOWN',
  lot_quantity: 1,
  lot_total_amount: 100,
  per_card_allocation_method: 'UNKNOWN_COMPOSITION',
  currency: 'USD',
  fx_rate_to_base: null,
  fx_source: null,
  fx_as_of: null,
  normalization_confidence: 'LOW',
  normalization_reason_codes: ['FEES_UNKNOWN', 'SUSPECT_ZERO_SHIPPING'],
} satisfies PriceComponents;

const buyerPolicy: ValuationBasisPolicy = 'buyer_landed_cost';
const sellerPolicy: ValuationBasisPolicy = 'seller_net_proceeds';

const observation: MarketObservation = {
  id: 'obs-1',
  tenantId: 'tenant-1',
  targetIdentityRef: 'printing-1',
  sourceId: 'src-claim-1',
  sourceFeedType: 'USER_NOTE',
  nativeSourceRecordId: 'raw-1',
  observed_at: '2026-11-22T00:00:00.000Z',
  source_date: '2026-11-21',
  source_timeframe: 'DAY',
  source_date_assumed: true,
  captured_at: '2026-11-22T00:00:00.000Z',
  basis: 'CLAIM',
  currency: 'USD',
  amount: 100,
  fees: null,
  shipping_amount: null,
  tax_amount: null,
  quantity: 1,
  price_kind: 'ITEM',
  marketplace: 'manual',
  region: 'US',
  seller_hashed_id: null,
  buyer_hashed_id: null,
  condition: 'NM',
  condition_source: 'SELLER',
  language: 'EN',
  finish: 'REVERSE_HOLO',
  grade: 'PSA 10',
  grading_company: 'PSA',
  certificate_number: null,
  raw_evidence: { note: 'reverse holo claim' },
  checksum_sha256: 'b'.repeat(64),
  mime_type: 'text/plain',
  source_url: null,
  confidence: 0.4,
  confidence_band: 'LOW',
  confidence_reasons: ['UNVERIFIED_CLAIM'],
  exact_dedupe_key: 'obs-1-exact',
  near_dedupe_key: 'obs-1-near',
  cluster_id: 'cluster-1',
  reconciliation_policy: 'QUARANTINE',
  status: 'QUARANTINED',
  lineage_pointer: null,
  priceComponents,
};

const researchObservation: ResearchObservationNode = {
  id: 'robs-1',
  sourceId: 'src-claim-1',
  kind: 'CLAIM',
  value: 'reverse holo variant',
  confidence: 0.4,
  evidenceIds: [slabMedia.id],
  createdAt: '2026-11-22T00:00:00.000Z',
};

const researchNote: ResearchNoteNode = {
  id: 'rnote-1',
  question: 'Is this a reverse holo?',
  subquestions: ['Does the label show a reverse finish?'],
  evidenceIds: [researchObservation.id],
  synthesis: 'Insufficient evidence to confirm finish.',
  confidence: 0.3,
  missingData: ['slab label OCR', 'certificate verification'],
  createdAt: '2026-11-22T00:00:00.000Z',
};

const researchProjection: ResearchProjectionNode = {
  id: 'rproj-1',
  assetId: 'asset-1',
  horizon: '90D',
  currentValue: 100,
  projectedValue: 110,
  currency: 'USD',
  drivers: ['POPULATION_SUPPLY'],
  invalidationConditions: ['new population report'],
  confidence: 0.35,
  createdAt: '2026-11-22T00:00:00.000Z',
};

const identityDecision: IdentityDecision = {
  id: 'decision-1',
  version: 1,
  targetRef: 'printing-1',
  status: 'QUARANTINED',
  candidates: [{ ref: 'printing-1', score: 0.4 }],
  scores: { printing1: 0.4 },
  votes: [],
  contradictions: ['finish ambiguous'],
  reviewerAction: 'PENDING',
  decidedAt: '2026-11-22T00:00:00.000Z',
};

test('research and market schema types accept first-party literal shapes', () => {
  assert.equal(claimSource.basis, 'CLAIM');
  assert.equal(slabMedia.kind, 'SLAB_LABEL');
  assert.equal(priceComponents.shipping_amount, null);
  assert.equal(priceComponents.shipping_estimated, true);
  assert.equal(observation.basis, 'CLAIM');
  assert.equal(sellerPolicy, 'seller_net_proceeds');
  assert.equal(buyerPolicy, 'buyer_landed_cost');
  assert.equal(researchNote.subquestions.length, 1);
  assert.equal(researchProjection.horizon, '90D');
  assert.equal(identityDecision.status, 'QUARANTINED');
});
