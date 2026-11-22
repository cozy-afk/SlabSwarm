/** Postgres-backed job table. No Redis, no external queue. */

import { randomUUID } from 'node:crypto';
import type { DbStore, Row } from '../store.ts';
import { requireNonEmpty } from '../validation.ts';

export type JobStatus = 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED';
export interface JobInput {
  kind: string;
  status?: JobStatus;
  payload?: Record<string, unknown> | null;
  attempts?: number;
  runAt?: string | null;
}

export interface Job extends JobInput {
  id: string;
  status: JobStatus;
  attempts: number;
  createdAt: string;
}

export interface JobsRepository {
  create(input: JobInput): Promise<Job>;
  get(id: string): Promise<Job | null>;
  list(filters?: Record<string, unknown>): Promise<Job[]>;
  upsert(input: Job): Promise<Job>;
}

const TABLE = 'jobs';
const CONFLICT_KEYS = ['id'];

function toRow(input: JobInput, id: string, createdAt: string): Row {
  return {
    id,
    kind: input.kind,
    status: input.status ?? 'PENDING',
    payload: input.payload ?? null,
    attempts: input.attempts ?? 0,
    runAt: input.runAt ?? null,
    lockedAt: null,
    lastError: null,
    createdAt,
    updatedAt: new Date().toISOString(),
  };
}

export function createJobsRepository(store: DbStore): JobsRepository {
  return {
    async create(input): Promise<Job> {
      requireNonEmpty(input.kind, 'kind');
      return (await store.insert(TABLE, toRow(input, randomUUID(), new Date().toISOString()))) as unknown as Job;
    },
    async get(id): Promise<Job | null> {
      const row = await store.findById(TABLE, id);
      return row ? (row as unknown as Job) : null;
    },
    async list(filters = {}): Promise<Job[]> {
      return (await store.findAll(TABLE, filters, { orderBy: { column: 'createdAt', direction: 'DESC' } })) as unknown as Job[];
    },
    async upsert(input): Promise<Job> {
      return (await store.upsert(TABLE, toRow(input, input.id, input.createdAt ?? new Date().toISOString()), CONFLICT_KEYS)) as unknown as Job;
    },
  };
}
