/**
 * Pure, policy-aware price normalization for first-party market observations.
 *
 * This module never mutates its input. Every derived output is a fresh value,
 * and missing components stay UNKNOWN (null) rather than being coerced to zero.
 * Buyer landed cost and seller net proceeds are always computed as distinct
 * outputs; the selected valuation policy only decides which one is surfaced as
 * `value`. Basis (SOLD / ASKING / ...) is carried through unchanged and is
 * never inferred from the amount.
 */

import type {
  MarketBasis,
  PriceComponents,
  ValuationBasisPolicy,
} from '../src/types/graph.ts';

export interface NormalizedPrice {
  /** The policy-selected value, or null when it cannot be computed. */
  value: number | null;
  /** Currency of `value`: 'BASE' when FX conversion was applied, else source currency. */
  valueCurrency: string;
  /** Currency the raw components were denominated in. */
  sourceCurrency: string;
  /** The explicit policy used — always named, never defaulted. */
  policy: ValuationBasisPolicy;
  /** Basis carried through from the observation. UNKNOWN when not supplied. */
  basis: MarketBasis;
  /** Buyer-side real value: item + shipping + buyer premium + tax. */
  landed_cost_buyer: number | null;
  /** Seller-side real value: item + buyer-paid shipping − seller/platform fees. */
  net_seller_proceeds: number | null;
  /** Best estimate of the card-only economic value before manipulation. */
  normalized_item_value: number | null;
  /** A defensive copy of the input components — never the input object. */
  components: PriceComponents;
  /** Machine-readable reason codes (UNKNOWN flags, FX provenance, lot rules). */
  reason_codes: string[];
  /** Confidence band, downgraded when required components are unknown. */
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
  /** True only when basis is explicitly SOLD and the row is lot-eligible. */
  eligibleForSoldComps: boolean;
  /** True only when this observation can enter single-card comps. */
  singleCardEligible: boolean;
}

/** The observation's basis travels with its price components. */
export type PriceInput = PriceComponents & { basis?: MarketBasis };

const CONFIDENCE_RANK = { UNKNOWN: 0, LOW: 1, MEDIUM: 2, HIGH: 3 } as const;

/** Add a reason code once, preserving first-seen order. */
function flag(reasons: string[], code: string): void {
  if (!reasons.includes(code)) reasons.push(code);
}

/**
 * Resolve the fee amount from `seller_fee` / `platform_fee`.
 *
 * A fee is interpreted as a percentage of the component named by `fee_basis`
 * when the fee value is in 0..100 and a basis amount is resolvable; documented
 * formula: 10% of listed_amount 100 = 10. Otherwise the fee is treated as an
 * absolute amount. Returns null when the fee is unknown.
 */
function resolveFee(
  input: PriceInput,
  basisAmount: number,
  listedAmount: number,
): number | null {
  const sellerFee = input.seller_fee;
  const platformFee = input.platform_fee;
  if (sellerFee === null && platformFee === null) return null;

  const feeBasisAmount = resolveFeeBasisAmount(input, listedAmount);
  const raw = (sellerFee ?? 0) + (platformFee ?? 0);
  const looksLikePercent =
    raw >= 0 &&
    raw <= 100 &&
    feeBasisAmount !== null &&
    input.fee_basis !== 'ABSOLUTE' &&
    input.fee_basis !== 'FIXED_AMOUNT';

  return looksLikePercent ? (raw / 100) * feeBasisAmount : raw;
}

function resolveFeeBasisAmount(input: PriceInput, listedAmount: number): number | null {
  switch (input.fee_basis) {
    case 'ITEM_AMOUNT':
      return input.item_amount ?? null;
    case 'LANDED_COST':
      return null; // circular: fee basis depends on the fee itself
    case 'LISTED_AMOUNT':
    default:
      return listedAmount;
  }
}

/**
 * Normalize a price observation into policy-aware real-value outputs.
 * Pure: `input` is never modified, including nested arrays.
 */
export function normalizePrice(
  input: PriceInput,
  policy: ValuationBasisPolicy,
): NormalizedPrice {
  const reasons: string[] = [];
  const sourceCurrency = input.currency;
  const basis: MarketBasis = input.basis ?? 'UNKNOWN';
  const listed = input.listed_amount;

  // Defensive deep copy — the caller keeps ownership of its object.
  const components: PriceComponents = {
    ...input,
    normalization_reason_codes: [...input.normalization_reason_codes],
  };
  delete (components as Partial<PriceInput>).basis;
  const output: NormalizedPrice = {
    value: null,
    valueCurrency: sourceCurrency,
    sourceCurrency,
    policy,
    basis,
    landed_cost_buyer: null,
    net_seller_proceeds: null,
    normalized_item_value: null,
    components,
    reason_codes: reasons,
    confidence: 'HIGH',
    eligibleForSoldComps: false,
    singleCardEligible: false,
  };

  // --- Basis: carried through, never inferred, never promoted. -----------
  if (basis === 'UNKNOWN') flag(reasons, 'BASIS_UNKNOWN');
  else if (basis !== 'SOLD') flag(reasons, 'BASIS_NOT_SOLD');

  // --- Per-card allocation: LOTs need known composition. -----------------
  const isLot = input.lot_quantity > 1;
  const knownComposition =
    input.per_card_allocation_method !== null &&
    input.per_card_allocation_method !== 'UNKNOWN_COMPOSITION';
  if (isLot && !knownComposition) {
    flag(reasons, 'LOT_UNKNOWN_COMPOSITION');
  }
  output.singleCardEligible = !isLot || knownComposition;

  // --- Item amount: prefer the de-manipulated item amount. ---------------
  let item: number | null = input.item_amount ?? listed;
  if (input.item_amount === null || input.item_amount === undefined) {
    flag(reasons, 'ITEM_AMOUNT_FALLBACK_LISTED');
  }
  if (isLot && knownComposition) {
    if (input.lot_total_amount !== null) {
      item = input.lot_total_amount / input.lot_quantity;
      flag(reasons, 'LOT_SPLIT');
    } else {
      item = null;
      flag(reasons, 'LOT_TOTAL_UNKNOWN');
    }
  }
  if (item !== null && input.item_amount === null && input.shipping_included === true) {
    flag(reasons, 'SHIPPING_IN_ITEM');
  }

  // --- Shipping: unknown stays unknown (never zero). ---------------------
  const shipping = input.shipping_amount;
  if (shipping === null) {
    flag(reasons, 'SHIPPING_UNKNOWN');
    downgrade(output, 'MEDIUM');
  } else if (shipping === 0 && input.shipping_estimated === true) {
    flag(reasons, 'SUSPECT_ZERO_SHIPPING');
  }

  // --- Buyer premium / tax: unknown flags, no zero coercion. -------------
  if (input.buyer_premium === null) {
    flag(reasons, 'BUYER_PREMIUM_UNKNOWN');
    downgrade(output, 'MEDIUM');
  }
  if (input.tax_amount === null) {
    flag(reasons, 'TAX_UNKNOWN');
    downgrade(output, 'MEDIUM');
  }

  // --- Real-value outputs (distinct by construction). --------------------
  if (item !== null && output.singleCardEligible) {
    output.normalized_item_value = item;

    // landed = item + shipping + premium + tax; partial knowledge => unknown.
    if (
      shipping !== null &&
      input.buyer_premium !== null &&
      input.tax_amount !== null
    ) {
      output.landed_cost_buyer =
        item + shipping + input.buyer_premium + input.tax_amount;
    }

    // proceeds = item + buyer-paid shipping − fees.
    const fee = resolveFee(input, item, listed);
    if (shipping !== null) {
      if (fee === null) {
        flag(reasons, 'FEES_UNKNOWN');
        downgrade(output, 'LOW');
      } else {
        output.net_seller_proceeds = item + shipping - fee;
      }
    }
  }

  // --- FX: conversion is required only for non-base currencies. USD is the
  // base currency of this app; any other currency needs rate + provenance.
  const needsFx = sourceCurrency !== 'BASE' && sourceCurrency !== 'USD';
  const fxUsable =
    !needsFx ||
    (input.fx_rate_to_base !== null &&
      input.fx_source !== null &&
      input.fx_as_of !== null);
  if (needsFx && !fxUsable) {
    flag(reasons, 'FX_MISSING_PROVENANCE');
    downgrade(output, 'LOW');
  }

  // --- Policy selects which real-value output is surfaced. ----------------
  // Never convert without provenance: in that case there is no safe `value`.
  if (!fxUsable) {
    output.value = null;
  } else {
    const selected = selectByPolicy(output, policy, item, reasons);
    if (selected !== null && needsFx) {
      output.value = selected * (input.fx_rate_to_base as number);
      output.valueCurrency = 'BASE';
    } else {
      output.value = selected;
    }
  }

  // Populate the component envelope with derived real values.
  components.landed_cost_buyer = output.landed_cost_buyer;
  components.net_seller_proceeds = output.net_seller_proceeds;
  components.normalized_item_value = output.normalized_item_value;
  components.normalization_reason_codes = [...reasons];
  components.normalization_confidence = output.confidence;

  // --- Sold-comp eligibility. --------------------------------------------
  output.eligibleForSoldComps =
    basis === 'SOLD' && output.singleCardEligible;

  return output;
}

function selectByPolicy(
  out: NormalizedPrice,
  policy: ValuationBasisPolicy,
  item: number | null,
  reasons: string[],
): number | null {
  switch (policy) {
    case 'buyer_landed_cost':
      return out.landed_cost_buyer;
    case 'seller_net_proceeds':
      return out.net_seller_proceeds;
    case 'item_only':
      return item;
    case 'guide':
    case 'asking':
    case 'offer':
      if (out.basis !== policy.toUpperCase()) {
        flag(reasons, 'POLICY_BASIS_MISMATCH');
        return null;
      }
      return item;
    case 'derived_model':
      flag(reasons, 'DERIVED_MODEL_REQUIRES_EXTERNAL_VALUE');
      return null;
  }
}

function downgrade(out: NormalizedPrice, to: 'MEDIUM' | 'LOW'): void {
  if (CONFIDENCE_RANK[to] < CONFIDENCE_RANK[out.confidence]) {
    out.confidence = to;
  }
}
