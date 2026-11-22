/**
 * First-party market observation write/read API (data-product rebuild, Task 1).
 *
 * Raw evidence is immutable: the caller's raw values are stored separately
 * from the values derived by `normalizePrice`. Basis is required and never
 * inferred. Missing shipping / fees / tax / currency remain UNKNOWN (null),
 * never zero. All persistence is append-only via the graph engine's stored
 * collection, backed by Task 2's data store.
 */

import { randomUUID } from 'node:crypto';
import type {
  MarketBasis,
  MarketObservation,
  PriceComponents,
} from '../src/types/graph.ts';
import { graphEngine } from './graphEngine.ts';
import { normalizePrice } from './priceNormalizer.ts';

const VALID_BASES: ReadonlySet<string> = new Set<MarketBasis>([
  'SOLD',
  'ASKING',
  'OFFER',
  'GUIDE',
  'CLAIM',
  'POPULATION',
  'UNKNOWN',
]);

const VALID_STATUSES: ReadonlySet<string> = new Set([
  'ACTIVE',
  'QUARANTINED',
  'SUPERSEDED',
  'RECONCILED',
]);

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/** Validate a monetary amount: null means UNKNOWN; numbers must be finite >= 0. */
function validateAmount(value: unknown, label: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ValidationError(`${label} must be a finite number or null.`);
  }
  if (value < 0) {
    throw new ValidationError(`${label} must not be negative.`);
  }
  return value;
}

/** Validate the raw price component envelope without coercing unknown values. */
function validateComponents(raw: unknown): PriceComponents {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ValidationError('priceComponents must be an object.');
  }
  const c = raw as Record<string, unknown>;
  const num = (key: string): number | null => validateAmount(c[key], `priceComponents.${key}`);

  const listed = num('listed_amount');
  if (listed === null) {
    throw new ValidationError('priceComponents.listed_amount is required.');
  }
  const currency = c.currency;
  if (typeof currency !== 'string' || currency.trim() === '') {
    throw new ValidationError('priceComponents.currency is required.');
  }

  const fxRate = num('fx_rate_to_base');
  const needsFx = currency !== 'BASE' && currency !== 'USD';
  if (needsFx) {
    if (fxRate === null) {
      throw new ValidationError(
        `FX conversion for currency ${currency} requires fx_rate_to_base.`,
      );
    }
    if (
      typeof c.fx_source !== 'string' ||
      c.fx_source.trim() === '' ||
      typeof c.fx_as_of !== 'string' ||
      c.fx_as_of.trim() === ''
    ) {
      throw new ValidationError(
        'FX conversion requires both fx_source and fx_as_of provenance.',
      );
    }
  }

  return {
    listed_amount: listed,
    item_amount: num('item_amount'),
    shipping_amount: num('shipping_amount'),
    shipping_included:
      c.shipping_included === null || c.shipping_included === undefined
        ? null
        : Boolean(c.shipping_included),
    shipping_estimated:
      c.shipping_estimated === null || c.shipping_estimated === undefined
        ? null
        : Boolean(c.shipping_estimated),
    shipping_source:
      typeof c.shipping_source === 'string' ? c.shipping_source : null,
    buyer_premium: num('buyer_premium'),
    platform_fee: num('platform_fee'),
    seller_fee: num('seller_fee'),
    tax_amount: num('tax_amount'),
    fee_basis: typeof c.fee_basis === 'string' ? c.fee_basis : null,
    lot_quantity: num('lot_quantity') ?? 1,
    lot_total_amount: num('lot_total_amount'),
    per_card_allocation_method:
      typeof c.per_card_allocation_method === 'string'
        ? c.per_card_allocation_method
        : null,
    currency,
    fx_rate_to_base: fxRate,
    fx_source: typeof c.fx_source === 'string' ? c.fx_source : null,
    fx_as_of: typeof c.fx_as_of === 'string' ? c.fx_as_of : null,
    // Derived outputs are populated below by normalizePrice.
    landed_cost_buyer: null,
    net_seller_proceeds: null,
    normalized_item_value: null,
    normalization_reason_codes: [],
    normalization_confidence: 'UNKNOWN',
  };
}

/**
 * Normalize raw price components into the derived component envelope.
 * The raw `listed_amount` and top-level `amount` are never overwritten.
 */
function deriveComponents(components: PriceComponents, basis: MarketBasis): PriceComponents {
  const normalized = normalizePrice({ ...components, basis }, 'buyer_landed_cost');
  return { ...normalized.components };
}

/**
 * Append a market observation. Basis is required: UNKNOWN is a valid explicit
 * sentinel for "not supplied", but a missing basis is rejected outright.
 * The input is untrusted (it arrives as HTTP JSON), so it is typed `unknown`
 * and validated at runtime rather than assumed to satisfy the schema.
 */
export function addMarketObservation(input: unknown): MarketObservation {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('Observation input must be an object.');
  }

  // Basis must be explicitly supplied and valid — never defaulted.
  if (!('basis' in input) || (input as Record<string, unknown>).basis === undefined) {
    throw new ValidationError('basis is required; supply an explicit MarketBasis (UNKNOWN if not supplied).');
  }
  const basis = (input as Record<string, unknown>).basis;
  if (typeof basis !== 'string' || !VALID_BASES.has(basis)) {
    throw new ValidationError(
      'Invalid basis. Must be SOLD, ASKING, OFFER, GUIDE, CLAIM, POPULATION or UNKNOWN.',
    );
  }

  const amount = validateAmount(
    (input as Record<string, unknown>).amount,
    'amount',
  );
  if (amount === null) {
    throw new ValidationError('amount is required and must be a non-negative number.');
  }

  const fees = validateAmount((input as Record<string, unknown>).fees, 'fees');
  const shipping = validateAmount(
    (input as Record<string, unknown>).shipping_amount,
    'shipping_amount',
  );
  const tax = validateAmount((input as Record<string, unknown>).tax_amount, 'tax_amount');
  const quantityRaw = validateAmount(
    (input as Record<string, unknown>).quantity,
    'quantity',
  );
  const quantity = quantityRaw ?? 1;

  const rawComponents = validateComponents((input as Record<string, unknown>).priceComponents);
  // Cross-check: the raw component currency must agree with the observation's currency.
  const currency = (input as Record<string, unknown>).currency;
  if (typeof currency !== 'string' || currency.trim() === '') {
    throw new ValidationError('currency is required.');
  }
  if (currency !== rawComponents.currency) {
    throw new ValidationError('currency and priceComponents.currency must match.');
  }

  const statusRaw = (input as Record<string, unknown>).status ?? 'ACTIVE';
  if (typeof statusRaw !== 'string' || !VALID_STATUSES.has(statusRaw)) {
    throw new ValidationError('Invalid status.');
  }

  const rawEvidence =
    (input as Record<string, unknown>).raw_evidence !== null &&
    typeof (input as Record<string, unknown>).raw_evidence === 'object'
      ? (input as Record<string, unknown>).raw_evidence as Record<string, unknown>
      : {};

  const observation: MarketObservation = {
    id: `obs-${randomUUID()}`,
    tenantId: String((input as Record<string, unknown>).tenantId ?? 'default'),
    targetIdentityRef: String(
      (input as Record<string, unknown>).targetIdentityRef ?? 'unresolved',
    ),
    sourceId: String((input as Record<string, unknown>).sourceId ?? ''),
    sourceFeedType: String((input as Record<string, unknown>).sourceFeedType ?? 'UNKNOWN'),
    nativeSourceRecordId: String(
      (input as Record<string, unknown>).nativeSourceRecordId ?? '',
    ),
    observed_at: String(
      (input as Record<string, unknown>).observed_at ??
        (input as Record<string, unknown>).captured_at ??
        new Date().toISOString(),
    ),
    source_date:
      typeof (input as Record<string, unknown>).source_date === 'string'
        ? (input as Record<string, unknown>).source_date as string
        : null,
    source_timeframe:
      typeof (input as Record<string, unknown>).source_timeframe === 'string'
        ? (input as Record<string, unknown>).source_timeframe as string
        : null,
    source_date_assumed: Boolean(
      (input as Record<string, unknown>).source_date_assumed ?? false,
    ),
    captured_at:
      typeof (input as Record<string, unknown>).captured_at === 'string'
        ? (input as Record<string, unknown>).captured_at as string
        : new Date().toISOString(),
    basis: basis as MarketBasis,
    currency,
    amount,
    fees,
    shipping_amount: shipping,
    tax_amount: tax,
    quantity,
    price_kind: String((input as Record<string, unknown>).price_kind ?? 'ITEM'),
    marketplace: String((input as Record<string, unknown>).marketplace ?? 'UNKNOWN'),
    region: String((input as Record<string, unknown>).region ?? 'UNKNOWN'),
    seller_hashed_id:
      typeof (input as Record<string, unknown>).seller_hashed_id === 'string'
        ? (input as Record<string, unknown>).seller_hashed_id as string
        : null,
    buyer_hashed_id:
      typeof (input as Record<string, unknown>).buyer_hashed_id === 'string'
        ? (input as Record<string, unknown>).buyer_hashed_id as string
        : null,
    condition:
      typeof (input as Record<string, unknown>).condition === 'string'
        ? (input as Record<string, unknown>).condition as string
        : null,
    condition_source:
      typeof (input as Record<string, unknown>).condition_source === 'string'
        ? (input as Record<string, unknown>).condition_source as string
        : null,
    language:
      typeof (input as Record<string, unknown>).language === 'string'
        ? (input as Record<string, unknown>).language as string
        : null,
    finish:
      typeof (input as Record<string, unknown>).finish === 'string'
        ? (input as Record<string, unknown>).finish as string
        : null,
    grade:
      typeof (input as Record<string, unknown>).grade === 'string'
        ? (input as Record<string, unknown>).grade as string
        : null,
    grading_company:
      typeof (input as Record<string, unknown>).grading_company === 'string'
        ? (input as Record<string, unknown>).grading_company as string
        : null,
    certificate_number:
      typeof (input as Record<string, unknown>).certificate_number === 'string'
        ? (input as Record<string, unknown>).certificate_number as string
        : null,
    raw_evidence: rawEvidence,
    checksum_sha256:
      typeof (input as Record<string, unknown>).checksum_sha256 === 'string'
        ? (input as Record<string, unknown>).checksum_sha256 as string
        : null,
    mime_type:
      typeof (input as Record<string, unknown>).mime_type === 'string'
        ? (input as Record<string, unknown>).mime_type as string
        : null,
    source_url:
      typeof (input as Record<string, unknown>).source_url === 'string'
        ? (input as Record<string, unknown>).source_url as string
        : null,
    confidence:
      typeof (input as Record<string, unknown>).confidence === 'number'
        ? (input as Record<string, unknown>).confidence as number
        : 0.5,
    confidence_band:
      (input as Record<string, unknown>).confidence_band === 'HIGH' ||
      (input as Record<string, unknown>).confidence_band === 'MEDIUM' ||
      (input as Record<string, unknown>).confidence_band === 'LOW'
        ? (input as Record<string, unknown>).confidence_band as 'HIGH' | 'MEDIUM' | 'LOW'
        : 'MEDIUM',
    confidence_reasons: Array.isArray((input as Record<string, unknown>).confidence_reasons)
      ? ((input as Record<string, unknown>).confidence_reasons as string[]).slice()
      : [],
    exact_dedupe_key: null,
    near_dedupe_key: null,
    cluster_id: null,
    reconciliation_policy: null,
    status: statusRaw as MarketObservation['status'],
    lineage_pointer: null,
    priceComponents: deriveComponents(rawComponents, basis as MarketBasis),
  };

  return graphEngine.addMarketObservationRecord(observation);
}

/** Filters accepted by `listMarketObservations`. */
export interface MarketObservationFilters {
  tenantId?: string;
  targetIdentityRef?: string;
  basis?: MarketBasis;
  status?: MarketObservation['status'];
  sourceId?: string;
  nativeSourceRecordId?: string;
  marketplace?: string;
  currency?: string;
}

/** List observations, newest first, filtered by any supplied field. */
export function listMarketObservations(
  filters: MarketObservationFilters = {},
): MarketObservation[] {
  const all = graphEngine.listMarketObservationRecords();
  const filtered = all.filter((o) => {
    if (filters.tenantId !== undefined && o.tenantId !== filters.tenantId) return false;
    if (
      filters.targetIdentityRef !== undefined &&
      o.targetIdentityRef !== filters.targetIdentityRef
    ) {
      return false;
    }
    if (filters.basis !== undefined && o.basis !== filters.basis) return false;
    if (filters.status !== undefined && o.status !== filters.status) return false;
    if (filters.sourceId !== undefined && o.sourceId !== filters.sourceId) return false;
    if (
      filters.nativeSourceRecordId !== undefined &&
      o.nativeSourceRecordId !== filters.nativeSourceRecordId
    ) {
      return false;
    }
    if (filters.marketplace !== undefined && o.marketplace !== filters.marketplace) {
      return false;
    }
    if (filters.currency !== undefined && o.currency !== filters.currency) return false;
    return true;
  });
  return filtered.sort((a, b) => b.observed_at.localeCompare(a.observed_at));
}

/** Fetch a single observation by id; null when not found. */
export function getMarketObservation(id: string): MarketObservation | null {
  return graphEngine.getMarketObservationRecord(id);
}
