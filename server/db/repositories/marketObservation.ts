/** First-party market observations with explicit basis and UNKNOWN-preserving components. */

import { randomUUID } from 'node:crypto';
import { reusedIso } from './dates.ts';
import type { MarketObservation, MarketObservationInput } from '../../contracts/dataProduct.ts';
import type { DbStore, Row } from '../store.ts';
import { assertBasis, requireFiniteAmount, requireNonEmpty } from '../validation.ts';

const TABLE = 'market_observations';
const CONFLICT_KEYS = ['evidenceId', 'targetIdentityId', 'basis', 'observedAt'];

export interface MarketObservationRepository {
  create(input: MarketObservationInput): Promise<MarketObservation>;
  get(id: string): Promise<MarketObservation | null>;
  list(filters?: Record<string, unknown>): Promise<MarketObservation[]>;
  upsert(input: MarketObservationInput): Promise<MarketObservation>;
}

function toRow(input: MarketObservationInput, id: string, existing?: Row): Row {
  return {
    id,
    evidenceId: input.evidenceId,
    sourceRecordId: (input as unknown as Row).sourceRecordId ?? null,
    targetIdentityId: input.targetIdentityRef,
    basis: input.basis,
    amount: input.amount,
    currency: input.currency,
    marketplace: input.marketplace ?? null,
    observedAt: input.observedAt,
    capturedAt: reusedIso(existing?.capturedAt),
    priceComponents: input.priceComponents ?? null,
    status: input.status ?? existing?.status ?? 'RAW',
    confidence: (input as unknown as Row).confidence ?? null,
    lineage: existing?.lineage ?? { evidenceId: input.evidenceId, targetIdentityRef: input.targetIdentityRef },
    createdAt: reusedIso(existing?.createdAt),
  };
}

export function createMarketObservationRepository(store: DbStore): MarketObservationRepository {
  return {
    async create(input: MarketObservationInput): Promise<MarketObservation> {
      assertBasis(input.basis);
      requireFiniteAmount(input.amount, 'amount');
      requireNonEmpty(input.currency, 'currency');
      requireNonEmpty(input.evidenceId, 'evidenceId');
      requireNonEmpty(input.targetIdentityRef, 'targetIdentityRef');
      requireNonEmpty(input.observedAt, 'observedAt');
      return (await store.insert(TABLE, toRow(input, randomUUID()))) as unknown as MarketObservation;
    },
    async get(id: string): Promise<MarketObservation | null> {
      const row = await store.findById(TABLE, id);
      return row ? (row as unknown as MarketObservation) : null;
    },
    async list(filters: Record<string, unknown> = {}): Promise<MarketObservation[]> {
      const normalized: Row = { ...filters };
      if ('targetIdentityRef' in normalized) {
        normalized.targetIdentityId = normalized.targetIdentityRef;
        delete normalized.targetIdentityRef;
      }
      const rows = await store.findAll(TABLE, normalized, { orderBy: { column: 'observedAt', direction: 'DESC' } });
      return rows as unknown as MarketObservation[];
    },
    async upsert(input: MarketObservationInput): Promise<MarketObservation> {
      assertBasis(input.basis);
      requireFiniteAmount(input.amount, 'amount');
      requireNonEmpty(input.currency, 'currency');
      const [existing] = await store.findAll(TABLE, Object.fromEntries(CONFLICT_KEYS.map((key) => {
        const value = key === 'targetIdentityId' ? input.targetIdentityRef : (input as unknown as Row)[key];
        return [key, value];
      })));
      const next = toRow(input, String(existing?.id ?? randomUUID()), existing);
      return (await store.upsert(TABLE, next, CONFLICT_KEYS)) as unknown as MarketObservation;
    },
  };
}
