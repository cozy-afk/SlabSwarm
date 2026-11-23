/**
 * Market read models for the Phase 5 serving API.
 *
 * All inputs come from the ingest ledger (evidence + market observations).
 * Rules enforced here:
 *  - basis is explicit and preserved; comps are SOLD-only;
 *  - a price summary is computed from exactly one (source, currency) group —
 *    no FX conversion and no summing quotes from different marketplaces;
 *  - missing amounts, currencies and timestamps are the literal UNKNOWN;
 *  - valuations are deterministic arithmetic, never model output.
 */

import type {
  EvidenceRecord,
  MarketObservation,
  MarketBasis,
} from '../contracts/dataProduct.ts';
import type { StoredEvidenceRecord } from '../ingest/types.ts';
import {
  UNKNOWN,
  dedupe,
  isMarketBasis,
  syntheticProvenance,
  type ConfidenceBand,
  type ServingProvenance,
  type UnknownValue,
} from './catalog.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ObservationFact {
  id: string;
  targetIdentityRef: string;
  basis: MarketBasis;
  amount: number | UnknownValue;
  currency: string;
  source: string;
  marketplace: string;
  observedAt: string;
  capturedAt: string;
  status: string;
  lineage: string[];
  confidence: ConfidenceBand;
  warnings: string[];
}

export interface PriceSummaryView {
  targetId: string;
  basis: MarketBasis;
  low: number | UnknownValue;
  median: number | UnknownValue;
  high: number | UnknownValue;
  currency: string;
  sampleSize: number;
  source: string;
  provenance: ServingProvenance;
}

export interface CompView {
  id: string;
  basis: MarketBasis;
  amount: number | UnknownValue;
  currency: string;
  observedAt: string;
  source: string;
  marketplace: string;
  status: string;
  provenance: ServingProvenance;
}

export interface MarketSourceSnapshot {
  source: string;
  currency: string;
  basis: MarketBasis;
  askCount: number | UnknownValue;
  soldCount30d: number | UnknownValue;
  basisBreakdown: Partial<Record<MarketBasis, number>>;
  provenance: ServingProvenance;
}

export interface MarketSnapshotView {
  targetId: string;
  basis: MarketBasis;
  askCount: number | UnknownValue;
  soldCount30d: number | UnknownValue;
  momentum: 'UNKNOWN' | 'COOLING' | 'STABLE' | 'HEATING';
  source: string;
  currency: string;
  sources: MarketSourceSnapshot[];
  provenance: ServingProvenance;
}

export interface Built<T> {
  value: T;
  warnings: string[];
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? round2((sorted[mid - 1] + sorted[mid]) / 2)
    : round2(sorted[mid]);
}

function confidenceFromTrustTier(tier: string | undefined): ConfidenceBand {
  if (tier === 'HIGH' || tier === 'MEDIUM' || tier === 'LOW') return tier;
  return 'UNKNOWN';
}

const CONFIDENCE_RANK: Record<ConfidenceBand, number> = {
  UNKNOWN: 0,
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
};

function weakestConfidence(bands: ConfidenceBand[]): ConfidenceBand {
  if (!bands.length) return 'UNKNOWN';
  return bands.reduce((weakest, band) =>
    CONFIDENCE_RANK[band] < CONFIDENCE_RANK[weakest] ? band : weakest,
  );
}

/** Convert one ledger observation into a provenance-carrying fact. */
export function toObservationFact(
  observation: MarketObservation,
  evidence: EvidenceRecord | null,
): ObservationFact {
  const warnings: string[] = [];
  const marketplace = String(observation.marketplace ?? '').trim() || UNKNOWN;
  const source = marketplace !== UNKNOWN
    ? marketplace
    : String(evidence?.sourceId ?? '').trim() || UNKNOWN;
  const basis: MarketBasis = isMarketBasis(observation.basis)
    ? observation.basis
    : UNKNOWN;
  if (!isMarketBasis(observation.basis)) {
    warnings.push(`Observation ${observation.id} had no explicit basis; preserved as UNKNOWN.`);
  }

  const rawAmount = observation.amount as number | null | undefined;
  let amount: number | UnknownValue = UNKNOWN;
  if (typeof rawAmount === 'number' && Number.isFinite(rawAmount) && rawAmount > 0) {
    amount = round2(rawAmount);
  } else {
    warnings.push(`Observation ${observation.id} has no usable amount; amount is UNKNOWN.`);
  }

  const currency = String(observation.currency ?? '').trim() || UNKNOWN;
  if (currency === UNKNOWN) {
    warnings.push(`Observation ${observation.id} has no currency; currency is UNKNOWN.`);
  }

  const observedAt = String(observation.observedAt ?? '').trim() || UNKNOWN;
  if (observedAt === UNKNOWN) {
    warnings.push(`Observation ${observation.id} has no observed_at; value is UNKNOWN.`);
  }
  const capturedAt = String(evidence?.capturedAt ?? '').trim() || UNKNOWN;
  if (capturedAt === UNKNOWN) {
    warnings.push(`Observation ${observation.id} has no linked evidence capture time; value is UNKNOWN.`);
  }

  const evidenceLineage = (evidence as StoredEvidenceRecord | null)?.lineage ?? [];
  const lineage = dedupe([
    'ingest-ledger',
    ...evidenceLineage,
    ...(evidence ? [evidence.id] : []),
    observation.id,
  ]);

  return {
    id: observation.id,
    targetIdentityRef: observation.targetIdentityRef,
    basis,
    amount,
    currency,
    source,
    marketplace,
    observedAt,
    capturedAt,
    status: String(observation.status ?? 'RAW'),
    lineage,
    confidence: confidenceFromTrustTier(evidence?.trustTier),
    warnings,
  };
}

/** Exact identity reference match, optionally in `kind:<id>` / `kind/<id>` form. */
export function targetRefMatches(ref: string, targetId: string): boolean {
  if (ref === targetId) return true;
  const tail = ref.split(/[:/#]/).pop() ?? '';
  return tail === targetId;
}

export interface ObservationLedger {
  list(filters?: Record<string, unknown>): Promise<MarketObservation[]>;
}

export async function loadFacts(
  observations: ObservationLedger,
  evidence: { get(id: string): Promise<EvidenceRecord | null> },
  targetId: string,
): Promise<{ facts: ObservationFact[]; warnings: string[] }> {
  const rows = await observations.list();
  const warnings: string[] = [];
  const matched = rows.filter((row) => targetRefMatches(String(row.targetIdentityRef ?? ''), targetId));
  // Defense in depth: a quarantined hard-attribute match must never reach a
  // price summary or FMV even if a stale/imported row slipped into the ledger.
  const quarantined = matched.filter((row) => {
    const components = (row.priceComponents ?? {}) as Record<string, unknown>;
    return (row.status as string) === 'QUARANTINED'
      || components.hardAttributeDisposition === 'QUARANTINE'
      || components.hardAttributeDisposition === 'QUARANTINED';
  });
  if (quarantined.length > 0) {
    warnings.push(
      `Excluded ${quarantined.length} hard-attribute quarantined observation(s) from FMV inputs: `
      + `${quarantined.map((row) => row.id).join(', ')}.`,
    );
  }
  const eligible = matched.filter((row) => !quarantined.includes(row));
  const facts: ObservationFact[] = [];
  for (const row of eligible) {
    const linked = await evidence.get(row.evidenceId);
    if (!linked) {
      warnings.push(`Observation ${row.id} has no linked evidence row; capture time is UNKNOWN.`);
    }
    const fact = toObservationFact(row, linked);
    warnings.push(...fact.warnings);
    facts.push(fact);
  }
  return { facts, warnings };
}

function isEligibleStatus(fact: ObservationFact): boolean {
  return fact.status !== 'CONTESTED' && fact.status !== 'SUPERSEDED';
}

function filterFacts(
  facts: ObservationFact[],
  basis: MarketBasis | undefined,
  source: string | undefined,
  warnings: string[],
): ObservationFact[] {
  let kept = facts.filter(isEligibleStatus);
  const ineligible = facts.length - kept.length;
  if (ineligible > 0) {
    warnings.push(`Excluded ${ineligible} CONTESTED/SUPERSEDED observation(s).`);
  }
  if (basis !== undefined) {
    kept = kept.filter((fact) => fact.basis === basis);
  }
  if (source !== undefined && source.length > 0) {
    kept = kept.filter((fact) => fact.source === source);
  }
  return kept;
}

function groupKey(fact: ObservationFact): string {
  return `${fact.source}::${fact.currency}`;
}

/**
 * Sources and currencies stay separate. When more than one group exists we
 * deterministically pick the largest group (tie-break: key) for scalar fields
 * and expose every group under `sources`. No values are ever converted.
 */
function pickPrimaryGroup(
  facts: ObservationFact[],
  warnings: string[],
): ObservationFact[] {
  const groups = new Map<string, ObservationFact[]>();
  for (const fact of facts) {
    const key = groupKey(fact);
    const bucket = groups.get(key) ?? [];
    bucket.push(fact);
    groups.set(key, bucket);
  }
  const entries = [...groups.entries()].sort(
    (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
  );
  if (entries.length > 1) {
    warnings.push(
      `Found ${entries.length} marketplace/currency groups (${entries.map(([key]) => key).join(', ')}). ` +
      `Scalar fields use ${entries[0][0]} only; no cross-source aggregation or FX conversion was applied.`,
    );
  }
  return entries[0]?.[1] ?? [];
}

function groupProvenance(
  facts: ObservationFact[],
  basis: MarketBasis,
  currency: string,
  source: string,
  generatedAt: string,
): ServingProvenance {
  if (!facts.length) {
    return syntheticProvenance('ingest-ledger', basis, currency, generatedAt, [
      'ingest-ledger',
      'marketObservations',
    ]);
  }
  const observed = facts
    .map((fact) => fact.observedAt)
    .filter((value) => value !== UNKNOWN)
    .sort();
  const captured = facts
    .map((fact) => fact.capturedAt)
    .filter((value) => value !== UNKNOWN)
    .sort();
  return {
    source,
    basis,
    currency,
    observedAt: observed[0] ?? UNKNOWN,
    capturedAt: captured[captured.length - 1] ?? UNKNOWN,
    observed_at: observed[0] ?? UNKNOWN,
    captured_at: captured[captured.length - 1] ?? UNKNOWN,
    lineage: dedupe(facts.flatMap((fact) => fact.lineage)),
    confidence: weakestConfidence(facts.map((fact) => fact.confidence)),
  };
}

export interface PriceSummaryOptions {
  basis: MarketBasis;
  source?: string;
  generatedAt: string;
}

/** Deterministic low/median/high over one explicit-basis, one-source group. */
export function buildPriceSummary(
  targetId: string,
  facts: ObservationFact[],
  options: PriceSummaryOptions,
): Built<PriceSummaryView> {
  const warnings: string[] = [];
  const eligible = filterFacts(facts, options.basis, options.source, warnings);
  const primary = pickPrimaryGroup(eligible, warnings);
  const currency = primary[0]?.currency ?? UNKNOWN;
  const source = primary[0]?.source ?? UNKNOWN;
  const amounts = primary
    .map((fact) => fact.amount)
    .filter((amount): amount is number => typeof amount === 'number')
    .sort((a, b) => a - b);
  if (primary.length > amounts.length) {
    warnings.push(`${primary.length - amounts.length} observation(s) had UNKNOWN amounts and were not priced.`);
  }
  if (!amounts.length) {
    warnings.push(`No eligible ${options.basis} observations for ${targetId}; all prices are UNKNOWN.`);
  }
  return {
    value: {
      targetId,
      basis: options.basis,
      low: amounts.length ? round2(amounts[0]) : UNKNOWN,
      median: amounts.length ? median(amounts) : UNKNOWN,
      high: amounts.length ? round2(amounts[amounts.length - 1]) : UNKNOWN,
      currency,
      sampleSize: amounts.length,
      source,
      provenance: groupProvenance(primary, options.basis, currency, source, options.generatedAt),
    },
    warnings,
  };
}

export interface CompOptions {
  source?: string;
  generatedAt: string;
}

/** Basis-safe comps: SOLD only, never ASKING/OFFER/GUIDE/CLAIM/POPULATION. */
export function buildComps(
  targetId: string,
  facts: ObservationFact[],
  options: CompOptions,
): Built<CompView[]> {
  const warnings: string[] = [];
  const nonSold = facts.filter((fact) => isEligibleStatus(fact) && fact.basis !== 'SOLD').length;
  if (nonSold > 0) {
    warnings.push(`Excluded ${nonSold} non-SOLD observation(s) from comps; comps are basis-safe.`);
  }
  const eligible = filterFacts(facts, 'SOLD', options.source, warnings);
  const rows = eligible
    .slice()
    .sort((a, b) => a.observedAt.localeCompare(b.observedAt) || a.id.localeCompare(b.id))
    .map<CompView>((fact) => ({
      id: fact.id,
      basis: 'SOLD',
      amount: fact.amount,
      currency: fact.currency,
      observedAt: fact.observedAt,
      source: fact.source,
      marketplace: fact.marketplace,
      status: fact.status,
      provenance: {
        source: fact.source,
        basis: fact.basis,
        currency: fact.currency,
        observedAt: fact.observedAt,
        capturedAt: fact.capturedAt,
        observed_at: fact.observedAt,
        captured_at: fact.capturedAt,
        lineage: fact.lineage,
        confidence: fact.confidence,
      },
    }));
  if (!rows.length) {
    warnings.push(`No eligible SOLD comps for ${targetId}.`);
  }
  return { value: rows, warnings };
}

function sourceSnapshot(
  source: string,
  currency: string,
  facts: ObservationFact[],
  nowMs: number,
  warnings: string[],
): MarketSourceSnapshot {
  const asks = facts.filter((fact) => fact.basis === 'ASKING');
  const sold = facts.filter((fact) => fact.basis === 'SOLD');
  const basisBreakdown: Partial<Record<MarketBasis, number>> = {};
  for (const fact of facts) {
    basisBreakdown[fact.basis] = (basisBreakdown[fact.basis] ?? 0) + 1;
  }
  const within30d = (fact: ObservationFact): boolean => {
    const ts = Date.parse(fact.observedAt);
    if (Number.isNaN(ts)) {
      warnings.push(`Observation ${fact.id} has an unparseable observed_at; excluded from time windows.`);
      return false;
    }
    return ts <= nowMs && nowMs - ts <= 30 * DAY_MS;
  };
  const soldInWindow = sold.filter(within30d);
  return {
    source,
    currency,
    basis: UNKNOWN,
    askCount: asks.length ? asks.length : UNKNOWN,
    soldCount30d: sold.length ? soldInWindow.length : UNKNOWN,
    basisBreakdown,
    provenance: groupProvenance(facts, UNKNOWN, currency, source, new Date(nowMs).toISOString()),
  };
}

function computeMomentum(
  soldFacts: ObservationFact[],
  nowMs: number,
  warnings: string[],
): MarketSnapshotView['momentum'] {
  const recent: number[] = [];
  const previous: number[] = [];
  for (const fact of soldFacts) {
    if (typeof fact.amount !== 'number') continue;
    const ts = Date.parse(fact.observedAt);
    if (Number.isNaN(ts)) continue;
    const age = nowMs - ts;
    if (age >= 0 && age <= 30 * DAY_MS) recent.push(fact.amount);
    else if (age > 30 * DAY_MS && age <= 60 * DAY_MS) previous.push(fact.amount);
  }
  if (!recent.length || !previous.length) {
    warnings.push('Momentum is UNKNOWN without SOLD amounts in both the last 30 days and the prior 30 days.');
    return 'UNKNOWN';
  }
  const recentAvg = recent.reduce((sum, value) => sum + value, 0) / recent.length;
  const previousAvg = previous.reduce((sum, value) => sum + value, 0) / previous.length;
  if (!(previousAvg > 0)) return 'UNKNOWN';
  const ratio = recentAvg / previousAvg;
  if (ratio >= 1.1) return 'HEATING';
  if (ratio <= 0.9) return 'COOLING';
  return 'STABLE';
}

export interface MarketSnapshotOptions {
  now: Date;
}

/** Market snapshot with a per-marketplace/currency breakdown; no aggregation. */
export function buildMarketSnapshot(
  targetId: string,
  facts: ObservationFact[],
  options: MarketSnapshotOptions,
): Built<MarketSnapshotView> {
  const warnings: string[] = [];
  const eligible = filterFacts(facts, undefined, undefined, warnings);
  const groups = new Map<string, ObservationFact[]>();
  for (const fact of eligible) {
    const key = groupKey(fact);
    const bucket = groups.get(key) ?? [];
    bucket.push(fact);
    groups.set(key, bucket);
  }
  const sources = [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, group]) => {
      const [source, currency] = key.split('::');
      return sourceSnapshot(source, currency, group, options.now.getTime(), warnings);
    });
  const primary = pickPrimaryGroup(eligible, warnings);
  const nowMs = options.now.getTime();
  const snapshotSource = primary[0]?.source ?? UNKNOWN;
  const snapshotCurrency = primary[0]?.currency ?? UNKNOWN;
  const primarySnapshot = primary.length
    ? sourceSnapshot(snapshotSource, snapshotCurrency, primary, nowMs, warnings)
    : null;
  if (!primary.length) {
    warnings.push(`No eligible market observations for ${targetId}; counts are UNKNOWN.`);
  }
  return {
    value: {
      targetId,
      basis: UNKNOWN,
      askCount: primarySnapshot?.askCount ?? UNKNOWN,
      soldCount30d: primarySnapshot?.soldCount30d ?? UNKNOWN,
      momentum: computeMomentum(
        primary.filter((fact) => fact.basis === 'SOLD'),
        nowMs,
        warnings,
      ),
      source: snapshotSource,
      currency: snapshotCurrency,
      sources,
      provenance: groupProvenance(primary, UNKNOWN, snapshotCurrency, snapshotSource, options.now.toISOString()),
    },
    warnings,
  };
}
