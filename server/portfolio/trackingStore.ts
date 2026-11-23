/**
 * Task 17 in-process tracking store. Stores only operator-entered watchlist,
 * holding, sale and alert-rule records plus in-app alert state. No canonical
 * fact, billing record, external notification or model output is written.
 */

import {
  ALERT_METRICS,
  UNKNOWN,
  type AlertMetric,
  type AlertRuleRecord,
  type AlertState,
  type HoldingRecord,
  type NumberOrUnknown,
  type SaleRecord,
  type WatchItemRecord,
} from './tracking.ts';

export class TrackingValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TrackingValidationError';
  }
}

export interface TrackingStoreOptions {
  now?: () => Date;
}

export interface WatchInput {
  targetId: string;
  grade?: string | null;
  note?: string;
}

export interface HoldingInput {
  assetId: string;
  grade?: string | null;
  quantity: number;
  unitCost: NumberOrUnknown;
  costCurrency?: string | null;
  costBasis: string;
  costSource: string;
  acquiredAt?: string | null;
  fees?: NumberOrUnknown;
  shipping?: NumberOrUnknown;
  note?: string;
}

export interface SaleInput {
  holdingId: string;
  quantity: number;
  unitProceeds: NumberOrUnknown;
  proceedsCurrency?: string | null;
  proceedsBasis: string;
  proceedsSource: string;
  soldAt?: string | null;
  fees?: NumberOrUnknown;
  shipping?: NumberOrUnknown;
  note?: string;
}

export interface AlertRuleInput {
  targetId: string;
  metric: AlertMetric;
  threshold: number;
  basis?: 'SOLD_DERIVED';
  grade?: string | null;
  active?: boolean;
  note?: string;
}

export interface TrackingStore {
  listWatchlist(): WatchItemRecord[];
  addWatchlist(input: WatchInput): WatchItemRecord;
  removeWatchlist(id: string): boolean;
  listHoldings(): HoldingRecord[];
  addHolding(input: HoldingInput): HoldingRecord;
  removeHolding(id: string): boolean;
  listSales(): SaleRecord[];
  addSale(input: SaleInput): SaleRecord;
  removeSale(id: string): boolean;
  listRules(): AlertRuleRecord[];
  addRule(input: AlertRuleInput): AlertRuleRecord;
  toggleRule(id: string): AlertRuleRecord | null;
  removeRule(id: string): boolean;
  listAlertStates(): AlertState[];
  replaceAlertStates(states: readonly AlertState[]): AlertState[];
  acknowledgeAlert(id: string): AlertState | null;
  clearAlertStates(): number;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TrackingValidationError(`${label} is required and must be a non-empty string.`);
  }
  return value.trim();
}

function optionalText(value: unknown, fallback: string = UNKNOWN): string {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
}

function numericOrUnknown(value: unknown, label: string): NumberOrUnknown {
  if (value === UNKNOWN || value === undefined || value === null) return UNKNOWN;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TrackingValidationError(`${label} must be a non-negative finite number or UNKNOWN.`);
  }
  return value;
}

function positiveInt(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new TrackingValidationError(`${label} must be a positive integer.`);
  }
  return value;
}

function noteOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** Create an isolated store. Every returned record is a defensive copy. */
export function createTrackingStore(options: TrackingStoreOptions = {}): TrackingStore {
  const now = options.now ?? (() => new Date());
  let watchlist: WatchItemRecord[] = [];
  let holdings: HoldingRecord[] = [];
  let sales: SaleRecord[] = [];
  let rules: AlertRuleRecord[] = [];
  let alertStates: AlertState[] = [];
  let watchSeq = 0;
  let holdingSeq = 0;
  let saleSeq = 0;
  let ruleSeq = 0;

  return {
    listWatchlist: () => clone(watchlist),

    addWatchlist(input: WatchInput): WatchItemRecord {
      const record: WatchItemRecord = {
        id: `watch-${++watchSeq}`,
        targetId: requiredText(input?.targetId, 'targetId'),
        grade: optionalText(input?.grade),
        addedAt: now().toISOString(),
        ...(noteOf(input?.note) !== undefined ? { note: noteOf(input?.note) } : {}),
      };
      watchlist.push(record);
      return clone(record);
    },

    removeWatchlist(id: string): boolean {
      const before = watchlist.length;
      watchlist = watchlist.filter((item) => item.id !== id);
      return watchlist.length !== before;
    },

    listHoldings: () => clone(holdings),

    addHolding(input: HoldingInput): HoldingRecord {
      const record: HoldingRecord = {
        id: `holding-${++holdingSeq}`,
        assetId: requiredText(input?.assetId, 'assetId'),
        grade: optionalText(input?.grade),
        quantity: positiveInt(input?.quantity, 'quantity'),
        unitCost: numericOrUnknown(input?.unitCost, 'unitCost'),
        costCurrency: optionalText(input?.costCurrency),
        costBasis: requiredText(input?.costBasis, 'costBasis'),
        costSource: requiredText(input?.costSource, 'costSource'),
        acquiredAt: optionalText(input?.acquiredAt),
        fees: numericOrUnknown(input?.fees, 'fees'),
        shipping: numericOrUnknown(input?.shipping, 'shipping'),
        createdAt: now().toISOString(),
        ...(noteOf(input?.note) !== undefined ? { note: noteOf(input?.note) } : {}),
      };
      holdings.push(record);
      return clone(record);
    },

    removeHolding(id: string): boolean {
      const before = holdings.length;
      holdings = holdings.filter((item) => item.id !== id);
      return holdings.length !== before;
    },

    listSales: () => clone(sales),

    addSale(input: SaleInput): SaleRecord {
      const holdingId = requiredText(input?.holdingId, 'holdingId');
      if (!holdings.some((holding) => holding.id === holdingId)) {
        throw new TrackingValidationError(`Holding ${holdingId} does not exist.`);
      }
      const record: SaleRecord = {
        id: `sale-${++saleSeq}`,
        holdingId,
        quantity: positiveInt(input?.quantity, 'quantity'),
        unitProceeds: numericOrUnknown(input?.unitProceeds, 'unitProceeds'),
        proceedsCurrency: optionalText(input?.proceedsCurrency),
        proceedsBasis: requiredText(input?.proceedsBasis, 'proceedsBasis'),
        proceedsSource: requiredText(input?.proceedsSource, 'proceedsSource'),
        soldAt: optionalText(input?.soldAt),
        fees: numericOrUnknown(input?.fees, 'fees'),
        shipping: numericOrUnknown(input?.shipping, 'shipping'),
        createdAt: now().toISOString(),
        ...(noteOf(input?.note) !== undefined ? { note: noteOf(input?.note) } : {}),
      };
      sales.push(record);
      return clone(record);
    },

    removeSale(id: string): boolean {
      const before = sales.length;
      sales = sales.filter((item) => item.id !== id);
      return sales.length !== before;
    },

    listRules: () => clone(rules),

    addRule(input: AlertRuleInput): AlertRuleRecord {
      const metric = input?.metric;
      if (typeof metric !== 'string' || !(ALERT_METRICS as readonly string[]).includes(metric)) {
        throw new TrackingValidationError(`metric must be one of ${ALERT_METRICS.join(', ')}.`);
      }
      if (typeof input?.threshold !== 'number' || !Number.isFinite(input.threshold)) {
        throw new TrackingValidationError('threshold must be a finite number.');
      }
      if (input.basis !== undefined && input.basis !== 'SOLD_DERIVED') {
        throw new TrackingValidationError('basis must be SOLD_DERIVED.');
      }
      const record: AlertRuleRecord = {
        id: `rule-${++ruleSeq}`,
        targetId: requiredText(input?.targetId, 'targetId'),
        metric: metric as AlertMetric,
        threshold: input.threshold,
        basis: 'SOLD_DERIVED',
        grade: optionalText(input?.grade),
        active: input?.active !== false,
        createdAt: now().toISOString(),
        ...(noteOf(input?.note) !== undefined ? { note: noteOf(input?.note) } : {}),
      };
      rules.push(record);
      return clone(record);
    },

    toggleRule(id: string): AlertRuleRecord | null {
      const rule = rules.find((item) => item.id === id);
      if (!rule) return null;
      rule.active = !rule.active;
      return clone(rule);
    },

    removeRule(id: string): boolean {
      const before = rules.length;
      rules = rules.filter((item) => item.id !== id);
      alertStates = alertStates.filter((state) => state.ruleId !== id);
      return rules.length !== before;
    },

    listAlertStates: () => clone(alertStates),

    replaceAlertStates(states: readonly AlertState[]): AlertState[] {
      const previous = new Map(alertStates.map((state) => [state.id, state]));
      alertStates = states.map((state) => {
        const prior = previous.get(state.id);
        return {
          ...clone(state),
          acknowledged: Boolean(
            prior?.acknowledged &&
            prior.detail === state.detail &&
            prior.status === state.status,
          ),
        };
      });
      return clone(alertStates);
    },

    acknowledgeAlert(id: string): AlertState | null {
      const state = alertStates.find((item) => item.id === id);
      if (!state) return null;
      state.acknowledged = true;
      return clone(state);
    },

    clearAlertStates(): number {
      const count = alertStates.length;
      alertStates = [];
      return count;
    },
  };
}
