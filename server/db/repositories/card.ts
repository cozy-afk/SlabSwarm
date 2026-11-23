/** Canonical card identity with JSONB facets and raw payloads. */

import { randomUUID } from 'node:crypto';
import { reusedIso } from './dates.ts';
import type { DbStore, Row } from '../store.ts';
import { requireNonEmpty } from '../validation.ts';

export interface CardInput {
  id?: string;
  setId?: string | null;
  name: string;
  cardNumber?: string | null;
  variant?: string | null;
  identityKey: string;
  facets?: Record<string, unknown> | null;
  rawPayload?: Record<string, unknown> | null;
}

export interface Card extends CardInput {
  id: string;
  createdAt: string;
}

export interface CardRepository {
  create(input: CardInput): Promise<Card>;
  get(id: string): Promise<Card | null>;
  list(filters?: Record<string, unknown>): Promise<Card[]>;
  upsert(input: CardInput): Promise<Card>;
}

const TABLE = 'cards';
const CONFLICT_KEYS = ['identityKey'];

function toRow(input: CardInput, id: string, createdAt: string, existing?: Row): Row {
  return {
    id,
    setId: input.setId ?? existing?.setId ?? null,
    name: input.name,
    cardNumber: input.cardNumber ?? existing?.cardNumber ?? null,
    variant: input.variant ?? existing?.variant ?? null,
    identityKey: input.identityKey,
    facets: input.facets ?? null,
    rawPayload: input.rawPayload === undefined ? (existing?.rawPayload ?? null) : input.rawPayload,
    createdAt,
  };
}

export function createCardRepository(store: DbStore): CardRepository {
  return {
    create(input): Promise<Card> {
      requireNonEmpty(input.name, 'name');
      requireNonEmpty(input.identityKey, 'identityKey');
      return store.insert(TABLE, toRow(input, input.id ?? randomUUID(), new Date().toISOString())) as unknown as Promise<Card>;
    },
    async get(id): Promise<Card | null> {
      const row = await store.findById(TABLE, id);
      return row ? (row as unknown as Card) : null;
    },
    async list(filters = {}): Promise<Card[]> {
      return (await store.findAll(TABLE, filters)) as unknown as Card[];
    },
    async upsert(input): Promise<Card> {
      requireNonEmpty(input.name, 'name');
      requireNonEmpty(input.identityKey, 'identityKey');
      const [existing] = await store.findAll(TABLE, { identityKey: input.identityKey });
      const row = toRow(input, String(existing?.id ?? input.id ?? randomUUID()), reusedIso(existing?.createdAt), existing);
      return (await store.upsert(TABLE, row, CONFLICT_KEYS)) as unknown as Card;
    },
  };
}
