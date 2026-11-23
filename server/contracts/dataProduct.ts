// Shared first-party contracts for the data-product rebuild.
// These are names only. Each lane implements its own persistence behind them.

export type MarketBasis =
  | 'SOLD'
  | 'ASKING'
  | 'OFFER'
  | 'GUIDE'
  | 'CLAIM'
  | 'POPULATION'
  | 'UNKNOWN';

export interface EvidenceRecordInput {
  sourceId: string;
  sourceRecordId: string;
  sourceUri?: string | null;
  capturedAt: string;
  observedAt: string;
  checksum: string;
  mimeType: string;
  license?: string | null;
  rawRef: string;
  parsedPayload?: Record<string, unknown>;
  trustTier?: 'UNKNOWN' | 'LOW' | 'MEDIUM' | 'HIGH';
}

export interface EvidenceRecord extends EvidenceRecordInput {
  id: string;
  parseStatus: 'PENDING' | 'PARSED' | 'FAILED' | 'QUARANTINED';
}

export interface MarketObservationInput {
  evidenceId: string;
  targetIdentityRef: string;
  basis: MarketBasis;
  amount: number;
  currency: string;
  marketplace?: string | null;
  observedAt: string;
  priceComponents?: Record<string, unknown>;
  status?: 'RAW' | 'NORMALIZED' | 'CONTESTED' | 'SUPERSEDED';
}

export interface MarketObservation extends MarketObservationInput {
  id: string;
  status: 'RAW' | 'NORMALIZED' | 'CONTESTED' | 'SUPERSEDED';
}

export interface DiscoveryFinding {
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
  confidence: 'LOW' | 'MEDIUM' | 'HIGH';
  metrics: Record<string, number | string | null>;
  createdAt: string;
}

export interface ForecastBand {
  low: number;
  base: number;
  high: number;
  currency: string;
}

export interface Forecast {
  id: string;
  targetType: 'CARD' | 'SET' | 'COLLECTION' | 'EVENT';
  targetId: string;
  horizonDays: 7 | 30 | 90;
  scenario: string;
  priceBands: ForecastBand;
  demandPressure: 'LOW' | 'MEDIUM' | 'HIGH';
  supplyPressure: 'LOW' | 'MEDIUM' | 'HIGH';
  drivers: string[];
  invalidators: string[];
  evidenceIds: string[];
  confidence: 'LOW' | 'MEDIUM' | 'HIGH';
  createdAt: string;
  status: 'HYPOTHESIS' | 'SCORED' | 'REJECTED';
}

/**
 * Read-only census of the ingest ledger. Produced by scripts/data-coverage.ts
 * from the durable repositories; no field is inferred or invented. A priced
 * candidate has a finite amount and an explicit (non-UNKNOWN) basis. Missing
 * amounts remain catalog-only, never zero.
 */
export interface CoverageSnapshot {
  /** Row counts of the durable ledger tables read for this census. */
  tables: {
    evidence: number;
    candidates: number;
    observations: number;
    runs: number;
  };
  /** Candidate counts keyed by the source that produced them. */
  bySource: Record<string, number>;
  /** Candidate counts keyed by explicit basis, including UNKNOWN. */
  byBasis: Record<string, number>;
  /** Evidence counts keyed by raw parse status (not promotion status). */
  byParseStatus: Record<string, number>;
  /** Evidence counts keyed by declared trust tier, including UNKNOWN. */
  byTrustTier: Record<string, number>;
  /** Candidates with a finite amount and an explicit basis. */
  pricedCandidates: number;
  /** Candidates without a price; UNKNOWN stays UNKNOWN, never zero. */
  catalogOnly: number;
  /** Canonical market observation rows already present in the ledger. */
  promotedObservations: number;
  /** Priced candidates with no observation carrying their evidence/ref/basis key. */
  pricedWithoutObservation: number;
  /** Observation rows beyond the first for an evidence/ref/basis key. */
  duplicateObservationKeys: number;
}

export interface RepositoryBundle {
  evidence: {
    create(input: EvidenceRecordInput): Promise<EvidenceRecord>;
    get(id: string): Promise<EvidenceRecord | null>;
    list(filters?: Record<string, unknown>): Promise<EvidenceRecord[]>;
  };
  marketObservations: {
    create(input: MarketObservationInput): Promise<MarketObservation>;
    get(id: string): Promise<MarketObservation | null>;
    list(filters?: Record<string, unknown>): Promise<MarketObservation[]>;
  };
}

export const CONTRACT_VERSION = '2026-11-22.1';
