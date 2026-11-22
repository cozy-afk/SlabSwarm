/**
 * Report-driven forecast drafts and scoring.
 *
 * Drafts are deterministic projections of an ActiveReport — no clock, no LLM,
 * no simulation. Scoring is delegated to the existing Phase 4 services, which
 * validate every forecast and require evidence-backed outcomes. Simulations
 * are hypotheses here and never become evidence or canonical facts.
 */

import {
  UNKNOWN,
  type ActiveReport,
  type ForecastDraft,
  type ForecastDraftInput,
} from '../contracts/activeReport.ts';
import { createForecast, type ForecastRecord } from '../forecast/repository.ts';
import {
  scoreAndRecord,
  type ForecastOutcome,
  type ForecastScore,
} from '../forecast/scoring.ts';

export const REPORT_FORECAST_HORIZONS = [7, 30, 90] as const;

export type ReportForecastHorizon = (typeof REPORT_FORECAST_HORIZONS)[number];

export type ReportForecastOutcomes = Partial<Record<ReportForecastHorizon, ForecastOutcome>>;

export interface ScoredReportForecast {
  targetId: string;
  name: string;
  forecastIds: Partial<Record<ReportForecastHorizon, string>>;
  scores: ForecastScore[];
}

const DEFAULT_MIN_OBSERVATIONS = 3;

function reportOf(input: ActiveReport | ForecastDraftInput): ActiveReport {
  return 'report' in input ? input.report : input;
}

function minObservationsOf(input: ActiveReport | ForecastDraftInput): number {
  return 'report' in input && typeof input.minObservations === 'number'
    ? input.minObservations
    : DEFAULT_MIN_OBSERVATIONS;
}

/**
 * One draft per report card that has at least `minObservations` observations,
 * a known price band and at least one cited evidence id. UNKNOWN price data
 * never becomes a zero or a guessed band.
 */
export function forecastFromReport(input: ActiveReport | ForecastDraftInput): ForecastDraft[] {
  const report = reportOf(input);
  const minObservations = minObservationsOf(input);
  const drafts: ForecastDraft[] = [];

  for (const card of report.cards) {
    if (card.observationCount < minObservations) continue;
    if (card.priceBand === UNKNOWN) continue;

    const evidenceIds = [...new Set(card.evidence.map((ref) => ref.id))].sort();
    if (evidenceIds.length === 0) continue;

    const drivers = card.drivers.length > 0
      ? [...card.drivers]
      : ['Evidence-backed comps anchor the band'];
    const invalidators = card.invalidators.length > 0
      ? [...card.invalidators]
      : ['New evidence-backed comps outside the band invalidate this forecast'];

    drafts.push({
      targetId: card.id,
      name: card.name,
      band: {
        low: card.priceBand.low,
        mid: card.priceBand.mid,
        high: card.priceBand.high,
        currency: card.priceBand.currency,
        basis: card.priceBand.basis,
      },
      drivers,
      invalidators,
      evidenceIds,
      // LOW is the conservative floor required by Phase 4 validation; an
      // UNKNOWN card confidence is never upgraded to a stronger claim.
      confidence: card.confidence === UNKNOWN ? 'LOW' : card.confidence,
      horizonsDays: [...REPORT_FORECAST_HORIZONS],
    });
  }

  return drafts;
}

/**
 * Turn a draft into three Phase 4 HYPOTHESIS forecasts (7/30/90 days) and
 * score each one against a real, evidence-backed outcome. A missing outcome
 * stays unscored — it is never filled with a synthetic price.
 */
export function scoreReportForecast(
  draft: ForecastDraft,
  outcomes: ReportForecastOutcomes,
): ScoredReportForecast {
  const result: ScoredReportForecast = {
    targetId: draft.targetId,
    name: draft.name,
    forecastIds: {},
    scores: [],
  };

  for (const horizon of REPORT_FORECAST_HORIZONS) {
    const outcome = outcomes[horizon];
    if (!outcome) continue;

    const forecast: ForecastRecord = createForecast({
      targetType: 'CARD',
      targetId: draft.targetId,
      horizonDays: horizon,
      scenario: 'report-derived',
      priceBands: {
        low: draft.band.low,
        base: draft.band.mid,
        high: draft.band.high,
        currency: draft.band.currency,
      },
      // Neutral hypothesis priors, not asserted market facts. There is no
      // defensible baseline in the report draft, so direction stays unknown.
      demandPressure: 'MEDIUM',
      supplyPressure: 'MEDIUM',
      baselinePrice: null,
      drivers: [...draft.drivers],
      invalidators: [...draft.invalidators],
      evidenceIds: [...draft.evidenceIds],
      confidence: draft.confidence === 'UNKNOWN' ? 'LOW' : draft.confidence,
    });
    result.forecastIds[horizon] = forecast.id;
    result.scores.push(scoreAndRecord(forecast.id, outcome));
  }

  return result;
}

/** Convenience: draft and score every eligible card in one call. */
export function forecastAndScoreReport(
  report: ActiveReport,
  outcomes: ReportForecastOutcomes,
): ScoredReportForecast[] {
  return forecastFromReport(report).map((draft) => scoreReportForecast(draft, outcomes));
}

export default forecastFromReport;
