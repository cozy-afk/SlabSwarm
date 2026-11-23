/** Frozen contract for web-source harvesting. Controller-owned so the adapter,
 * swarm and UI workers can proceed in parallel. No canonical facts live here. */

export type SourceKind = 'json' | 'html';

export interface WebSourceConfig {
  id: string;
  name: string;
  url: string;
  kind: SourceKind;
  enabled: boolean;
  license: string;
  /** Dotted or slash-separated path used for JSON extraction. */
  recordPath?: string;
  /** CSS-like selectors for HTML extraction. */
  selectors?: Record<string, string>;
  respectRobots: boolean;
  rateLimitMs: number;
  /** Optional note explaining where the data came from. */
  provenanceNote?: string;
}

export interface WebHarvestCandidate {
  id: string;
  sourceId: string;
  evidenceId: string;
  name: string;
  set: string | 'UNKNOWN';
  game: string | 'UNKNOWN';
  number: string | 'UNKNOWN';
  basis: 'SOLD' | 'ASKING' | 'OFFER' | 'GUIDE' | 'CLAIM' | 'POPULATION' | 'UNKNOWN';
  amount: number | 'UNKNOWN';
  currency: string | 'UNKNOWN';
  observedAt: string;
  capturedAt: string;
  license: string;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
  warnings: string[];
}

export interface WebHarvestResult {
  sourceId: string;
  fetched: number;
  parsed: number;
  candidates: WebHarvestCandidate[];
  skippedRobots: boolean;
  errors: string[];
}

export type ReviewStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export interface ReviewCandidate extends WebHarvestCandidate {
  status: ReviewStatus;
  reviewedAt?: string;
  reviewNote?: string;
}
