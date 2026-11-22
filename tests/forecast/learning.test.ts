import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addLearningFeedback,
  getLearningState,
  learningEventRepository,
  runLearningCycle,
  resetLearningState,
  type BenchmarkResult,
} from '../../server/forecast/learning.ts';
import { forecastRepository, createForecast } from '../../server/forecast/repository.ts';
import { scoreAndRecord, forecastScoreRepository } from '../../server/forecast/scoring.ts';
import { backtestRepository } from '../../server/forecast/backtest.ts';

const PASS: BenchmarkResult = {
  baselineMae: 10,
  candidateMae: 8,
  baselineCoverage: 0.6,
  candidateCoverage: 0.8,
  nonRegression: true,
};
const FAIL: BenchmarkResult = { ...PASS, candidateMae: 14, candidateCoverage: 0.4, nonRegression: false };

function seedScore() {
  forecastRepository.clear();
  forecastScoreRepository.clear();
  const forecast = createForecast({
    targetType: 'CARD',
    targetId: 'card-x',
    horizonDays: 30,
    scenario: 'baseline',
    priceBands: { low: 95, base: 110, high: 125, currency: 'USD' },
    demandPressure: 'HIGH',
    supplyPressure: 'MEDIUM',
    drivers: ['SOLD comps'],
    invalidators: ['reprint'],
    evidenceIds: ['ev-source-1'],
    confidence: 'HIGH',
    createdAt: '2026-07-01T00:00:00.000Z',
    baselinePrice: 100,
  });
  return scoreAndRecord(forecast.id, {
    realizedPrice: 112,
    observedAt: '2026-07-31T00:00:00.000Z',
    evidenceIds: ['ev-outcome'],
  });
}

test('initial learning state is neutral and exposes all four learned surfaces', () => {
  resetLearningState();
  const state = getLearningState();
  assert.equal(state.version, 1);
  assert.equal(state.cycleCount, 0);
  assert.equal(state.lastCycleAt, null);
  assert.deepEqual(state.sourceTrust, {});
  assert.deepEqual(state.factorWeights, {});
  assert.deepEqual(state.personaParams, {});
  assert.deepEqual(Object.keys(state.calibration).sort(), ['HIGH', 'LOW', 'MEDIUM']);
});

test('feedback events require evidence and are appended, never overwritten', () => {
  resetLearningState();
  const event = addLearningFeedback({
    signal: 'band_covered',
    scoreId: 'score-1',
    evidenceIds: ['ev-outcome'],
    createdAt: '2026-08-01T00:00:00.000Z',
  });
  assert.match(event.id, /^learn-\d{6}$/);
  assert.deepEqual(event.evidenceIds, ['ev-outcome']);
  assert.equal(learningEventRepository.all().length, 1);
  assert.throws(
    () => addLearningFeedback({ signal: 'x', evidenceIds: [] }),
    /FEEDBACK_EVIDENCE_REQUIRED/,
  );
});

test('a learning cycle only promotes through a non-regression benchmark gate', () => {
  resetLearningState();
  seedScore();
  const before = getLearningState();
  const blocked = runLearningCycle({ benchmark: FAIL, asOf: '2026-08-02T00:00:00.000Z' });
  assert.equal(blocked.promoted, false);
  assert.equal(blocked.reason, 'BENCHMARK_REGRESSION');
  assert.deepEqual(getLearningState(), before);

  const passed = runLearningCycle({ benchmark: PASS, asOf: '2026-08-02T00:00:00.000Z' });
  assert.equal(passed.promoted, true);
  assert.equal(passed.reason, 'BENCHMARK_NON_REGRESSION');
  const after = getLearningState();
  assert.equal(after.version, 2);
  assert.equal(after.cycleCount, 1);
  assert.equal(after.lastCycleAt, '2026-08-02T00:00:00.000Z');
  assert.ok(after.sourceTrust['ev-source-1'] > 0, 'covered forecast raises source trust');
  assert.ok(after.factorWeights['band_coverage'] > 0);
  assert.ok(Object.keys(after.personaParams).length > 0);
  assert.ok(after.calibration.HIGH.count > 0);
});

test('learning cycles are deterministic for the same scores and benchmark', () => {
  resetLearningState();
  seedScore();
  const a = runLearningCycle({ benchmark: PASS, asOf: '2026-08-02T00:00:00.000Z' });
  const firstState = getLearningState();
  resetLearningState();
  seedScore();
  const b = runLearningCycle({ benchmark: PASS, asOf: '2026-08-02T00:00:00.000Z' });
  assert.deepEqual(a, b);
  assert.deepEqual(getLearningState(), firstState);
});

test('without backtest benchmark evidence the cycle refuses to promote', () => {
  resetLearningState();
  backtestRepository.clear();
  seedScore();
  const result = runLearningCycle({ asOf: '2026-08-02T00:00:00.000Z' });
  assert.equal(result.promoted, false);
  assert.equal(result.reason, 'NO_BENCHMARK_EVIDENCE');
});
