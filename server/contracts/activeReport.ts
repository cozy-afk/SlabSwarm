/** Frozen contract for the industry insight report. Controller-owned so the
 * endpoint, forecast and UI workers can proceed in parallel. Values that are
 * unknown stay the literal string UNKNOWN — never null, zero or a guess. */

export const UNKNOWN = 'UNKNOWN' as const;

export type Basis =
  | 'SOLD'
  | 'ASKING'
  | 'OFFER'
  | 'GUIDE'
  | 'CLAIM'
  | 'POPULATION'
  | typeof UNKNOWN;

export type Freshness = 'fresh' | 'aging' | 'stale' | typeof UNKNOWN;
export type Confidence = 'HIGH' | 'MEDIUM' | 'LOW' | typeof UNKNOWN;

export interface EvidenceRef {
  id: string;
  source: string;
  observedAt: string;
  basis: Basis;
  currency: string | typeof UNKNOWN;
}

export interface PriceBand {
  low: number;
  mid: number;
  high: number;
  currency: string;
  basis: Basis;
}

export interface ActiveCard {
  id: string;
  name: string;
  set: string | typeof UNKNOWN;
  game: string | typeof UNKNOWN;
  basis: Basis;
  currency: string | typeof UNKNOWN;
  observationCount: number;
  lastObservedAt: string | typeof UNKNOWN;
  momentum7d: number | typeof UNKNOWN;
  momentum30d: number | typeof UNKNOWN;
  priceBand: PriceBand | typeof UNKNOWN;
  drivers: string[];
  invalidators: string[];
  evidence: EvidenceRef[];
  confidence: Confidence;
  freshness: Freshness;
}

export interface ActiveReportSummary {
  totalEvidence: number;
  totalObservations: number;
  cardsObserved: number;
  insufficientEvidence: boolean;
  oldestObservationAt: string | typeof UNKNOWN;
  newestObservationAt: string | typeof UNKNOWN;
}

export interface ActiveReport {
  generatedAt: string;
  cards: ActiveCard[];
  summary: ActiveReportSummary;
}

export interface ForecastDraftInput {
  report: ActiveReport;
  minObservations?: number;
}

export type ForecastDraft = {
  targetId: string;
  name: string;
  band: PriceBand;
  drivers: string[];
  invalidators: string[];
  evidenceIds: string[];
  confidence: Confidence;
  horizonsDays: readonly [7, 30, 90];
};
