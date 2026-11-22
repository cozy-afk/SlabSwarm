import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  forecastRepository,
  createForecast,
} from '../../server/forecast/repository.ts';
import {
  runBacktest,
  backtestRepository,
  type BacktestEvidence,
  type BacktestInput,
} from '../../server/forecast/backtest.ts';

function setUp() {
  forecastRepository.clear();
  backtestRepository.clear();
  return createForecast({
    targetType: 'CARD',
    targetId: 'card-x',
    horizonDays: 30,
    scenario: 'baseline',
    priceBands: { low: 95, base: 110, high: 125, currency: 'USD' },
    demandPressure: 'HIGH',
    supplyPressure: 'MEDIUM',
    drivers: ['SOLD comps'],
    invalidators: ['reprint'],
    evidenceIds: ['ev-1'],
    confidence: 'HIGH',
    createdAt: '2026-06-01T00:00:00.000Z',
    baselinePrice: 100,
  });
}

const EVIDENCE: BacktestEvidence[] = [
  { id: 'ev-1', observedAt: '2026-05-25T00:00:00.000Z', capturedAt: '2026-05-25T01:00:00.000Z', price: 100, basis: 'SOLD' },
  { id: 'ev-2', observedAt: '2026-06-05T00:00:00.000Z', capturedAt: '2026-06-06T00:00:00.000Z', price: 104, basis: 'SOLD' },
  { id: 'ev-leak', observedAt: '2026-06-01T00:00:00.000Z', capturedAt: '2026-06-30T00:00:00.000Z', price: 999, basis: 'SOLD' },
];

function input(forecastId: string): BacktestInput {
  return {
    forecastId,
    events: [
      { eventAt: '2026-06-08T00:00:00.000Z', realizedPrice: 105, evidenceIds: ['ev-2'] },
      { eventAt: '2026-06-16T00:00:00.000Z', realizedPrice: 112, evidenceIds: ['ev-3'] },
    ],
    evidence: EVIDENCE,
    asOf: '2026-06-20T00:00:00.000Z',
  };
}

test('backtest replays only pre-event evidence and flags future information', () => {
  const forecast = setUp();
  const result = runBacktest(input(forecast.id));
  assert.ok(result.usedEvidenceIds.includes('ev-1'));
  assert.ok(result.usedEvidenceIds.includes('ev-2'));
  assert.ok(!result.usedEvidenceIds.includes('ev-leak'), 'captured-in-future evidence must be excluded');
  assert.deepEqual(result.leakedEvidenceIds, ['ev-leak']);
  for (const point of result.points) {
    for (const id of point.usedEvidenceIds) {
      const ev = EVIDENCE.find((e) => e.id === id)!;
      assert.ok(ev.capturedAt <= point.eventAt, 'no evidence captured after the event may be used');
    }
  }
});

test('backtest compares the predicted price path with realized outcomes', () => {
  const forecast = setUp();
  const result = runBacktest(input(forecast.id));
  assert.equal(result.points.length, 2);
  assert.equal(result.points[0].eventAt, '2026-06-08T00:00:00.000Z');
  assert.ok(result.points[0].predicted > 100, 'path moves from baseline toward the base case');
  assert.ok(result.points[0].predicted < result.points[1].predicted);
  assert.equal(result.points[0].realized, 105);
  assert.equal(result.points[0].absError, Number(Math.abs(result.points[0].predicted - 105).toFixed(6)));
  assert.equal(typeof result.points[0].covered, 'boolean');
  assert.ok(result.mae > 0);
  assert.ok(['NON_REGRESSION', 'REGRESSION'].includes(result.verdict));
  assert.equal(result.horizonDays, 30);
});

test('backtests are deterministic and stored for retrieval', () => {
  const forecast = setUp();
  const a = runBacktest(input(forecast.id));
  const b = runBacktest(input(forecast.id));
  assert.deepEqual(a, b);
  assert.deepEqual(backtestRepository.get(a.id), a);
  assert.equal(backtestRepository.forForecast(forecast.id).length, 1);
});

test('missing forecasts cannot be backtested', () => {
  setUp();
  assert.throws(() => runBacktest(input('missing')), /FORECAST_NOT_FOUND/);
});
