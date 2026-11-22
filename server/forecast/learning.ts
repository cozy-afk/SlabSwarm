/**
 * Phase 4 — INTELLIGENCE lane, Task 6: learning loop.
 *
 * Scores and backtests are the only teachers. A cycle updates four learned
 * surfaces — source trust, factor weights, persona parameters and confidence
 * calibration — but a candidate is promoted ONLY when a benchmark proves
 * non-regression. Blocked cycles are strict no-ops (no partial state writes).
 *
 * Every input is evidence-backed; missing values stay UNKNOWN/null, never 0.
 * All arithmetic is deterministic code; no model writes canonical facts.
 */

import { forecastRepository, type ForecastRecord } from './repository.ts';
import { forecastScoreRepository, type ForecastScore } from './scoring.ts';
import { backtestRepository } from './backtest.ts';

export type Confidence = 'LOW' | 'MEDIUM' | 'HIGH';

export interface BenchmarkResult {
  baselineMae: number;
  candidateMae: number;
  baselineCoverage: number;
  candidateCoverage: number;
  nonRegression: boolean;
}

export interface CalibrationBucket {
  count: number;
  covered: number;
  coverageRate: number;
  meanBrier: number | null;
}

export interface LearningState {
  version: number;
  cycleCount: number;
  lastCycleAt: string | null;
  sourceTrust: Record<string, number>;
  factorWeights: Record<string, number>;
  personaParams: Record<string, number>;
  calibration: Record<Confidence, CalibrationBucket>;
}

export interface LearningEventInput {
  signal: string;
  scoreId?: string | null;
  evidenceIds: string[];
  createdAt?: string;
}

export interface LearningEvent {
  id: string;
  signal: string;
  scoreId: string | null;
  evidenceIds: string[];
  createdAt: string;
}

export type CycleReason =
  | 'BENCHMARK_NON_REGRESSION'
  | 'BENCHMARK_REGRESSION'
  | 'NO_BENCHMARK_EVIDENCE';

export interface LearningCycleResult {
  promoted: boolean;
  reason: CycleReason;
  version: number;
  cycleCount: number;
  benchmark: BenchmarkResult | null;
}

function round(value: number, places = 6): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function emptyBucket(): CalibrationBucket {
  return { count: 0, covered: 0, coverageRate: 0, meanBrier: null };
}

function initialState(): LearningState {
  return {
    version: 1,
    cycleCount: 0,
    lastCycleAt: null,
    sourceTrust: {},
    factorWeights: {},
    personaParams: {},
    calibration: { LOW: emptyBucket(), MEDIUM: emptyBucket(), HIGH: emptyBucket() },
  };
}

function cloneState(state: LearningState): LearningState {
  return {
    version: state.version,
    cycleCount: state.cycleCount,
    lastCycleAt: state.lastCycleAt,
    sourceTrust: { ...state.sourceTrust },
    factorWeights: { ...state.factorWeights },
    personaParams: { ...state.personaParams },
    calibration: {
      LOW: { ...state.calibration.LOW },
      MEDIUM: { ...state.calibration.MEDIUM },
      HIGH: { ...state.calibration.HIGH },
    },
  };
}

class LearningEventRepository {
  private readonly events = new Map<string, LearningEvent>();
  private sequence = 0;

  create(input: LearningEventInput): LearningEvent {
    if (!Array.isArray(input?.evidenceIds) || input.evidenceIds.length === 0 ||
        input.evidenceIds.some((id) => typeof id !== 'string' || id.length === 0)) {
      throw new Error('FEEDBACK_EVIDENCE_REQUIRED');
    }
    this.sequence += 1;
    const event: LearningEvent = {
      id: `learn-${String(this.sequence).padStart(6, '0')}`,
      signal: typeof input.signal === 'string' && input.signal.length > 0 ? input.signal : 'UNKNOWN',
      scoreId: typeof input.scoreId === 'string' ? input.scoreId : null,
      evidenceIds: [...input.evidenceIds],
      createdAt: typeof input.createdAt === 'string' ? input.createdAt : new Date().toISOString(),
    };
    this.events.set(event.id, event);
    return event;
  }

  get(id: string): LearningEvent | null {
    return this.events.get(id) ?? null;
  }

  all(): LearningEvent[] {
    return [...this.events.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  clear(): void {
    this.events.clear();
    this.sequence = 0;
  }
}

/** Append-only, evidence-backed feedback trail (corrections append, never overwrite). */
export const learningEventRepository = new LearningEventRepository();

export function addLearningFeedback(input: LearningEventInput): LearningEvent {
  return learningEventRepository.create(input);
}

let state: LearningState = initialState();

/** Defensive clone: callers can inspect state but cannot mutate the learned model. */
export function getLearningState(): LearningState {
  return cloneState(state);
}

export function resetLearningState(): void {
  state = initialState();
  learningEventRepository.clear();
}

/**
 * Derive a benchmark from stored, non-regressing backtests when the caller
 * does not supply one. No backtest at all means no promotion is permitted.
 */
function benchmarkFromBacktests(): BenchmarkResult | null {
  const results = backtestRepository.all();
  if (results.length === 0) return null;
  const mean = (pick: (r: (typeof results)[number]) => number): number =>
    round(results.reduce((sum, r) => sum + pick(r), 0) / results.length);
  const candidateCoverage = mean((r) => r.bandCoverage);
  return {
    baselineMae: mean((r) => r.baselineMae),
    candidateMae: mean((r) => r.mae),
    // Backtests do not store a separate naive-coverage baseline; holding it
    // equal prevents coverage alone from manufacturing a "lift".
    baselineCoverage: candidateCoverage,
    candidateCoverage,
    nonRegression: results.every((r) => r.verdict === 'NON_REGRESSION'),
  };
}

function isPassing(benchmark: BenchmarkResult): boolean {
  return benchmark.nonRegression === true &&
    Number.isFinite(benchmark.candidateMae) && Number.isFinite(benchmark.baselineMae) &&
    benchmark.candidateMae <= benchmark.baselineMae &&
    benchmark.candidateCoverage >= benchmark.baselineCoverage;
}

/**
 * Learn from every recorded score, then publish only if the benchmark gate
 * passes. A failed or missing gate returns before touching any learned value.
 */
export function runLearningCycle(
  options: { benchmark?: BenchmarkResult; asOf?: string } = {},
): LearningCycleResult {
  const benchmark = options.benchmark ?? benchmarkFromBacktests();
  const blocked = (reason: CycleReason): LearningCycleResult => ({
    promoted: false,
    reason,
    version: state.version,
    cycleCount: state.cycleCount,
    benchmark,
  });

  if (!benchmark) return blocked('NO_BENCHMARK_EVIDENCE');
  if (!isPassing(benchmark)) return blocked('BENCHMARK_REGRESSION');

  const next = cloneState(state);
  const scores: ForecastScore[] = forecastScoreRepository.all();
  const forecasts = new Map<string, ForecastRecord>();
  for (const score of scores) {
    const forecast = forecastRepository.get(score.forecastId);
    if (forecast) forecasts.set(score.forecastId, forecast);
  }

  const brierSums: Record<Confidence, number> = { LOW: 0, MEDIUM: 0, HIGH: 0 };
  let signedMoveSum = 0;
  let maeRatioSum = 0;
  let scoredWithBaseline = 0;

  for (const score of scores) {
    const forecast = forecasts.get(score.forecastId);
    if (!forecast) continue;

    // Source trust follows the evidence that supported the forecast, not the
    // outcome record: a covered band credits the source, a miss penalises it.
    for (const sourceId of [...new Set(forecast.evidenceIds)].sort()) {
      const previous = next.sourceTrust[sourceId] ?? 0;
      const delta = score.bandCovered ? 0.1 : -0.05;
      next.sourceTrust[sourceId] = round(clamp(previous + delta, -1, 1));
    }

    next.factorWeights['band_coverage'] = round(
      (next.factorWeights['band_coverage'] ?? 0) + (score.bandCovered ? 1 : 0),
    );
    next.factorWeights['direction'] = round(
      (next.factorWeights['direction'] ?? 0) +
        (score.directionCorrect === true ? 1 : score.directionCorrect === false ? -1 : 0),
    );
    next.factorWeights['mae_inverse'] = round(
      (next.factorWeights['mae_inverse'] ?? 0) + 1 / (1 + score.mae),
    );
    next.factorWeights['brier_accuracy'] = round(
      (next.factorWeights['brier_accuracy'] ?? 0) + (1 - clamp(score.brier, 0, 1)),
    );

    const bucket = next.calibration[forecast.confidence];
    bucket.count += 1;
    bucket.covered += score.bandCovered ? 1 : 0;
    bucket.coverageRate = round(bucket.covered / bucket.count);
    brierSums[forecast.confidence] += score.brier;
    bucket.meanBrier = round(brierSums[forecast.confidence] / bucket.count);

    if (forecast.baselinePrice !== null && forecast.baselinePrice > 0) {
      signedMoveSum += (score.realizedPrice - forecast.baselinePrice) / forecast.baselinePrice;
      maeRatioSum += score.mae / Math.max(forecast.priceBands.base, 0.01);
      scoredWithBaseline += 1;
    }
  }

  // Persona parameters are deterministic market summaries used as priors by
  // the next simulation; they are proposals, never canonical market facts.
  next.personaParams['bias'] = scoredWithBaseline
    ? round(signedMoveSum / scoredWithBaseline)
    : 0;
  next.personaParams['volatility'] = scoredWithBaseline
    ? round(maeRatioSum / scoredWithBaseline)
    : round(benchmark.candidateMae / Math.max(benchmark.baselineMae, 0.01));

  next.factorWeights['benchmark_lift'] = round(benchmark.baselineMae - benchmark.candidateMae);
  for (const event of learningEventRepository.all()) {
    if (event.scoreId && forecasts.has(event.scoreId)) {
      next.factorWeights[event.signal] = round((next.factorWeights[event.signal] ?? 0) + 0.01);
    }
  }

  next.version += 1;
  next.cycleCount += 1;
  next.lastCycleAt = options.asOf ?? new Date().toISOString();
  state = next;

  return {
    promoted: true,
    reason: 'BENCHMARK_NON_REGRESSION',
    version: state.version,
    cycleCount: state.cycleCount,
    benchmark,
  };
}
