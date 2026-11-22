// Field projections shared by the Parquet exporter and discovery sweep.
// Missing facets stay explicit UNKNOWN — never zero, never inferred.

import type { EvidenceRecord, MarketObservation } from '../contracts/dataProduct.ts';

type Loose = Record<string, unknown>;

function loose(value: object): Loose {
  return value as Loose;
}

export function asText(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  return value;
}

export function gameOf(record: object): string {
  const r = loose(record);
  const payload = r.parsedPayload;
  const fromPayload = payload && typeof payload === 'object'
    ? asText(loose(payload as object).game) ?? asText(loose(payload as object).gameName)
    : null;
  return fromPayload ?? asText(r.game) ?? asText(r.gameName) ?? 'UNKNOWN';
}

export function sourceOf(record: object): string {
  const r = loose(record);
  return asText(r.source) ?? asText(r.marketplace) ?? asText(r.sourceId) ?? 'UNKNOWN';
}

/** YYYY-MM-DD in UTC, or UNKNOWN when the observation timestamp is unusable. */
export function observedDateOf(record: object): string {
  const r = loose(record);
  const raw = asText(r.observedAt) ?? asText(r.observed_at);
  if (!raw) return 'UNKNOWN';
  const time = Date.parse(raw);
  if (Number.isNaN(time)) return 'UNKNOWN';
  return new Date(time).toISOString().slice(0, 10);
}

export function basisOf(observation: MarketObservation): string {
  return observation.basis || 'UNKNOWN';
}

export function currencyOf(observation: MarketObservation): string {
  return asText(observation.currency) ?? 'UNKNOWN';
}

export function evidenceIdsOf(observations: MarketObservation[]): string[] {
  const ids = new Set<string>();
  for (const observation of observations) {
    const id = asText(observation.evidenceId);
    if (id) ids.add(id);
  }
  return [...ids].sort();
}

export function evidenceOf(evidence: EvidenceRecord): Loose {
  return loose(evidence);
}
