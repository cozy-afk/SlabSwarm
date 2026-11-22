/**
 * Phase 4 — INTELLIGENCE lane, Task 4: forecast repository.
 * Uses the frozen shared contract (server/contracts/dataProduct.ts) verbatim.
 * Every forecast begins as HYPOTHESIS; only scoring changes that status.
 */

import type { Forecast, ForecastBand } from '../contracts/dataProduct.ts';

export class ForecastValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForecastValidationError';
  }
}

export interface ForecastRecord extends Forecast {
  baselinePrice: number | null;
  sourceSimulationId?: string;
}

export interface ForecastFilters {
  targetId?: string;
  status?: Forecast['status'];
  horizonDays?: Forecast['horizonDays'];
}

class ForecastRepository {
  private readonly forecasts = new Map<string, ForecastRecord>();
  private sequence = 0;

  create(input: unknown): ForecastRecord {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      throw new ForecastValidationError('FORECAST_INPUT_REQUIRED');
    }
    const raw = input as Record<string, unknown>;
    if ('status' in raw && raw.status !== undefined && raw.status !== 'HYPOTHESIS') {
      throw new ForecastValidationError('FORECASTS_START_AS_HYPOTHESIS');
    }
    if (![7, 30, 90].includes(raw.horizonDays as number)) {
      throw new ForecastValidationError('INVALID_HORIZON');
    }
    const bands = raw.priceBands as Record<string, unknown> | undefined;
    if (!bands || typeof bands !== 'object') throw new ForecastValidationError('PRICE_BANDS_REQUIRED');
    const low = bands.low;
    const base = bands.base;
    const high = bands.high;
    if (![low, base, high].every((n) => typeof n === 'number' && Number.isFinite(n) && n > 0)) {
      throw new ForecastValidationError('INVALID_PRICE_BAND');
    }
    if ((low as number) > (base as number) || (base as number) > (high as number)) {
      throw new ForecastValidationError('PRICE_BANDS_OUT_OF_ORDER');
    }
    if (typeof bands.currency !== 'string' || bands.currency.trim() === '') {
      throw new ForecastValidationError('CURRENCY_REQUIRED');
    }
    if (!Array.isArray(raw.evidenceIds) || raw.evidenceIds.length === 0 ||
        raw.evidenceIds.some((id) => typeof id !== 'string' || id.length === 0)) {
      throw new ForecastValidationError('EVIDENCE_IDS_REQUIRED');
    }
    for (const key of ['drivers', 'invalidators'] as const) {
      if (!Array.isArray(raw[key]) || raw[key].length === 0) {
        throw new ForecastValidationError(`${key.toUpperCase()}_REQUIRED`);
      }
    }
    if (!['LOW', 'MEDIUM', 'HIGH'].includes(raw.confidence as string)) {
      throw new ForecastValidationError('INVALID_CONFIDENCE');
    }
    for (const key of ['demandPressure', 'supplyPressure'] as const) {
      if (!['LOW', 'MEDIUM', 'HIGH'].includes(raw[key] as string)) {
        throw new ForecastValidationError(`INVALID_${key.toUpperCase()}`);
      }
    }
    if (!['CARD', 'SET', 'COLLECTION', 'EVENT'].includes(raw.targetType as string)) {
      throw new ForecastValidationError('INVALID_TARGET_TYPE');
    }
    if (typeof raw.targetId !== 'string' || raw.targetId === '') {
      throw new ForecastValidationError('TARGET_ID_REQUIRED');
    }
    const baselinePrice = raw.baselinePrice === null || raw.baselinePrice === undefined
      ? null
      : typeof raw.baselinePrice === 'number' && Number.isFinite(raw.baselinePrice) && raw.baselinePrice > 0
        ? raw.baselinePrice
        : (() => { throw new ForecastValidationError('INVALID_BASELINE'); })();

    const priceBands: ForecastBand = {
      low: low as number,
      base: base as number,
      high: high as number,
      currency: bands.currency,
    };
    this.sequence += 1;
    const record: ForecastRecord = {
      id: `fc-${String(this.sequence).padStart(6, '0')}`,
      targetType: raw.targetType as Forecast['targetType'],
      targetId: raw.targetId,
      horizonDays: raw.horizonDays as Forecast['horizonDays'],
      scenario: typeof raw.scenario === 'string' ? raw.scenario : 'unspecified',
      priceBands,
      demandPressure: raw.demandPressure as Forecast['demandPressure'],
      supplyPressure: raw.supplyPressure as Forecast['supplyPressure'],
      drivers: [...(raw.drivers as string[])],
      invalidators: [...(raw.invalidators as string[])],
      evidenceIds: [...(raw.evidenceIds as string[])],
      confidence: raw.confidence as Forecast['confidence'],
      createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
      status: 'HYPOTHESIS',
      baselinePrice,
      ...(typeof raw.sourceSimulationId === 'string'
        ? { sourceSimulationId: raw.sourceSimulationId }
        : {}),
    };
    this.forecasts.set(record.id, record);
    return record;
  }

  get(id: string): ForecastRecord | null {
    return this.forecasts.get(id) ?? null;
  }

  list(filters: ForecastFilters = {}): ForecastRecord[] {
    return [...this.forecasts.values()].filter((f) => {
      if (filters.targetId !== undefined && f.targetId !== filters.targetId) return false;
      if (filters.status !== undefined && f.status !== filters.status) return false;
      if (filters.horizonDays !== undefined && f.horizonDays !== filters.horizonDays) return false;
      return true;
    });
  }

  markScored(id: string): ForecastRecord {
    const record = this.forecasts.get(id);
    if (!record) throw new Error('FORECAST_NOT_FOUND');
    record.status = 'SCORED';
    return record;
  }

  clear(): void {
    this.forecasts.clear();
    this.sequence = 0;
  }
}

export const forecastRepository = new ForecastRepository();

/** Helper for HTTP + orchestration callers that validate untrusted JSON. */
export function createForecast(input: unknown): ForecastRecord {
  return forecastRepository.create(input);
}
