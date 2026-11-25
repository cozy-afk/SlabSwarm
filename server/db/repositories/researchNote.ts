/** Durable research notes. All fields are append-only research traces, never canonical facts. */

import type { DbStore, Row } from '../store.ts';

const TABLE = 'research_notes';

export interface ResearchNoteRecord {
  id: string;
  question: string;
  subquestions?: readonly Record<string, unknown>[];
  evidenceIds?: readonly string[];
  synthesis?: string;
  confidence?: number;
  missingData?: readonly string[];
  source?: Record<string, unknown>;
  observedAt?: string;
  createdAt: string;
}

export type ResearchNoteInput = Omit<ResearchNoteRecord, 'createdAt'> & { createdAt?: string };

export interface ResearchNoteRepository {
  create(input: ResearchNoteInput): Promise<ResearchNoteRecord>;
  get(id: string): Promise<ResearchNoteRecord | null>;
  list(filters?: Record<string, unknown>): Promise<ResearchNoteRecord[]>;
  upsert(input: ResearchNoteInput): Promise<ResearchNoteRecord>;
}

function toRow(input: ResearchNoteInput): Row {
  return {
    id: input.id,
    question: input.question,
    subquestions: input.subquestions ?? [],
    evidenceIds: input.evidenceIds ?? [],
    synthesis: input.synthesis ?? '',
    confidence: input.confidence ?? 0,
    missingData: input.missingData ?? [],
    source: input.source ?? {},
    observedAt: input.observedAt,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}

export function createResearchNoteRepository(store: DbStore): ResearchNoteRepository {
  return {
    async create(input): Promise<ResearchNoteRecord> {
      const row = toRow(input);
      return (await store.insert(TABLE, row)) as unknown as ResearchNoteRecord;
    },
    async get(id): Promise<ResearchNoteRecord | null> {
      const row = await store.findById(TABLE, id);
      return row ? (row as unknown as ResearchNoteRecord) : null;
    },
    async list(filters = {}): Promise<ResearchNoteRecord[]> {
      return (await store.findAll(TABLE, filters, {
        orderBy: { column: 'createdAt', direction: 'DESC' },
      })) as unknown as ResearchNoteRecord[];
    },
    async upsert(input): Promise<ResearchNoteRecord> {
      return (await store.upsert(TABLE, toRow(input), ['id'])) as unknown as ResearchNoteRecord;
    },
  };
}
