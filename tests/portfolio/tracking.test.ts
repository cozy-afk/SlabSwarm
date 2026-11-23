// Task 17: watchlist / alerts / portfolio tracking primitives.
// Tests are deterministic: every clock, observation and rule is injected.
// No network, model, canonical write or external notification is involved.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  UNKNOWN,
  buildPortfolio,
  buildRealized,
  buildUnrealized,
  estimateFees,
  estimateTax,
  evaluateAlerts,
  fmvToValuation,
  type AlertRuleRecord,
  type HoldingRecord,
  type MetricSnapshot,
  type SaleRecord,
} from '../../server/portfolio/tracking.ts';
import {
  TrackingValidationError,
  createTrackingStore,
} from '../../server/portfolio/trackingStore.ts';
import { computeFmv } from '../../server/valuation/fmv.ts';

const NOW = new Date('2026-11-23T00:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function sold(id: string, amount: number, extras: Record<string, unknown> = {}) {
  return {
    id,
    basis: 'SOLD' as const,
    amount,
    observedAt: new Date(NOW.getTime() - 2 * DAY_MS).toISOString(),
    currency: 'USD',
    source: 'ebay_sold',
    ...extras,
  };
}

function fmv(amounts: number[] = [100, 110, 105], extras: Record<string, unknown> = {}) {
  return computeFmv(
    'A1',
    amounts.map((value, index) => sold(`sold-${index}`, value, extras)),
    { now: NOW },
  );
}

function holding(overrides: Record<string, unknown> = {}): HoldingRecord {
  return {
    id: 'holding-1',
    assetId: 'A1',
    grade: 'PSA 10',
    quantity: 2,
    unitCost: 80,
    costCurrency: 'USD',
    costBasis: 'PURCHASE_INVOICE',
    costSource: 'operator-entry',
    acquiredAt: UNKNOWN,
    fees: UNKNOWN,
    shipping: UNKNOWN,
    createdAt: NOW.toISOString(),
    ...overrides,
  } as HoldingRecord;
}

function sale(overrides: Record<string, unknown> = {}): SaleRecord {
  return {
    id: 'sale-1',
    holdingId: 'holding-1',
    quantity: 2,
    unitProceeds: 150,
    proceedsCurrency: 'USD',
    proceedsBasis: 'SALE_CONTRACT',
    proceedsSource: 'operator-entry',
    soldAt: UNKNOWN,
    fees: UNKNOWN,
    shipping: UNKNOWN,
    createdAt: NOW.toISOString(),
    ...overrides,
  } as SaleRecord;
}

// --- FMV-derived valuation view --------------------------------------------

test('fmvToValuation names the derived basis, source and explicit warnings', () => {
  const view = fmvToValuation(fmv());

  assert.equal(view.value, 105);
  assert.equal(view.basis, 'SOLD_DERIVED');
  assert.equal(view.sourceBasis, 'SOLD');
  assert.equal(view.source, 'ebay_sold');
  assert.equal(view.currency, 'USD');
  assert.equal(view.method, 'RECENCY_WEIGHTED_MEAN_IQR');
  assert.equal(view.sampleSize, 3);
  assert.equal(view.asOf, NOW.toISOString());
  assert.equal(view.band?.low, 100);
  assert.equal(view.band?.high, 110);
  assert.ok(view.warnings.some((warning: string) => /derived/i.test(warning)));
});

test('fmvToValuation keeps an empty SOLD set UNKNOWN instead of zero', () => {
  const view = fmvToValuation(fmv([]));

  assert.equal(view.value, UNKNOWN);
  assert.equal(view.currency, UNKNOWN);
  assert.equal(view.basis, 'SOLD_DERIVED');
  assert.equal(view.confidence, 'UNKNOWN');
  assert.equal(view.sampleSize, 0);
});

// --- Unrealized results ----------------------------------------------------

test('unrealized gain names FMV and cost basis and preserves missing fees, shipping and date', () => {
  const result = buildUnrealized(holding(), fmv());

  assert.equal(result.kind, 'UNREALIZED');
  assert.equal(result.unrealized, 50); // 2 * (105 - 80)
  assert.equal(result.currency, 'USD');
  assert.equal(result.basis, 'SOLD_DERIVED_FMV_MINUS_PURCHASE_INVOICE');
  assert.match(result.source, /ebay_sold/);
  assert.match(result.source, /operator-entry/);
  assert.equal(result.acquiredAt, UNKNOWN);
  assert.equal(result.fees, UNKNOWN);
  assert.equal(result.shipping, UNKNOWN);
  assert.equal(result.feeTreatment, 'UNKNOWN_NOT_SUBTRACTED');
  assert.ok(result.warnings.some((warning: string) => /fees.*UNKNOWN/i.test(warning)));
  assert.ok(result.warnings.some((warning: string) => /shipping.*UNKNOWN/i.test(warning)));
});

test('unrealized gain is UNKNOWN, never zero, when FMV or cost is UNKNOWN', () => {
  const noFmv = buildUnrealized(holding(), null);
  const noCost = buildUnrealized(holding({ unitCost: UNKNOWN }), fmv());

  assert.equal(noFmv.unrealized, UNKNOWN);
  assert.equal(noFmv.basis, 'SOLD_DERIVED_FMV_MINUS_PURCHASE_INVOICE');
  assert.equal(noCost.unrealized, UNKNOWN);
  assert.ok(noFmv.warnings.some((warning: string) => /UNKNOWN/i.test(warning)));
});

test('unrealized gain never converts across currencies', () => {
  const result = buildUnrealized(holding({ costCurrency: 'EUR' }), fmv());

  assert.equal(result.unrealized, UNKNOWN);
  assert.ok(result.warnings.some((warning: string) => /no FX conversion/i.test(warning)));
});

// --- Realized results ------------------------------------------------------

test('realized gain subtracts supplied fees and shipping and names both bases', () => {
  const result = buildRealized(
    sale({ soldAt: '2026-11-20T00:00:00.000Z', fees: 5, shipping: 10 }),
    holding({ acquiredAt: '2026-09-01T00:00:00.000Z' }),
  );

  assert.equal(result.kind, 'REALIZED');
  assert.equal(result.gain, 125); // 2*(150-80) - 5 - 10
  assert.equal(result.basis, 'SALE_CONTRACT_MINUS_PURCHASE_INVOICE');
  assert.match(result.source, /operator-entry/);
  assert.equal(result.fees, 5);
  assert.equal(result.shipping, 10);
  assert.equal(result.feeTreatment, 'INCLUDED');
  assert.equal(result.soldAt, '2026-11-20T00:00:00.000Z');
  assert.equal(result.acquiredAt, '2026-09-01T00:00:00.000Z');
});

test('a realized sale with missing date, fees and shipping reports them as UNKNOWN', () => {
  const result = buildRealized(sale(), holding());

  assert.equal(result.gain, 140); // gross: 2*(150-80)
  assert.equal(result.soldAt, UNKNOWN);
  assert.equal(result.acquiredAt, UNKNOWN);
  assert.equal(result.fees, UNKNOWN);
  assert.equal(result.shipping, UNKNOWN);
  assert.equal(result.feeTreatment, 'UNKNOWN_NOT_SUBTRACTED');
  assert.ok(result.warnings.some((warning: string) => /sale date.*UNKNOWN/i.test(warning)));
  assert.ok(result.warnings.some((warning: string) => /gross/i.test(warning)));
});

test('the store refuses a sale that references an unknown holding', () => {
  const store = createTrackingStore({ now: () => NOW });
  assert.throws(
    () => store.addSale(sale({ holdingId: 'missing' })),
    TrackingValidationError,
  );
  assert.deepEqual(store.listSales(), []);
});

// --- Portfolio totals ------------------------------------------------------

test('portfolio totals stay UNKNOWN when a position has no priced comps', () => {
  const result = buildPortfolio([holding(), holding({ id: 'holding-2', assetId: 'A2' })], [], {
    A1: fmv(),
  });

  assert.equal(result.unrealized.length, 2);
  assert.equal(result.totals.unrealizedGain, UNKNOWN);
  assert.equal(result.totals.complete, false);
  assert.ok(result.warnings.some((warning: string) => /UNKNOWN/i.test(warning)));
});

test('portfolio totals never sum across currencies', () => {
  const result = buildPortfolio(
    [holding(), holding({ id: 'holding-2', assetId: 'A2' })],
    [],
    {
      A1: fmv(),
      A2: fmv([90], { currency: 'EUR' }),
    },
  );

  assert.equal(result.totals.currency, UNKNOWN);
  assert.equal(result.totals.unrealizedGain, UNKNOWN);
  assert.ok(result.warnings.some((warning: string) => /no FX conversion/i.test(warning)));
});

// --- Fee and tax estimates -------------------------------------------------

test('fee estimate is an ESTIMATE with visible assumptions and explicit basis', () => {
  const result = estimateFees({
    price: 200,
    currency: 'USD',
    marketplaceFeeRate: 0.1,
    processingFeeRate: 0.03,
    shippingReserve: 12,
    basisLabel: 'OPERATOR_FEE_TABLE_2026',
    assumptions: ['Marketplace takes 10% of sale price.', 'Buyer pays shipping.'],
  });

  assert.equal(result.kind, 'ESTIMATE');
  assert.equal(result.basis, 'ASSUMED_FEE_SCHEDULE');
  assert.equal(result.estimate, 38); // 20 + 6 + 12
  assert.deepEqual(result.breakdown, {
    marketplaceFee: 20,
    processingFee: 6,
    shippingReserve: 12,
    total: 38,
  });
  assert.deepEqual(result.assumptions, [
    'Marketplace takes 10% of sale price.',
    'Buyer pays shipping.',
  ]);
  assert.ok(result.warnings.some((warning: string) => /estimate only/i.test(warning)));
  assert.ok(result.warnings.some((warning: string) => /not a fact/i.test(warning)));
});

test('fee estimate stays UNKNOWN for missing price, invalid rate or missing basis', () => {
  const base = {
    price: 200,
    currency: 'USD',
    marketplaceFeeRate: 0.1,
    processingFeeRate: 0.03,
    shippingReserve: 12,
    basisLabel: 'OPERATOR_FEE_TABLE_2026',
    assumptions: ['Assumption one.'],
  };
  for (const override of [
    { price: UNKNOWN },
    { marketplaceFeeRate: 1.5 },
    { processingFeeRate: Number.NaN },
    { basisLabel: '' },
    { assumptions: [] },
  ]) {
    const result = estimateFees({ ...base, ...override } as Parameters<typeof estimateFees>[0]);
    assert.equal(result.estimate, UNKNOWN);
    assert.equal(result.breakdown.total, UNKNOWN);
    assert.ok(result.warnings.length > 0);
  }
});

test('tax estimate is an ESTIMATE with visible assumptions and UNKNOWN inputs', () => {
  const ok = estimateTax({
    gain: 100,
    currency: 'USD',
    rate: 0.2,
    jurisdiction: 'operator-estimate',
    basisLabel: 'OPERATOR_TAX_RATE_2026',
    assumptions: ['Flat 20% estimate.', 'No filing obligation is determined here.'],
  });
  assert.equal(ok.kind, 'ESTIMATE');
  assert.equal(ok.basis, 'ASSUMED_TAX_RATE');
  assert.equal(ok.estimate, 20);
  assert.deepEqual(ok.assumptions, [
    'Flat 20% estimate.',
    'No filing obligation is determined here.',
  ]);
  assert.ok(ok.warnings.some((warning: string) => /estimate only/i.test(warning)));

  const missing = estimateTax({
    gain: UNKNOWN,
    rate: 0.2,
    basisLabel: 'OPERATOR_TAX_RATE_2026',
    assumptions: ['Flat 20% estimate.'],
  });
  assert.equal(missing.estimate, UNKNOWN);
});

// --- Alert rules and in-app state ------------------------------------------

function rule(overrides: Record<string, unknown> = {}): AlertRuleRecord {
  return {
    id: 'rule-1',
    targetId: 'A1',
    metric: 'FMV_BELOW',
    threshold: 100,
    basis: 'SOLD_DERIVED',
    grade: UNKNOWN,
    active: true,
    createdAt: NOW.toISOString(),
    ...overrides,
  } as AlertRuleRecord;
}

function snapshot(overrides: Record<string, unknown> = {}): MetricSnapshot {
  return {
    targetId: 'A1',
    basis: 'SOLD_DERIVED',
    source: 'ebay_sold',
    value: 105,
    sampleSize: 3,
    observedAt: NOW.toISOString(),
    ...overrides,
  } as MetricSnapshot;
}

test('alerts trigger only on known SOLD_DERIVED values and name basis and source', () => {
  const { states } = evaluateAlerts(
    [rule({ threshold: 110 }), rule({ id: 'rule-2', metric: 'FMV_ABOVE', threshold: 110 })],
    [snapshot()],
    { now: NOW },
  );

  assert.equal(states.length, 2);
  assert.equal(states[0].status, 'TRIGGERED');
  assert.equal(states[0].value, 105);
  assert.equal(states[0].basis, 'SOLD_DERIVED');
  assert.equal(states[0].source, 'ebay_sold');
  assert.equal(states[0].acknowledged, false);
  assert.equal(states[1].status, 'NOT_TRIGGERED');
});

test('two rules on one target use their own grade snapshot without cross-talk', () => {
  const psa9 = rule({ id: 'rule-9', grade: 'PSA 9', metric: 'FMV_BELOW', threshold: 120 });
  const psa10 = rule({ id: 'rule-10', grade: 'PSA 10', metric: 'FMV_BELOW', threshold: 120 });
  const { states } = evaluateAlerts([psa9, psa10], [
    snapshot({ grade: 'PSA 9', value: 90, source: 'psa9_sold' }),
    snapshot({ grade: 'PSA 10', value: 200, source: 'psa10_sold' }),
  ], { now: NOW });

  const ninth = states.find((state) => state.ruleId === 'rule-9');
  const tenth = states.find((state) => state.ruleId === 'rule-10');
  assert.equal(ninth?.value, 90, 'the PSA 9 rule sees the PSA 9 mark');
  assert.equal(ninth?.status, 'TRIGGERED');
  assert.equal(ninth?.grade, 'PSA 9');
  assert.equal(ninth?.source, 'psa9_sold');
  assert.equal(tenth?.value, 200, 'the PSA 10 rule sees the PSA 10 mark');
  assert.equal(tenth?.status, 'NOT_TRIGGERED');
  assert.equal(tenth?.grade, 'PSA 10');
  assert.equal(tenth?.source, 'psa10_sold');
  assert.match(tenth?.detail ?? '', /PSA 10/);
});

test('a rule with no snapshot for its own grade stays UNKNOWN even when another grade exists', () => {
  const { states } = evaluateAlerts(
    [rule({ grade: 'PSA 10' })],
    [snapshot({ grade: 'PSA 9', value: 90 })],
    { now: NOW },
  );
  assert.equal(states[0].status, 'UNKNOWN');
  assert.equal(states[0].grade, 'PSA 10');
  assert.match(states[0].detail, /PSA 10/);
});

test('an UNKNOWN FMV produces an UNKNOWN alert state and never a trigger', () => {
  const { states } = evaluateAlerts([rule()], [snapshot({ value: UNKNOWN })], { now: NOW });

  assert.equal(states[0].status, 'UNKNOWN');
  assert.match(states[0].detail, /UNKNOWN/);
  assert.equal(states[0].triggeredAt, UNKNOWN);
});

test('a rule is not evaluated against a different basis', () => {
  const { states, warnings } = evaluateAlerts(
    [rule()],
    [snapshot({ basis: 'ASKING', value: 1 })],
    { now: NOW },
  );

  assert.equal(states[0].status, 'UNKNOWN');
  assert.match(states[0].detail, /basis/i);
  assert.ok(warnings.some((warning: string) => /basis/i.test(warning)));
});

test('DROP_PCT requires a known previous value and triggers on a documented drop', () => {
  const dropRule = rule({ metric: 'FMV_DROP_PCT', threshold: 10 });
  const unknown = evaluateAlerts([dropRule], [snapshot()], { now: NOW });
  const known = evaluateAlerts(
    [dropRule],
    [snapshot({ value: 90, previousValue: 100 })],
    { now: NOW },
  );

  assert.equal(unknown.states[0].status, 'UNKNOWN');
  assert.equal(known.states[0].status, 'TRIGGERED');
  assert.equal(known.states[0].value, 10);
});

test('acknowledged alert state survives an identical refresh but a changed alert reopens', () => {
  const store = createTrackingStore({ now: () => NOW });
  const created = store.addRule(rule());
  const first = evaluateAlerts([created], [snapshot()], { now: NOW }).states;
  let states = store.replaceAlertStates(first);
  assert.equal(states[0].acknowledged, false);
  assert.equal(store.acknowledgeAlert(states[0].id)?.acknowledged, true);

  states = store.replaceAlertStates(
    evaluateAlerts([created], [snapshot()], { now: NOW }).states,
  );
  assert.equal(states[0].acknowledged, true, 'the same alert stays acknowledged');

  states = store.replaceAlertStates(
    evaluateAlerts([{ ...created, threshold: 200 }], [snapshot()], { now: NOW }).states,
  );
  assert.equal(states[0].acknowledged, false, 'a new alert is unacknowledged');
});

test('the store rejects invalid rules and clones records on read', () => {
  const store = createTrackingStore({ now: () => NOW });
  assert.throws(() => store.addRule(rule({ threshold: Number.NaN })), TrackingValidationError);
  assert.throws(
    () => store.addRule(rule({ metric: 'NOT_A_METRIC' })),
    TrackingValidationError,
  );

  const created = store.addRule(rule());
  created.threshold = 999999;
  assert.equal(store.listRules()[0].threshold, 100, 'callers cannot mutate stored rules');

  const held = store.addHolding(holding({ id: undefined }));
  held.unitCost = 0;
  assert.equal(store.listHoldings()[0].unitCost, 80);
});

test('watchlist entries keep grade UNKNOWN when absent and are cloned on read', () => {
  const store = createTrackingStore({ now: () => NOW });
  const item = store.addWatchlist({ targetId: 'A1' });
  assert.equal(item.grade, UNKNOWN);
  assert.equal(item.addedAt, NOW.toISOString());
  item.targetId = 'changed';
  assert.equal(store.listWatchlist()[0].targetId, 'A1');
  assert.equal(store.removeWatchlist(item.id), true);
  assert.deepEqual(store.listWatchlist(), []);
});
