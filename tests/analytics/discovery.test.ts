import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runDiscoverySweep } from '../../server/analytics/discovery.ts';
import type { DiscoveryFinding } from '../../server/contracts/dataProduct.ts';
import {
  FIXED_NOW,
  daysAgo,
  makeEvidence,
  makeObservation,
  makeStore,
  observationsAtBasis,
} from './fixtures.ts';

const SWEEP = { now: FIXED_NOW };

function findingsOf(store: ReturnType<typeof makeStore>) {
  return runDiscoverySweep(store, SWEEP).findings;
}

test('empty evidence deflects with an EVIDENCE_GAP finding and no invented findings', () => {
  const store = makeStore();
  const result = runDiscoverySweep(store, SWEEP);

  assert.equal(result.scanned.observationCount, 0);
  assert.equal(result.findings.length, 1);
  const finding = result.findings[0];
  assert.equal(finding.type, 'EVIDENCE_GAP');
  assert.equal(finding.confidence, 'LOW');
  assert.deepEqual(finding.evidenceIds, []);
  assert.match(finding.summary, /no evidence/i);
  assert.equal(store.listFindings().length, 1);
});

test('active cards are found from recent observations across distinct sources', () => {
  const store = makeStore({
    evidence: [
      makeEvidence({ id: 'e-1' }),
      makeEvidence({ id: 'e-2' }),
      makeEvidence({ id: 'e-3' }),
    ],
    observations: [
      makeObservation({ id: 'o-1', evidenceId: 'e-1', observedAt: daysAgo(1), marketplace: 'ebay' }),
      makeObservation({ id: 'o-2', evidenceId: 'e-2', observedAt: daysAgo(2), marketplace: 'tcgplayer' }),
      makeObservation({ id: 'o-3', evidenceId: 'e-3', observedAt: daysAgo(3), marketplace: 'ebay' }),
    ],
  });

  const active = findingsOf(store).filter((f) => f.type === 'ACTIVE_CARD');
  assert.equal(active.length, 1);
  assert.equal(active[0].targetId, 'card-alpha');
  assert.equal(active[0].confidence, 'HIGH');
  assert.deepEqual(active[0].evidenceIds.sort(), ['e-1', 'e-2', 'e-3'].sort());
  assert.equal(active[0].metrics.distinctSources, 2);
  assert.equal(active[0].metrics.windowDays, 30);
});

test('momentum requires history: a recent burst alone does not produce MOMENTUM', () => {
  const recentOnly = makeStore({
    observations: observationsAtBasis('SOLD', [100, 101, 102]),
  });
  assert.equal(findingsOf(recentOnly).some((f) => f.type === 'MOMENTUM'), false);

  const withHistory = makeStore({
    observations: [
      makeObservation({ id: 'old-90', observedAt: daysAgo(80), amount: 90 }),
      makeObservation({ id: 'old-60', observedAt: daysAgo(60), amount: 91 }),
      ...observationsAtBasis('SOLD', [100, 101, 102]),
    ],
  });
  const momentum = findingsOf(withHistory).find((f) => f.type === 'MOMENTUM');
  assert.ok(momentum);
  assert.equal(momentum.metrics.count7, 3);
  assert.equal(momentum.metrics.count30, 3);
  assert.equal(momentum.metrics.count90, 5);
  assert.equal(momentum.confidence, 'MEDIUM');
});

test('comps are basis-safe and currency-safe: SOLD and ASKING never mix', () => {
  const store = makeStore({
    observations: [
      ...observationsAtBasis('SOLD', [100, 100, 100, 1000]),
      ...observationsAtBasis('ASKING', [1000, 1000, 1000]),
      makeObservation({ id: 'eur-1', basis: 'SOLD', amount: 100, currency: 'EUR' }),
      makeObservation({ id: 'eur-2', basis: 'SOLD', amount: 100, currency: 'EUR' }),
      makeObservation({ id: 'eur-3', basis: 'SOLD', amount: 100, currency: 'EUR' }),
    ],
  });

  const findings = findingsOf(store);
  const anomalies = findings.filter((f) => f.type === 'ANOMALY');
  assert.equal(anomalies.length, 1);
  assert.equal(anomalies[0].metrics.basis, 'SOLD');
  assert.equal(anomalies[0].metrics.currency, 'USD');
  assert.deepEqual(anomalies[0].evidenceIds, ['evidence-sold-3-1000']);
  assert.match(anomalies[0].summary, /SOLD/i);

  // Every comps-derived finding names exactly one basis and one currency.
  for (const finding of findings.filter((f) => ['ANOMALY', 'SPREAD'].includes(f.type))) {
    assert.equal(typeof finding.metrics.basis, 'string');
    assert.ok(['SOLD', 'ASKING', 'OFFER', 'GUIDE', 'CLAIM', 'POPULATION', 'UNKNOWN'].includes(String(finding.metrics.basis)));
    assert.equal(typeof finding.metrics.currency, 'string');
  }
  // The 1000 ASKING prices must never be compared against 100 SOLD prices.
  assert.equal(findings.some((f) => String(f.metrics.basis).includes('|')), false);
});

test('stale sources produce a SOURCE_FRESHNESS finding', () => {
  const store = makeStore({
    observations: [
      makeObservation({ id: 'fresh', observedAt: daysAgo(1), marketplace: 'ebay' }),
      makeObservation({ id: 'stale', observedAt: daysAgo(45), marketplace: 'tcgplayer' }),
    ],
  });
  const freshness = findingsOf(store).find((f) => f.type === 'SOURCE_FRESHNESS');
  assert.ok(freshness);
  assert.equal(freshness.targetId, 'tcgplayer');
});

test('sweeps are idempotent and findings are append-only immutable records', () => {
  const store = makeStore({ observations: observationsAtBasis('SOLD', [100, 101, 102]) });
  const first = runDiscoverySweep(store, SWEEP).findings;
  const second = runDiscoverySweep(store, SWEEP).findings;

  assert.deepEqual(second.map((f) => f.id).sort(), first.map((f) => f.id).sort());
  assert.equal(store.listFindings().length, first.length);

  const stored = store.listFindings()[0] as DiscoveryFinding;
  stored.title = 'mutated';
  assert.notEqual(store.listFindings()[0].title, 'mutated');
});

test('every finding carries provenance, confidence and a timestamp', () => {
  const store = makeStore({
    observations: [
      ...observationsAtBasis('SOLD', [100, 101, 102]),
      makeObservation({ id: 'old', observedAt: daysAgo(80) }),
    ],
  });
  for (const finding of findingsOf(store)) {
    assert.ok(finding.id.startsWith('finding-'));
    assert.ok(!Number.isNaN(Date.parse(finding.createdAt)));
    assert.ok(['LOW', 'MEDIUM', 'HIGH'].includes(finding.confidence));
    assert.ok(Array.isArray(finding.evidenceIds));
    assert.ok(typeof finding.title === 'string' && finding.title.length > 0);
    assert.ok(typeof finding.summary === 'string' && finding.summary.length > 0);
    assert.ok(finding.metrics && typeof finding.metrics === 'object');
  }
});
