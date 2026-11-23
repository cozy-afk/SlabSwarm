// Free catalog feed adapter. Deterministic mapping only: responses become
// immutable evidence and candidate observations; no model writes facts here.
// HTTP is always injected through ctx.options.fetchImpl — this module never
// calls globalThis.fetch and never reads a key from a literal.

import type { EvidenceRecordInput, MarketBasis } from '../../contracts/dataProduct.ts';
import type { FreeFeedConfig, FreeFeedRecord } from '../../contracts/freeFeed.ts';
import { computeChecksum } from '../evidence.ts';
import type {
  AdapterFetchContext,
  AdapterFetchResult,
  IngestAdapter,
  RawItem,
} from '../types.ts';

export const UNKNOWN = 'UNKNOWN';
/** Published Cardex free-tier cap, enforced by a request counter as well as delay. */
export const CARDEX_DAILY_REQUEST_LIMIT = 100;

export interface FreeFeedFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text?(): Promise<string>;
}

export type FreeFeedFetchImpl = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<FreeFeedFetchResponse>;

/** Options are supplied through AdapterFetchContext.options so the frozen
 * createFreeFeedAdapter(config) signature stays stable. */
export interface FreeFeedAdapterOptions {
  fetchImpl?: FreeFeedFetchImpl;
  paths?: string[];
  env?: Record<string, unknown>;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_PATHS: Record<string, string[]> = {
  scryfall: ['/cards'],
  pokemontcg: ['/v2/cards'],
  carddex: ['/cards'],
  cardex: ['/cards'],
};

const ATTRIBUTION: Record<string, string> = {
  scryfall: 'Scryfall API (scryfall.com); card data (c) Wizards of the Coast',
  pokemontcg: 'Pokemon TCG API (pokemontcg.io)',
  carddex: 'CardDex API (carddex.io) - attribution required by license',
  cardex: 'Cardex public catalog (cardex.com)',
};

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function unknownOr(value: unknown): string {
  return nonEmpty(value) ?? UNKNOWN;
}

function positive(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function firstPositive(...values: unknown[]): number | null {
  for (const value of values) {
    const found = positive(value);
    if (found !== null) return found;
  }
  return null;
}

function nested(raw: Record<string, unknown>, ...keys: string[]): unknown {
  let current: unknown = raw;
  for (const key of keys) {
    if (!isObject(current)) return null;
    current = current[key];
  }
  return current ?? null;
}

function responseItems(body: unknown): Record<string, unknown>[] {
  if (Array.isArray(body)) return body.filter(isObject);
  if (isObject(body)) {
    if (Array.isArray(body.data)) return body.data.filter(isObject);
    if (body.object === 'card' || nonEmpty(body.id)) return [body];
  }
  return [];
}

/** Drop URL credentials and non-http schemes; never echo them into evidence. */
function safeUrl(value: unknown, fallback: string): string {
  const candidate = nonEmpty(value);
  if (candidate) {
    try {
      const parsed = new URL(candidate);
      if (
        (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
        parsed.username === '' &&
        parsed.password === ''
      ) {
        return parsed.toString();
      }
    } catch {
      // Not an absolute URL; fall through to the canonical source URL.
    }
  }
  return fallback;
}

function resolveUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/$/, '');
  if (/^https?:\/\//i.test(path)) return safeUrl(path, `${base}/`);
  return `${base}/${path.replace(/^\//, '')}`;
}

function observedAtFrom(raw: Record<string, unknown>, capturedAt: string): string {
  return (
    nonEmpty(raw.observedAt) ??
    nonEmpty(raw.updated_at) ??
    nonEmpty(raw.released_at) ??
    nonEmpty(raw.lastUpdated) ??
    capturedAt
  );
}

interface PriceView {
  amount: number | null;
  currency: string;
  sourceUrl: string;
}

function priceFor(
  config: FreeFeedConfig,
  raw: Record<string, unknown>,
  fallbackUrl: string,
): PriceView {
  if (config.sourceId === 'scryfall') {
    // Catalog-only feed: published price fields are deliberately ignored so
    // no price is invented and no basis is inferred.
    return { amount: null, currency: UNKNOWN, sourceUrl: fallbackUrl };
  }
  if (config.sourceId === 'pokemontcg') {
    const usd = firstPositive(nested(raw, 'tcgplayer', 'prices', 'normal', 'market'));
    if (usd !== null) {
      return {
        amount: usd,
        currency: 'USD',
        sourceUrl: safeUrl(nested(raw, 'tcgplayer', 'url'), fallbackUrl),
      };
    }
    const eur = firstPositive(
      nested(raw, 'cardmarket', 'prices', 'averageSellPrice'),
      nested(raw, 'cardmarket', 'prices', 'lowPrice'),
      nested(raw, 'cardmarket', 'prices', 'trendPrice'),
    );
    if (eur !== null) {
      return {
        amount: eur,
        currency: 'EUR',
        sourceUrl: safeUrl(nested(raw, 'cardmarket', 'url'), fallbackUrl),
      };
    }
    return { amount: null, currency: UNKNOWN, sourceUrl: fallbackUrl };
  }
  const amount = firstPositive(
    raw.price,
    raw.marketPrice,
    raw.market_price,
    raw.guidePrice,
    raw.priceGuide,
    nested(raw, 'prices', 'market'),
    nested(raw, 'priceGuide', 'market'),
  );
  return {
    amount,
    currency: nonEmpty(raw.currency)?.toUpperCase() ?? UNKNOWN,
    sourceUrl: safeUrl(raw.sourceUrl ?? raw.url, fallbackUrl),
  };
}

/** Deterministic raw response -> FreeFeedRecord. No price is ever SOLD. */
export function toFreeFeedRecord(
  config: FreeFeedConfig,
  raw: Record<string, unknown>,
  capturedAt: string,
): FreeFeedRecord {
  const externalId = unknownOr(raw.id ?? raw.externalId ?? raw.card_id ?? raw.uuid);
  const fallbackUrl = `${config.baseUrl.replace(/\/$/, '')}/cards/${encodeURIComponent(externalId)}`;
  const price = priceFor(config, raw, fallbackUrl);
  const basis: MarketBasis = price.amount === null ? 'UNKNOWN' : 'GUIDE';
  const property =
    config.sourceId === 'pokemontcg'
      ? nonEmpty(raw.game) ?? 'pokemon'
      : unknownOr(raw.game ?? raw.property ?? raw.sport ?? raw.league);
  const finish = nonEmpty(raw.finish) ?? (Array.isArray(raw.finishes) ? unknownOr(raw.finishes[0]) : UNKNOWN);
  return {
    sourceId: config.sourceId,
    externalId,
    vertical: config.vertical,
    property,
    set: unknownOr(raw.set_name ?? raw.setName ?? (isObject(raw.set) ? raw.set.name : raw.set) ?? raw.set_code),
    name: unknownOr(raw.name ?? raw.title),
    number: unknownOr(raw.number ?? raw.collector_number),
    finish,
    currency: price.currency,
    amount: price.amount ?? UNKNOWN,
    basis,
    observedAt: observedAtFrom(raw, capturedAt),
    sourceUrl: price.sourceUrl,
    license: config.license,
    attribution: ATTRIBUTION[config.sourceId] ?? `${config.sourceId} public catalog`,
  };
}

/** FreeFeedRecord -> the existing EvidenceRecordInput contract. */
export function toEvidenceInput(
  record: FreeFeedRecord,
  rawText: string,
  capturedAt: string,
): EvidenceRecordInput {
  const checksum = computeChecksum(rawText);
  const amount = record.amount === UNKNOWN ? null : record.amount;
  return {
    sourceId: record.sourceId,
    sourceRecordId: `${record.sourceId}:${record.externalId}`,
    sourceUri: record.sourceUrl,
    capturedAt,
    observedAt: record.observedAt,
    checksum,
    mimeType: 'application/json',
    license: record.license,
    rawRef: `free-feed://${record.sourceId}/${encodeURIComponent(record.externalId)}/${checksum}`,
    parsedPayload: {
      recordKind: amount === null ? 'CATALOG_CARD' : 'PRICE_GUIDE',
      record,
      source: record.sourceId,
      targetIdentityRef: `${record.sourceId}:${record.externalId}`,
      price: amount,
      amount,
      basis: record.basis,
      currency: record.currency,
      observedAt: record.observedAt,
      license: record.license,
      attribution: record.attribution,
      confidence: 'UNKNOWN',
      rawResponse: rawText,
    },
    trustTier: 'UNKNOWN',
  };
}

function toRawItem(input: EvidenceRecordInput): RawItem {
  return {
    nativeId: input.sourceRecordId!,
    observedAt: input.observedAt,
    payload: input.parsedPayload ?? {},
    sourceUri: input.sourceUri ?? null,
    checksum: input.checksum,
    mimeType: input.mimeType,
  };
}

function readEnv(env: Record<string, unknown>, name: string): string | null {
  return nonEmpty(env[name]);
}

export function createFreeFeedAdapter(config: FreeFeedConfig): IngestAdapter {
  // Cardex's published 100/day allowance belongs to the adapter instance, not
  // to a single fetch(): repeated runs in the same day share the counter.
  let dailyRequestsIssued = 0;
  return {
    id: config.sourceId,
    sourceId: config.sourceId,
    async fetch(ctx: AdapterFetchContext): Promise<AdapterFetchResult> {
      // A missing license disables the feed: zero calls, no partial data.
      if (!nonEmpty(config.license)) {
        return { items: [], meta: { skipped: 'LICENSE_MISSING' } };
      }
      const options: FreeFeedAdapterOptions = isObject(ctx.options) ? (ctx.options as FreeFeedAdapterOptions) : {};
      const fetchImpl = options.fetchImpl;
      if (typeof fetchImpl !== 'function') {
        return { items: [], meta: { skipped: 'FETCH_NOT_INJECTED' } };
      }
      const paths = Array.isArray(options.paths) && options.paths.length > 0
        ? options.paths.filter((path): path is string => typeof path === 'string' && path !== '')
        : (DEFAULT_PATHS[config.sourceId] ?? ['/cards']);
      const sleep = typeof options.sleep === 'function'
        ? options.sleep
        : (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
      const env = isObject(options.env)
        ? (options.env as Record<string, unknown>)
        : (process.env as Record<string, unknown>);
      const key = config.apiKeyEnv ? readEnv(env, config.apiKeyEnv) : null;

      const items: RawItem[] = [];
      const waits: number[] = [];
      const requestsBefore = dailyRequestsIssued;
      let dailyCapReached = false;

      for (let index = 0; index < paths.length; index += 1) {
        // Cardex: the published 100/day cap is a hard counter held in the
        // adapter closure, independent of the per-request delay. Request 101
        // is never issued, even across separate fetch() calls.
        if (config.sourceId === 'cardex' && dailyRequestsIssued >= CARDEX_DAILY_REQUEST_LIMIT) {
          dailyCapReached = true;
          break;
        }
        if (index > 0) {
          await sleep(config.rateLimitMs);
          waits.push(config.rateLimitMs);
        }
        const url = resolveUrl(config.baseUrl, paths[index]!);
        const headers: Record<string, string> = { accept: 'application/json' };
        // Only the env var named by the config is ever read; it is sent as a
        // header and never placed in a URL, log, meta or error message.
        if (key !== null && config.apiKeyEnv) headers['x-api-key'] = key;

        const response = await fetchImpl(url, { headers });
        dailyRequestsIssued += 1;
        if (response.status === 429) {
          // Stop immediately; never read or echo the response body.
          throw new Error(`Free feed ${config.sourceId}: HTTP 429 rate limited; run stopped`);
        }
        if (!response.ok) {
          throw new Error(`Free feed ${config.sourceId}: HTTP ${response.status}; run stopped`);
        }
        const rawText = typeof response.text === 'function'
          ? await response.text()
          : JSON.stringify(await response.json());
        let body: unknown;
        try {
          body = JSON.parse(rawText);
        } catch {
          body = await response.json();
        }
        for (const raw of responseItems(body)) {
          const record = toFreeFeedRecord(config, raw, ctx.capturedAt);
          items.push(toRawItem(toEvidenceInput(record, rawText, ctx.capturedAt)));
        }
      }

      return {
        items,
        meta: {
          requestsIssued: dailyRequestsIssued - requestsBefore,
          dailyRequestsIssued,
          dailyCapReached,
          waits,
          keyConfigured: key !== null,
        },
      };
    },
  };
}
