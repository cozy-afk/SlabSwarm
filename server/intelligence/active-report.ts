/**
 * "What is actively trading" report composition.
 *
 * Deterministic only: Phase 3 discovery findings are computed over the same
 * immutable evidence/observations returned by the durable ingest store, then
 * merged with first-party observation counts, basis-safe comps and recency.
 * No LLM is called. Any value without evidence stays the literal UNKNOWN.
 */

import {
  UNKNOWN,
  type ActiveCard,
  type ActiveReport,
  type Basis,
  type Confidence,
  type EvidenceRef,
  type Freshness,
  type PriceBand,
} from '../contracts/activeReport.ts';
import { observationTargetRef, runDiscoverySweep } from '../analytics/discovery.ts';
import { readLakeManifest, type ParquetExportResult } from '../analytics/parquet.ts';
import { gameOf } from '../analytics/fields.ts';
import { createAnalyticsStore } from '../analytics/store.ts';
import type { IdentityRecord } from '../analytics/types.ts';
import type {
  DiscoveryFinding,
  EvidenceRecord,
  MarketObservation,
} from '../contracts/dataProduct.ts';
import { createInMemoryRepositories } from '../ingest/store.ts';
interface ReportRepositories {
  evidence: { list(): Promise<EvidenceRecord[]> };
  marketObservations: { list(): Promise<MarketObservation[]> };
}

const DAY_MS = 86_400_000;
const DEFAULT_ACTIVE_WINDOW_DAYS = 30;
const DEFAULT_STALE_DAYS = 30;
const DEFAULT_MIN_ACTIVE_OBSERVATIONS = 3;
const DEFAULT_LIMIT = 50;
const FRESH_DAYS = 7;

const BASIS_VALUES = new Set<string>([
  'SOLD', 'ASKING', 'OFFER', 'GUIDE', 'CLAIM', 'POPULATION', UNKNOWN,
]);
const DRIVER_TYPES = new Set<DiscoveryFinding['type']>(['ACTIVE_CARD', 'MOMENTUM', 'SPREAD']);
const INVALIDATOR_TYPES = new Set<DiscoveryFinding['type']>(['ANOMALY', 'SOURCE_FRESHNESS']);

export interface ActiveReportOptions {
  now?: Date;
  activeWindowDays?: number;
  staleDays?: number;
  minActiveObservations?: number;
  limit?: number;
  repositories?: ReportRepositories;
  /** Optional canonical identity records for display names/set/game. */
  identities?: IdentityRecord[];
  /** Override the computed sweep findings (tests/injected Phase 3 lane). */
  findings?: DiscoveryFinding[];
  /** Lake proof: exported file paths, row counts and sha256 checksums. UNKNOWN until an export succeeds. */
  lakeManifest?: ParquetExportResult | typeof UNKNOWN;
}

export interface ActiveReportMeta {
  generatedAt: string;
  source: string;
  filters: {
    activeWindowDays: number;
    staleDays: number;
    minActiveObservations: number;
    limit: number;
  };
  scanned: {
    evidenceCount: number;
    observationCount: number;
    targetCount: number;
    findingCount: number;
    cardCount: number;
  };
  /** Last successful Parquet export, or the literal UNKNOWN when none exists. */
  lakeManifest: ParquetExportResult | typeof UNKNOWN;
}

export interface ActiveReportResult {
  data: ActiveReport;
  meta: ActiveReportMeta;
}

/** Integrator hook: the harvest worker replaces this with its file-backed store. */
let injectedRepositories: ReportRepositories | null = null;

export function setActiveReportRepositories(repositories: ReportRepositories): void {
  injectedRepositories = repositories;
}

export function getActiveReportRepositories(): ReportRepositories {
  if (!injectedRepositories) injectedRepositories = createInMemoryRepositories();
  return injectedRepositories;
}

function asBasis(value: unknown): Basis {
  return typeof value === 'string' && BASIS_VALUES.has(value) ? value as Basis : UNKNOWN;
}

function asCurrency(value: unknown): string {
  return typeof value === 'string' && value.trim() !== '' ? value : UNKNOWN;
}

function asText(value: unknown): string {
  return typeof value === 'string' && value.trim() !== '' ? value : UNKNOWN;
}

function validTimestamp(value: unknown): string | null {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null;
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function payloadText(evidence: EvidenceRecord | undefined, key: string): string | null {
  const payload = evidence?.parsedPayload;
  if (!payload || typeof payload !== 'object') return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function freshnessOf(lastObservedAt: string, now: Date, staleDays: number): Freshness {
  const timestamp = validTimestamp(lastObservedAt);
  if (!timestamp) return UNKNOWN;
  const ageDays = (now.getTime() - Date.parse(timestamp)) / DAY_MS;
  if (ageDays <= FRESH_DAYS) return 'fresh';
  if (ageDays <= staleDays) return 'aging';
  return 'stale';
}

function confidenceOf(findings: DiscoveryFinding[]): Confidence {
  let best: Confidence = UNKNOWN;
  for (const finding of findings) {
    if (finding.confidence === 'HIGH') return 'HIGH';
    // HIGH returns immediately, so `best` can only be UNKNOWN/MEDIUM/LOW here.
    if (finding.confidence === 'MEDIUM') best = 'MEDIUM';
    if (finding.confidence === 'LOW' && best === UNKNOWN) best = 'LOW';
  }
  return best;
}

/** Momentum is a count ratio and only exists when older history exists. */
function momentumOf(
  findings: DiscoveryFinding[],
): { momentum7d: number | typeof UNKNOWN; momentum30d: number | typeof UNKNOWN } {
  const marker = findings.find((finding) => finding.type === 'MOMENTUM');
  if (!marker) return { momentum7d: UNKNOWN, momentum30d: UNKNOWN };

  const count7 = Number(marker.metrics.count7);
  const count30 = Number(marker.metrics.count30);
  const count90 = Number(marker.metrics.count90);
  const prior7 = count30 - count7;
  const prior30 = count90 - count30;

  return {
    momentum7d: Number.isFinite(count7) && Number.isFinite(prior7) && count7 > 0 && prior7 > 0
      ? round(count7 / prior7)
      : UNKNOWN,
    momentum30d: Number.isFinite(count30) && Number.isFinite(prior30) && count30 > 0 && prior30 > 0
      ? round(count30 / prior30)
      : UNKNOWN,
  };
}

function bandOf(
  observations: MarketObservation[],
  basis: Basis,
  currency: string,
  minActiveObservations: number,
): PriceBand | typeof UNKNOWN {
  const amounts = observations
    .map((observation) => observation.amount)
    .filter((amount) => typeof amount === 'number' && Number.isFinite(amount) && amount > 0);
  if (amounts.length < minActiveObservations) return UNKNOWN;
  const low = round(Math.min(...amounts), 2);
  const mid = round(median(amounts), 2);
  const high = round(Math.max(...amounts), 2);
  return { low, mid, high, currency, basis };
}

function evidenceRefsOf(
  observations: MarketObservation[],
  evidenceById: Map<string, EvidenceRecord>,
): EvidenceRef[] {
  const refs = new Map<string, EvidenceRef>();
  for (const observation of observations) {
    const id = typeof observation.evidenceId === 'string' && observation.evidenceId.trim() !== ''
      ? observation.evidenceId
      : null;
    if (!id || refs.has(id)) continue;
    const evidence = evidenceById.get(id);
    const source = asText(evidence
      ? (evidence as unknown as Record<string, unknown>).sourceId
      : observation.marketplace);
    const observedAt = validTimestamp(observation.observedAt) ??
      validTimestamp(evidence?.observedAt) ??
      UNKNOWN;
    refs.set(id, {
      id,
      source,
      observedAt,
      basis: asBasis(observation.basis),
      currency: asCurrency(observation.currency),
    });
  }
  return [...refs.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Compose the report. The returned envelope is `{ data, meta }`; every card
 * figure is traceable to a cited evidence ref with source and observedAt.
 */
export async function buildActiveReport(
  options: ActiveReportOptions = {},
): Promise<ActiveReportResult> {
  const now = options.now ?? new Date();
  const activeWindowDays = options.activeWindowDays ?? DEFAULT_ACTIVE_WINDOW_DAYS;
  const staleDays = options.staleDays ?? DEFAULT_STALE_DAYS;
  const minActiveObservations = options.minActiveObservations ?? DEFAULT_MIN_ACTIVE_OBSERVATIONS;
  const limit = options.limit ?? DEFAULT_LIMIT;
  const repositories = options.repositories ?? getActiveReportRepositories();
  const lakeManifest = options.lakeManifest ?? await readLakeManifest();

  const [evidenceRows, observations] = await Promise.all([
    repositories.evidence.list(),
    repositories.marketObservations.list(),
  ]);
  const evidenceById = new Map(evidenceRows.map((record) => [record.id, record]));

  // Phase 3: re-run the deterministic discovery sweep over the exact same
  // first-party evidence that feeds this report. No LLM, no network, no writes
  // to the ingest store (findings land in a throwaway analytics store).
  const analyticsStore = createAnalyticsStore({ evidence: evidenceRows, observations });
  const sweep = runDiscoverySweep(analyticsStore, {
    now, activeWindowDays, staleDays, minActiveObservations,
  });
  const findings = options.findings ?? sweep.findings;

  const findingsByTarget = new Map<string, DiscoveryFinding[]>();
  for (const finding of findings) {
    const bucket = findingsByTarget.get(finding.targetId);
    if (bucket) bucket.push(finding);
    else findingsByTarget.set(finding.targetId, [finding]);
  }

  const byTarget = new Map<string, MarketObservation[]>();
  for (const observation of observations) {
    const resolved = observationTargetRef(observation);
    const target = resolved === 'unresolved' ? UNKNOWN : resolved;
    const bucket = byTarget.get(target);
    if (bucket) bucket.push(observation);
    else byTarget.set(target, [observation]);
  }

  const cards: ActiveCard[] = [];
  for (const [target, group] of byTarget) {
    const ordered = [...group].sort(
      (a, b) => (validTimestamp(b.observedAt) ?? '').localeCompare(validTimestamp(a.observedAt) ?? '') ||
        a.id.localeCompare(b.id),
    );
    const lastObservedAt = ordered
      .map((observation) => validTimestamp(observation.observedAt))
      .find((value): value is string => value !== null) ?? UNKNOWN;

    // Basis-safe and currency-safe comps: pick one deterministic (basis,
    // currency) bucket. SOLD and GUIDE/ASKING are never pooled or summed.
    const compBuckets = new Map<string, MarketObservation[]>();
    for (const observation of ordered) {
      const key = `${asBasis(observation.basis)}\u0000${asCurrency(observation.currency)}`;
      const bucket = compBuckets.get(key);
      if (bucket) bucket.push(observation);
      else compBuckets.set(key, [observation]);
    }
    const rankedBuckets = [...compBuckets.entries()].sort(
      (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
    );
    const [chosenKey, chosenGroup] = rankedBuckets[0] ?? ['', []];
    const [basisText, currencyText] = chosenKey.split('\u0000');
    const basis = chosenKey ? asBasis(basisText) : UNKNOWN;
    const currency = chosenKey ? asCurrency(currencyText) : UNKNOWN;
    const priceBand = chosenKey ? bandOf(chosenGroup, basis, currency, minActiveObservations) : UNKNOWN;

    const targetFindings = findingsByTarget.get(target) ?? [];
    const { momentum7d, momentum30d } = momentumOf(targetFindings);
    const drivers = [...new Set(targetFindings
      .filter((finding) => DRIVER_TYPES.has(finding.type))
      .map((finding) => finding.title))].sort();
    const invalidators = [...new Set(targetFindings
      .filter((finding) => INVALIDATOR_TYPES.has(finding.type))
      .map((finding) => finding.title))].sort();
    if (drivers.length === 0) {
      drivers.push('Ranked from first-party observations by count and recency');
    }
    if (invalidators.length === 0) {
      invalidators.push('New evidence-backed comps outside the observed band invalidate this claim');
    }

    const primaryEvidence = chosenGroup
      .map((observation) => evidenceById.get(observation.evidenceId))
      .find((record): record is EvidenceRecord => Boolean(record));
    const identity = options.identities?.find((record) => record.id === target);
    const name = identity?.canonicalName ??
      payloadText(primaryEvidence, 'name') ??
      target;
    const set = payloadText(primaryEvidence, 'set') ??
      payloadText(primaryEvidence, 'expansionName') ?? UNKNOWN;
    const game = gameOf(primaryEvidence ?? {}) || UNKNOWN;

    cards.push({
      id: target,
      name,
      set,
      game,
      basis,
      currency,
      observationCount: group.length,
      lastObservedAt,
      momentum7d,
      momentum30d,
      priceBand,
      drivers,
      invalidators,
      evidence: evidenceRefsOf(ordered, evidenceById),
      confidence: confidenceOf(targetFindings),
      freshness: freshnessOf(lastObservedAt, now, staleDays),
    });
  }

  cards.sort(
    (a, b) =>
      b.observationCount - a.observationCount ||
      b.lastObservedAt.localeCompare(a.lastObservedAt) ||
      a.id.localeCompare(b.id),
  );
  const rankedCards = cards.slice(0, limit);

  const timestamps = observations
    .map((observation) => validTimestamp(observation.observedAt))
    .filter((value): value is string => value !== null)
    .sort();

  const summary = {
    totalEvidence: evidenceRows.length,
    totalObservations: observations.length,
    cardsObserved: rankedCards.length,
    insufficientEvidence:
      observations.length === 0 || rankedCards.every((card) => card.priceBand === UNKNOWN),
    oldestObservationAt: timestamps[0] ?? UNKNOWN,
    newestObservationAt: timestamps[timestamps.length - 1] ?? UNKNOWN,
  };

  return {
    data: {
      generatedAt: now.toISOString(),
      cards: rankedCards,
      summary,
    },
    meta: {
      generatedAt: now.toISOString(),
      source: 'first-party-ingest-store',
      filters: { activeWindowDays, staleDays, minActiveObservations, limit },
      scanned: {
        evidenceCount: evidenceRows.length,
        observationCount: observations.length,
        targetCount: byTarget.size,
        findingCount: findings.length,
        cardCount: rankedCards.length,
      },
      lakeManifest,
    },
  };
}

export default buildActiveReport;
