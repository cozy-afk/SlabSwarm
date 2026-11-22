/** Runtime validation at the repository boundary; bad facts never reach storage. */

import type { MarketBasis } from '../contracts/dataProduct.ts';

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

const VALID_BASES: ReadonlySet<string> = new Set<MarketBasis>([
  'SOLD', 'ASKING', 'OFFER', 'GUIDE', 'CLAIM', 'POPULATION', 'UNKNOWN',
]);

/** Basis is always explicit. UNKNOWN is a sentinel; a missing value is rejected. */
export function assertBasis(value: unknown): MarketBasis {
  if (typeof value !== 'string' || !VALID_BASES.has(value)) {
    throw new ValidationError('basis is required and must be an explicit MarketBasis (UNKNOWN if not supplied).');
  }
  return value as MarketBasis;
}

export function requireNonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`${label} is required and must be a non-empty string.`);
  }
  return value;
}

/** Missing numeric values stay UNKNOWN (null/undefined), never zero. */
export function requireFiniteAmount(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ValidationError(`${label} must be a finite, non-negative number.`);
  }
  return value;
}
