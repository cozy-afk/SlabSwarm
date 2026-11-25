// First-party data-product view contracts.
//
// These mirror the { data, meta } response envelope and provenance rules in
// docs/openapi.json. They describe the planned endpoints from the approved
// design spec; the backend lanes implement persistence behind them.

export const BASIS_VALUES = [
  'SOLD',
  'ASKING',
  'OFFER',
  'GUIDE',
  'CLAIM',
  'POPULATION',
  'UNKNOWN',
] as const;

export type MarketBasis = (typeof BASIS_VALUES)[number];
export type ConfidenceBand = 'UNKNOWN' | 'LOW' | 'MEDIUM' | 'HIGH';

/** Every fact carries source, timestamps, lineage and confidence. */
export interface Provenance {
  source: string;
  observedAt: string;
  capturedAt: string;
  lineage: string[];
  confidence: ConfidenceBand;
}

export interface ApiMeta {
  requestId: string;
  generatedAt: string;
  contractVersion: string;
  provenance?: Provenance;
  basis?: MarketBasis;
  warnings?: string[];
}

export interface ApiEnvelope<T> {
  data: T;
  meta: ApiMeta;
}

export interface EvidenceRecordView {
  id: string;
  sourceId: string;
  sourceRecordId: string;
  sourceUri?: string | null;
  capturedAt: string;
  observedAt: string;
  parseStatus: 'PENDING' | 'PARSED' | 'FAILED' | 'QUARANTINED';
  mimeType: string;
  license?: string | null;
  provenance?: Provenance;
}

export interface ObservationView {
  id: string;
  targetIdentityRef: string;
  basis: MarketBasis;
  amount: number | null;
  currency: string;
  observedAt: string;
  status: 'RAW' | 'NORMALIZED' | 'CONTESTED' | 'SUPERSEDED';
  provenance?: Provenance;
}

export interface CatalogItem {
  id: string;
  name: string;
  game: string;
  set: string;
  number: string;
  identityConfidence: ConfidenceBand;
  provenance?: Provenance;
}

export interface PrintingView {
  id: string;
  label: string;
  finish: string;
  language: string;
  gradingPopulation: number | null;
  provenance?: Provenance;
}

export interface PriceSummary {
  targetId: string;
  basis: MarketBasis;
  low: number | null;
  median: number | null;
  high: number | null;
  currency: string;
  sampleSize: number;
  provenance?: Provenance;
}

export interface CompView {
  id: string;
  basis: MarketBasis;
  amount: number | null;
  currency: string;
  observedAt: string;
  provenance?: Provenance;
}

export interface MarketSnapshot {
  targetId: string;
  askCount: number | null;
  soldCount30d: number | null;
  momentum: 'UNKNOWN' | 'COOLING' | 'STABLE' | 'HEATING';
  provenance?: Provenance;
}

export interface Finding {
  id: string;
  type:
    | 'ACTIVE_CARD'
    | 'MOMENTUM'
    | 'SPREAD'
    | 'ANOMALY'
    | 'SOURCE_FRESHNESS'
    | 'EVIDENCE_GAP';
  targetId: string;
  title: string;
  summary: string;
  evidenceIds: string[];
  confidence: ConfidenceBand;
  createdAt: string;
  provenance?: Provenance;
}

export interface SwarmRunView {
  id: string;
  question: string;
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  roleClaims: Array<{ role: string; claim: string; evidenceIds: string[] }>;
  synthesis: string;
  missingData: string[];
  createdAt: string;
}

export interface ForecastBandView {
  low: number | null;
  base: number | null;
  high: number | null;
  currency: string;
}

export interface ForecastReport {
  id: string;
  targetType: 'CARD' | 'SET' | 'COLLECTION' | 'EVENT';
  targetId: string;
  targetName?: string;
  horizonDays: 7 | 30 | 90;
  scenario: string;
  priceBands: ForecastBandView;
  demandPressure: 'LOW' | 'MEDIUM' | 'HIGH';
  supplyPressure: 'LOW' | 'MEDIUM' | 'HIGH';
  drivers: string[];
  invalidators: string[];
  evidenceIds: string[];
  confidence: ConfidenceBand;
  status: 'HYPOTHESIS' | 'SCORED' | 'REJECTED';
  createdAt: string;
  provenance?: Provenance;
}

export interface LearningStateView {
  sourceTrust: Array<{ sourceId: string; trustTier: ConfidenceBand }>;
  factorWeights: Array<{ factor: string; weight: number }>;
  calibration: { bins: number; lastScoredAt: string | null };
  promotedRules: string[];
  benchmarkGate: 'OPEN' | 'BLOCKED';
}

export interface SqlQueryResult {
  columns: string[];
  rows: Array<Record<string, string | number | boolean | null>>;
  rowCount: number;
  truncated: boolean;
}

export interface SavedQuery {
  id: string;
  name: string;
  sql: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Active trading report — UI mirror of the frozen, controller-owned contract.
// Source of truth: .superpowers/sdd/dp-integration/server/contracts/activeReport.ts
// Types are mirrored here so no server module ever enters the browser bundle.
// Unknown values stay the literal string UNKNOWN — never null, zero or a guess.
// ---------------------------------------------------------------------------

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
