import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { MarketObservation } from '../../server/contracts/dataProduct.ts';
import {
  buildPriceSummary,
  toObservationFact,
} from '../../server/serving/market.ts';
import {
  UNKNOWN_VALUE,
  computeFmv,
  estimateCrossGradeFmv,
  fromObservationFact,
  type FmvEvidence,
} from '../../server/valuation/fmv.ts';

const FIXED_NOW = new Date('2026-11-22T00:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function sold(
  id: string,
  amount: number,
  ageDays: number,
  extras: Partial<FmvEvidence> = {},
): FmvEvidence {
  return {
    id,
    basis: 'SOLD',
    amount,
    observedAt: new Date(FIXED_NOW.getTime() - ageDays * DAY_MS).toISOString(),
    currency: 'USD',
    source: 'ebay_sold',
    ...extras,
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function observation(
  id: string,
  basis: MarketObservation['basis'],
  amount: number,
  marketplace: string,
): MarketObservation {
  return {
    id,
    evidenceId: `evidence-${id}`,
    targetIdentityRef: 'A1',
    basis,
    amount,
    currency: 'USD',
    marketplace,
    observedAt: '2026-11-20T00:00:00.000Z',
    status: 'NORMALIZED',
  };
}

// ---------------------------------------------------------------------------
// Recency-weighted decay over SOLD evidence only
// ---------------------------------------------------------------------------

test('recency decay weights a recent SOLD comp more than an older one', () => {
  const out = computeFmv(
    'A1',
    [sold('recent', 100, 0), sold('old', 200, 90)],
    { now: FIXED_NOW, halfLifeDays: 30 },
  );

  // Weight of the 90-day-old sale = 0.5^(90/30) = 0.125.
  // (100*1 + 200*0.125) / (1 + 0.125) = 111.11 (rounded).
  assert.equal(out.value, 111.11);
  assert.equal(out.kind, 'DERIVED');
  assert.equal(out.basis, 'SOLD_DERIVED');
  assert.equal(out.sourceBasis, 'SOLD');
  assert.equal(out.method, 'RECENCY_WEIGHTED_MEAN_IQR');
  assert.equal(out.sampleSize, 2);
});

test('SOLD comps with the same observedAt reduce to a plain mean', () => {
  const out = computeFmv(
    'A1',
    [sold('a', 100, 0), sold('b', 200, 0)],
    { now: FIXED_NOW, halfLifeDays: 30 },
  );
  assert.equal(out.value, 150);
});

// ---------------------------------------------------------------------------
// IQR outlier removal
// ---------------------------------------------------------------------------

test('IQR removes an extreme SOLD outlier without deleting the evidence row', () => {
  const out = computeFmv(
    'A1',
    [
      sold('s1', 100, 0),
      sold('s2', 105, 0),
      sold('s3', 110, 0),
      sold('s4', 115, 0),
      sold('outlier', 1000, 0),
    ],
    { now: FIXED_NOW },
  );

  // Q1=105, Q3=115, IQR=10, upper fence=130 -> 1000 is excluded.
  assert.equal(out.value, 107.5);
  assert.equal(out.sampleSize, 4);
  assert.ok(!out.inlierIds.includes('outlier'));
  assert.ok(
    out.excluded.some((row) => row.id === 'outlier' && row.reason === 'IQR_OUTLIER'),
  );
  assert.deepEqual([out.band.low, out.band.high], [100, 115]);
});

test('IQR keeps every comp when no value crosses a fence', () => {
  const out = computeFmv(
    'A1',
    [80, 100, 110, 120, 130].map((amount, i) => sold(`s${i}`, amount, 0)),
    { now: FIXED_NOW },
  );
  assert.equal(out.value, 108);
  assert.equal(out.sampleSize, 5);
  assert.deepEqual(out.excluded, []);
});

test('confidence bands use the observed inlier range and expose sample support', () => {
  const tight = computeFmv(
    'A1',
    [98, 100, 102].map((amount, i) => sold(`t${i}`, amount, 0)),
    { now: FIXED_NOW },
  );
  const wide = computeFmv(
    'A1',
    [80, 100, 130].map((amount, i) => sold(`w${i}`, amount, 0)),
    { now: FIXED_NOW },
  );

  assert.equal(tight.band.method, 'IQR_INLIER_RANGE');
  assert.deepEqual([tight.band.low, tight.band.high], [98, 102]);
  assert.deepEqual([wide.band.low, wide.band.high], [80, 130]);
  const tightWidth = (tight.band.high as number) - (tight.band.low as number);
  const wideWidth = (wide.band.high as number) - (wide.band.low as number);
  assert.ok(wideWidth > tightWidth);
  assert.equal(tight.confidence, 'MEDIUM');
  assert.equal(tight.sampleSize, 3);
});

// ---------------------------------------------------------------------------
// Basis separation and UNKNOWN preservation
// ---------------------------------------------------------------------------

test('ASKING and GUIDE rows are counted but never priced as SOLD', () => {
  const out = computeFmv(
    'A1',
    [
      sold('s1', 100, 0),
      sold('s2', 110, 0),
      { ...sold('ask', 500, 0), basis: 'ASKING' },
      { ...sold('guide', 5, 0), basis: 'GUIDE' },
    ],
    { now: FIXED_NOW },
  );

  assert.equal(out.value, 105);
  assert.equal(out.basisBreakdown.SOLD, 2);
  assert.equal(out.basisBreakdown.ASKING, 1);
  assert.equal(out.basisBreakdown.GUIDE, 1);
  assert.equal(out.excluded.filter((row) => row.reason === 'NON_SOLD_BASIS').length, 2);
  assert.ok(out.warnings.some((warning) => /non-SOLD/i.test(warning)));
  assert.ok(!JSON.stringify(out).includes('"500"'));
});

test('missing amounts and timestamps stay UNKNOWN and are never coerced to zero', () => {
  const out = computeFmv(
    'A1',
    [
      sold('ok', 100, 0),
      { ...sold('unknown', 0, 0), amount: UNKNOWN_VALUE },
      { ...sold('null', 0, 0), amount: null },
      { ...sold('nan', 0, 0), amount: Number.NaN },
      { ...sold('no-date', 100, 0), observedAt: UNKNOWN_VALUE },
    ],
    { now: FIXED_NOW },
  );

  assert.equal(out.value, 100);
  assert.notEqual(out.value, 0);
  assert.equal(out.sampleSize, 1);
  assert.equal(out.excluded.filter((row) => row.reason === 'AMOUNT_UNKNOWN').length, 3);
  assert.ok(out.excluded.some((row) => row.reason === 'OBSERVED_AT_UNKNOWN'));
  assert.deepEqual(out.inlierIds, ['ok']);
});

test('no usable SOLD evidence yields UNKNOWN FMV with an explicit UNKNOWN confidence', () => {
  const out = computeFmv(
    'A1',
    [
      { ...sold('ask', 250, 0), basis: 'ASKING' },
      { ...sold('empty', 100, 0), amount: UNKNOWN_VALUE },
    ],
    { now: FIXED_NOW },
  );

  assert.equal(out.value, UNKNOWN_VALUE);
  assert.equal(out.band.low, UNKNOWN_VALUE);
  assert.equal(out.band.high, UNKNOWN_VALUE);
  assert.equal(out.confidence, 'UNKNOWN');
  assert.equal(out.sampleSize, 0);
  assert.ok(out.warnings.some((warning) => /UNKNOWN/i.test(warning)));
});

test('currency groups are isolated with no FX conversion', () => {
  const out = computeFmv(
    'A1',
    [
      sold('usd1', 100, 0),
      sold('usd2', 110, 0),
      sold('eur', 200, 0, { currency: 'EUR' }),
    ],
    { now: FIXED_NOW },
  );

  assert.equal(out.value, 105);
  assert.equal(out.currency, 'USD');
  assert.ok(out.excluded.some((row) => row.id === 'eur' && row.reason === 'OTHER_CURRENCY_GROUP'));
  assert.ok(out.warnings.some((warning) => /no FX conversion/i.test(warning)));
});

test('an optional grade filter keeps only matching SOLD comps', () => {
  const out = computeFmv(
    'A1',
    [
      sold('psa10', 100, 0, { grade: 'PSA 10' }),
      sold('psa9', 50, 0, { grade: 'PSA 9' }),
    ],
    { now: FIXED_NOW, grade: 'PSA 10' },
  );

  assert.equal(out.value, 100);
  assert.equal(out.sampleSize, 1);
  assert.ok(out.excluded.some((row) => row.id === 'psa9' && row.reason === 'OTHER_GRADE'));
});

test('FMV is deterministic and independent of evidence input order', () => {
  const evidence = [
    sold('s1', 100, 1),
    sold('s2', 110, 3),
    sold('s3', 105, 7),
  ];
  const first = computeFmv('A1', evidence, { now: FIXED_NOW });
  const reversed = computeFmv('A1', [...evidence].reverse(), { now: FIXED_NOW });
  const repeated = computeFmv('A1', evidence, { now: FIXED_NOW });

  assert.deepEqual(reversed, first);
  assert.deepEqual(repeated, first);
});

test('FMV exposes inlier lineage and states the band is not a probabilistic interval', () => {
  const out = computeFmv(
    'A1',
    [
      sold('s1', 100, 0, { lineage: ['raw-ebay', 'ev-1'] }),
      sold('s2', 110, 0, { lineage: ['raw-ebay', 'ev-2'] }),
    ],
    { now: FIXED_NOW },
  );

  assert.deepEqual(out.lineage, ['raw-ebay', 'ev-1', 'ev-2']);
  assert.ok(
    out.warnings.some((warning) => /observed IQR-filtered range.*not a probabilistic/i.test(warning)),
  );
});

test('a non-finite or non-positive half-life is rejected', () => {
  for (const halfLifeDays of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => computeFmv('A1', [sold('s1', 100, 0)], { now: FIXED_NOW, halfLifeDays }),
      /halfLifeDays/,
    );
  }
});

// ---------------------------------------------------------------------------
// Reuse of the existing pricing read models
// ---------------------------------------------------------------------------

test('existing basis-specific pricing summaries stay separate from the SOLD FMV', () => {
  const facts = [
    toObservationFact(observation('o-sold', 'SOLD', 100, 'ebay_sold'), null),
    toObservationFact(observation('o-ask', 'ASKING', 250, 'ebay_sold'), null),
    toObservationFact(observation('o-guide', 'GUIDE', 5, 'tcgapis'), null),
  ];
  const ask = buildPriceSummary('A1', facts, {
    basis: 'ASKING',
    generatedAt: FIXED_NOW.toISOString(),
  });
  const guide = buildPriceSummary('A1', facts, {
    basis: 'GUIDE',
    generatedAt: FIXED_NOW.toISOString(),
  });
  const fmv = computeFmv('A1', facts.map((fact) => fromObservationFact(fact)), {
    now: FIXED_NOW,
  });

  assert.equal(ask.value.median, 250);
  assert.equal(ask.value.basis, 'ASKING');
  assert.equal(guide.value.median, 5);
  assert.equal(guide.value.basis, 'GUIDE');
  assert.equal(fmv.value, 100);
  assert.equal(fmv.basis, 'SOLD_DERIVED');
});

test('fromObservationFact preserves basis, amount and lineage from the ledger fact', () => {
  const fact = toObservationFact(
    { ...observation('o-ask', 'ASKING', 250, 'ebay_sold'), amount: 0 },
    null,
  );
  const mapped = fromObservationFact(fact, 'PSA 10');

  assert.equal(mapped.basis, 'ASKING');
  assert.equal(mapped.amount, UNKNOWN_VALUE, 'a zero amount stays UNKNOWN');
  assert.equal(mapped.grade, 'PSA 10');
  assert.deepEqual(mapped.lineage, fact.lineage);
  assert.equal(mapped.confidence, fact.confidence);
});

// ---------------------------------------------------------------------------
// Cross-grade imputation is an explicitly labelled estimate
// ---------------------------------------------------------------------------

test('cross-grade imputation is labelled ESTIMATE with its own basis and never relabels a sale', () => {
  const soldRows = [
    sold('p9a', 50, 0, { grade: 'PSA 9' }),
    sold('p9b', 55, 0, { grade: 'PSA 9' }),
    sold('p9c', 60, 0, { grade: 'PSA 9' }),
  ];
  const sourceFmv = computeFmv('A1', soldRows, { now: FIXED_NOW });
  const before = clone(sourceFmv);
  const estimate = estimateCrossGradeFmv({
    targetId: 'A1',
    targetGrade: 'PSA 10',
    sourceGrade: 'PSA 9',
    sourceFmv,
    ratio: 2,
    ratioBasis: 'paired SOLD comps PSA 10 / PSA 9, 3 pairs, 2026-11',
    ratioEvidenceIds: ['pair-1', 'pair-2', 'pair-3'],
    generatedAt: FIXED_NOW.toISOString(),
  });

  assert.equal(sourceFmv.value, 55);
  assert.equal(estimate.value, 110);
  assert.equal(estimate.kind, 'ESTIMATE');
  assert.equal(estimate.basis, 'CROSS_GRADE_ESTIMATE');
  assert.equal(estimate.sourceBasis, 'SOLD');
  assert.match(estimate.basisDetail, /paired SOLD comps/);
  assert.deepEqual(estimate.ratioEvidenceIds, ['pair-1', 'pair-2', 'pair-3']);
  assert.equal(estimate.confidence, 'MEDIUM');
  assert.deepEqual(sourceFmv, before, 'the real SOLD FMV is never overwritten');
  assert.deepEqual(soldRows.map((row) => row.basis), ['SOLD', 'SOLD', 'SOLD']);
  assert.ok(
    estimate.warnings.some((warning) => /no SOLD row was created or relabelled/i.test(warning)),
  );
});

test('cross-grade imputation with an UNKNOWN source FMV never invents a price', () => {
  const sourceFmv = computeFmv('A1', [sold('p9', 100, 0, { amount: UNKNOWN_VALUE })], {
    now: FIXED_NOW,
  });
  const estimate = estimateCrossGradeFmv({
    targetId: 'A1',
    targetGrade: 'PSA 10',
    sourceGrade: 'PSA 9',
    sourceFmv,
    ratio: 2,
    ratioBasis: 'paired SOLD comps',
    ratioEvidenceIds: ['pair-1', 'pair-2', 'pair-3'],
    generatedAt: FIXED_NOW.toISOString(),
  });

  assert.equal(estimate.value, UNKNOWN_VALUE);
  assert.equal(estimate.confidence, 'UNKNOWN');
});

test('cross-grade imputation without a stated ratio basis is not priced', () => {
  const sourceFmv = computeFmv('A1', [sold('p9a', 50, 0), sold('p9b', 60, 0)], {
    now: FIXED_NOW,
  });
  const estimate = estimateCrossGradeFmv({
    targetId: 'A1',
    targetGrade: 'PSA 10',
    sourceGrade: 'PSA 9',
    sourceFmv,
    ratio: 2,
    ratioBasis: '',
    generatedAt: FIXED_NOW.toISOString(),
  });

  assert.equal(estimate.value, UNKNOWN_VALUE);
  assert.equal(estimate.confidence, 'UNKNOWN');
  assert.ok(estimate.warnings.some((warning) => /ratio basis/i.test(warning)));
});

test('cross-grade imputation rejects an unusable ratio instead of pricing from it', () => {
  const sourceFmv = computeFmv('A1', [sold('p9a', 50, 0), sold('p9b', 60, 0)], {
    now: FIXED_NOW,
  });
  for (const ratio of [0, -2, Number.NaN, UNKNOWN_VALUE, null] as const) {
    const estimate = estimateCrossGradeFmv({
      targetId: 'A1',
      targetGrade: 'PSA 10',
      sourceGrade: 'PSA 9',
      sourceFmv,
      ratio,
      ratioBasis: 'paired SOLD comps',
      ratioEvidenceIds: ['pair-1', 'pair-2', 'pair-3'],
      generatedAt: FIXED_NOW.toISOString(),
    });
    assert.equal(estimate.value, UNKNOWN_VALUE);
    assert.equal(estimate.confidence, 'UNKNOWN');
  }
});
