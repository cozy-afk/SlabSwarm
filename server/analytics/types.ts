// Analytics-lane shared types. Shapes imported from the frozen shared
// contracts; the extra records here are analytics-local projections only.

import type {
  DiscoveryFinding,
  EvidenceRecord,
  Forecast,
  MarketObservation,
} from '../contracts/dataProduct.ts';

export interface IdentityRecord {
  id: string;
  canonicalName: string;
  game?: string | null;
  source?: string | null;
  observedAt?: string | null;
}

export interface EventRecord {
  id: string;
  type: string;
  targetId?: string | null;
  source?: string | null;
  game?: string | null;
  observedAt: string;
}

export interface ForecastScoreRecord {
  id: string;
  forecastId: string;
  scoredAt: string;
  error?: number | null;
  outcomeAt?: string | null;
}

export interface AnalyticsSnapshot {
  evidence: EvidenceRecord[];
  observations: MarketObservation[];
  identities: IdentityRecord[];
  events: EventRecord[];
  forecasts: Forecast[];
  scores: ForecastScoreRecord[];
  findings: DiscoveryFinding[];
}

export interface FindingFilters {
  type?: DiscoveryFinding['type'];
  targetId?: string;
  limit?: number;
}

export interface SavedQueryInput {
  name: string;
  sql: string;
  description?: string | null;
}

export interface SavedQuery extends SavedQueryInput {
  id: string;
  createdAt: string;
}

export interface AnalyticsStore {
  snapshot(): AnalyticsSnapshot;
  addFinding(input: DiscoveryFinding): DiscoveryFinding;
  listFindings(filters?: FindingFilters): DiscoveryFinding[];
  saveQuery(input: SavedQueryInput): SavedQuery;
  listSavedQueries(): SavedQuery[];
  getSavedQuery(id: string): SavedQuery | null;
  deleteSavedQuery(id: string): boolean;
}

export function emptySnapshot(): AnalyticsSnapshot {
  return {
    evidence: [],
    observations: [],
    identities: [],
    events: [],
    forecasts: [],
    scores: [],
    findings: [],
  };
}
