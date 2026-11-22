// TCGAPIs adapter. Off by default. The API key is read from env on the server
// and sent only as an HTTP request header — never logged, never persisted,
// never returned. HTTP responses are mocked in tests; no live key is required.

import { computeChecksum } from '../evidence.ts';
import type {
  AdapterFetchContext,
  AdapterFetchResult,
  IngestAdapter,
  RawItem,
} from '../types.ts';

type FetchImpl = (
  input: string,
  init?: { headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface TcgapisOptions {
  env?: Record<string, string | undefined>;
  fetchImpl?: FetchImpl;
}

export type TcgapiStatus = 'DISABLED' | 'NO_KEY' | 'OK' | 'UNAUTHORIZED' | 'ERROR';

const API_BASE = 'https://api.tcgapi.dev/v2/cards';

function enabled(env: Record<string, string | undefined>): boolean {
  return String(env.TCGAPI_ENABLED ?? '').toLowerCase() === 'true';
}

function apiKey(env: Record<string, string | undefined>): string | null {
  const key = env.TCGAPI_KEY;
  return typeof key === 'string' && key.trim() !== '' ? key : null;
}

function defaultFetch(): FetchImpl {
  return globalThis.fetch as unknown as FetchImpl;
}

interface Card {
  id?: string | number;
  name?: string;
  set_name?: string;
  number?: string;
  product_type?: string;
  market_price?: number;
  game_name?: string;
}

function toItems(cards: Card[], ctx: AdapterFetchContext): RawItem[] {
  const items: RawItem[] = [];
  for (const card of cards) {
    if (card === null || typeof card !== 'object') continue;
    if (card.product_type && String(card.product_type) !== 'Cards') continue;
    const nativeId = `tcg:${String(card.id ?? computeChecksum(card))}`;
    const price =
      typeof card.market_price === 'number' && Number.isFinite(card.market_price) && card.market_price > 0
        ? card.market_price
        : null;
    const payload: Record<string, unknown> = {
      source: 'tcgapis',
      targetIdentityRef: nativeId,
      title: card.name ?? null,
      name: card.name ?? null,
      setName: card.set_name ?? null,
      number: card.number ?? null,
      productType: card.product_type ?? null,
      gameName: card.game_name ?? null,
      // A published market price is a GUIDE, never a verified sale.
      basis: 'GUIDE',
      price,
      currency: price === null ? 'UNKNOWN' : 'USD',
      observedAt: ctx.capturedAt,
    };
    items.push({
      nativeId,
      observedAt: ctx.capturedAt,
      payload,
      sourceUri: null,
      mimeType: 'application/json',
    });
  }
  return items;
}

export function createTcgapisAdapter(options: TcgapisOptions = {}): IngestAdapter {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? defaultFetch();
  return {
    id: 'tcgapis',
    sourceId: 'tcgapis',
    async fetch(ctx: AdapterFetchContext): Promise<AdapterFetchResult> {
      if (!enabled(env)) {
        return { items: [], meta: { skipped: 'TCGAPI_DISABLED' } };
      }
      const key = apiKey(env);
      if (!key) {
        return { items: [], meta: { skipped: 'TCGAPI_KEY_MISSING' } };
      }
      const rawQueries = ctx.options.queries;
      const queries: Array<{ q: string; game?: string }> = Array.isArray(rawQueries)
        ? (rawQueries as Array<{ q?: unknown; game?: unknown }>)
            .filter((query) => query && typeof query.q === 'string' && query.q.trim() !== '')
            .map((query) => ({
              q: query.q as string,
              game: typeof query.game === 'string' ? query.game : undefined,
            }))
        : [];

      const items: RawItem[] = [];
      const parseErrors: Array<{ nativeId: string | null; message: string }> = [];
      for (const query of queries) {
        const url = `${API_BASE}?query=${encodeURIComponent(query.q)}${
          query.game ? `&game=${encodeURIComponent(query.game)}` : ''
        }`;
        try {
          const response = await fetchImpl(url, {
            headers: { 'x-api-key': key, accept: 'application/json' },
          });
          if (!response.ok) {
            parseErrors.push({
              nativeId: query.q,
              message: `TCGAPIs HTTP ${response.status} for query`,
            });
            continue;
          }
          const body = (await response.json()) as { data?: Card[] } | null;
          const data = body && Array.isArray(body.data) ? body.data : [];
          items.push(...toItems(data, ctx));
        } catch (error) {
          parseErrors.push({
            nativeId: query.q,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return {
        items,
        meta: { queryCount: queries.length, parseErrors },
      };
    },
  };
}

/** Status-only verification: returns a token, never the key or response body. */
export async function verifyTcgapiStatus(options: TcgapisOptions = {}): Promise<TcgapiStatus> {
  const env = options.env ?? process.env;
  if (!enabled(env)) return 'DISABLED';
  const key = apiKey(env);
  if (!key) return 'NO_KEY';
  const fetchImpl = options.fetchImpl ?? defaultFetch();
  try {
    const response = await fetchImpl(`${API_BASE}?query=status&limit=1`, {
      headers: { 'x-api-key': key, accept: 'application/json' },
    });
    if (response.status === 200) return 'OK';
    if (response.status === 401 || response.status === 403) return 'UNAUTHORIZED';
    return 'ERROR';
  } catch {
    return 'ERROR';
  }
}
