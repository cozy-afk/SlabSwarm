// Types shared by the ingestion lane. Contract shapes are imported from the
// canonical bundle in server/contracts/dataProduct.ts; this lane only adds
// ingestion-specific concerns (run state, cursors, candidate observations).

import type {
  EvidenceRecord,
  EvidenceRecordInput,
  MarketObservationInput,
  RepositoryBundle,
} from '../contracts/dataProduct.ts';

export type { MarketBasis } from '../contracts/dataProduct.ts';

export type IngestMode = 'backfill' | 'forward';
export type RunStatus = 'RUNNING' | 'COMPLETED' | 'PARTIAL' | 'FAILED';
export type ConfidenceBand = 'UNKNOWN' | 'LOW' | 'MEDIUM' | 'HIGH';

/** Evidence plus the append-only lineage the ledger maintains itself. */
export interface StoredEvidenceRecord extends EvidenceRecord {
  lineage: string[];
  correctionOf: string | null;
  correctionReason: string | null;
}

/** Extra internal metadata accepted when the ledger appends evidence. */
export interface EvidenceWriteInput extends EvidenceRecordInput {
  lineage?: string[];
  correctionOf?: string | null;
  correctionReason?: string | null;
  parseStatus?: EvidenceRecord['parseStatus'];
}

/**
 * Adapters emit candidate observations only. `amount` is nullable because a
 * missing price must remain UNKNOWN — never coerced to zero — and candidates
 * are not canonical market observations.
 */
export interface IngestCandidate extends Omit<MarketObservationInput, 'amount'> {
  amount: number | null;
  sourceId: string;
  capturedAt: string;
  observedAt: string;
  lineage: string[];
  confidence: ConfidenceBand;
  /**
   * Raw parse status carried from the evidence lane. PENDING is allowed: raw
   * parsing may still be pending while an explicitly priced candidate is
   * already eligible for deterministic promotion. It is never rewritten by
   * promotion (raw parse status and promotion status are different facts).
   */
  parseStatus: 'PARSED' | 'PENDING' | 'FAILED' | 'UNKNOWN_FIELDS';
  warnings: string[];
}

export interface RunCounts {
  fetched: number;
  created: number;
  duplicates: number;
  failed: number;
  candidates: number;
}

export interface RunError {
  nativeId: string | null;
  message: string;
}

export interface IngestRun {
  id: string;
  sourceId: string;
  adapterId: string;
  mode: IngestMode;
  status: RunStatus;
  startedAt: string;
  finishedAt: string | null;
  cursorIn: string | null;
  cursorOut: string | null;
  watermarkIn: string | null;
  watermarkOut: string | null;
  counts: RunCounts;
  errors: RunError[];
  meta: Record<string, unknown>;
}

export type IngestRunInput = Omit<IngestRun, 'id' | 'counts' | 'errors' | 'meta'> &
  Partial<Pick<IngestRun, 'id' | 'counts' | 'errors' | 'meta'>>;

/** One raw item fetched by an adapter before it becomes evidence. */
export interface RawItem {
  nativeId: string;
  observedAt: string;
  payload: Record<string, unknown>;
  sourceUri?: string | null;
  checksum?: string | null;
  mimeType?: string;
}

export interface AdapterFetchContext {
  mode: IngestMode;
  /** Watermark from the last successful run; null in backfill mode. */
  since: string | null;
  cursor: string | null;
  capturedAt: string;
  options: Record<string, unknown>;
}

export interface AdapterFetchResult {
  items: RawItem[];
  cursor?: string | null;
  watermark?: string | null;
  meta?: Record<string, unknown>;
}

export interface IngestAdapter {
  readonly id: string;
  readonly sourceId: string;
  fetch(ctx: AdapterFetchContext): Promise<AdapterFetchResult>;
}

type BaseEvidenceRepository = RepositoryBundle['evidence'];

export interface EvidenceRepository extends BaseEvidenceRepository {
  createIdempotent(
    input: EvidenceWriteInput,
  ): Promise<{ record: StoredEvidenceRecord; created: boolean }>;
  appendCorrection(
    evidenceId: string,
    input: Partial<EvidenceWriteInput> & { checksum: string },
  ): Promise<StoredEvidenceRecord | null>;
}

export interface IngestRunRepository {
  create(input: IngestRunInput): Promise<IngestRun>;
  get(id: string): Promise<IngestRun | null>;
  list(filters?: Record<string, unknown>): Promise<IngestRun[]>;
  update(id: string, patch: Partial<IngestRun>): Promise<IngestRun | null>;
  lastSuccessful(sourceId: string): Promise<IngestRun | null>;
}

export interface CandidateRepository {
  create(candidate: IngestCandidate): Promise<IngestCandidate>;
  get(id: string): Promise<IngestCandidate | null>;
  list(filters?: Record<string, unknown>): Promise<IngestCandidate[]>;
}

export interface IngestRepositories extends RepositoryBundle {
  evidence: EvidenceRepository;
  runs: IngestRunRepository;
  candidates: CandidateRepository;
}

export interface AdapterLookup {
  get(id: string): IngestAdapter;
}

export interface RunIngestOptions {
  mode?: IngestMode;
  cursor?: string | null;
  capturedAt?: string;
  options?: Record<string, unknown>;
  registry?: AdapterLookup;
  /** Server-side secret values to redact from every error before it is
   * returned or persisted in the run record. Never sourced from request data. */
  secrets?: string[];
}

export interface RunIngestResult {
  run: IngestRun;
  evidence: StoredEvidenceRecord[];
  candidates: IngestCandidate[];
}
