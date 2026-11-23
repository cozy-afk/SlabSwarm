import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MarketBasis, MarketObservation } from '../../server/contracts/dataProduct.ts';
import {
  FACTOR_KEYS,
  computeFactorPack,
  factorByKey,
  type FactorInput,
  type PopulationSnapshot,
} from '../../server/forecast/factors.ts';

const NOW = new Date('2026-06-30T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const TARGET = 'card-x';

function at(daysAgo: number): string {
  return new Date(NOW.getTime() - daysAgo * DAY).toISOString();
}

function obs(
  id: string,
  basis: MarketBasis,
  amount: number,
  daysAgo: number,
  status: MarketObservation['status'] = 'NORMALIZED',
  marketplace = 'ebay',
): MarketObservation {
  return {
    id,
    evidenceId: `ev-${id}`,
    targetIdentityRef: TARGET,
    basis,
    amount,
    currency: 'USD',
    marketplace,
    observedAt: at(daysAgo),
    status,
  } as MarketObservation;
}

function pack(input: FactorInput) {
  return computeFactorPack(TARGET, input, { now: NOW });
}

test('price momentum compares trailing 7d, 30d and 90d SOLD windows only', () => {
  const result = pack({
    observations: [
      obs('s1', 'SOLD', 120, 2),
      obs('s2', 'SOLD', 130, 5),
      obs('s3', 'SOLD', 100, 12),
      obs('s4', 'SOLD', 100, 20),
      obs('s5', 'SOLD', 90, 45),
      obs('s6', 'SOLD', 90, 80),
      // Non-SOLD, bad timestamp and superseded rows must never feed momentum.
      obs('a1', 'ASKING', 999999, 2),
      obs('g1', 'GUIDE', 999999, 2),
      { ...obs('bad', 'SOLD', 999999, 2), observedAt: 'not-a-date' },
      obs('sup', 'SOLD', 999999, 2, 'SUPERSEDED'),
    ],
  });
  const short = factorByKey(result, 'price_momentum_7d_30d');
  const long = factorByKey(result, 'price_momentum_30d_90d');
  // avg7 = 125, avg30 = 112.5, avg90 = 105.
  assert.equal(short.value, 0.111111);
  assert.equal(long.value, 0.071429);
  assert.equal(short.basis, 'SOLD');
  assert.deepEqual(short.derivedFrom, ['SOLD']);
  assert.equal(short.source, 'ebay');
  assert.equal(short.confidence, 'MEDIUM');
  assert.ok(short.evidenceIds.includes('s1'));
  assert.ok(!short.evidenceIds.includes('a1'));
  assert.ok(!short.evidenceIds.includes('sup'));
});

test('momentum is UNKNOWN when a comparison window has no SOLD evidence', () => {
  const result = pack({ observations: [obs('old', 'SOLD', 100, 60)] });
  for (const key of ['price_momentum_7d_30d', 'price_momentum_30d_90d'] as const) {
    const factor = factorByKey(result, key);
    assert.equal(factor.value, 'UNKNOWN', `${key} must be UNKNOWN, never zero`);
    assert.equal(factor.basis, 'UNKNOWN');
    assert.equal(factor.source, 'UNKNOWN');
    assert.equal(factor.confidence, 'UNKNOWN');
    assert.match(String(factor.reason), /INSUFFICIENT_SOLD/);
  }
});

test('absorption ratio is SOLD-in-30d over active ASKING listings', () => {
  const result = pack({
    observations: [
      obs('s1', 'SOLD', 100, 3),
      obs('s2', 'SOLD', 110, 10),
      obs('s3', 'SOLD', 120, 40), // outside the 30d sold window
      obs('a1', 'ASKING', 200, 1),
      obs('a2', 'ASKING', 210, 1),
      obs('a3', 'ASKING', 220, 1),
      obs('a4', 'ASKING', 230, 1),
    ],
  });
  const factor = factorByKey(result, 'absorption_ratio');
  assert.equal(factor.value, 0.5);
  assert.equal(factor.basis, 'SOLD');
  assert.deepEqual(factor.derivedFrom, ['SOLD', 'ASKING']);
  assert.equal(factor.confidence, 'MEDIUM');
  assert.deepEqual(factor.metrics.soldCount30d, 2);
  assert.deepEqual(factor.metrics.activeListings, 4);
});

test('absorption is UNKNOWN with no active listings instead of Infinity', () => {
  const result = pack({ observations: [obs('s1', 'SOLD', 100, 3)] });
  const factor = factorByKey(result, 'absorption_ratio');
  assert.equal(factor.value, 'UNKNOWN');
  assert.equal(factor.basis, 'UNKNOWN');
  assert.equal(factor.confidence, 'UNKNOWN');
  assert.match(String(factor.reason), /NO_ACTIVE_LISTINGS/);
});

test('population velocity uses population snapshots when present', () => {
  const snapshots: PopulationSnapshot[] = [
    { observedAt: at(60), count: 100, source: 'psa', evidenceId: 'ev-pop-1' },
    { observedAt: at(30), count: 130, source: 'psa', evidenceId: 'ev-pop-2' },
  ];
  const result = pack({ observations: [], populationSnapshots: snapshots });
  const factor = factorByKey(result, 'population_velocity');
  assert.equal(factor.value, 0.3); // +30% over the 30-day interval
  assert.equal(factor.basis, 'POPULATION');
  assert.equal(factor.source, 'psa');
  assert.equal(factor.confidence, 'MEDIUM');
  assert.ok(factor.evidenceIds.includes('ev-pop-2'));
});

test('population velocity falls back to POPULATION-basis observations', () => {
  const result = pack({
    observations: [
      obs('p1', 'POPULATION', 100, 60),
      obs('p2', 'POPULATION', 130, 30),
    ],
  });
  const factor = factorByKey(result, 'population_velocity');
  assert.equal(factor.value, 0.3);
  assert.equal(factor.basis, 'POPULATION');
});

test('population velocity is UNKNOWN below two snapshots or a zero baseline', () => {
  const one = pack({
    observations: [],
    populationSnapshots: [{ observedAt: at(30), count: 100, source: 'psa' }],
  });
  assert.equal(factorByKey(one, 'population_velocity').value, 'UNKNOWN');

  const zero = pack({
    observations: [],
    populationSnapshots: [
      { observedAt: at(60), count: 0, source: 'psa' },
      { observedAt: at(30), count: 10, source: 'psa' },
    ],
  });
  const factor = factorByKey(zero, 'population_velocity');
  assert.equal(factor.value, 'UNKNOWN');
  assert.match(String(factor.reason), /POPULATION/);
});

test('attention and catalyst stay UNKNOWN until a licensed source is approved', () => {
  const result = pack({
    observations: [
      obs('s1', 'SOLD', 100, 3),
      obs('a1', 'ASKING', 200, 1),
    ],
    populationSnapshots: [
      { observedAt: at(60), count: 100, source: 'psa' },
      { observedAt: at(30), count: 130, source: 'psa' },
    ],
  });
  for (const key of ['attention_delta', 'catalyst_score'] as const) {
    const factor = factorByKey(result, key);
    assert.equal(factor.value, 'UNKNOWN');
    assert.equal(factor.basis, 'UNKNOWN');
    assert.equal(factor.source, 'UNKNOWN');
    assert.equal(factor.confidence, 'UNKNOWN');
    assert.equal(factor.reason, 'LICENSED_SOURCE_NOT_APPROVED');
  }
});

test('factor pack is complete, deterministic and never fabricates numeric values', () => {
  const input: FactorInput = {
    observations: [obs('s1', 'SOLD', 100, 3), obs('a1', 'ASKING', 200, 1)],
  };
  // Input is frozen: computing a pack must be a pure read.
  Object.freeze(input.observations);
  for (const row of input.observations) Object.freeze(row);
  Object.freeze(input);

  const first = pack(input);
  const second = pack(input);
  assert.deepEqual(first, second);
  assert.deepEqual([...first.factors.map((f) => f.key)].sort(), [...FACTOR_KEYS].sort());
  for (const factor of first.factors) {
    for (const field of ['basis', 'source', 'confidence'] as const) {
      assert.ok(field in factor, `${factor.key} missing ${field}`);
      assert.equal(typeof factor[field], 'string');
    }
    if (typeof factor.value === 'number') {
      assert.ok(Number.isFinite(factor.value), `${factor.key} produced a non-finite number`);
    } else {
      assert.equal(factor.value, 'UNKNOWN');
    }
  }
  assert.equal(input.observations.length, 2, 'input observations were mutated');
});
