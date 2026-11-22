// Deterministic tests for report-driven forecast drafts and Phase 4 scoring.
// Simulations never appear here: drafts are hypotheses, never evidence.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import {
  forecastFromReport,
  scoreReportForecast,
} from '../../server/intelligence/report-forecast.ts';
import { createIntelligenceRouter } from '../../server/intelligence/routes.ts';
import {
  forecastRepository,
} from '../../server/forecast/repository.ts';
import {
  forecastScoreRepository,
  type ForecastOutcome,
} from '../../server/forecast/scoring.ts';
import {
  UNKNOWN,
  type ActiveCard,
  type ActiveReport,
  type PriceBand,
} from '../../server/contracts/activeReport.ts';

const BAND: PriceBand = { low: 90, mid: 100, high: 110, currency: 'USD', basis: 'SOLD' };

function makeCard(overrides: Partial<ActiveCard> = {}): ActiveCard {
  const evidence = [
    { id: 'ev-1', source: 'ebay', observedAt: '2026-11-21T00:00:00.000Z', basis: 'SOLD' as const, currency: 'USD' },
    { id: 'ev-2', source: 'ebay', observedAt: '2026-11-20T00:00:00.000Z', basis: 'SOLD' as const, currency: 'USD' },
    { id: 'ev-3', source: 'tcgplayer', observedAt: '2026-11-19T00:00:00.000Z', basis: 'SOLD' as const, currency: 'USD' },
    { id: 'ev-4', source: 'ebay', observedAt: '2026-11-18T00:00:00.000Z', basis: 'SOLD' as const, currency: 'USD' },
  ];
  return {
    id: 'card-alpha',
    name: 'Alpha',
    set: 'Base Set',
    game: 'TestGame',
    basis: 'SOLD',
    currency: 'USD',
    observationCount: 4,
    lastObservedAt: '2026-11-21T00:00:00.000Z',
    momentum7d: 1.5,
    momentum30d: 0.9,
    priceBand: { ...BAND },
    drivers: ['SOLD comps anchor the band'],
    invalidators: ['A confirmed reprint invalidates scarcity'],
    evidence,
    confidence: 'MEDIUM',
    freshness: 'fresh',
    ...overrides,
  };
}

function makeReport(cards: ActiveCard[]): ActiveReport {
  return {
    generatedAt: '2026-11-22T00:00:00.000Z',
    cards,
    summary: {
      totalEvidence: cards.reduce((sum, c) => sum + c.evidence.length, 0),
      totalObservations: cards.reduce((sum, c) => sum + c.observationCount, 0),
      cardsObserved: cards.length,
      insufficientEvidence: cards.length === 0,
      oldestObservationAt: '2026-11-18T00:00:00.000Z',
      newestObservationAt: '2026-11-21T00:00:00.000Z',
    },
  };
}

test('drafts are produced only for cards with enough observations and a known band', () => {
  const report = makeReport([
    makeCard({ id: 'card-a', observationCount: 4 }),
    makeCard({ id: 'card-b', observationCount: 2 }),
    makeCard({ id: 'card-c', observationCount: 3 }),
    makeCard({ id: 'card-d', observationCount: 9, priceBand: UNKNOWN }),
  ]);

  const drafts = forecastFromReport(report);
  assert.deepEqual(drafts.map((d) => d.targetId), ['card-a', 'card-c']);
  assert.deepEqual(drafts[0].horizonsDays, [7, 30, 90]);
  assert.deepEqual(drafts[0].band, BAND);
});

test('no draft is created when price data is UNKNOWN — no zero or guessed band', () => {
  const report = makeReport([
    makeCard({ priceBand: UNKNOWN, momentum7d: UNKNOWN, momentum30d: UNKNOWN }),
  ]);
  assert.deepEqual(forecastFromReport(report), []);
});

test('band derivation is deterministic for the same report', () => {
  const report = makeReport([makeCard(), makeCard({ id: 'card-z', basis: 'ASKING' })]);
  const first = forecastFromReport(report);
  const second = forecastFromReport(report);
  assert.deepEqual(second, first);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test('every draft cites at least one evidence id from its source card', () => {
  const report = makeReport([makeCard()]);
  const [draft] = forecastFromReport(report);
  assert.ok(draft.evidenceIds.length >= 1);
  assert.deepEqual(draft.evidenceIds, ['ev-1', 'ev-2', 'ev-3', 'ev-4']);
  assert.deepEqual(draft.drivers, makeCard().drivers);
  assert.deepEqual(draft.invalidators, makeCard().invalidators);
});

test('scoring delegates to Phase 4 at 7/30/90 and does not mutate the source report', () => {
  forecastRepository.clear();
  forecastScoreRepository.clear();
  const report = makeReport([makeCard()]);
  const before = structuredClone(report);
  const [draft] = forecastFromReport(report);

  const outcomeFor = (horizon: 7 | 30 | 90): ForecastOutcome => ({
    realizedPrice: 95 + horizon,
    observedAt: `2026-12-${String(horizon).padStart(2, '0')}T00:00:00.000Z`,
    evidenceIds: [`ev-outcome-${horizon}`],
  });
  const scored = scoreReportForecast(draft, {
    7: outcomeFor(7),
    30: outcomeFor(30),
    90: outcomeFor(90),
  });

  assert.deepEqual(scored.scores.map((s) => s.horizonDays), [7, 30, 90]);
  assert.equal(scored.scores.length, 3);
  for (const score of scored.scores) {
    assert.equal(typeof score.mae, 'number');
    assert.equal(typeof score.bandCovered, 'boolean');
    assert.ok(score.evidenceIds.length >= 1);
    const forecast = forecastRepository.get(score.forecastId)!;
    assert.equal(forecast.status, 'SCORED');
    assert.equal(forecast.targetId, 'card-alpha');
  }
  assert.deepEqual(report, before, 'source report is immutable');
  assert.deepEqual(draft.band, BAND, 'source draft is immutable');
});

test('POST /api/intelligence/forecast-from-report returns ForecastDraft[]', async () => {
  const report = makeReport([makeCard()]);
  const app = express();
  app.use(express.json());
  app.use(createIntelligenceRouter());
  const server: Server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const response = await fetch(`${baseUrl}/api/intelligence/forecast-from-report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ report }),
    });
    assert.equal(response.status, 200);
    const drafts = await response.json() as Array<{ targetId: string; horizonsDays: number[] }>;
    assert.ok(Array.isArray(drafts));
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].targetId, 'card-alpha');
    assert.deepEqual(drafts[0].horizonsDays, [7, 30, 90]);

    const bad = await fetch(`${baseUrl}/api/intelligence/forecast-from-report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(bad.status, 400);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
