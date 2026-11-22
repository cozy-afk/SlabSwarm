/**
 * Phase 4 — INTELLIGENCE lane, Task 4: deterministic forecast scoring.
 * Band coverage, direction, MAE and Brier are computed by code, never by an
 * LLM. Every outcome must itself be backed by evidence IDs.
 */

import type { ForecastRecord } from './repository.ts';
import { forecastRepository } from './repository.ts';

export interface ForecastOutcome {
  realizedPrice: number;
  observedAt: string;
  evidenceIds: string[];
}

export interface ForecastScore {
  id: string;
  forecastId: string;
  horizonDays: ForecastRecord['horizonDays'];
  realizedPrice: number;
  baselinePrice: number | null;
  bandCovered: boolean;
  directionCorrect: boolean | null;
  mae: number;
  brier: number;
  scoredAt: string;
  evidenceIds: string[];
}

function confidenceWeight(confidence: ForecastRecord['confidence']): number {
  return confidence === 'HIGH' ? 0.6 : confidence === 'MEDIUM' ? 0.4 : 0.2;
}

/** Score one forecast against a realized, evidence-backed outcome. */
export function scoreForecast(forecast: ForecastRecord, outcome: ForecastOutcome): ForecastScore {
  if (!Array.isArray(outcome?.evidenceIds) || outcome.evidenceIds.length === 0) {
    throw new Error('OUTCOME_EVIDENCE_REQUIRED');
  }
  if (typeof outcome.realizedPrice !== 'number' || !Number.isFinite(outcome.realizedPrice) ||
      outcome.realizedPrice < 0) {
    throw new Error('INVALID_OUTCOME');
  }
  const base = forecast.priceBands.base;
  const baseline = forecast.baselinePrice;
  const bandCovered = outcome.realizedPrice >= forecast.priceBands.low &&
    outcome.realizedPrice <= forecast.priceBands.high;
  const mae = Number(Math.abs(outcome.realizedPrice - base).toFixed(6));

  let directionCorrect: boolean | null = null;
  let pUp = 0.5;
  if (baseline !== null && base !== baseline) {
    const predictedUp = base > baseline;
    const realizedUp = outcome.realizedPrice > baseline;
    directionCorrect = predictedUp === realizedUp;
    pUp = 0.5 + (predictedUp ? 1 : -1) * confidenceWeight(forecast.confidence) / 2;
  }
  const realizedBinary = baseline !== null && outcome.realizedPrice > baseline ? 1 : 0;
  const brier = Number(((pUp - realizedBinary) ** 2).toFixed(6));

  return {
    id: `score-${forecast.id}-${String(forecastScoreRepository.countFor(forecast.id) + 1).padStart(3, '0')}`,
    forecastId: forecast.id,
    horizonDays: forecast.horizonDays,
    realizedPrice: outcome.realizedPrice,
    baselinePrice: baseline,
    bandCovered,
    directionCorrect,
    mae,
    brier,
    scoredAt: outcome.observedAt,
    evidenceIds: [...outcome.evidenceIds],
  };
}

class ForecastScoreRepository {
  private readonly scores = new Map<string, ForecastScore>();

  create(score: ForecastScore): ForecastScore {
    this.scores.set(score.id, score);
    return score;
  }

  get(id: string): ForecastScore | null {
    return this.scores.get(id) ?? null;
  }

  forForecast(forecastId: string): ForecastScore[] {
    return [...this.scores.values()]
      .filter((s) => s.forecastId === forecastId)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  countFor(forecastId: string): number {
    return this.forForecast(forecastId).length;
  }

  all(): ForecastScore[] {
    return [...this.scores.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  clear(): void {
    this.scores.clear();
  }
}

export const forecastScoreRepository = new ForecastScoreRepository();

/** Score, append, and advance the forecast's lifecycle in one operation. */
export function scoreAndRecord(forecastId: string, outcome: ForecastOutcome): ForecastScore {
  const forecast = forecastRepository.get(forecastId);
  if (!forecast) throw new Error('FORECAST_NOT_FOUND');
  const score = scoreForecast(forecast, outcome);
  forecastScoreRepository.create(score);
  forecastRepository.markScored(forecastId);
  return score;
}
