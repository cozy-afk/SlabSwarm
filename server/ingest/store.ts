// Ingest repositories with an optional file-backed, append-only ledger.
// The HTTP router and the seed script use the durable store so evidence
// survives process restarts and can be shared between processes. Tests can
// request an isolated in-memory store (the default under `node --test`) or an
// explicit file path; either way the repository API is identical.
//
// Evidence is immutable: records are frozen on write and keyed by the
// immutable triple (sourceId, sourceRecordId, checksum). Corrections are new
// records, never updates. Each mutation is persisted atomically (temp file +
// rename) so a crash cannot leave a partially written ledger.

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
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

const STORE_FILENAME = 'ingest-store.json';
const DEFAULT_DATA_DIR = './data';

export interface StoreOptions {
  /** Explicit path to the JSON ledger. `null` forces an ephemeral store. */
  filePath?: string | null;
  /** Directory containing ingest-store.json (alternative to filePath). */
  dataDir?: string;
  /** Force durability (or ephemerality with `false`) under any environment. */
  durable?: boolean;
  /** Environment used to resolve SLABSWARM_DATA_DIR. Defaults to process.env. */
  env?: Record<string, string | undefined>;
}

/** `$SLABSWARM_DATA_DIR/ingest-store.json`, falling back to ./data/. */
export function resolveIngestStorePath(
  env: Record<string, string | undefined> = process.env,
): string {
  const dir = typeof env.SLABSWARM_DATA_DIR === 'string' && env.SLABSWARM_DATA_DIR.trim() !== ''
    ? env.SLABSWARM_DATA_DIR.trim()
    : DEFAULT_DATA_DIR;
  return resolve(dir, STORE_FILENAME);
}

export const DEFAULT_INGEST_STORE_PATH = resolveIngestStorePath();

function isTestRunner(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.NODE_TEST_CONTEXT) || env.NODE_ENV === 'test';
}

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

interface StoreSnapshot {
  version: 1;
  evidence: StoredEvidenceRecord[];
  runs: IngestRun[];
  candidates: IngestCandidate[];
  observations: MarketObservation[];
}

function emptySnapshot(): StoreSnapshot {
  return { version: 1, evidence: [], runs: [], candidates: [], observations: [] };
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Mutable indexes plus atomic persistence. Instances for the same path share
 * one state object in-process; before each mutation we also reload from disk
 * so a second process (e.g. the seed script vs. the running server) cannot be
 * silently overwritten by a stale snapshot.
 */
class LedgerState {
  readonly filePath: string | null;
  private evidenceRows: StoredEvidenceRecord[] = [];
  private runRows: IngestRun[] = [];
  private candidateRows: IngestCandidate[] = [];
  private observationRows: MarketObservation[] = [];
  private readonly evidenceById = new Map<string, StoredEvidenceRecord>();
  private readonly evidenceByKey = new Map<string, string>();
  private readonly runsById = new Map<string, IngestRun>();
  private readonly candidatesById = new Map<string, IngestCandidate>();
  private readonly observationsById = new Map<string, MarketObservation>();

  constructor(filePath: string | null) {
    this.filePath = filePath ? resolve(filePath) : null;
    if (this.filePath) this.load();
  }

  private load(): void {
    if (!this.filePath) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.hydrate(emptySnapshot());
        return;
      }
      throw new Error(`cannot read ingest store ${this.filePath}: ${(error as Error).message}`);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`invalid ingest store at ${this.filePath}`);
    }
    this.hydrate(parsed as StoreSnapshot);
  }

  private hydrate(raw: StoreSnapshot): void {
    this.evidenceRows = arrayOf(raw.evidence).map((row) =>
      deepFreeze(clone(row as StoredEvidenceRecord)),
    );
    this.runRows = arrayOf(raw.runs).map((row) => clone(row as IngestRun));
    this.candidateRows = arrayOf(raw.candidates).map((row) =>
      deepFreeze(clone(row as IngestCandidate)),
    );
    this.observationRows = arrayOf(raw.observations).map((row) =>
      clone(row as MarketObservation),
    );
    this.evidenceById.clear();
    this.evidenceByKey.clear();
    this.runsById.clear();
    this.candidatesById.clear();
    this.observationsById.clear();
    for (const row of this.evidenceRows) {
      this.evidenceById.set(row.id, row);
      this.evidenceByKey.set(evidenceKey(row.sourceId, row.sourceRecordId, row.checksum), row.id);
    }
    for (const row of this.runRows) this.runsById.set(row.id, row);
    for (const row of this.candidateRows) {
      this.candidatesById.set((row as IngestCandidate & { id: string }).id, row);
    }
    for (const row of this.observationRows) this.observationsById.set(row.id, row);
  }

  /** Read methods never reload: a reader sees one consistent in-process view. */
  evidence(): StoredEvidenceRecord[] {
    return [...this.evidenceRows];
  }
  getEvidence(id: string): StoredEvidenceRecord | undefined {
    return this.evidenceById.get(id);
  }
  getEvidenceByKey(key: string): StoredEvidenceRecord | undefined {
    const id = this.evidenceByKey.get(key);
    return id ? this.evidenceById.get(id) : undefined;
  }
  runs(): IngestRun[] {
    return [...this.runRows];
  }
  getRun(id: string): IngestRun | undefined {
    return this.runsById.get(id);
  }
  candidates(): IngestCandidate[] {
    return [...this.candidateRows];
  }
  observations(): MarketObservation[] {
    return [...this.observationRows];
  }
  getCandidate(id: string): IngestCandidate | undefined {
    return this.candidatesById.get(id);
  }

  /** Serialize a mutation: refresh from disk, apply it, then persist. */
  mutate(change: () => void): void {
    if (this.filePath) this.load();
    change();
    if (this.filePath) this.persist();
  }

  private persist(): void {
    if (!this.filePath) return;
    const snapshot: StoreSnapshot = {
      version: 1,
      evidence: this.evidenceRows,
      runs: this.runRows,
      candidates: this.candidateRows,
      observations: this.observationRows,
    };
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temp, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    renameSync(temp, this.filePath);
  }

  addEvidence(record: StoredEvidenceRecord): void {
    this.mutate(() => {
      this.evidenceRows.push(record);
      this.evidenceById.set(record.id, record);
      this.evidenceByKey.set(
        evidenceKey(record.sourceId, record.sourceRecordId, record.checksum),
        record.id,
      );
    });
  }

  addRun(run: IngestRun): void {
    this.mutate(() => {
      this.runRows.push(run);
      this.runsById.set(run.id, run);
    });
  }

  updateRun(id: string, updated: IngestRun): void {
    this.mutate(() => {
      const index = this.runRows.findIndex((row) => row.id === id);
      if (index >= 0) this.runRows[index] = updated;
      this.runsById.set(id, updated);
    });
  }

  addCandidate(candidate: IngestCandidate): void {
    this.mutate(() => {
      const id = (candidate as { id?: string }).id as string;
      this.candidateRows.push(candidate);
      this.candidatesById.set(id, candidate);
    });
  }

  addObservation(observation: MarketObservation): void {
    this.mutate(() => {
      this.observationRows.push(observation);
      this.observationsById.set(observation.id, observation);
    });
  }
}

const states = new Map<string, LedgerState>();

function stateFor(filePath: string | null): LedgerState {
  if (!filePath) return new LedgerState(null);
  const key = resolve(filePath);
  let state = states.get(key);
  if (!state) {
    state = new LedgerState(key);
    states.set(key, state);
  }
  return state;
}

function stateFromOptions(options: StoreOptions = {}, forceDurable = false): LedgerState {
  const env = options.env ?? process.env;
  let filePath: string | null;
  if (options.filePath !== undefined) {
    filePath = options.filePath === null ? null : resolve(options.filePath);
  } else if (options.dataDir !== undefined) {
    filePath = resolve(options.dataDir, STORE_FILENAME);
  } else if (forceDurable || options.durable === true) {
    filePath = resolveIngestStorePath(env);
  } else if (options.durable === false) {
    filePath = null;
  } else {
    // Legacy callers expect fresh process-local state inside tests. The
    // router calls createDurableRepositories() explicitly, so production is
    // always durable regardless of this test-only default.
    filePath = isTestRunner(env) ? null : resolveIngestStorePath(env);
  }
  return stateFor(filePath);
}

class LedgerEvidenceRepository implements EvidenceRepository {
  constructor(private readonly state: LedgerState) {}

  async create(input: EvidenceRecordInput): Promise<EvidenceRecord> {
    return (await this.createIdempotent(input as EvidenceWriteInput)).record;
  }

  async createIdempotent(
    input: EvidenceWriteInput,
  ): Promise<{ record: StoredEvidenceRecord; created: boolean }> {
    const key = evidenceKey(input.sourceId, input.sourceRecordId, input.checksum);
    const existing = this.state.getEvidenceByKey(key);
    if (existing) return { record: existing, created: false };
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
    this.state.addEvidence(record);
    return { record, created: true };
  }

  async appendCorrection(
    evidenceId: string,
    input: Partial<EvidenceWriteInput> & { checksum: string },
  ): Promise<StoredEvidenceRecord | null> {
    const original = this.state.getEvidence(evidenceId);
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
    return this.state.getEvidence(id) ?? null;
  }

  async list(filters: Record<string, unknown> = {}): Promise<EvidenceRecord[]> {
    let rows = this.state.evidence();
    for (const [key, value] of Object.entries(filters)) {
      if (value === undefined) continue;
      if (key === 'limit') continue;
      rows = rows.filter((row) => (row as unknown as Record<string, unknown>)[key] === value);
    }
    const limit = typeof filters.limit === 'number' ? filters.limit : undefined;
    return limit === undefined ? rows : rows.slice(0, limit);
  }
}

class LedgerRunRepository implements IngestRunRepository {
  constructor(private readonly state: LedgerState) {}

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
    this.state.addRun(run);
    return run;
  }

  async get(id: string): Promise<IngestRun | null> {
    return this.state.getRun(id) ?? null;
  }

  async list(filters: Record<string, unknown> = {}): Promise<IngestRun[]> {
    let rows = this.state.runs();
    for (const [key, value] of Object.entries(filters)) {
      if (value === undefined || key === 'limit') continue;
      rows = rows.filter((row) => (row as unknown as Record<string, unknown>)[key] === value);
    }
    rows = rows.reverse();
    const limit = typeof filters.limit === 'number' ? filters.limit : undefined;
    return limit === undefined ? rows : rows.slice(0, limit);
  }

  async update(id: string, patch: Partial<IngestRun>): Promise<IngestRun | null> {
    const current = this.state.getRun(id);
    if (!current) return null;
    const updated: IngestRun = { ...current, ...clone(patch), id: current.id };
    this.state.updateRun(id, updated);
    return updated;
  }

  async lastSuccessful(sourceId: string): Promise<IngestRun | null> {
    const rows = await this.list({ sourceId });
    return (
      rows.find((row) => row.status === 'COMPLETED' || row.status === 'PARTIAL') ?? null
    );
  }
}

class LedgerCandidateRepository implements CandidateRepository {
  constructor(private readonly state: LedgerState) {}

  async create(candidate: IngestCandidate): Promise<IngestCandidate> {
    const id =
      (candidate as { id?: string }).id ??
      `cand-${candidate.evidenceId}:${candidate.targetIdentityRef}:${candidate.basis}:${String(candidate.amount)}`;
    const existing = this.state.getCandidate(id);
    if (existing) return existing;
    const stored = deepFreeze(clone({ ...candidate, id })) as IngestCandidate;
    this.state.addCandidate(stored);
    return stored;
  }

  async get(id: string): Promise<IngestCandidate | null> {
    return this.state.getCandidate(id) ?? null;
  }

  async list(filters: Record<string, unknown> = {}): Promise<IngestCandidate[]> {
    let rows = this.state.candidates();
    for (const [key, value] of Object.entries(filters)) {
      if (value === undefined || key === 'limit') continue;
      rows = rows.filter((row) => (row as unknown as Record<string, unknown>)[key] === value);
    }
    const limit = typeof filters.limit === 'number' ? filters.limit : undefined;
    return limit === undefined ? rows : rows.slice(0, limit);
  }
}

type BaseObservationRepository = RepositoryBundle['marketObservations'];

class LedgerObservationRepository implements BaseObservationRepository {
  constructor(private readonly state: LedgerState) {}

  async create(input: MarketObservationInput): Promise<MarketObservation> {
    const record: MarketObservation = {
      ...clone(input),
      id: `obs-${randomUUID()}`,
      status: input.status ?? 'RAW',
    };
    this.state.addObservation(record);
    return record;
  }

  async get(id: string): Promise<MarketObservation | null> {
    return this.state.observations().find((row) => row.id === id) ?? null;
  }

  async list(filters: Record<string, unknown> = {}): Promise<MarketObservation[]> {
    return this.state.observations().filter((row) =>
      Object.entries(filters).every(
        ([key, value]) => value === undefined || (row as unknown as Record<string, unknown>)[key] === value,
      ),
    );
  }
}

function repositoriesFor(state: LedgerState): IngestRepositories {
  return {
    evidence: new LedgerEvidenceRepository(state),
    marketObservations: new LedgerObservationRepository(state),
    runs: new LedgerRunRepository(state),
    candidates: new LedgerCandidateRepository(state),
  };
}

/**
 * Always file-backed. Used by the default HTTP router and the seed script so
 * they share the same evidence across process restarts.
 */
export function createDurableRepositories(options: StoreOptions = {}): IngestRepositories {
  return repositoriesFor(stateFromOptions(options, true));
}

/** Backwards-compatible name; durable in production, isolated under tests. */
export function createInMemoryRepositories(options: StoreOptions = {}): IngestRepositories {
  return repositoriesFor(stateFromOptions(options));
}
