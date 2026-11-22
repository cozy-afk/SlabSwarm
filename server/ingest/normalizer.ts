// Deterministic parser/normalizer: raw evidence -> candidate observations.
// Basis is explicit and never inferred; absent or invalid values remain
// UNKNOWN / null and are reported in `warnings`. No model participates here.

import type { MarketBasis } from '../contracts/dataProduct.ts';
import type { ConfidenceBand, IngestCandidate, RawItem, StoredEvidenceRecord } from './types.ts';

const VALID_BASES = new Set<MarketBasis>([
  'SOLD',
  'ASKING',
  'OFFER',
  'GUIDE',
  'CLAIM',
  'POPULATION',
  'UNKNOWN',
]);
const VALID_CONFIDENCE = new Set<ConfidenceBand>(['UNKNOWN', 'LOW', 'MEDIUM', 'HIGH']);

function pick(raw: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (raw[key] !== undefined && raw[key] !== null) return raw[key];
  }
  return null;
}

/** Only a finite, strictly positive number is a known amount. */
function amount(raw: Record<string, unknown>, warnings: string[]): number | null {
  const value = pick(raw, ['price', 'priceUsd', 'amount', 'market_price', 'listed_amount']);
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  warnings.push('AMOUNT_UNKNOWN');
  return null;
}

function currency(raw: Record<string, unknown>, warnings: string[]): string {
  const value = pick(raw, ['currency', 'currencyCode']);
  if (typeof value === 'string' && /^[A-Z]{3}$/.test(value)) return value;
  warnings.push('CURRENCY_UNKNOWN');
  return 'UNKNOWN';
}

function basis(raw: Record<string, unknown>, warnings: string[]): MarketBasis {
  const value = pick(raw, ['basis']);
  if (value === null) {
    warnings.push('BASIS_UNKNOWN');
    return 'UNKNOWN';
  }
  if (typeof value === 'string' && VALID_BASES.has(value as MarketBasis)) {
    return value as MarketBasis;
  }
  warnings.push('BASIS_INVALID');
  return 'UNKNOWN';
}

function optionalNumber(raw: Record<string, unknown>, keys: string[], warnings: string[], label: string): number | null {
  const value = pick(raw, keys);
  if (value === null) {
    warnings.push(`${label}_UNKNOWN`);
    return null;
  }
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  warnings.push(`${label}_INVALID`);
  return null;
}

function optionalString(raw: Record<string, unknown>, keys: string[], warnings: string[], label: string): string | null {
  const value = pick(raw, keys);
  if (typeof value === 'string' && value.trim() !== '') return value;
  warnings.push(`${label}_UNKNOWN`);
  return null;
}

export function normalizeRawItem(
  raw: RawItem,
  evidence: StoredEvidenceRecord,
): IngestCandidate {
  const payload =
    raw.payload && typeof raw.payload === 'object' && !Array.isArray(raw.payload)
      ? (raw.payload as Record<string, unknown>)
      : {};
  const warnings: string[] = [];
  const parsedBasis = basis(payload, warnings);
  const parsedAmount = amount(payload, warnings);
  const parsedCurrency = currency(payload, warnings);
  const observedAt =
    typeof payload.observedAt === 'string' && payload.observedAt
      ? payload.observedAt
      : raw.observedAt;
  const targetIdentityRef = String(
    pick(payload, ['targetIdentityRef', 'assetId', 'nativeId']) ?? raw.nativeId ?? 'unresolved',
  );
  const confidenceValue = pick(payload, ['confidence']);
  const confidence: ConfidenceBand =
    typeof confidenceValue === 'string' && VALID_CONFIDENCE.has(confidenceValue as ConfidenceBand)
      ? (confidenceValue as ConfidenceBand)
      : 'UNKNOWN';

  const priceComponents: Record<string, unknown> = {
    listed_amount: parsedAmount,
    currency: parsedCurrency,
    // Missing components stay null (UNKNOWN). Never coerce them to zero.
    item_amount: parsedAmount,
    shipping_amount: optionalNumber(payload, ['shipping', 'shippingAmount', 'shipping_amount'], warnings, 'SHIPPING'),
    fees: optionalNumber(payload, ['fees', 'fee', 'platformFee'], warnings, 'FEES'),
    fx_rate_to_base: optionalNumber(payload, ['fxRate', 'fx_rate_to_base'], warnings, 'FX'),
    fx_source: optionalString(payload, ['fxSource', 'fx_source'], warnings, 'FX_SOURCE'),
    fx_as_of: optionalString(payload, ['fxAsOf', 'fx_as_of'], warnings, 'FX_AS_OF'),
    grade: optionalString(payload, ['grade'], warnings, 'GRADE'),
    condition: optionalString(payload, ['condition'], warnings, 'CONDITION'),
    observedAt,
    capturedAt: evidence.capturedAt,
  };
  if (priceComponents.fx_rate_to_base === null) {
    priceComponents.fx_source = null;
    priceComponents.fx_as_of = null;
  }

  return {
    evidenceId: evidence.id,
    targetIdentityRef,
    basis: parsedBasis,
    amount: parsedAmount,
    currency: parsedCurrency,
    marketplace:
      typeof pick(payload, ['marketplace', 'marketplaceId']) === 'string'
        ? (pick(payload, ['marketplace', 'marketplaceId']) as string)
        : null,
    observedAt,
    sourceId: evidence.sourceId,
    capturedAt: evidence.capturedAt,
    // A candidate's direct lineage is the immutable evidence it derives from.
    // The evidence record itself carries [adapterId, runId], so the full chain
    // is candidate -> evidence -> run -> adapter.
    lineage: [evidence.id],
    confidence,
    priceComponents,
    status: 'RAW',
    parseStatus: evidence.parseStatus === 'FAILED' ? 'FAILED' : 'PARSED',
    warnings,
  };
}
