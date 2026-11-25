import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createForecast } from '../../server/forecast/repository.ts';

test('forecast keeps the human-readable target name alongside its stable id', () => {
  const forecast = createForecast({
    targetType: 'CARD',
    targetId: 'tcg:719412',
    targetName: 'Amalgamight, Close Encounter',
    horizonDays: 30,
    scenario: 'report-derived',
    priceBands: { low: 0.2, base: 0.65, high: 1, currency: 'USD' },
    demandPressure: 'MEDIUM',
    supplyPressure: 'MEDIUM',
    baselinePrice: null,
    drivers: ['GUIDE price spread'],
    invalidators: ['New comps outside band'],
    evidenceIds: ['ev-1'],
    confidence: 'MEDIUM',
  });

  assert.equal(forecast.targetId, 'tcg:719412');
  assert.equal(forecast.targetName, 'Amalgamight, Close Encounter');
});
