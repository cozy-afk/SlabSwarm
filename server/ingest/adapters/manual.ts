// Manual note adapter. Operators submit a text note plus optional URL/date/
// source/basis/amount. Missing or malformed values stay UNKNOWN and produce a
// parse error instead of being coerced.

import { computeChecksum } from '../evidence.ts';
import type {
  AdapterFetchContext,
  AdapterFetchResult,
  IngestAdapter,
  RawItem,
} from '../types.ts';

const VALID_BASES = new Set([
  'SOLD',
  'ASKING',
  'OFFER',
  'GUIDE',
  'CLAIM',
  'POPULATION',
  'UNKNOWN',
]);
const VALID_CONFIDENCE = new Set(['UNKNOWN', 'LOW', 'MEDIUM', 'HIGH']);

function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() === '') return false;
  const time = Date.parse(value);
  return Number.isFinite(time);
}

function validUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return null;
  try {
    new URL(value);
    return value;
  } catch {
    return null;
  }
}

function positiveAmount(value: unknown): number | null {
  if (typeof value !== 'number') return null;
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function createManualAdapter(): IngestAdapter {
  return {
    id: 'manual',
    sourceId: 'manual',
    async fetch(ctx: AdapterFetchContext): Promise<AdapterFetchResult> {
      const note = ctx.options.note;
      if (note === null || typeof note !== 'object' || Array.isArray(note)) {
        throw new Error('manual note option is required');
      }
      const raw = note as Record<string, unknown>;
      if (typeof raw.text !== 'string' || raw.text.trim() === '') {
        throw new Error('manual note text is required');
      }

      const parseErrors: Array<{ nativeId: string; message: string }> = [];
      const observedAt = validDate(raw.observedAt) ? raw.observedAt : ctx.capturedAt;
      if (!validDate(raw.observedAt)) {
        parseErrors.push({
          nativeId: 'manual-note',
          message: `manual note date is invalid (${String(raw.observedAt)}); observedAt is UNKNOWN`,
        });
      }

      const sourceUri = validUrl(raw.sourceUrl);
      if (raw.sourceUrl !== undefined && raw.sourceUrl !== null && sourceUri === null) {
        parseErrors.push({
          nativeId: 'manual-note',
          message: 'manual note sourceUrl is not a valid http(s) URL',
        });
      }

      const amount = positiveAmount(raw.amount);
      const basis =
        typeof raw.basis === 'string' && VALID_BASES.has(raw.basis) ? raw.basis : 'UNKNOWN';
      if (raw.basis !== undefined && basis === 'UNKNOWN') {
        parseErrors.push({
          nativeId: 'manual-note',
          message: 'manual note basis is not recognised; basis is UNKNOWN',
        });
      }

      const currency =
        typeof raw.currency === 'string' && /^[A-Z]{3}$/.test(raw.currency)
          ? raw.currency
          : 'UNKNOWN';

      const payload: Record<string, unknown> = {
        source: typeof raw.source === 'string' && raw.source.trim() !== '' ? raw.source : 'manual',
        title: raw.text,
        text: raw.text,
        basis,
        price: amount,
        currency,
        observedAt,
        confidence:
          typeof raw.confidence === 'string' && VALID_CONFIDENCE.has(raw.confidence)
            ? raw.confidence
            : 'UNKNOWN',
      };
      const checksum = computeChecksum({
        text: raw.text,
        sourceUrl: sourceUri,
        observedAt: validDate(raw.observedAt) ? raw.observedAt : null,
        source: payload.source,
      });

      const item: RawItem = {
        nativeId: `manual:${checksum}`,
        observedAt,
        payload,
        sourceUri,
        checksum,
        mimeType: 'text/plain',
      };
      return { items: [item], meta: { parseErrors } };
    },
  };
}
