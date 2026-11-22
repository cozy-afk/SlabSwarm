import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ForecastValidationError,
  forecastRepository,
  createForecast,
  type ForecastRecord,
} from '../../server/forecast/repository.ts';
import {
  forecastScoreRepository,
  scoreAndRecord,
  scoreForecast,
  type ForecastOutcome,
} from '../../server/forecast/scoring.ts';

function validInput() {
  return {
    targetType: 'CARD' as const,
    targetId: 'card-x',
    horizonDays: 30 as const,
    scenario: 'baseline',
    priceBands: { low: 100, base: 110, high: 120, currency: 'USD' },
    demandPressure: 'HIGH' as const,
    supplyPressure: 'MEDIUM' as const,
    drivers: ['SOLD comps anchor the band'],
    invalidators: ['Confirmed reprint'],
    evidenceIds: ['ev-1', 'ev-2'],
    confidence: 'HIGH' as const,
    createdAt: '2026-04-01T00:00:00.000Z',
    baselinePrice: 100,
  };
}

const OUTCOME: ForecastOutcome = {
  realizedPrice: 115,
  observedAt: '2026-05-01T00:00:00.000Z',
  evidenceIds: ['ev-outcome'],
};

test('forecast repository stores only HYPOTHESIS forecasts with complete bands and citations', () => {
  forecastRepository.clear();
  const created = createForecast(validInput());
  assert.equal(created.status, 'HYPOTHESIS');
  assert.match(created.id, /^fc-\d{6}$/);
  assert.equal(forecastRepository.get(created.id), created);
  assert.equal(forecastRepository.list().length, 1);
  assert.equal(forecastRepository.list({ targetId: 'card-x' }).length, 1);
  assert.equal(forecastRepository.list({ targetId: 'other' }).length, 0);

  assert.throws(() => createForecast({ ...validInput(), priceBands: { low: 120, base: 110, high: 100, currency: 'USD' } }), ForecastValidationError);
  assert.throws(() => createForecast({ ...validInput(), evidenceIds: [] }), ForecastValidationError);
  assert.throws(() => createForecast({ ...validInput(), drivers: [] }), ForecastValidationError);
  assert.throws(() => createForecast({ ...validInput(), horizonDays: 14 as 30 }), ForecastValidationError);
  assert.throws(() => createForecast({ ...validInput(), status: 'SCORED' }), ForecastValidationError);
});

test('scoring computes band coverage, direction, MAE and Brier from real outcomes', () => {
  const forecast = createForecast(validInput());
  const score = scoreForecast(forecast, OUTCOME);
  assert.equal(score.bandCovered, true);
  assert.equal(score.directionCorrect, true);
  assert.equal(score.mae, 5);
  assert.equal(score.brier, 0.04, 'pUp=0.8 for HIGH confidence, outcome=1');
  assert.equal(score.horizonDays, 30);
  assert.deepEqual(score.evidenceIds, ['ev-outcome']);
  assert.equal(score.forecastId, forecast.id);
});

test('out-of-band outcomes are detected and direction errors reduce accuracy', () => {
  const forecast = createForecast(validInput());
  const out = scoreForecast(forecast, { ...OUTCOME, realizedPrice: 130 });
  assert.equal(out.bandCovered, false);
  assert.equal(out.mae, 20);

  const down = scoreForecast(forecast, { ...OUTCOME, realizedPrice: 90 });
  assert.equal(down.directionCorrect, false);
  assert.equal(down.brier, 0.64, 'pUp=0.8, outcome=0');
});

test('outcomes require evidence; unbacked outcomes are rejected', () => {
  const forecast = createForecast(validInput());
  assert.throws(
    () => scoreForecast(forecast, { ...OUTCOME, evidenceIds: [] }),
    /OUTCOME_EVIDENCE_REQUIRED/,
  );
  assert.throws(
    () => scoreForecast(forecast, { ...OUTCOME, realizedPrice: Number.NaN }),
    /INVALID_OUTCOME/,
  );
});

test('scoreAndRecord appends a score and moves the forecast from HYPOTHESIS to SCORED', () => {
  forecastScoreRepository.clear();
  const forecast: ForecastRecord = createForecast(validInput());
  assert.equal(forecast.status, 'HYPOTHESIS');
  const score = scoreAndRecord(forecast.id, OUTCOME);
  assert.equal(forecast.status, 'SCORED');
  assert.equal(forecastScoreRepository.get(score.id), score);
  assert.equal(forecastScoreRepository.forForecast(forecast.id).length, 1);
  assert.throws(() => scoreAndRecord('missing', OUTCOME), /FORECAST_NOT_FOUND/);
});

test('missing baseline makes direction indeterminate instead of inventing one', () => {
  const forecast = createForecast({ ...validInput(), baselinePrice: null });
  const score = scoreForecast(forecast, OUTCOME);
  assert.equal(score.directionCorrect, null);
  assert.equal(score.brier, 0.25);
});
