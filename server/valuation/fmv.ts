/**
 * Deterministic fair-market value (FMV) from first-party SOLD evidence.
 *
 * Rules, all enforced by pure functions:
 *  - only rows whose basis is explicitly SOLD can enter the estimate;
 *  - IQR fences remove outliers; fences are computed from the injected rows;
 *  - a half-life decay weights recent sales more than older sales;
 *  - sources/currencies are never converted or merged across groups;
 *  - missing amounts and timestamps stay UNKNOWN, never zero;
 *  - confidence bands and confidence labels are explicit outputs;
 *  - cross-grade imputation is a separate, labelled ESTIMATE with its own
 *    basis and never mutates, relabels or replaces a real SOLD observation.
 *
 * No clock, network, model, simulation or canonical write happens here. The
 * caller injects the evidence and the `now` date, so results are reproducible.
 */

import type { MarketBasis } from '../contracts/dataProduct.ts';
import { UNKNOWN, type ConfidenceBand } from '../serving/catalog.ts';
import type { ObservationFact } from '../serving/market.ts';

export const UNKNOWN_VALUE = UNKNOWN;
export type UnknownValue = typeof UNKNOWN_VALUE;

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_HALF_LIFE_DAYS = 30;
const IQR_MULTIPLIER = 1.5;
const CONFIDENCE_RANK: Record<ConfidenceBand, number> = {
  UNKNOWN: 0,
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
};

/** One injected evidence row. Basis is required; nothing is inferred. */
export interface FmvEvidence {
  id: string;
  basis: MarketBasis;
  amount: number | UnknownValue | null | undefined;
  observedAt: string | UnknownValue | null | undefined;
  currency?: string | UnknownValue | null;
  source?: string | UnknownValue | null;
  /** Optional grade label, used only by the optional grade filter. */
  grade?: string | UnknownValue | null;
  /** Optional source trust tier, carried through but never invented. */
  confidence?: ConfidenceBand | null;
  /** Optional immutable ledger lineage, carried through unchanged. */
  lineage?: string[];
}

export interface FmvOptions {
  /** Injected clock. FMV never reads Date.now(). */
  now: Date;
  /** Days for one halving of a comp's weight. Must be finite and > 0. */
  halfLifeDays?: number;
  /** Optional exact grade label; only matching SOLD comps are priced. */
  grade?: string;
}

export interface FmvExclusion {
  id: string;
  basis: MarketBasis;
  reason:
    | 'NON_SOLD_BASIS'
    | 'AMOUNT_UNKNOWN'
    | 'OBSERVED_AT_UNKNOWN'
    | 'FUTURE_OBSERVED_AT'
    | 'OTHER_CURRENCY_GROUP'
    | 'OTHER_GRADE'
    | 'GRADE_UNKNOWN'
    | 'IQR_OUTLIER';
}

export interface FmvBand {
  low: number | UnknownValue;
  high: number | UnknownValue;
  /** Named derivation: the min/max of the retained SOLD inliers. */
  method: 'IQR_INLIER_RANGE';
  currency: string | UnknownValue;
}

export interface FmvResult {
  targetId: string;
  kind: 'DERIVED';
  /** Derived from SOLD comps; never the raw SOLD basis of any single row. */
  basis: 'SOLD_DERIVED';
  sourceBasis: 'SOLD';
  method: 'RECENCY_WEIGHTED_MEAN_IQR';
  value: number | UnknownValue;
  currency: string | UnknownValue;
  band: FmvBand;
  /** Statistical confidence in this estimate (inlier count), not source trust. */
  confidence: ConfidenceBand;
  /** Weakest explicitly supplied source trust among inliers; UNKNOWN if none. */
  evidenceConfidence: ConfidenceBand;
  sampleSize: number;
  totalSoldRows: number;
  inlierIds: string[];
  /** Deduplicated immutable ledger lineage of the retained comps. */
  lineage: string[];
  excluded: FmvExclusion[];
  basisBreakdown: Partial<Record<MarketBasis, number>>;
  source: string | UnknownValue;
  generatedAt: string;
  warnings: string[];
}

interface Candidate {
  row: FmvEvidence;
  amount: number;
  timestampMs: number;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Type-7 (linear interpolation) quantile over an already sorted array. */
function quantile(sorted: number[], p: number): number {
  const position = (sorted.length - 1) * p;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function weakest(bands: ConfidenceBand[]): ConfidenceBand {
  if (!bands.length) return UNKNOWN;
  return bands.reduce((current, band) =>
    CONFIDENCE_RANK[band] < CONFIDENCE_RANK[current] ? band : current,
  );
}

function confidenceFromSampleSize(size: number): ConfidenceBand {
  if (size >= 5) return 'HIGH';
  if (size >= 3) return 'MEDIUM';
  if (size >= 1) return 'LOW';
  return UNKNOWN;
}

function isConfidenceBand(value: unknown): value is ConfidenceBand {
  return value === 'HIGH' || value === 'MEDIUM' || value === 'LOW' || value === UNKNOWN;
}

function currencyOf(row: FmvEvidence): string {
  return String(row.currency ?? '').trim() || UNKNOWN;
}

/**
 * Compute a deterministic FMV over injected evidence.
 *
 * Pure: neither `evidence` nor any row inside it is mutated. The only clock is
 * `options.now`; the only math is IQR fencing and a 0.5^(age/halfLife) weighting.
 */
export function computeFmv(
  targetId: string,
  evidence: readonly FmvEvidence[],
  options: FmvOptions,
): FmvResult {
  const halfLifeDays = options.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS;
  if (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0) {
    throw new RangeError('halfLifeDays must be a finite number greater than zero.');
  }
  const nowMs = options.now?.getTime();
  if (!Number.isFinite(nowMs)) {
    throw new RangeError('options.now must be a valid Date.');
  }

  const warnings: string[] = [];
  const excluded: FmvExclusion[] = [];
  const basisBreakdown: Partial<Record<MarketBasis, number>> = {};
  // Stable input order: ties break by id, so result order never depends on the
  // order in which the caller supplied the rows.
  const rows = [...evidence].sort(
    (a, b) => a.id.localeCompare(b.id) || a.basis.localeCompare(b.basis),
  );
  for (const row of rows) {
    basisBreakdown[row.basis] = (basisBreakdown[row.basis] ?? 0) + 1;
  }

  const nonSold = rows.filter((row) => row.basis !== 'SOLD');
  if (nonSold.length) {
    warnings.push(
      `Excluded ${nonSold.length} non-SOLD observation(s) from FMV; basis is explicit and never inferred.`,
    );
    for (const row of nonSold) {
      excluded.push({ id: row.id, basis: row.basis, reason: 'NON_SOLD_BASIS' });
    }
  }

  const soldRows = rows.filter((row) => row.basis === 'SOLD');
  const candidates: Candidate[] = [];
  for (const row of soldRows) {
    if (typeof row.amount !== 'number' || !Number.isFinite(row.amount) || row.amount <= 0) {
      excluded.push({ id: row.id, basis: 'SOLD', reason: 'AMOUNT_UNKNOWN' });
      continue;
    }
    const rawDate = typeof row.observedAt === 'string' ? row.observedAt.trim() : '';
    const timestampMs = rawDate && rawDate !== UNKNOWN ? Date.parse(rawDate) : Number.NaN;
    if (!Number.isFinite(timestampMs)) {
      excluded.push({ id: row.id, basis: 'SOLD', reason: 'OBSERVED_AT_UNKNOWN' });
      continue;
    }
    if (timestampMs > nowMs) {
      excluded.push({ id: row.id, basis: 'SOLD', reason: 'FUTURE_OBSERVED_AT' });
      warnings.push(`Observation ${row.id} is dated after the injected now; it cannot be a past sale.`);
      continue;
    }
    candidates.push({ row, amount: row.amount, timestampMs });
  }

  // Currency isolation mirrors the serving price summary: never convert FX.
  const currencyGroups = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const key = currencyOf(candidate.row);
    const bucket = currencyGroups.get(key) ?? [];
    bucket.push(candidate);
    currencyGroups.set(key, bucket);
  }
  const groups = [...currencyGroups.entries()].sort(
    (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
  );
  for (const [key, group] of groups.slice(1)) {
    warnings.push(`Excluded currency group ${key}; no FX conversion was applied.`);
    for (const candidate of group) {
      excluded.push({ id: candidate.row.id, basis: 'SOLD', reason: 'OTHER_CURRENCY_GROUP' });
    }
  }
  const currency: string | UnknownValue = groups[0]?.[0] ?? UNKNOWN;
  let primary = groups[0]?.[1] ?? [];

  const grade = typeof options.grade === 'string' ? options.grade.trim() : '';
  if (grade) {
    const graded: Candidate[] = [];
    for (const candidate of primary) {
      const rowGrade = String(candidate.row.grade ?? '').trim();
      if (rowGrade === grade) {
        graded.push(candidate);
      } else {
        excluded.push({
          id: candidate.row.id,
          basis: 'SOLD',
          reason: rowGrade ? 'OTHER_GRADE' : 'GRADE_UNKNOWN',
        });
      }
    }
    primary = graded;
  }

  // IQR fence over the retained SOLD amounts. Rows are only flagged, never
  // deleted: the immutable ledger keeps the original observation.
  const amounts = primary.map((candidate) => candidate.amount).sort((a, b) => a - b);
  let lowerFence = Number.NEGATIVE_INFINITY;
  let upperFence = Number.POSITIVE_INFINITY;
  if (amounts.length >= 2) {
    const q1 = quantile(amounts, 0.25);
    const q3 = quantile(amounts, 0.75);
    const iqr = q3 - q1;
    lowerFence = q1 - IQR_MULTIPLIER * iqr;
    upperFence = q3 + IQR_MULTIPLIER * iqr;
  }
  const inliers = primary.filter(
    (candidate) => candidate.amount >= lowerFence && candidate.amount <= upperFence,
  );
  const outlierCount = primary.length - inliers.length;
  if (outlierCount) {
    warnings.push(`Excluded ${outlierCount} IQR outlier(s) from FMV; the ledger rows are unchanged.`);
    for (const candidate of primary) {
      if (!inliers.includes(candidate)) {
        excluded.push({ id: candidate.row.id, basis: 'SOLD', reason: 'IQR_OUTLIER' });
      }
    }
  }

  let value: number | UnknownValue = UNKNOWN;
  if (!inliers.length) {
    warnings.push(`No usable SOLD comps for ${targetId}; FMV is UNKNOWN and no price was invented.`);
  } else {
    let weightSum = 0;
    let weightedSum = 0;
    let equalSum = 0;
    for (const candidate of inliers) {
      const ageDays = (nowMs - candidate.timestampMs) / DAY_MS;
      const weight = Math.pow(0.5, ageDays / halfLifeDays);
      weightSum += weight;
      weightedSum += weight * candidate.amount;
      equalSum += candidate.amount;
    }
    if (weightSum > 0 && Number.isFinite(weightSum)) {
      value = round2(weightedSum / weightSum);
    } else {
      warnings.push('All recency weights underflowed; used equal weights deterministically.');
      value = round2(equalSum / inliers.length);
    }
  }

  const bandAmounts = inliers.map((candidate) => candidate.amount);
  warnings.push(
    'The band is the observed IQR-filtered range of inlier SOLD comps, not a probabilistic confidence interval.',
  );
  const suppliedTrust = inliers
    .map((candidate) => candidate.row.confidence)
    .filter(isConfidenceBand);

  return {
    targetId,
    kind: 'DERIVED',
    basis: 'SOLD_DERIVED',
    sourceBasis: 'SOLD',
    method: 'RECENCY_WEIGHTED_MEAN_IQR',
    value,
    currency,
    band: {
      low: bandAmounts.length ? round2(Math.min(...bandAmounts)) : UNKNOWN,
      high: bandAmounts.length ? round2(Math.max(...bandAmounts)) : UNKNOWN,
      method: 'IQR_INLIER_RANGE',
      currency,
    },
    confidence: confidenceFromSampleSize(inliers.length),
    evidenceConfidence: weakest(suppliedTrust),
    sampleSize: inliers.length,
    totalSoldRows: soldRows.length,
    inlierIds: inliers.map((candidate) => candidate.row.id),
    lineage: [...new Set(inliers.flatMap((candidate) => candidate.row.lineage ?? []))],
    excluded,
    basisBreakdown,
    source: String(primary[0]?.row.source ?? '').trim() || UNKNOWN,
    generatedAt: new Date(nowMs).toISOString(),
    warnings,
  };
}

/** Map a serving-ledger fact into FMV evidence, preserving its explicit basis. */
export function fromObservationFact(
  fact: ObservationFact,
  grade?: string | null,
): FmvEvidence {
  return {
    id: fact.id,
    basis: fact.basis,
    amount: fact.amount,
    observedAt: fact.observedAt,
    currency: fact.currency,
    source: fact.source,
    ...(grade ? { grade } : {}),
    ...(isConfidenceBand(fact.confidence) ? { confidence: fact.confidence } : {}),
    lineage: [...fact.lineage],
  };
}

export interface CrossGradeEstimateInput {
  targetId: string;
  targetGrade: string;
  sourceGrade: string;
  /** FMV computed from real SOLD comps in `sourceGrade`. Never mutated. */
  sourceFmv: FmvResult;
  /** Deterministic ratio derived from observed cross-grade SOLD pairs. */
  ratio: number | UnknownValue | null | undefined;
  /** Mandatory human/machine-readable basis for the ratio itself. */
  ratioBasis: string;
  ratioEvidenceIds?: readonly string[];
  generatedAt: string;
}

export interface CrossGradeEstimate {
  targetId: string;
  targetGrade: string;
  sourceGrade: string;
  kind: 'ESTIMATE';
  /** A distinct basis label: this value is NOT a sale and NOT a SOLD FMV. */
  basis: 'CROSS_GRADE_ESTIMATE';
  sourceBasis: 'SOLD';
  method: 'CROSS_GRADE_RATIO';
  value: number | UnknownValue;
  currency: string | UnknownValue;
  confidence: ConfidenceBand;
  ratio: number | UnknownValue;
  ratioBasis: string | UnknownValue;
  ratioEvidenceIds: string[];
  basisDetail: string;
  sourceFmvRef: {
    targetId: string;
    basis: FmvResult['basis'];
    value: number | UnknownValue;
    confidence: ConfidenceBand;
    inlierIds: string[];
  };
  generatedAt: string;
  warnings: string[];
}

function ratioConfidence(ids: readonly string[]): ConfidenceBand {
  if (ids.length >= 3) return 'HIGH';
  if (ids.length === 2) return 'MEDIUM';
  if (ids.length === 1) return 'LOW';
  return UNKNOWN;
}

/**
 * Cross-grade imputation as an explicitly labelled estimate.
 *
 * Pure and side-effect free: it does not write to, relabel or replace any SOLD
 * observation. When any required basis is missing the value stays UNKNOWN.
 */
export function estimateCrossGradeFmv(
  input: CrossGradeEstimateInput,
): CrossGradeEstimate {
  const warnings: string[] = [
    'Estimate only: no SOLD row was created or relabelled; never present this value as a completed sale.',
  ];
  const ratioEvidenceIds = [...(input.ratioEvidenceIds ?? [])];
  const ratioBasis = String(input.ratioBasis ?? '').trim();
  const source = input.sourceFmv;
  const sourceValue = source?.value;
  const usableRatio =
    typeof input.ratio === 'number' &&
    Number.isFinite(input.ratio) &&
    input.ratio > 0;
  const usableSource = typeof sourceValue === 'number' && Number.isFinite(sourceValue) && sourceValue > 0;
  const usableBasis = ratioBasis.length > 0;

  if (!usableBasis) {
    warnings.push('No ratio basis was stated; the estimate stays UNKNOWN.');
  }
  if (!usableRatio) {
    warnings.push('Ratio is UNKNOWN or unusable; the estimate stays UNKNOWN.');
  }
  if (!usableSource) {
    warnings.push('Source-grade FMV is UNKNOWN; the estimate stays UNKNOWN.');
  }
  if (ratioEvidenceIds.length < 3) {
    warnings.push('Fewer than three ratio evidence ids were supplied; estimate confidence is capped.');
  }

  const priceable = usableBasis && usableRatio && usableSource;
  const value: number | UnknownValue = priceable
    ? round2((sourceValue as number) * (input.ratio as number))
    : UNKNOWN;
  const confidence: ConfidenceBand = priceable
    ? weakest([source.confidence, ratioConfidence(ratioEvidenceIds)])
    : UNKNOWN;
  const ratio: number | UnknownValue = usableRatio ? (input.ratio as number) : UNKNOWN;

  return {
    targetId: input.targetId,
    targetGrade: String(input.targetGrade ?? '').trim() || UNKNOWN,
    sourceGrade: String(input.sourceGrade ?? '').trim() || UNKNOWN,
    kind: 'ESTIMATE',
    basis: 'CROSS_GRADE_ESTIMATE',
    sourceBasis: 'SOLD',
    method: 'CROSS_GRADE_RATIO',
    value,
    currency: priceable ? source.currency : UNKNOWN,
    confidence,
    ratio,
    ratioBasis: usableBasis ? ratioBasis : UNKNOWN,
    ratioEvidenceIds,
    basisDetail: priceable
      ? `CROSS_GRADE_ESTIMATE: ${String(input.sourceGrade)} SOLD-derived FMV ` +
        `(${source.basis}, ${source.inlierIds.length} SOLD inlier(s)) * observed ratio ` +
        `${ratio} from ${ratioBasis}; not a sale.`
      : 'CROSS_GRADE_ESTIMATE: incomplete basis; no value computed.',
    sourceFmvRef: {
      targetId: source.targetId,
      basis: source.basis,
      value: sourceValue,
      confidence: source.confidence,
      inlierIds: [...source.inlierIds],
    },
    generatedAt: input.generatedAt,
    warnings,
  };
}
