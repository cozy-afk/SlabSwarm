/**
 * Task 17 round-1 fix: payload builders shared by the shipped TrackingView
 * and the API regression tests. A currency is always an explicit operator
 * selection; a blank selection becomes the literal UNKNOWN, never a guessed
 * currency derived from a comp or a default.
 */

export const UNKNOWN_TEXT = 'UNKNOWN';

export interface HoldingFormValues {
  assetId: string;
  grade?: string;
  quantity?: number;
  /** Raw form values: blank stays UNKNOWN. */
  unitCost: string;
  costCurrency: string;
  costBasis: string;
  costSource: string;
  acquiredAt?: string;
  fees?: string;
  shipping?: string;
}

export interface SaleFormValues {
  holdingId: string;
  quantity?: number;
  unitProceeds: string;
  proceedsCurrency: string;
  proceedsBasis: string;
  proceedsSource: string;
  soldAt?: string;
}

function text(value: string | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

function currency(value: string | undefined): string {
  return text(value) || UNKNOWN_TEXT;
}

function numeric(value: string | undefined): number | 'UNKNOWN' {
  const raw = text(value);
  if (raw === '') return UNKNOWN_TEXT;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : UNKNOWN_TEXT;
}

/** The exact body posted by the Add-holding form. */
export function buildHoldingPayload(values: HoldingFormValues): Record<string, unknown> {
  return {
    assetId: text(values.assetId),
    ...(text(values.grade) ? { grade: text(values.grade) } : {}),
    quantity: values.quantity ?? 1,
    unitCost: numeric(values.unitCost),
    costCurrency: currency(values.costCurrency),
    costBasis: text(values.costBasis),
    costSource: text(values.costSource),
    ...(text(values.acquiredAt) ? { acquiredAt: text(values.acquiredAt) } : {}),
    ...(text(values.fees) ? { fees: numeric(values.fees) } : {}),
    ...(text(values.shipping) ? { shipping: numeric(values.shipping) } : {}),
  };
}

/** The exact body posted by the Record-sale form. */
export function buildSalePayload(values: SaleFormValues): Record<string, unknown> {
  return {
    holdingId: text(values.holdingId),
    quantity: values.quantity ?? 1,
    unitProceeds: numeric(values.unitProceeds),
    proceedsCurrency: currency(values.proceedsCurrency),
    proceedsBasis: text(values.proceedsBasis),
    proceedsSource: text(values.proceedsSource),
    ...(text(values.soldAt) ? { soldAt: text(values.soldAt) } : {}),
  };
}
