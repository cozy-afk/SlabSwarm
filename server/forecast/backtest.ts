/**
 * Phase 4 — INTELLIGENCE lane, Task 5: backtesting.
 * Replays past events using only evidence that existed (and was captured)
 * before each event. Future information is recorded, never consumed.
 */

import { createHash } from 'node:crypto';
import { forecastRepository } from './repository.ts';

export interface BacktestEvidence {
  id: string;
  observedAt: string;
  capturedAt: string;
  price: number;
  basis?: string;
}

export interface BacktestEvent {
  eventAt: string;
  realizedPrice: number;
  evidenceIds: string[];
}

export interface BacktestInput {
  forecastId: string;
  events: BacktestEvent[];
  evidence: BacktestEvidence[];
  asOf?: string;
}

export interface BacktestPoint {
  eventAt: string;
  predicted: number;
  realized: number;
  absError: number;
  covered: boolean;
  usedEvidenceIds: string[];
}

export interface BacktestResult {
  id: string;
  forecastId: string;
  horizonDays: number;
  points: BacktestPoint[];
  mae: number;
  baselineMae: number;
  bandCoverage: number;
  verdict: 'NON_REGRESSION' | 'REGRESSION';
  usedEvidenceIds: string[];
  leakedEvidenceIds: string[];
  createdAt: string;
}

const DAY_MS = 86_400_000;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

class BacktestRepository {
  private readonly results = new Map<string, BacktestResult>();

  create(result: BacktestResult): BacktestResult {
    this.results.set(result.id, result);
    return result;
  }

  get(id: string): BacktestResult | null {
    return this.results.get(id) ?? null;
  }

  forForecast(forecastId: string): BacktestResult[] {
    return [...this.results.values()]
      .filter((r) => r.forecastId === forecastId)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  all(): BacktestResult[] {
    return [...this.results.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  clear(): void {
    this.results.clear();
  }
}

export const backtestRepository = new BacktestRepository();

/** Replay events against a forecast's predicted price path. */
export function runBacktest(input: BacktestInput): BacktestResult {
  const forecast = forecastRepository.get(input.forecastId);
  if (!forecast) throw new Error('FORECAST_NOT_FOUND');
  const events = [...input.events].sort((a, b) => a.eventAt.localeCompare(b.eventAt));
  const evidence = [...(input.evidence ?? [])].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
  const origin = Date.parse(forecast.createdAt);
  const baseline = forecast.baselinePrice ?? forecast.priceBands.low;
  const horizonMs = forecast.horizonDays * DAY_MS;

  const points: BacktestPoint[] = events.map((event) => {
    const eventAt = Date.parse(event.eventAt);
    const fraction = Math.max(0, Math.min(1, (eventAt - origin) / horizonMs));
    const predicted = Number((baseline + (forecast.priceBands.base - baseline) * fraction).toFixed(6));
    // Strict anti-leakage: observed before the event AND captured before it.
    const available = evidence.filter(
      (e) => Date.parse(e.observedAt) <= eventAt && Date.parse(e.capturedAt) <= eventAt,
    );
    const absError = Number(Math.abs(predicted - event.realizedPrice).toFixed(6));
    return {
      eventAt: event.eventAt,
      predicted,
      realized: event.realizedPrice,
      absError,
      covered: event.realizedPrice >= forecast.priceBands.low &&
        event.realizedPrice <= forecast.priceBands.high,
      usedEvidenceIds: [...new Set(available.map((e) => e.id))].sort(),
    };
  });

  const usedEvidenceIds = [...new Set(points.flatMap((p) => p.usedEvidenceIds))].sort();
  const leakedEvidenceIds = evidence
    .filter((e) => !usedEvidenceIds.includes(e.id))
    .map((e) => e.id)
    .sort();
  const mae = points.length
    ? Number((points.reduce((sum, p) => sum + p.absError, 0) / points.length).toFixed(6))
    : 0;
  const firstEventAt = events.length ? Date.parse(events[0].eventAt) : origin;
  const naivePrices = evidence
    .filter((e) => Date.parse(e.capturedAt) <= firstEventAt && e.basis === 'SOLD')
    .map((e) => e.price);
  const naive = naivePrices.length ? median(naivePrices) : baseline;
  const baselineMae = points.length
    ? Number((points.reduce((sum, p) => sum + Math.abs(naive - p.realized), 0) / points.length).toFixed(6))
    : 0;
  const bandCoverage = points.length
    ? Number((points.filter((p) => p.covered).length / points.length).toFixed(6))
    : 0;

  const idMaterial = JSON.stringify([input.forecastId, events, evidence, input.asOf ?? null]);
  const result: BacktestResult = {
    id: `bt-${createHash('sha256').update(idMaterial).digest('hex').slice(0, 16)}`,
    forecastId: forecast.id,
    horizonDays: forecast.horizonDays,
    points,
    mae,
    baselineMae,
    bandCoverage,
    verdict: mae <= baselineMae ? 'NON_REGRESSION' : 'REGRESSION',
    usedEvidenceIds,
    leakedEvidenceIds,
    createdAt: input.asOf ?? new Date().toISOString(),
  };
  return backtestRepository.create(result);
}
