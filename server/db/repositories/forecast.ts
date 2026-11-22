/** Deterministic forecasts. Bands and drivers are JSONB; status starts as HYPOTHESIS. */

import { randomUUID } from 'node:crypto';
import type { Forecast } from '../../contracts/dataProduct.ts';
import type { DbStore, Row } from '../store.ts';
import { requireFiniteAmount, requireNonEmpty } from '../validation.ts';

export type { Forecast } from '../../contracts/dataProduct.ts';

export type ForecastInput = Omit<Forecast, 'id' | 'createdAt' | 'status'> & { status?: Forecast['status'] };
export interface ForecastRepository {
  create(input: ForecastInput): Promise<Forecast>;
  get(id: string): Promise<Forecast | null>;
  list(filters?: Record<string, unknown>): Promise<Forecast[]>;
  upsert(input: Forecast): Promise<Forecast>;
}

const TABLE = 'forecasts';
const CONFLICT_KEYS = ['id'];

function toRow(input: ForecastInput, id: string, createdAt: string): Row {
  return {
    id,
    targetType: input.targetType,
    targetId: input.targetId,
    horizonDays: input.horizonDays,
    scenario: input.scenario,
    priceBands: input.priceBands,
    demandPressure: input.demandPressure,
    supplyPressure: input.supplyPressure,
    drivers: input.drivers,
    invalidators: input.invalidators,
    evidenceIds: input.evidenceIds,
    confidence: input.confidence,
    status: input.status ?? 'HYPOTHESIS',
    createdAt,
  };
}

export function createForecastRepository(store: DbStore): ForecastRepository {
  return {
    async create(input): Promise<Forecast> {
      requireNonEmpty(input.targetId, 'targetId');
      requireFiniteAmount(input.priceBands.base, 'priceBands.base');
      return (await store.insert(TABLE, toRow(input, randomUUID(), new Date().toISOString()))) as unknown as Forecast;
    },
    async get(id): Promise<Forecast | null> {
      const row = await store.findById(TABLE, id);
      return row ? (row as unknown as Forecast) : null;
    },
    async list(filters = {}): Promise<Forecast[]> {
      return (await store.findAll(TABLE, filters, { orderBy: { column: 'createdAt', direction: 'DESC' } })) as unknown as Forecast[];
    },
    async upsert(input): Promise<Forecast> {
      const row = toRow(input, input.id, input.createdAt ?? new Date().toISOString());
      return (await store.upsert(TABLE, row, CONFLICT_KEYS)) as unknown as Forecast;
    },
  };
}
