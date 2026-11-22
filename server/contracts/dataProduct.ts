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
