/**
 * Task 15 — deterministic liquidity, population and demand factor pack.
 *
 * Pure read model: it consumes canonical market observations and optional
 * population snapshots supplied by the caller and derives factors by code.
 * It never writes a canonical fact, never calls a model, never fetches a
 * feed and never invents an attention or catalyst number.
 *
 * Rules carried over from the evidence-first design:
 *  - basis is explicit; SOLD evidence never mixes with ASKING/GUIDE prices;
 *  - one (source, currency) group is used per scalar, never cross-source math;
 *  - missing or unusable inputs become the literal UNKNOWN, never zero or NaN;
 *  - every factor carries basis, source, confidence, evidence and a reason;
 *  - licensed-only factors (attention, catalyst) stay UNKNOWN by default.
 */

import type { MarketBasis, MarketObservation } from '../contracts/dataProduct.ts';
import {
  UNKNOWN,
  type ConfidenceBand,
  type UnknownValue,
} from '../serving/catalog.ts';
import { targetRefMatches } from '../serving/market.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

export type FactorKey =
  | 'price_momentum_7d_30d'
  | 'price_momentum_30d_90d'
  | 'absorption_ratio'
  | 'population_velocity'
  | 'attention_delta'
  | 'catalyst_score';

export const FACTOR_KEYS: readonly FactorKey[] = [
  'price_momentum_7d_30d',
  'price_momentum_30d_90d',
  'absorption_ratio',
  'population_velocity',
  'attention_delta',
  'catalyst_score',
];

export interface FactorOutput {
  key: FactorKey;
  value: number | UnknownValue;
  basis: MarketBasis;
  /** All canonical bases that took part in the derivation (empty when UNKNOWN). */
  derivedFrom: MarketBasis[];
  source: string | UnknownValue;
  confidence: ConfidenceBand;
  evidenceIds: string[];
  observedAt: string | UnknownValue;
  computedAt: string;
  reason: string | null;
  metrics: Record<string, number | string | UnknownValue>;
}

export interface FactorPack {
  targetId: string;
  factors: FactorOutput[];
  warnings: string[];
}

/** A canonical population count taken at a point in time (basis POPULATION). */
export interface PopulationSnapshot {
  observedAt: string;
  count: number;
  source?: string;
  evidenceId?: string;
  grade?: string;
}

export interface FactorInput {
  observations: MarketObservation[];
  populationSnapshots?: PopulationSnapshot[];
}

export interface FactorOptions {
  /** Explicit clock: windows are trailing relative to this instant. */
  now: Date;
}

function round6(value: number): number {
  return Number(value.toFixed(6));
}

function bandForSample(size: number): ConfidenceBand {
  if (size >= 5) return 'HIGH';
  if (size >= 2) return 'MEDIUM';
  if (size >= 1) return 'LOW';
  return 'UNKNOWN';
}

function isEligible(row: MarketObservation): boolean {
  const status = String(row.status ?? '');
  return status !== 'CONTESTED' && status !== 'SUPERSEDED';
}

function groupKey(row: MarketObservation): string {
  const source = String(row.marketplace ?? '').trim() || UNKNOWN;
  const currency = String(row.currency ?? '').trim() || UNKNOWN;
  return `${source}::${currency}`;
}

/** Pick one (source, currency) group deterministically; never aggregate across groups. */
function pickPrimaryGroup(
  rows: MarketObservation[],
  warnings: string[],
): MarketObservation[] {
  const groups = new Map<string, MarketObservation[]>();
  for (const row of rows) {
    const key = groupKey(row);
    const bucket = groups.get(key) ?? [];
    bucket.push(row);
    groups.set(key, bucket);
  }
  const entries = [...groups.entries()].sort(
    (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
  );
  if (entries.length > 1) {
    warnings.push(
      `Multiple source/currency groups (${entries.map(([key]) => key).join(', ')}); ` +
        `factors use ${entries[0][0]} only. No cross-source aggregation was applied.`,
    );
  }
  return entries[0]?.[1] ?? [];
}

interface TimedObservation {
  row: MarketObservation;
  ts: number;
  age: number;
}

function timed(rows: MarketObservation[], nowMs: number, warnings: string[]): TimedObservation[] {
  const out: TimedObservation[] = [];
  for (const row of rows) {
    const ts = Date.parse(String(row.observedAt ?? ''));
    if (Number.isNaN(ts)) {
      warnings.push(`Observation ${row.id} has an unparseable observed_at; excluded from time windows.`);
      continue;
    }
    if (ts > nowMs) {
      warnings.push(`Observation ${row.id} is dated in the future; excluded (no look-ahead).`);
      continue;
    }
    out.push({ row, ts, age: nowMs - ts });
  }
  return out;
}

function sortedIds(rows: MarketObservation[]): string[] {
  return rows.map((row) => String(row.id)).sort();
}

function unknownFactor(
  key: FactorKey,
  reason: string,
  computedAt: string,
  derivedFrom: MarketBasis[] = [],
): FactorOutput {
  return {
    key,
    value: UNKNOWN,
    basis: UNKNOWN as MarketBasis,
    derivedFrom,
    source: UNKNOWN,
    confidence: 'UNKNOWN',
    evidenceIds: [],
    observedAt: UNKNOWN,
    computedAt,
    reason,
    metrics: {},
  };
}

function windowStats(sold: TimedObservation[], days: number): { avg: number; count: number } {
  const values = sold
    .filter((item) => item.age <= days * DAY_MS)
    .map((item) => Number(item.row.amount))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (!values.length) return { avg: Number.NaN, count: 0 };
  return { avg: values.reduce((sum, value) => sum + value, 0) / values.length, count: values.length };
}

function momentumFactor(
  key: FactorKey,
  recent: { avg: number; count: number },
  baseline: { avg: number; count: number },
  evidenceIds: string[],
  observedAt: string | UnknownValue,
  source: string | UnknownValue,
  computedAt: string,
): FactorOutput {
  if (
    !recent.count ||
    !baseline.count ||
    !Number.isFinite(recent.avg) ||
    !Number.isFinite(baseline.avg) ||
    !(baseline.avg > 0)
  ) {
    return unknownFactor(key, 'INSUFFICIENT_SOLD_IN_WINDOWS', computedAt, ['SOLD']);
  }
  return {
    key,
    value: round6(recent.avg / baseline.avg - 1),
    basis: 'SOLD',
    derivedFrom: ['SOLD'],
    source,
    confidence: bandForSample(Math.min(recent.count, baseline.count)),
    evidenceIds: [...evidenceIds].sort(),
    observedAt,
    computedAt,
    reason: null,
    metrics: {
      recentWindowAvg: round6(recent.avg),
      baselineWindowAvg: round6(baseline.avg),
      recentWindowCount: recent.count,
      baselineWindowCount: baseline.count,
    },
  };
}

function populationSnapshotsFrom(
  observations: MarketObservation[],
  nowMs: number,
  warnings: string[],
): PopulationSnapshot[] {
  return timed(
    observations.filter((row) => row.basis === 'POPULATION'),
    nowMs,
    warnings,
  ).map(({ row }) => ({
    observedAt: String(row.observedAt),
    count: Number(row.amount),
    source: String(row.marketplace ?? '').trim() || UNKNOWN,
    evidenceId: String(row.evidenceId ?? ''),
  }));
}

function populationFactor(
  snapshots: PopulationSnapshot[],
  nowMs: number,
  computedAt: string,
  warnings: string[],
): FactorOutput {
  const usable = snapshots
    .map((row) => ({
      ...row,
      ts: Date.parse(String(row.observedAt ?? '')),
      count: Number(row.count),
    }))
    .filter((row) => Number.isFinite(row.ts) && row.ts <= nowMs && Number.isFinite(row.count) && row.count >= 0)
    .sort((a, b) => a.ts - b.ts);
  if (usable.length < 2) {
    return unknownFactor('population_velocity', 'INSUFFICIENT_POPULATION_SNAPSHOTS', computedAt, ['POPULATION']);
  }
  const first = usable[0];
  const last = usable[usable.length - 1];
  const elapsedDays = (last.ts - first.ts) / DAY_MS;
  if (!(elapsedDays > 0)) {
    return unknownFactor('population_velocity', 'INVALID_POPULATION_INTERVAL', computedAt, ['POPULATION']);
  }
  if (!(first.count > 0)) {
    return unknownFactor('population_velocity', 'INVALID_POPULATION_BASELINE', computedAt, ['POPULATION']);
  }
  const change = (last.count - first.count) / first.count;
  const evidenceIds = usable
    .map((row) => row.evidenceId)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
    .sort();
  warnings.push(
    `Population velocity normalised to a 30-day rate from ${first.count} -> ${last.count} over ${round6(elapsedDays)} day(s).`,
  );
  return {
    key: 'population_velocity',
    value: round6(change * (30 / elapsedDays)),
    basis: 'POPULATION',
    derivedFrom: ['POPULATION'],
    source: String(last.source ?? '').trim() || String(first.source ?? '').trim() || UNKNOWN,
    confidence: bandForSample(usable.length),
    evidenceIds,
    observedAt: String(last.observedAt),
    computedAt,
    reason: null,
    metrics: {
      initialCount: first.count,
      finalCount: last.count,
      elapsedDays: round6(elapsedDays),
      snapshotCount: usable.length,
    },
  };
}

/**
 * Derive the full factor pack for one canonical target.
 * `now` is explicit so identical inputs always yield identical output.
 */
export function computeFactorPack(
  targetId: string,
  input: FactorInput,
  options: FactorOptions,
): FactorPack {
  const nowMs = options.now.getTime();
  const computedAt = options.now.toISOString();
  const warnings: string[] = [];
  const rows = (Array.isArray(input?.observations) ? input.observations : []).filter(
    (row) => targetRefMatches(String(row?.targetIdentityRef ?? ''), targetId) && isEligible(row),
  );
  const primary = pickPrimaryGroup(rows, warnings);
  const source = primary.length
    ? String(primary[0].marketplace ?? '').trim() || UNKNOWN
    : UNKNOWN;
  const recentObservedAt = primary.length
    ? primary.map((row) => String(row.observedAt)).sort().pop() ?? UNKNOWN
    : UNKNOWN;
  const timedRows = timed(primary, nowMs, warnings);
  const sold = timedRows.filter(({ row }) => row.basis === 'SOLD');
  const asks = timedRows.filter(({ row }) => row.basis === 'ASKING').map(({ row }) => row);

  const w7 = windowStats(sold, 7);
  const w30 = windowStats(sold, 30);
  const w90 = windowStats(sold, 90);
  const evidence30 = sortedIds(sold.filter((item) => item.age <= 30 * DAY_MS).map((item) => item.row));
  const evidence90 = sortedIds(sold.filter((item) => item.age <= 90 * DAY_MS).map((item) => item.row));

  const soldWindow = sold.filter((item) => item.age <= 30 * DAY_MS).map((item) => item.row);
  const absorptionIds = [...sortedIds(soldWindow), ...sortedIds(asks)].sort();
  const absorption = asks.length === 0
    ? unknownFactor('absorption_ratio', 'NO_ACTIVE_LISTINGS', computedAt, ['SOLD', 'ASKING'])
    : {
        key: 'absorption_ratio' as const,
        value: round6(soldWindow.length / asks.length),
        basis: 'SOLD' as MarketBasis,
        derivedFrom: ['SOLD', 'ASKING'] as MarketBasis[],
        source,
        confidence: bandForSample(Math.min(soldWindow.length, asks.length)),
        evidenceIds: absorptionIds,
        observedAt: recentObservedAt,
        computedAt,
        reason: null,
        metrics: {
          soldCount30d: soldWindow.length,
          activeListings: asks.length,
        },
      };

  const snapshots = Array.isArray(input?.populationSnapshots) && input.populationSnapshots.length
    ? input.populationSnapshots
    : populationSnapshotsFrom(primary, nowMs, warnings);
  const population = populationFactor(snapshots, nowMs, computedAt, warnings);

  const factors: FactorOutput[] = [
    momentumFactor(
      'price_momentum_7d_30d',
      w7,
      w30,
      evidence30,
      recentObservedAt,
      source,
      computedAt,
    ),
    momentumFactor(
      'price_momentum_30d_90d',
      w30,
      w90,
      evidence90,
      recentObservedAt,
      source,
      computedAt,
    ),
    absorption,
    population,
    unknownFactor('attention_delta', 'LICENSED_SOURCE_NOT_APPROVED', computedAt),
    unknownFactor('catalyst_score', 'LICENSED_SOURCE_NOT_APPROVED', computedAt),
  ];
  return { targetId, factors, warnings: [...new Set(warnings)].sort() };
}

/** Look up one factor by key; throws rather than silently returning a fabricated default. */
export function factorByKey(pack: FactorPack, key: FactorKey): FactorOutput {
  const found = pack.factors.find((factor) => factor.key === key);
  if (!found) throw new Error(`FACTOR_NOT_FOUND:${key}`);
  return found;
}
