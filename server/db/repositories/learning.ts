/** Append-only learning events and source trust updates. */

import { randomUUID } from 'node:crypto';
import type { DbStore, Row } from '../store.ts';
import { requireNonEmpty } from '../validation.ts';

export interface LearningEventInput {
  kind: string;
  targetId?: string | null;
  score?: number | null;
  payload?: Record<string, unknown> | null;
  observedAt?: string;
}

export interface LearningEvent extends LearningEventInput {
  id: string;
  createdAt: string;
}

export interface LearningRepository {
  create(input: LearningEventInput): Promise<LearningEvent>;
  get(id: string): Promise<LearningEvent | null>;
  list(filters?: Record<string, unknown>): Promise<LearningEvent[]>;
  upsert(input: LearningEvent): Promise<LearningEvent>;
}

const TABLE = 'learning_events';
const CONFLICT_KEYS = ['id'];

function toRow(input: LearningEventInput, id: string, createdAt: string): Row {
  return {
    id,
    kind: input.kind,
    targetId: input.targetId ?? null,
    score: input.score ?? null,
    payload: input.payload ?? null,
    observedAt: input.observedAt ?? new Date().toISOString(),
    createdAt,
  };
}

export function createLearningRepository(store: DbStore): LearningRepository {
  return {
    async create(input): Promise<LearningEvent> {
      requireNonEmpty(input.kind, 'kind');
      return (await store.insert(TABLE, toRow(input, randomUUID(), new Date().toISOString()))) as unknown as LearningEvent;
    },
    async get(id): Promise<LearningEvent | null> {
      const row = await store.findById(TABLE, id);
      return row ? (row as unknown as LearningEvent) : null;
    },
    async list(filters = {}): Promise<LearningEvent[]> {
      return (await store.findAll(TABLE, filters, { orderBy: { column: 'createdAt', direction: 'DESC' } })) as unknown as LearningEvent[];
    },
    async upsert(input): Promise<LearningEvent> {
      return (await store.upsert(TABLE, toRow(input, input.id, input.createdAt ?? new Date().toISOString()), CONFLICT_KEYS)) as unknown as LearningEvent;
    },
  };
}
