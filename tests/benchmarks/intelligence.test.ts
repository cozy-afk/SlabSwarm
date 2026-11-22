import assert from 'node:assert/strict';
import { test } from 'node:test';

/**
 * Phase 4 — INTELLIGENCE lane golden benchmark suite.
 *
 * Deterministic, network-free regression tripwires over the whole pipeline:
 * bounded packet -> swarm -> simulation -> forecast -> score -> backtest ->
 * gated learning. Golden constants below were produced by real execution of
 * this lane's code and must not drift silently.
 */

import {
  REGISTERED_TOOLS,
  buildEvidencePacket,
  invokeTool,
  type EvidenceItem,
} from '../../server/swarm/tools.ts';
import { ROLES, runRole } from '../../server/swarm/roles.ts';
import { runSwarmResearch, swarmRunStore } from '../../server/swarm/run.ts';
import { runSimulation, type ScenarioSpec } from '../../server/simulation/engine.ts';
import { createForecast, forecastRepository } from '../../server/forecast/repository.ts';
import { forecastScoreRepository, scoreAndRecord } from '../../server/forecast/scoring.ts';
import { backtestRepository, runBacktest } from '../../server/forecast/backtest.ts';
import {
  getLearningState,
  resetLearningState,
  runLearningCycle,
  type BenchmarkResult,
} from '../../server/forecast/learning.ts';
import { createIntelligenceRouter } from '../../server/routes/intelligence.ts';

const EVIDENCE: EvidenceItem[] = [
  { id: 'ev-claim', source: 'forum', observedAt: '2026-06-20T00:00:00.000Z', capturedAt: '2026-06-20T01:00:00.000Z', basis: 'CLAIM', kind: 'event', summary: 'reprint announcement rumour', confidence: 'LOW' },
  { id: 'ev-event', source: 'event-feed', observedAt: '2026-06-22T00:00:00.000Z', capturedAt: '2026-06-22T01:00:00.000Z', basis: 'UNKNOWN', kind: 'event', summary: 'tournament announced', confidence: 'MEDIUM' },
  { id: 'ev-sold-1', source: 'sold-feed', observedAt: '2026-06-24T00:00:00.000Z', capturedAt: '2026-06-24T01:00:00.000Z', basis: 'SOLD', summary: 'SOLD 100 USD', amount: 100, confidence: 'HIGH' },
  { id: 'ev-sold-2', source: 'sold-feed', observedAt: '2026-06-26T00:00:00.000Z', capturedAt: '2026-06-26T01:00:00.000Z', basis: 'SOLD', summary: 'SOLD 110 USD', amount: 110, confidence: 'HIGH' },
];

const SPEC: ScenarioSpec = {
  id: 'golden-scenario',
  targetId: 'card-golden',
  targetType: 'CARD',
  horizonDays: 30,
  seed: 7,
  baselinePrice: 105,
  currency: 'USD',
  demandShock: 0.2,
  supplyShock: -0.05,
  events: [
    { day: 7, type: 'REPRINT_RUMOUR', magnitude: -0.2, evidenceId: 'ev-claim' },
    { day: 14, type: 'TOURNAMENT', magnitude: 0.2, evidenceId: 'ev-event' },
  ],
  personas: ['collector', 'flipper'],
  evidenceIds: ['ev-claim', 'ev-event', 'ev-sold-1', 'ev-sold-2'],
  asOf: '2026-07-01T00:00:00.000Z',
};

function resetAll(): void {
  forecastRepository.clear();
  forecastScoreRepository.clear();
  backtestRepository.clear();
  swarmRunStore.clear();
  resetLearningState();
}

function seedForecast() {
  return createForecast({
    targetType: 'CARD',
    targetId: 'card-golden',
    horizonDays: 30,
    scenario: 'golden-scenario',
    priceBands: { low: 95, base: 110, high: 125, currency: 'USD' },
    demandPressure: 'HIGH',
    supplyPressure: 'MEDIUM',
    drivers: ['SOLD comps'],
    invalidators: ['reprint'],
    evidenceIds: ['ev-sold-1', 'ev-sold-2'],
    confidence: 'HIGH',
    createdAt: '2026-07-01T00:00:00.000Z',
    baselinePrice: 105,
  });
}

test('benchmark: bounded packet + swarm + simulation golden digests are stable', () => {
  const packet = buildEvidencePacket({ items: EVIDENCE });
  assert.equal(
    packet.digest,
    '9ba5290a7b5f9ac10dd3b69030fadcbc2737a0a8641aa0060501d274ea513e16',
    'golden evidence packet digest drifted',
  );
  assert.deepEqual(packet.evidenceIds, ['ev-claim', 'ev-event', 'ev-sold-1', 'ev-sold-2']);

  const tool = invokeTool({ tool: 'get_comps', args: { evidenceIds: packet.evidenceIds } }, { packet });
  assert.deepEqual((tool.data as { items: Array<{ id: string }> }).items.map((i) => i.id), ['ev-sold-1', 'ev-sold-2']);
  for (const role of ROLES) {
    assert.deepEqual(runRole(role, packet), runRole(role, packet));
  }

  swarmRunStore.clear();
  const run = runSwarmResearch({ targetId: 'card-golden', evidence: EVIDENCE, asOf: '2026-07-01T00:00:00.000Z' });
  assert.equal(run.decision, 'ACCEPT');
  assert.deepEqual(run.packetDigest, packet.digest);

  const sim = runSimulation(SPEC);
  assert.equal(sim.id, 'sim-2c59debf7a2830e3', 'golden simulation identity drifted');
  assert.deepEqual(sim.priceBands, { low: 99.75, base: 107.34, high: 112.98, currency: 'USD' });
  assert.equal(sim.status, 'HYPOTHESIS');
});

test('benchmark: scoring golden values — coverage, direction, MAE and Brier', () => {
  resetAll();
  const forecast = seedForecast();
  const score = scoreAndRecord(forecast.id, {
    realizedPrice: 112,
    observedAt: '2026-07-31T00:00:00.000Z',
    evidenceIds: ['ev-outcome'],
  });
  assert.equal(score.bandCovered, true);
  assert.equal(score.directionCorrect, true);
  assert.equal(score.mae, 2);
  assert.equal(score.brier, 0.04);
  assert.equal(score.horizonDays, 30);
  assert.equal(forecast.status, 'SCORED');
});

test('benchmark: backtest uses only pre-event evidence and beats the naive baseline', () => {
  resetAll();
  const forecast = seedForecast();
  const result = runBacktest({
    forecastId: forecast.id,
    events: [
      { eventAt: '2026-07-08T00:00:00.000Z', realizedPrice: 108, evidenceIds: ['ev-sold-2'] },
      { eventAt: '2026-07-22T00:00:00.000Z', realizedPrice: 118, evidenceIds: ['ev-outcome'] },
    ],
    evidence: [
      { id: 'ev-sold-1', observedAt: '2026-06-24T00:00:00.000Z', capturedAt: '2026-06-24T01:00:00.000Z', price: 100, basis: 'SOLD' },
      { id: 'ev-sold-2', observedAt: '2026-06-26T00:00:00.000Z', capturedAt: '2026-06-26T01:00:00.000Z', price: 110, basis: 'SOLD' },
      { id: 'ev-leak', observedAt: '2026-07-01T00:00:00.000Z', capturedAt: '2026-08-30T00:00:00.000Z', price: 999, basis: 'SOLD' },
    ],
    asOf: '2026-08-01T00:00:00.000Z',
  });
  assert.deepEqual(result.usedEvidenceIds, ['ev-sold-1', 'ev-sold-2']);
  assert.deepEqual(result.leakedEvidenceIds, ['ev-leak']);
  assert.equal(result.mae, 5.666666);
  assert.equal(result.baselineMae, 8);
  assert.equal(result.bandCoverage, 1);
  assert.equal(result.verdict, 'NON_REGRESSION');
});

const REGRESSION: BenchmarkResult = {
  baselineMae: 10,
  candidateMae: 14,
  baselineCoverage: 0.6,
  candidateCoverage: 0.4,
  nonRegression: false,
};

test('benchmark: learning promotes only on non-regression and is reproducible', () => {
  function runOnce() {
    resetAll();
    const forecast = seedForecast();
    scoreAndRecord(forecast.id, {
      realizedPrice: 112,
      observedAt: '2026-07-31T00:00:00.000Z',
      evidenceIds: ['ev-outcome'],
    });
    // A non-regressing backtest is the benchmark evidence the cycle promotes on.
    runBacktest({
      forecastId: forecast.id,
      events: [{ eventAt: '2026-07-08T00:00:00.000Z', realizedPrice: 108, evidenceIds: ['ev-sold-1'] }],
      evidence: [
        { id: 'ev-sold-1', observedAt: '2026-06-24T00:00:00.000Z', capturedAt: '2026-06-24T01:00:00.000Z', price: 100, basis: 'SOLD' },
      ],
      asOf: '2026-08-01T00:00:00.000Z',
    });
    const blocked = runLearningCycle({ benchmark: REGRESSION, asOf: '2026-08-02T00:00:00.000Z' });
    const blockedState = getLearningState();
    const promoted = runLearningCycle({ asOf: '2026-08-02T00:00:00.000Z' });
    return { blocked, blockedState, promoted, state: getLearningState() };
  }

  const a = runOnce();
  const b = runOnce();
  assert.deepEqual(a, b, 'learning benchmark must be reproducible');
  assert.equal(a.blocked.promoted, false);
  assert.equal(a.blocked.reason, 'BENCHMARK_REGRESSION');
  assert.equal(a.blockedState.version, 1);
  assert.equal(a.promoted.promoted, true);
  assert.equal(a.promoted.reason, 'BENCHMARK_NON_REGRESSION');
  assert.equal(a.state.version, 2);
  assert.deepEqual(a.state.sourceTrust, { 'ev-sold-1': 0.1, 'ev-sold-2': 0.1 });
  assert.equal(a.state.factorWeights['band_coverage'], 1);
  assert.ok(Object.keys(a.state.personaParams).length > 0);
  assert.equal(a.state.calibration.HIGH.count, 1);
  assert.equal(a.state.calibration.HIGH.meanBrier, 0.04);
});

test('benchmark: router exposes every Phase 4 endpoint without registering a listener', () => {
  const router = createIntelligenceRouter() as unknown as {
    stack: Array<{ route?: { methods: Record<string, boolean>; path: string } }>;
  };
  const routes = router.stack
    .filter((layer) => Boolean(layer.route))
    .map((layer) => `${Object.keys(layer.route!.methods)[0].toUpperCase()} ${layer.route!.path}`);
  for (const expected of [
    'POST /api/swarm/research/run',
    'GET /api/swarm/runs/:id',
    'POST /api/simulations/run',
    'POST /api/forecasts',
    'GET /api/forecasts/:id',
    'POST /api/forecasts/:id/score',
    'POST /api/forecasts/:id/backtest',
    'GET /api/learning/state',
    'POST /api/learning/feedback',
    'POST /api/learning/run-cycle',
  ]) {
    assert.ok(routes.includes(expected), `missing endpoint: ${expected}`);
  }
  assert.equal(REGISTERED_TOOLS.length, 12);
});
