/** Immutable evidence ledger. Corrections append; upserts only update derived fields. */

import { randomUUID } from 'node:crypto';
import type { EvidenceRecord, EvidenceRecordInput } from '../../contracts/dataProduct.ts';
import type { DbStore, Row } from '../store.ts';
import { requireNonEmpty } from '../validation.ts';

const TABLE = 'evidence_records';
const CONFLICT_KEYS = ['sourceId', 'sourceRecordId', 'checksum'];

export interface EvidenceRepository {
  create(input: EvidenceRecordInput): Promise<EvidenceRecord>;
  get(id: string): Promise<EvidenceRecord | null>;
  list(filters?: Record<string, unknown>): Promise<EvidenceRecord[]>;
  upsert(input: EvidenceRecordInput): Promise<EvidenceRecord>;
}

function validate(input: EvidenceRecordInput): void {
  requireNonEmpty(input.sourceId, 'sourceId');
  requireNonEmpty(input.sourceRecordId, 'sourceRecordId');
  requireNonEmpty(input.checksum, 'checksum');
  requireNonEmpty(input.mimeType, 'mimeType');
  requireNonEmpty(input.rawRef, 'rawRef');
  requireNonEmpty(input.capturedAt, 'capturedAt');
  requireNonEmpty(input.observedAt, 'observedAt');
}

function toRow(input: EvidenceRecordInput, id: string): Row {
  return {
    id,
    sourceId: input.sourceId,
    sourceRecordId: input.sourceRecordId,
    sourceUri: input.sourceUri ?? null,
    capturedAt: input.capturedAt,
    observedAt: input.observedAt,
    checksum: input.checksum,
    mimeType: input.mimeType,
    license: input.license ?? null,
    rawRef: input.rawRef,
    parsedPayload: input.parsedPayload ?? null,
    trustTier: input.trustTier ?? 'UNKNOWN',
    parseStatus: 'PENDING',
    createdAt: new Date().toISOString(),
  };
}

export function createEvidenceRepository(store: DbStore): EvidenceRepository {
  return {
    async create(input: EvidenceRecordInput): Promise<EvidenceRecord> {
      validate(input);
      return (await store.insert(TABLE, toRow(input, randomUUID()))) as unknown as EvidenceRecord;
    },
    async get(id: string): Promise<EvidenceRecord | null> {
      const row = await store.findById(TABLE, id);
      return row ? (row as unknown as EvidenceRecord) : null;
    },
    async list(filters: Record<string, unknown> = {}): Promise<EvidenceRecord[]> {
      const rows = await store.findAll(TABLE, filters, { orderBy: { column: 'observedAt', direction: 'DESC' } });
      return rows as unknown as EvidenceRecord[];
    },
    async upsert(input: EvidenceRecordInput): Promise<EvidenceRecord> {
      validate(input);
      const [existing] = await store.findAll(TABLE, Object.fromEntries(CONFLICT_KEYS.map((key) => [key, (input as unknown as Row)[key]])));
      const id = String(existing?.id ?? randomUUID());
      const next = toRow(input, id);
      if (existing) {
        // Raw fields are immutable: keep the original source and checksum values.
        for (const key of CONFLICT_KEYS) next[key] = existing[key];
        next.parseStatus = existing.parseStatus;
        next.createdAt = existing.createdAt;
      }
      return (await store.upsert(TABLE, next, CONFLICT_KEYS)) as unknown as EvidenceRecord;
    },
  };
}
