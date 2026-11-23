/** Canonical identity decision and alias repositories.
 *
 * The schema already defines `identity_decisions` and `aliases`; this module
 * is the repository boundary for them (no ad hoc SQL outside the repository
 * layer). Rows are append-only: a merge never deletes or rewrites the absorbed
 * identity, so a decision can be audited and reversed.
 */

import { randomUUID } from 'node:crypto';
import type { DbStore, Row } from '../store.ts';
import { requireNonEmpty } from '../validation.ts';

const DECISIONS_TABLE = 'identity_decisions';
const ALIASES_TABLE = 'aliases';

export interface IdentityDecisionInput {
  id?: string;
  targetRef: string;
  status: string;
  candidates?: unknown[];
  scores?: Record<string, unknown>;
  votes?: unknown[];
  contradictions?: string[];
  createdAt?: string;
}

export interface IdentityDecisionRow extends IdentityDecisionInput {
  id: string;
  candidates: unknown[];
  scores: Record<string, unknown>;
  votes: unknown[];
  contradictions: string[];
  createdAt: string;
}

export interface IdentityDecisionRepository {
  create(input: IdentityDecisionInput): Promise<IdentityDecisionRow>;
  get(id: string): Promise<IdentityDecisionRow | null>;
  list(filters?: Record<string, unknown>): Promise<IdentityDecisionRow[]>;
}

export interface AliasInput {
  id?: string;
  entityId: string;
  alias: string;
  source: string;
  confidence?: number | null;
}

export interface AliasRow extends AliasInput {
  id: string;
  confidence: number | null;
}

export interface AliasRepository {
  create(input: AliasInput): Promise<AliasRow>;
  list(filters?: Record<string, unknown>): Promise<AliasRow[]>;
  upsert(input: AliasInput): Promise<AliasRow>;
}

function decisionToRow(input: IdentityDecisionInput): Row {
  return {
    id: input.id ?? randomUUID(),
    targetRef: input.targetRef,
    status: input.status,
    candidates: input.candidates ?? [],
    scores: input.scores ?? {},
    votes: input.votes ?? [],
    contradictions: input.contradictions ?? [],
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}

function aliasToRow(input: AliasInput): Row {
  return {
    id: input.id ?? randomUUID(),
    entityId: input.entityId,
    alias: input.alias,
    source: input.source,
    confidence: input.confidence ?? null,
  };
}

export function createIdentityDecisionRepository(store: DbStore): IdentityDecisionRepository {
  return {
    async create(input): Promise<IdentityDecisionRow> {
      requireNonEmpty(input.targetRef, 'targetRef');
      requireNonEmpty(input.status, 'status');
      return (await store.insert(DECISIONS_TABLE, decisionToRow(input))) as unknown as IdentityDecisionRow;
    },
    async get(id): Promise<IdentityDecisionRow | null> {
      const row = await store.findById(DECISIONS_TABLE, id);
      return row ? (row as unknown as IdentityDecisionRow) : null;
    },
    async list(filters = {}): Promise<IdentityDecisionRow[]> {
      return (await store.findAll(
        DECISIONS_TABLE,
        filters,
        { orderBy: { column: 'createdAt', direction: 'ASC' } },
      )) as unknown as IdentityDecisionRow[];
    },
  };
}

export function createAliasRepository(store: DbStore): AliasRepository {
  const conflictKeys = ['entityId', 'alias', 'source'];
  return {
    async create(input): Promise<AliasRow> {
      requireNonEmpty(input.entityId, 'entityId');
      requireNonEmpty(input.alias, 'alias');
      requireNonEmpty(input.source, 'source');
      return (await store.insert(ALIASES_TABLE, aliasToRow(input))) as unknown as AliasRow;
    },
    async list(filters = {}): Promise<AliasRow[]> {
      return (await store.findAll(ALIASES_TABLE, filters)) as unknown as AliasRow[];
    },
    async upsert(input): Promise<AliasRow> {
      requireNonEmpty(input.entityId, 'entityId');
      requireNonEmpty(input.alias, 'alias');
      requireNonEmpty(input.source, 'source');
      return (await store.upsert(
        ALIASES_TABLE,
        aliasToRow(input),
        conflictKeys,
      )) as unknown as AliasRow;
    },
  };
}
