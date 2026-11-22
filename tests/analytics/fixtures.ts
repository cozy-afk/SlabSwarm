// Shared deterministic fixtures for the analytics lane tests.
// All values below are synthetic test data, never canonical market facts.

import type {
  EvidenceRecord,
  Forecast,
  MarketBasis,
  MarketObservation,
} from '../../server/contracts/dataProduct.ts';
import {
  createAnalyticsStore,
  type AnalyticsStore,
  type AnalyticsSnapshot,
} from '../../server/analytics/store.ts';
import type { ForecastScoreRecord } from '../../server/analytics/types.ts';

let sequence = 0;
const nextId = (prefix: string): string => `${prefix}-fixture-${++sequence}`;

export const FIXED_NOW = new Date('2026-11-22T00:00:00.000Z');

export function makeObservation(
  overrides: Partial<MarketObservation> = {},
): MarketObservation {
  const id = overrides.id ?? nextId('obs');
  return {
    id,
    evidenceId: `evidence-${id}`,
    targetIdentityRef: 'card-alpha',
    basis: 'SOLD',
    amount: 100,
    currency: 'USD',
    marketplace: 'ebay',
    observedAt: '2026-11-21T00:00:00.000Z',
    status: 'NORMALIZED',
    ...overrides,
  };
}

export function makeEvidence(
  overrides: Partial<EvidenceRecord> = {},
): EvidenceRecord {
  const id = overrides.id ?? nextId('evidence');
  return {
    id,
    sourceId: 'ebay',
    sourceRecordId: `native-${id}`,
    capturedAt: '2026-11-21T01:00:00.000Z',
    observedAt: '2026-11-21T00:00:00.000Z',
    checksum: `sha256-${id}`,
    mimeType: 'application/json',
    rawRef: `raw/${id}.json`,
    parseStatus: 'PARSED',
    ...overrides,
  };
}

export function daysAgo(days: number): string {
  return new Date(FIXED_NOW.getTime() - days * 86_400_000).toISOString();
}

export function makeForecast(overrides: Partial<Forecast> = {}): Forecast {
  return {
    id: nextId('forecast'),
    targetType: 'CARD',
    targetId: 'card-alpha',
    horizonDays: 30,
    scenario: 'baseline',
    priceBands: { low: 80, base: 100, high: 130, currency: 'USD' },
    demandPressure: 'MEDIUM',
    supplyPressure: 'LOW',
    drivers: ['observation_count'],
    invalidators: ['no_new_evidence'],
    evidenceIds: [],
    confidence: 'LOW',
    createdAt: FIXED_NOW.toISOString(),
    status: 'HYPOTHESIS',
    ...overrides,
  };
}

export function makeScore(overrides: Partial<ForecastScoreRecord> = {}): ForecastScoreRecord {
  return {
    id: nextId('score'),
    forecastId: 'forecast-fixture-1',
    scoredAt: FIXED_NOW.toISOString(),
    error: 0.05,
    outcomeAt: FIXED_NOW.toISOString(),
    ...overrides,
  };
}

export function makeStore(
  partial: Partial<AnalyticsSnapshot> = {},
): AnalyticsStore {
  return createAnalyticsStore({
    evidence: [],
    observations: [],
    identities: [],
    events: [],
    forecasts: [],
    scores: [],
    ...partial,
  });
}

export function observationsAtBasis(
  basis: MarketBasis,
  amounts: number[],
  observedAt = daysAgo(1),
): MarketObservation[] {
  return amounts.map((amount, index) =>
    makeObservation({
      id: `${basis.toLowerCase()}-${index}-${amount}`,
      basis,
      amount,
      observedAt,
      marketplace: index % 2 === 0 ? 'ebay' : 'tcgplayer',
    }),
  );
}
