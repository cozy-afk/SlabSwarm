// Evidence service: validation, content-addressed checksums and append-only
// corrections. The ledger is the only writer to evidence records; adapters
// never write canonical facts.

import { createHash } from 'node:crypto';
import type { EvidenceRecordInput } from '../contracts/dataProduct.ts';
import { evidenceKey } from './store.ts';
import type {
  EvidenceRepository,
  EvidenceWriteInput,
  IngestRepositories,
  StoredEvidenceRecord,
} from './types.ts';

export class EvidenceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvidenceValidationError';
  }
}

/** Canonical JSON: object keys sorted so equivalent payloads share a digest. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value ?? null;
}

export function computeChecksum(payload: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(payload)))
    .digest('hex');
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new EvidenceValidationError(`${label} is required and must be a non-empty string.`);
  }
  return value;
}

export function validateEvidenceInput(input: unknown): EvidenceRecordInput {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new EvidenceValidationError('Evidence input must be an object.');
  }
  const raw = input as Record<string, unknown>;
  const trustTier = raw.trustTier ?? 'UNKNOWN';
  if (!['UNKNOWN', 'LOW', 'MEDIUM', 'HIGH'].includes(String(trustTier))) {
    throw new EvidenceValidationError('Invalid trustTier.');
  }
  return {
    sourceId: requiredString(raw.sourceId, 'sourceId'),
    sourceRecordId: requiredString(raw.sourceRecordId, 'sourceRecordId'),
    sourceUri: typeof raw.sourceUri === 'string' ? raw.sourceUri : null,
    capturedAt: requiredString(raw.capturedAt, 'capturedAt'),
    observedAt: requiredString(raw.observedAt, 'observedAt'),
    checksum: requiredString(raw.checksum, 'checksum'),
    mimeType: requiredString(raw.mimeType, 'mimeType'),
    license: typeof raw.license === 'string' ? raw.license : null,
    rawRef: requiredString(raw.rawRef, 'rawRef'),
    parsedPayload:
      raw.parsedPayload && typeof raw.parsedPayload === 'object' && !Array.isArray(raw.parsedPayload)
        ? (raw.parsedPayload as Record<string, unknown>)
        : {},
    trustTier: trustTier as EvidenceRecordInput['trustTier'],
  };
}

export function createEvidenceService(repos: Pick<IngestRepositories, 'evidence'>) {
  const evidence: EvidenceRepository = repos.evidence;
  return {
    async create(input: EvidenceWriteInput): Promise<StoredEvidenceRecord> {
      return (await evidence.createIdempotent(validateEvidenceInput(input) as EvidenceWriteInput)).record;
    },
    async createIdempotent(input: EvidenceWriteInput) {
      return evidence.createIdempotent(validateEvidenceInput(input) as EvidenceWriteInput);
    },
    get(id: string) {
      return evidence.get(id);
    },
    list(filters?: Record<string, unknown>) {
      return evidence.list(filters);
    },
    /** Corrections are new evidence records linked to the immutable original. */
    async appendCorrection(
      evidenceId: string,
      patch: Partial<EvidenceWriteInput> & { checksum: string },
    ): Promise<StoredEvidenceRecord | null> {
      return evidence.appendCorrection(evidenceId, patch);
    },
  };
}

export { evidenceKey };
