// In-memory repositories behind the shared data-product contracts.
// Phase 1 owns Postgres persistence; this lane implements the same interfaces
// with process-local stores so ingestion works standalone and in tests.
// Evidence is append-only: records are frozen on write and keyed by the
// immutable triple (sourceId, sourceRecordId, checksum).

import { randomUUID } from 'node:crypto';
import type {
  EvidenceRecord,
  EvidenceRecordInput,
  MarketObservation,
  MarketObservationInput,
  RepositoryBundle,
} from '../contracts/dataProduct.ts';
import type {
  CandidateRepository,
  EvidenceRepository,
  EvidenceWriteInput,
  IngestCandidate,
  IngestRepositories,
  IngestRun,
  IngestRunInput,
  IngestRunRepository,
  StoredEvidenceRecord,
} from './types.ts';

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function clone<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(clone) as T;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[key] = clone(child);
  }
  return out as T;
}

export function evidenceKey(sourceId: string, sourceRecordId: string, checksum: string): string {
  return `${sourceId}\u0000${sourceRecordId}\u0000${checksum}`;
}

class InMemoryEvidenceRepository implements EvidenceRepository {
  private readonly byId = new Map<string, StoredEvidenceRecord>();
  private readonly byKey = new Map<string, string>();
  private readonly order: string[] = [];

  async create(input: EvidenceRecordInput): Promise<EvidenceRecord> {
    return (await this.createIdempotent(input)).record;
  }

  async createIdempotent(
    input: EvidenceWriteInput,
  ): Promise<{ record: StoredEvidenceRecord; created: boolean }> {
    const key = evidenceKey(input.sourceId, input.sourceRecordId, input.checksum);
    const existingId = this.byKey.get(key);
    if (existingId) {
      return { record: this.byId.get(existingId) as StoredEvidenceRecord, created: false };
    }
    const record: StoredEvidenceRecord = deepFreeze({
      ...clone(input),
      id: `ev-${randomUUID()}`,
      lineage: [...(input.lineage ?? [])],
      correctionOf: input.correctionOf ?? null,
      correctionReason: input.correctionReason ?? null,
      parseStatus: input.parseStatus ??
        ((input as { parseStatus?: EvidenceRecord['parseStatus'] }).parseStatus ?? 'PENDING'),
      parsedPayload: deepFreeze(clone(input.parsedPayload ?? {})),
    }) as StoredEvidenceRecord;
    this.byId.set(record.id, record);
    this.byKey.set(key, record.id);
    this.order.push(record.id);
    return { record, created: true };
  }

  async appendCorrection(
    evidenceId: string,
    input: Partial<EvidenceWriteInput> & { checksum: string },
  ): Promise<StoredEvidenceRecord | null> {
    const original = this.byId.get(evidenceId);
    if (!original) return null;
    return (
      await this.createIdempotent({
        ...original,
        ...clone(input),
        sourceId: original.sourceId,
        sourceRecordId: original.sourceRecordId,
        checksum: input.checksum,
        capturedAt: input.capturedAt ?? new Date().toISOString(),
        observedAt: input.observedAt ?? original.observedAt,
        mimeType: input.mimeType ?? original.mimeType,
        rawRef: input.rawRef ?? original.rawRef,
        lineage: [...original.lineage, original.id],
        correctionOf: original.id,
        correctionReason: input.correctionReason ?? null,
      })
    ).record;
  }

  async get(id: string): Promise<EvidenceRecord | null> {
    return this.byId.get(id) ?? null;
  }

  async list(filters: Record<string, unknown> = {}): Promise<EvidenceRecord[]> {
    let rows = this.order.map((id) => this.byId.get(id) as StoredEvidenceRecord);
    for (const [key, value] of Object.entries(filters)) {
      if (value === undefined) continue;
      if (key === 'limit') continue;
      rows = rows.filter((row) => (row as unknown as Record<string, unknown>)[key] === value);
    }
    const limit = typeof filters.limit === 'number' ? filters.limit : undefined;
    return limit === undefined ? rows : rows.slice(0, limit);
  }
}

class InMemoryRunRepository implements IngestRunRepository {
  private readonly byId = new Map<string, IngestRun>();
  private readonly order: string[] = [];

  async create(input: IngestRunInput): Promise<IngestRun> {
    const run: IngestRun = {
      ...clone(input),
      id: input.id ?? `run-${randomUUID()}`,
      counts: clone(input.counts ?? {
        fetched: 0,
        created: 0,
        duplicates: 0,
        failed: 0,
        candidates: 0,
      }),
      errors: clone(input.errors ?? []),
      meta: clone(input.meta ?? {}),
    };
    this.byId.set(run.id, run);
    this.order.push(run.id);
    return run;
  }

  async get(id: string): Promise<IngestRun | null> {
    return this.byId.get(id) ?? null;
  }

  async list(filters: Record<string, unknown> = {}): Promise<IngestRun[]> {
    let rows = this.order.map((id) => this.byId.get(id) as IngestRun);
    for (const [key, value] of Object.entries(filters)) {
      if (value === undefined || key === 'limit') continue;
      rows = rows.filter((row) => (row as unknown as Record<string, unknown>)[key] === value);
    }
    rows = [...rows].reverse();
    const limit = typeof filters.limit === 'number' ? filters.limit : undefined;
    return limit === undefined ? rows : rows.slice(0, limit);
  }

  async update(id: string, patch: Partial<IngestRun>): Promise<IngestRun | null> {
    const current = this.byId.get(id);
    if (!current) return null;
    const updated: IngestRun = { ...current, ...clone(patch), id: current.id };
    this.byId.set(id, updated);
    return updated;
  }

  async lastSuccessful(sourceId: string): Promise<IngestRun | null> {
    const rows = await this.list({ sourceId });
    return (
      rows.find((row) => row.status === 'COMPLETED' || row.status === 'PARTIAL') ?? null
    );
  }
}

class InMemoryCandidateRepository implements CandidateRepository {
  private readonly byId = new Map<string, IngestCandidate>();
  private readonly order: string[] = [];

  async create(candidate: IngestCandidate): Promise<IngestCandidate> {
    const id =
      (candidate as { id?: string }).id ??
      `cand-${candidate.evidenceId}:${candidate.targetIdentityRef}:${candidate.basis}:${String(candidate.amount)}`;
    const existing = this.byId.get(id);
    if (existing) return existing;
    const stored = deepFreeze(clone({ ...candidate, id })) as IngestCandidate;
    this.byId.set(id, stored);
    this.order.push(id);
    return stored;
  }

  async get(id: string): Promise<IngestCandidate | null> {
    return this.byId.get(id) ?? null;
  }

  async list(filters: Record<string, unknown> = {}): Promise<IngestCandidate[]> {
    let rows = this.order.map((id) => this.byId.get(id) as IngestCandidate);
    for (const [key, value] of Object.entries(filters)) {
      if (value === undefined || key === 'limit') continue;
      rows = rows.filter((row) => (row as unknown as Record<string, unknown>)[key] === value);
    }
    const limit = typeof filters.limit === 'number' ? filters.limit : undefined;
    return limit === undefined ? rows : rows.slice(0, limit);
  }
}

type BaseObservationRepository = RepositoryBundle['marketObservations'];

class InMemoryObservationRepository implements BaseObservationRepository {
  private readonly byId = new Map<string, MarketObservation>();

  async create(input: MarketObservationInput): Promise<MarketObservation> {
    const record: MarketObservation = {
      ...clone(input),
      id: `obs-${randomUUID()}`,
      status: input.status ?? 'RAW',
    };
    this.byId.set(record.id, record);
    return record;
  }

  async get(id: string): Promise<MarketObservation | null> {
    return this.byId.get(id) ?? null;
  }

  async list(filters: Record<string, unknown> = {}): Promise<MarketObservation[]> {
    return [...this.byId.values()].filter((row) =>
      Object.entries(filters).every(
        ([key, value]) => value === undefined || (row as unknown as Record<string, unknown>)[key] === value,
      ),
    );
  }
}

export function createInMemoryRepositories(): IngestRepositories {
  return {
    evidence: new InMemoryEvidenceRepository(),
    marketObservations: new InMemoryObservationRepository(),
    runs: new InMemoryRunRepository(),
    candidates: new InMemoryCandidateRepository(),
  };
}
