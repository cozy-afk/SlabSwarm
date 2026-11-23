/**
 * Task 17: watchlist / alert / portfolio read models on top of Task 14 FMV.
 *
 * Pure and deterministic: no clock, network, model, canonical write or
 * notification. Inputs are injected by the caller. Every value carries an
 * explicit basis and source; missing fees, shipping and dates stay the literal
 * UNKNOWN. Fee and tax outputs are labelled ESTIMATE with visible assumptions
 * and are never presented as facts.
 */

import { UNKNOWN, type ConfidenceBand, type UnknownValue } from '../serving/catalog.ts';
import type { FmvResult } from '../valuation/fmv.ts';

export { UNKNOWN };
export type { UnknownValue };

export type NumberOrUnknown = number | UnknownValue;

export const ALERT_METRICS = [
  'FMV_BELOW',
  'FMV_ABOVE',
  'FMV_DROP_PCT',
  'SOLD_COMP_COUNT_BELOW',
] as const;
export type AlertMetric = (typeof ALERT_METRICS)[number];

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function text(value: unknown): string | UnknownValue {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : UNKNOWN;
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function amount(value: unknown): NumberOrUnknown {
  return isNumber(value) ? value : UNKNOWN;
}

// --- Valuation view --------------------------------------------------------

export interface ValuationView {
  targetId: string;
  kind: 'DERIVED' | 'UNKNOWN';
  basis: string;
  sourceBasis: string;
  source: string | UnknownValue;
  method: string;
  value: NumberOrUnknown;
  currency: string | UnknownValue;
  band: FmvResult['band'] | null;
  confidence: ConfidenceBand;
  sampleSize: number;
  asOf: string | UnknownValue;
  lineage: string[];
  warnings: string[];
}

/** Convert an FMV artifact into an explicitly labelled portfolio valuation. */
export function fmvToValuation(fmv: FmvResult): ValuationView {
  return {
    targetId: fmv.targetId,
    kind: fmv.value === UNKNOWN ? 'UNKNOWN' : 'DERIVED',
    basis: fmv.basis,
    sourceBasis: fmv.sourceBasis,
    source: fmv.source,
    method: fmv.method,
    value: fmv.value,
    currency: fmv.currency,
    band: fmv.band,
    confidence: fmv.confidence,
    sampleSize: fmv.sampleSize,
    asOf: fmv.generatedAt,
    lineage: [...fmv.lineage],
    warnings: [
      ...fmv.warnings,
      'This is a DERIVED SOLD_DERIVED valuation, not a completed sale of the held item.',
    ],
  };
}

function unknownValuation(assetId: string): ValuationView {
  return {
    targetId: assetId,
    kind: 'UNKNOWN',
    basis: UNKNOWN,
    sourceBasis: UNKNOWN,
    source: UNKNOWN,
    method: UNKNOWN,
    value: UNKNOWN,
    currency: UNKNOWN,
    band: null,
    confidence: 'UNKNOWN',
    sampleSize: 0,
    asOf: UNKNOWN,
    lineage: [],
    warnings: [`No FMV was supplied for ${assetId}; the value stays UNKNOWN and no price was invented.`],
  };
}

// --- Stored records (input shapes mirror the tracking store) ---------------

export interface HoldingRecord {
  id: string;
  assetId: string;
  grade: string | UnknownValue;
  quantity: number;
  unitCost: NumberOrUnknown;
  costCurrency: string | UnknownValue;
  costBasis: string | UnknownValue;
  costSource: string | UnknownValue;
  acquiredAt: string | UnknownValue;
  fees: NumberOrUnknown;
  shipping: NumberOrUnknown;
  note?: string;
  createdAt: string;
}

export interface SaleRecord {
  id: string;
  holdingId: string;
  quantity: number;
  unitProceeds: NumberOrUnknown;
  proceedsCurrency: string | UnknownValue;
  proceedsBasis: string | UnknownValue;
  proceedsSource: string | UnknownValue;
  soldAt: string | UnknownValue;
  fees: NumberOrUnknown;
  shipping: NumberOrUnknown;
  note?: string;
  createdAt: string;
}

export interface WatchItemRecord {
  id: string;
  targetId: string;
  grade: string | UnknownValue;
  note?: string;
  addedAt: string;
}

export interface AlertRuleRecord {
  id: string;
  targetId: string;
  metric: AlertMetric;
  threshold: number;
  basis: 'SOLD_DERIVED';
  grade: string | UnknownValue;
  active: boolean;
  note?: string;
  createdAt: string;
}

export interface AlertState {
  id: string;
  ruleId: string;
  targetId: string;
  metric: AlertMetric;
  threshold: number;
  status: 'TRIGGERED' | 'NOT_TRIGGERED' | 'UNKNOWN';
  value: NumberOrUnknown;
  basis: string;
  source: string | UnknownValue;
  observedAt: string | UnknownValue;
  triggeredAt: string | UnknownValue;
  acknowledged: boolean;
  detail: string;
}

// --- Unrealized result -----------------------------------------------------

export interface UnrealizedResult {
  kind: 'UNREALIZED';
  holdingId: string;
  assetId: string;
  grade: string | UnknownValue;
  quantity: number;
  valuation: ValuationView;
  value: NumberOrUnknown;
  currency: string | UnknownValue;
  unitCost: NumberOrUnknown;
  unrealized: NumberOrUnknown;
  basis: string;
  source: string;
  costBasis: string | UnknownValue;
  costSource: string | UnknownValue;
  acquiredAt: string | UnknownValue;
  fees: NumberOrUnknown;
  shipping: NumberOrUnknown;
  feeTreatment: 'INCLUDED_IN_COST_BASIS' | 'RECORDED_NOT_SUBTRACTED' | 'UNKNOWN_NOT_SUBTRACTED';
  warnings: string[];
}

/**
 * Mark an open holding to an injected FMV. The result names both bases
 * (derived SOLD FMV and the recorded purchase cost) and both sources.
 */
export function buildUnrealized(
  holding: HoldingRecord,
  fmv: FmvResult | null,
): UnrealizedResult {
  const valuation = fmv ? fmvToValuation(fmv) : unknownValuation(holding.assetId);
  const warnings: string[] = [
    ...valuation.warnings,
    'Unrealized value is a mark to SOLD_DERIVED FMV, not a completed sale.',
  ];
  const basis = `SOLD_DERIVED_FMV_MINUS_${holding.costBasis}`;
  const source = `${valuation.source} + ${holding.costSource}`;

  if (holding.acquiredAt === UNKNOWN) {
    warnings.push('Acquisition date is UNKNOWN; no holding period is asserted.');
  }
  let feeTreatment: UnrealizedResult['feeTreatment'] = 'RECORDED_NOT_SUBTRACTED';
  if (holding.fees === UNKNOWN || holding.shipping === UNKNOWN) {
    feeTreatment = 'UNKNOWN_NOT_SUBTRACTED';
  } else {
    feeTreatment = 'INCLUDED_IN_COST_BASIS';
  }
  if (holding.fees === UNKNOWN) {
    warnings.push('Fees are UNKNOWN and were not subtracted; the result is gross of fees.');
  }
  if (holding.shipping === UNKNOWN) {
    warnings.push('Shipping is UNKNOWN and was not subtracted; the result is gross of shipping.');
  }

  let unrealized: NumberOrUnknown = UNKNOWN;
  const unitCost = amount(holding.unitCost);
  if (valuation.value === UNKNOWN || unitCost === UNKNOWN) {
    warnings.push('FMV or unit cost is UNKNOWN; unrealized value stays UNKNOWN, never zero.');
  } else if (valuation.currency !== holding.costCurrency || valuation.currency === UNKNOWN) {
    warnings.push('No FX conversion is applied; different or UNKNOWN currencies keep the value UNKNOWN.');
  } else {
    unrealized = round2(holding.quantity * (valuation.value - unitCost));
  }

  return {
    kind: 'UNREALIZED',
    holdingId: holding.id,
    assetId: holding.assetId,
    grade: holding.grade,
    quantity: holding.quantity,
    valuation,
    value: valuation.value,
    currency: valuation.currency,
    unitCost,
    unrealized,
    basis,
    source,
    costBasis: holding.costBasis,
    costSource: holding.costSource,
    acquiredAt: holding.acquiredAt,
    fees: holding.fees,
    shipping: holding.shipping,
    feeTreatment,
    warnings,
  };
}

// --- Realized result -------------------------------------------------------

export interface RealizedResult {
  kind: 'REALIZED';
  saleId: string;
  holdingId: string;
  assetId: string;
  grade: string | UnknownValue;
  quantity: number;
  unitProceeds: NumberOrUnknown;
  unitCost: NumberOrUnknown;
  proceeds: NumberOrUnknown;
  cost: NumberOrUnknown;
  gain: NumberOrUnknown;
  currency: string | UnknownValue;
  basis: string;
  source: string;
  acquiredAt: string | UnknownValue;
  soldAt: string | UnknownValue;
  fees: NumberOrUnknown;
  shipping: NumberOrUnknown;
  feeTreatment: 'INCLUDED' | 'RECORDED_NOT_SUBTRACTED' | 'UNKNOWN_NOT_SUBTRACTED';
  warnings: string[];
}

/** Compute a realized result from an explicitly based sale and purchase cost. */
export function buildRealized(sale: SaleRecord, holding: HoldingRecord): RealizedResult {
  const warnings: string[] = [
    'Realized result uses the recorded sale proceeds basis minus the recorded purchase cost basis.',
  ];
  if (sale.soldAt === UNKNOWN) {
    warnings.push('Sale date is UNKNOWN; no holding period or tax year is asserted.');
  }
  if (holding.acquiredAt === UNKNOWN) {
    warnings.push('Acquisition date is UNKNOWN; no holding period is asserted.');
  }

  const fees = amount(sale.fees);
  const shipping = amount(sale.shipping);
  let feeTreatment: RealizedResult['feeTreatment'] = 'RECORDED_NOT_SUBTRACTED';
  if (!isNumber(fees) || !isNumber(shipping)) {
    feeTreatment = 'UNKNOWN_NOT_SUBTRACTED';
    if (sale.fees === UNKNOWN) warnings.push('Sale fees are UNKNOWN and were not subtracted.');
    if (sale.shipping === UNKNOWN) warnings.push('Shipping is UNKNOWN and was not subtracted.');
    warnings.push('The realized result is gross of any UNKNOWN fees or shipping.');
  } else {
    feeTreatment = 'INCLUDED';
  }

  const unitProceeds = amount(sale.unitProceeds);
  const unitCost = amount(holding.unitCost);
  const proceeds = isNumber(unitProceeds) ? round2(sale.quantity * unitProceeds) : UNKNOWN;
  const cost = isNumber(unitCost) ? round2(sale.quantity * unitCost) : UNKNOWN;
  let gain: NumberOrUnknown = UNKNOWN;

  if (proceeds === UNKNOWN || cost === UNKNOWN) {
    warnings.push('Sale proceeds or purchase cost is UNKNOWN; realized gain stays UNKNOWN.');
  } else if (
    sale.proceedsCurrency !== holding.costCurrency ||
    sale.proceedsCurrency === UNKNOWN
  ) {
    warnings.push('No FX conversion is applied; different or UNKNOWN currencies keep the gain UNKNOWN.');
  } else {
    gain = proceeds - cost;
    if (feeTreatment === 'INCLUDED') {
      gain = round2(gain - (fees as number) - (shipping as number));
    }
  }

  return {
    kind: 'REALIZED',
    saleId: sale.id,
    holdingId: sale.holdingId,
    assetId: holding.assetId,
    grade: holding.grade,
    quantity: sale.quantity,
    unitProceeds,
    unitCost,
    proceeds,
    cost,
    gain,
    currency: sale.proceedsCurrency,
    basis: `${sale.proceedsBasis}_MINUS_${holding.costBasis}`,
    source: `${sale.proceedsSource} + ${holding.costSource}`,
    acquiredAt: holding.acquiredAt,
    soldAt: sale.soldAt,
    fees: sale.fees,
    shipping: sale.shipping,
    feeTreatment,
    warnings,
  };
}

// --- Portfolio aggregation -------------------------------------------------

export interface PortfolioTotals {
  realizedGain: NumberOrUnknown;
  unrealizedGain: NumberOrUnknown;
  currency: string | UnknownValue;
  basis: string;
  source: string;
  complete: boolean;
  warnings: string[];
}

export interface PortfolioResult {
  realized: RealizedResult[];
  unrealized: UnrealizedResult[];
  totals: PortfolioTotals;
  warnings: string[];
}

/** Aggregate only explicitly known, same-currency results; never coerce. */
export function buildPortfolio(
  holdings: readonly HoldingRecord[],
  sales: readonly SaleRecord[],
  valuations: Readonly<Record<string, FmvResult | null | undefined>>,
  valuationByHolding: Readonly<Record<string, FmvResult | null | undefined>> = {},
): PortfolioResult {
  const warnings: string[] = [];
  const byId = new Map(holdings.map((holding) => [holding.id, holding]));
  const unrealized = holdings.map((holding) =>
    buildUnrealized(holding, valuationByHolding[holding.id] ?? valuations[holding.assetId] ?? null),
  );
  const realized: RealizedResult[] = [];
  for (const sale of sales) {
    const holding = byId.get(sale.holdingId);
    if (!holding) {
      warnings.push(`Sale ${sale.id} references an unknown holding; it was not aggregated.`);
      continue;
    }
    realized.push(buildRealized(sale, holding));
  }

  const all = [...unrealized, ...realized];
  const currencies = new Set(all.map((row) => row.currency));
  if (currencies.size > 1 || currencies.has(UNKNOWN)) {
    warnings.push('No FX conversion is applied; mixed or UNKNOWN currencies keep totals UNKNOWN.');
  }

  function total(rows: Array<{ currency: string | UnknownValue }>, key: 'unrealized' | 'gain'): NumberOrUnknown {
    const values = rows.map((row) => (row as unknown as Record<string, NumberOrUnknown>)[key]);
    if (currencies.size !== 1 || currencies.has(UNKNOWN) || values.some((value) => value === UNKNOWN)) {
      return UNKNOWN;
    }
    return round2((values as number[]).reduce((sum, value) => sum + value, 0));
  }

  const totals: PortfolioTotals = {
    realizedGain: total(realized, 'gain'),
    unrealizedGain: total(unrealized, 'unrealized'),
    currency: currencies.size === 1 ? [...currencies][0] : UNKNOWN,
    basis: 'SOLD_DERIVED_FMV_MINUS_PURCHASE_COST + SALE_PROCEEDS_MINUS_PURCHASE_COST',
    source: [...new Set(all.map((row) => row.source))].sort().join(' + ') || UNKNOWN,
    complete: all.length > 0 && all.every((row) =>
      ((row as unknown as Record<string, NumberOrUnknown>).unrealized ?? (row as unknown as Record<string, NumberOrUnknown>).gain) !== UNKNOWN,
    ),
    warnings,
  };
  return { realized, unrealized, totals, warnings };
}

// --- Watchlist view --------------------------------------------------------

export interface IdentityView {
  id: string;
  name: string;
  game: string | UnknownValue;
  set: string | UnknownValue;
  number: string | UnknownValue;
  identityConfidence: ConfidenceBand;
  facets: {
    game: string | UnknownValue;
    set: string | UnknownValue;
    number: string | UnknownValue;
    segment: string | UnknownValue;
    variant: string | UnknownValue;
  };
}

export interface WatchView {
  id: string;
  targetId: string;
  grade: string | UnknownValue;
  note?: string;
  addedAt: string;
  valuation: ValuationView;
  basis: string;
  source: string | UnknownValue;
  currency: string | UnknownValue;
  identity: IdentityView;
  warnings: string[];
}

/** Watchlist row: identity facets plus an explicitly based FMV mark. */
export function buildWatchView(
  item: WatchItemRecord,
  fmv: FmvResult | null,
  identity?: IdentityView | null,
): WatchView {
  const valuation = fmv ? fmvToValuation(fmv) : unknownValuation(item.targetId);
  const fallback: IdentityView = {
    id: item.targetId,
    name: item.targetId,
    game: UNKNOWN,
    set: UNKNOWN,
    number: UNKNOWN,
    identityConfidence: 'UNKNOWN',
    facets: { game: UNKNOWN, set: UNKNOWN, number: UNKNOWN, segment: UNKNOWN, variant: UNKNOWN },
  };
  const warnings = [
    ...valuation.warnings,
    'No watchlist entry, identity or FMV is a canonical write; identity facets come from the catalog read model.',
  ];
  if (!identity) {
    warnings.push(`No catalog identity was found for ${item.targetId}; identity facets stay UNKNOWN.`);
  }
  return {
    id: item.id,
    targetId: item.targetId,
    grade: item.grade,
    ...(item.note !== undefined ? { note: item.note } : {}),
    addedAt: item.addedAt,
    valuation,
    basis: valuation.basis,
    source: valuation.source,
    currency: valuation.currency,
    identity: identity ?? fallback,
    warnings,
  };
}

// --- Fee and tax estimates -------------------------------------------------

export interface FeeEstimateInput {
  price: NumberOrUnknown;
  currency?: string | UnknownValue | null;
  marketplaceFeeRate: NumberOrUnknown;
  processingFeeRate: NumberOrUnknown;
  shippingReserve: NumberOrUnknown;
  basisLabel: string | UnknownValue | null | undefined;
  assumptions: readonly string[] | null | undefined;
}

export interface EstimateArtifact {
  kind: 'ESTIMATE';
  basis: string;
  source: string;
  estimate: NumberOrUnknown;
  currency: string | UnknownValue;
  assumptions: string[];
  warnings: string[];
}

function estimateWarnings(label: string): string[] {
  return [
    'Estimate only: assumptions are operator-supplied; this is not a fact, quote or completed transaction.',
    'No canonical fact is written and no fee, tax or payment is collected here.',
    label,
  ];
}

function validRate(value: NumberOrUnknown): value is number {
  return isNumber(value) && value >= 0 && value <= 1;
}

/** Deterministic fee estimate with every assumption visible in the artifact. */
export function estimateFees(input: FeeEstimateInput): EstimateArtifact & {
  breakdown: {
    marketplaceFee: NumberOrUnknown;
    processingFee: NumberOrUnknown;
    shippingReserve: NumberOrUnknown;
    total: NumberOrUnknown;
  };
} {
  const warnings = estimateWarnings('Fee basis label and assumptions are required; missing or invalid inputs stay UNKNOWN.');
  const assumptions = Array.isArray(input.assumptions)
    ? input.assumptions.filter((value): value is string => typeof value === 'string' && value.trim() !== '')
    : [];
  const basisLabel = text(input.basisLabel);
  const price = amount(input.price);
  const reserve = amount(input.shippingReserve);
  const priceOk = isNumber(price) && price >= 0;
  const reserveOk = isNumber(reserve) && reserve >= 0;
  const usable = basisLabel !== UNKNOWN && assumptions.length > 0 && priceOk && reserveOk;

  let marketplaceFee: NumberOrUnknown = UNKNOWN;
  let processingFee: NumberOrUnknown = UNKNOWN;
  let total: NumberOrUnknown = UNKNOWN;
  if (
    usable &&
    isNumber(price) && isNumber(reserve) &&
    validRate(input.marketplaceFeeRate) && validRate(input.processingFeeRate)
  ) {
    marketplaceFee = round2(price * input.marketplaceFeeRate);
    processingFee = round2(price * input.processingFeeRate);
    total = round2(marketplaceFee + processingFee + reserve);
  } else if (usable) {
    warnings.push('A fee rate is UNKNOWN or outside 0..1; the fee estimate stays UNKNOWN.');
  }
  if (basisLabel === UNKNOWN) warnings.push('No fee basis label was stated; the estimate stays UNKNOWN.');
  if (!assumptions.length) warnings.push('No fee assumptions were stated; the estimate stays UNKNOWN.');

  return {
    kind: 'ESTIMATE',
    basis: 'ASSUMED_FEE_SCHEDULE',
    source: basisLabel === UNKNOWN ? UNKNOWN : `operator assumptions:${basisLabel}`,
    estimate: total,
    currency: text(input.currency),
    assumptions,
    warnings,
    breakdown: { marketplaceFee, processingFee, shippingReserve: reserveOk ? reserve : UNKNOWN, total },
  };
}

export interface TaxEstimateInput {
  gain: NumberOrUnknown;
  currency?: string | UnknownValue | null;
  rate: NumberOrUnknown;
  jurisdiction?: string | UnknownValue | null;
  basisLabel: string | UnknownValue | null | undefined;
  assumptions: readonly string[] | null | undefined;
}

/** Deterministic tax estimate. It never determines an actual tax obligation. */
export function estimateTax(input: TaxEstimateInput): EstimateArtifact {
  const warnings = estimateWarnings('Tax basis label and assumptions are required; missing inputs stay UNKNOWN.');
  warnings.push('This is not tax advice; no jurisdiction, filing obligation or liability is determined here.');
  const assumptions = Array.isArray(input.assumptions)
    ? input.assumptions.filter((value): value is string => typeof value === 'string' && value.trim() !== '')
    : [];
  const basisLabel = text(input.basisLabel);
  const gain = amount(input.gain);
  const estimate = basisLabel !== UNKNOWN && assumptions.length > 0 && isNumber(gain) && validRate(input.rate)
    ? round2(gain * input.rate)
    : UNKNOWN;
  if (estimate === UNKNOWN) warnings.push('Gain, rate, basis label or assumptions are UNKNOWN or invalid; the estimate stays UNKNOWN.');

  return {
    kind: 'ESTIMATE',
    basis: 'ASSUMED_TAX_RATE',
    source: basisLabel === UNKNOWN ? UNKNOWN : `operator assumptions:${basisLabel}`,
    estimate,
    currency: text(input.currency),
    assumptions,
    warnings,
  };
}

// --- Alert evaluation ------------------------------------------------------

export interface MetricSnapshot {
  targetId: string;
  basis: string;
  source: string | UnknownValue;
  value: NumberOrUnknown;
  sampleSize?: number;
  previousValue?: NumberOrUnknown;
  previousAsOf?: string | UnknownValue;
  observedAt?: string | UnknownValue;
}

export interface AlertEvaluation {
  states: AlertState[];
  warnings: string[];
}

/** Evaluate stored rules against injected, explicitly based metric snapshots. */
export function evaluateAlerts(
  rules: readonly AlertRuleRecord[],
  snapshots: readonly MetricSnapshot[],
  options: { now: Date },
): AlertEvaluation {
  const warnings: string[] = [
    'Alerts are stored rules plus in-app state only; no external notification provider is involved.',
  ];
  const states: AlertState[] = [];
  const byTarget = new Map<string, MetricSnapshot>();
  for (const snapshot of snapshots) byTarget.set(snapshot.targetId, snapshot);

  for (const rule of rules) {
    if (!rule.active) continue;
    const snapshot = byTarget.get(rule.targetId);
    if (!snapshot) {
      warnings.push(`Rule ${rule.id} has no metric snapshot for ${rule.targetId}; its state is UNKNOWN.`);
      states.push({
        id: `alert-${rule.id}::${rule.targetId}`,
        ruleId: rule.id,
        targetId: rule.targetId,
        metric: rule.metric,
        threshold: rule.threshold,
        status: 'UNKNOWN',
        value: UNKNOWN,
        basis: rule.basis,
        source: UNKNOWN,
        observedAt: UNKNOWN,
        triggeredAt: UNKNOWN,
        acknowledged: false,
        detail: 'No metric snapshot is available; the alert cannot be evaluated.',
      });
      continue;
    }

    const observedAt = snapshot.observedAt ?? UNKNOWN;
    const base = {
      id: `alert-${rule.id}::${snapshot.targetId}`,
      ruleId: rule.id,
      targetId: snapshot.targetId,
      metric: rule.metric,
      threshold: rule.threshold,
      basis: snapshot.basis,
      source: snapshot.source,
      observedAt,
      acknowledged: false,
    };
    if (snapshot.basis !== rule.basis) {
      warnings.push(`Rule ${rule.id} expects basis ${rule.basis} but the snapshot has ${snapshot.basis}; no trigger was evaluated.`);
      states.push({
        ...base,
        status: 'UNKNOWN',
        value: UNKNOWN,
        triggeredAt: UNKNOWN,
        detail: `Basis mismatch: rule requires ${rule.basis}, snapshot carries ${snapshot.basis}.`,
      });
      continue;
    }

    let value: NumberOrUnknown = snapshot.value;
    if (rule.metric === 'SOLD_COMP_COUNT_BELOW') {
      value = isNumber(snapshot.sampleSize) ? snapshot.sampleSize : UNKNOWN;
    } else if (rule.metric === 'FMV_DROP_PCT') {
      const previous = snapshot.previousValue ?? UNKNOWN;
      value = isNumber(value) && isNumber(previous) && previous !== 0
        ? round2(((previous - value) / previous) * 100)
        : UNKNOWN;
      if (value === UNKNOWN) {
        warnings.push(`Rule ${rule.id} needs a known prior FMV for FMV_DROP_PCT; its state is UNKNOWN.`);
      }
    }

    let triggered = false;
    if (value !== UNKNOWN) {
      if (rule.metric === 'FMV_BELOW' || rule.metric === 'SOLD_COMP_COUNT_BELOW') {
        triggered = value < rule.threshold;
      } else if (rule.metric === 'FMV_DROP_PCT') {
        triggered = value >= rule.threshold;
      } else {
        triggered = value > rule.threshold;
      }
    }
    const status: AlertState['status'] = value === UNKNOWN ? 'UNKNOWN' : triggered ? 'TRIGGERED' : 'NOT_TRIGGERED';
    const detail = value === UNKNOWN
      ? `${rule.metric} is UNKNOWN on basis ${snapshot.basis}; no trigger was fired.`
      : `${rule.metric} ${value} ${triggered ? 'met' : 'did not meet'} threshold ${rule.threshold} on basis ${snapshot.basis} from ${snapshot.source}.`;

    states.push({
      ...base,
      status,
      value,
      triggeredAt: triggered ? options.now.toISOString() : UNKNOWN,
      detail,
    });
  }
  return { states, warnings };
}
