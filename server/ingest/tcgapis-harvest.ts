// Credit-bounded TCGAPIs v2 harvest. This module owns the v2 catalog chain,
// the credit gate and the mapping of raw API records into the Phase 2 ingest
// adapter. All writes go through runIngest() -> evidence ledger; the harvest
// never touches a canonical repository directly.
//
// The API key is read from process.env (or an injected env), sent only as the
// x-api-key HTTP header, and is never logged, returned or persisted.

import { runIngest, sanitizeError } from './runner.ts';
import type {
  AdapterFetchContext,
  AdapterFetchResult,
  IngestAdapter,
  IngestRepositories,
  RawItem,
} from './types.ts';

const API_BASE = 'https://api.tcgapis.com/api/v2';
const SOURCE_ID = 'tcgapis';
const DEFAULT_BUDGET = 60;
const TRIAL_ERROR = 'TCGAPIs trial credits exhausted (HTTP 403 TRIAL_CREDITS_USED)';

/** Public /games is free; protected catalog calls are 1, prices/sales are 2. */
const COST = { games: 0, expansions: 1, cards: 1, prices: 2, sales: 2 } as const;

export interface HarvestFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text?: () => Promise<string>;
}

export type HarvestFetch = (
  url: string,
  init?: { headers?: Record<string, string>; method?: string },
) => Promise<HarvestFetchResponse>;

export interface HarvestDeps {
  /** Ingest ledger (never the canonical repositories). */
  repos: IngestRepositories;
  /** Injected fetch; no live HTTP happens unless the caller provides one. */
  fetchImpl?: HarvestFetch;
  /** Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Overrides TCGAPI_HARVEST_CREDIT_BUDGET. */
  budget?: number;
  /** Fixed timestamp keeps payload checksums stable across reruns. */
  capturedAt?: string;
  /** Fetch recent completed sales (2 credits each) while budget remains. */
  includeSalesHistory?: boolean;
  maxGames?: number;
  maxExpansions?: number;
  maxCardsPerExpansion?: number;
}

export interface HarvestResult {
  games: number;
  expansions: number;
  cards: number;
  prices: number;
  sales: number;
  evidenceWritten: number;
  creditsSpent: number;
  stoppedAtBudget: boolean;
  errors: string[];
}

class TrialCreditsExhausted extends Error {}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function enabled(env: Record<string, string | undefined>): boolean {
  return String(env.TCGAPI_ENABLED ?? '').toLowerCase() === 'true';
}

export function apiKeyFromEnv(env: Record<string, string | undefined>): string | null {
  const value = env.TCGAPI_KEY;
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

export function budgetFromEnv(env: Record<string, string | undefined>, override?: number): number {
  if (override !== undefined && Number.isFinite(override)) return Math.max(0, Math.floor(override));
  const raw = Number(env.TCGAPI_HARVEST_CREDIT_BUDGET ?? DEFAULT_BUDGET);
  return Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : DEFAULT_BUDGET;
}

function firstString(row: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function firstNumber(row: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  return null;
}

function firstTimestamp(row: Record<string, unknown>, keys: string[]): string | null {
  return firstString(row, keys);
}

function isTrialCreditsUsed(body: unknown): boolean {
  return JSON.stringify(body ?? '').includes('TRIAL_CREDITS_USED');
}

function rowsFromBody(body: unknown): Record<string, unknown>[] {
  if (Array.isArray(body)) return body.filter(isObject);
  if (!isObject(body)) return [];
  for (const key of ['data', 'results', 'items', 'rows', 'sales', 'salesHistory', 'sales_history']) {
    if (Array.isArray(body[key])) return (body[key] as unknown[]).filter(isObject);
  }
  for (const key of ['data', 'result']) {
    if (isObject(body[key])) return rowsFromBody(body[key]);
  }
  return [];
}

/** /prices returns data.prices keyed by printing, not a flat array. */
function priceRowsFromBody(body: unknown): Record<string, unknown>[] {
  const data = isObject(body) && isObject(body.data) ? body.data : null;
  const prices = data?.prices;
  if (isObject(prices)) {
    return Object.entries(prices)
      .filter(([, row]) => isObject(row))
      .map(([printing, row]) => ({ ...(row as Record<string, unknown>), printing }));
  }
  return rowsFromBody(body);
}

interface ChainState {
  creditsSpent: number;
  stoppedAtBudget: boolean;
  errors: string[];
  games: number;
  expansions: number;
  cards: number;
  prices: number;
  sales: number;
  items: RawItem[];
}

function newChainState(): ChainState {
  return {
    creditsSpent: 0,
    stoppedAtBudget: false,
    errors: [],
    games: 0,
    expansions: 0,
    cards: 0,
    prices: 0,
    sales: 0,
    items: [],
  };
}

interface ChainAdapterOptions {
  key: string;
  budget: number;
  fetchImpl: HarvestFetch;
  includeSalesHistory: boolean;
  maxGames: number;
  maxExpansions: number;
  maxCardsPerExpansion: number;
}

interface ChainAdapter extends IngestAdapter {
  getState(): ChainState;
}

function createChainAdapter(options: ChainAdapterOptions): ChainAdapter {
  const state = newChainState();

  async function call(
    path: string,
    cost: (typeof COST)[keyof typeof COST],
    label: string,
    capturedAt: string,
  ): Promise<{ body: unknown; data: Record<string, unknown> | null } | null> {
    if (state.creditsSpent + cost > options.budget) {
      state.stoppedAtBudget = true;
      return null;
    }
    state.creditsSpent += cost;
    let response: HarvestFetchResponse;
    try {
      response = await options.fetchImpl(`${API_BASE}${path}`, {
        headers: { 'x-api-key': options.key, accept: 'application/json' },
      });
    } catch (error) {
      state.errors.push(sanitizeError(error, [options.key]));
      return null;
    }
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // Some error responses are not JSON; status is still enough.
    }
    if (response.status === 403 && (isTrialCreditsUsed(body) || isTrialCreditsUsed(response))) {
      throw new TrialCreditsExhausted();
    }
    if (!response.ok) {
      state.errors.push(sanitizeError(`TCGAPIs ${label} HTTP ${response.status}`, [options.key]));
      return null;
    }
    if (isObject(body) && body.success === false) {
      if (isTrialCreditsUsed(body)) throw new TrialCreditsExhausted();
      state.errors.push(sanitizeError(`TCGAPIs ${label} rejected the request`, [options.key]));
      return null;
    }
    return { body, data: isObject(body) && isObject(body.data) ? body.data : null };
  }

  function add(
    nativeId: string,
    payload: Record<string, unknown>,
    observedAt: string,
    sourceUri: string,
  ): void {
    state.items.push({ nativeId, observedAt, payload, sourceUri, mimeType: 'application/json' });
  }

  function recordObservedAt(row: Record<string, unknown>, keys: string[], capturedAt: string): string {
    return firstTimestamp(row, keys) ?? capturedAt;
  }

  function currencyOf(row: Record<string, unknown>, data: Record<string, unknown> | null): string {
    const explicit = firstString(row, ['currency', 'currencyCode']) ??
      (data ? firstString(data, ['currency', 'currencyCode']) : null);
    // TCGPlayer values from TCGAPIs are USD; preserve an explicit currency
    // verbatim when the API supplies one. No conversion is ever performed.
    return explicit ?? 'USD';
  }

  function addPriceRecords(
    productId: string,
    card: Record<string, unknown>,
    body: unknown,
    data: Record<string, unknown> | null,
    capturedAt: string,
  ): void {
    const sourceTimestamp = data
      ? firstTimestamp(data, ['last_updated', 'lastUpdated', 'updatedAt', 'observedAt'])
      : null;
    const rows = priceRowsFromBody(body);
    for (const [index, row] of rows.entries()) {
      for (const field of ['marketPrice', 'lowPrice', 'midPrice', 'highPrice', 'directLowPrice']) {
        const price = firstNumber(row, [field]);
        if (price === null) continue; // missing price stays UNKNOWN, never 0
        const observedAt = recordObservedAt(
          row,
          ['last_updated', 'lastUpdated', 'updatedAt', 'observedAt', 'date'],
          sourceTimestamp ?? capturedAt,
        );
        const printing = firstString(row, ['printing']) ?? 'UNKNOWN';
        add(`tcg:price:${productId}:${index}:${field}`, {
          source: SOURCE_ID,
          recordKind: 'PRICE_GUIDE',
          targetIdentityRef: `tcg:${productId}`,
          name: firstString(card, ['name', 'cleanName']),
          expansionName: firstString(card, ['expansionName', 'set_name']),
          gameName: firstString(card, ['gameName']),
          printing,
          priceField: field,
          // Guide references (including marketPrice) are never completed sales.
          basis: 'GUIDE',
          price,
          currency: currencyOf(row, data),
          observedAt,
          sourceTimestamp: sourceTimestamp ?? 'UNKNOWN',
          number: firstString(card, ['number']),
        }, observedAt, `${API_BASE}/prices/${encodeURIComponent(productId)}`);
        state.prices += 1;
      }
    }
  }

  function addSaleRecords(
    productId: string,
    card: Record<string, unknown>,
    body: unknown,
    data: Record<string, unknown> | null,
    capturedAt: string,
  ): void {
    const rows = rowsFromBody(body);
    for (const [index, row] of rows.entries()) {
      const price = firstNumber(row, ['price', 'salePrice', 'amount', 'lowSalePrice']);
      const observedAt = recordObservedAt(
        row,
        ['date', 'soldAt', 'createdAt', 'timestamp', 'observedAt', 'updatedAt'],
        capturedAt,
      );
      add(`tcg:sale:${productId}:${index}`, {
        source: SOURCE_ID,
        recordKind: 'SALE',
        targetIdentityRef: `tcg:${productId}`,
        name: firstString(card, ['name', 'cleanName']),
        expansionName: firstString(card, ['expansionName', 'set_name']),
        gameName: firstString(card, ['gameName']),
        condition: firstString(row, ['condition']),
        variant: firstString(row, ['variant']),
        // Completed-source sales only; never relabel a guide as SOLD.
        basis: 'SOLD',
        price,
        currency: currencyOf(row, data),
        observedAt,
        sourceTimestamp: firstTimestamp(row, ['date', 'soldAt', 'createdAt', 'timestamp']) ?? 'UNKNOWN',
        shipping: firstNumber(row, ['shipping', 'shippingAmount']),
      }, observedAt, `${API_BASE}/sales-history/${encodeURIComponent(productId)}`);
      state.sales += 1;
    }
  }

  const adapter: ChainAdapter = {
    id: 'tcgapis-chain',
    sourceId: SOURCE_ID,
    getState: () => state,
    async fetch(ctx: AdapterFetchContext): Promise<AdapterFetchResult> {
      const capturedAt = ctx.capturedAt;
      try {
        const gamesResult = await call('/games?limit=100', COST.games, 'games', capturedAt);
        if (!gamesResult) {
          return { items: state.items, meta: meta() };
        }
        const games = rowsFromBody(gamesResult.body).slice(0, options.maxGames);
        for (const game of games) {
          if (state.stoppedAtBudget) break;
          const categoryId = firstString(game, ['categoryId', 'id', 'gameId']);
          if (!categoryId) continue;
          state.games += 1;
          add(`tcg:game:${categoryId}`, {
            source: SOURCE_ID,
            recordKind: 'CATALOG_GAME',
            basis: 'UNKNOWN',
            name: firstString(game, ['name', 'displayName']),
            targetIdentityRef: `tcg:game:${categoryId}`,
            observedAt: capturedAt,
          }, capturedAt, `${API_BASE}/games`);

          const expansionsResult = await call(
            `/expansions/${encodeURIComponent(categoryId)}?limit=100`,
            COST.expansions,
            'expansions',
            capturedAt,
          );
          if (!expansionsResult) continue;
          const expansions = rowsFromBody(expansionsResult.body).slice(0, options.maxExpansions);
          for (const expansion of expansions) {
            if (state.stoppedAtBudget) break;
            const groupId = firstString(expansion, ['groupId', 'id', 'expansionId']);
            if (!groupId) continue;
            state.expansions += 1;
            add(`tcg:expansion:${groupId}`, {
              source: SOURCE_ID,
              recordKind: 'CATALOG_EXPANSION',
              basis: 'UNKNOWN',
              name: firstString(expansion, ['name']),
              gameName: firstString(game, ['name', 'displayName']),
              targetIdentityRef: `tcg:expansion:${groupId}`,
              observedAt: capturedAt,
            }, capturedAt, `${API_BASE}/expansions/${encodeURIComponent(categoryId)}`);

            const cardsResult = await call(
              `/cards/${encodeURIComponent(groupId)}?limit=100`,
              COST.cards,
              'cards',
              capturedAt,
            );
            if (!cardsResult) continue;
            const cards = rowsFromBody(cardsResult.body).slice(0, options.maxCardsPerExpansion);
            for (const card of cards) {
              if (state.stoppedAtBudget) break;
              const productId = firstString(card, ['productId', 'id', 'cardId']);
              if (!productId) continue;
              state.cards += 1;
              add(`tcg:card:${productId}`, {
                source: SOURCE_ID,
                recordKind: 'CATALOG_CARD',
                basis: 'UNKNOWN',
                name: firstString(card, ['name', 'cleanName']),
                expansionName: firstString(expansion, ['name']),
                gameName: firstString(game, ['name', 'displayName']),
                number: firstString(card, ['number']),
                rarity: firstString(card, ['rarity']),
                targetIdentityRef: `tcg:${productId}`,
                observedAt: capturedAt,
              }, capturedAt, `${API_BASE}/cards/${encodeURIComponent(groupId)}`);

              const pricesResult = await call(
                `/prices/${encodeURIComponent(productId)}`,
                COST.prices,
                'prices',
                capturedAt,
              );
              if (pricesResult) {
                addPriceRecords(productId, card, pricesResult.body, pricesResult.data, capturedAt);
              }
              if (state.stoppedAtBudget) break;
              if (options.includeSalesHistory) {
                const salesResult = await call(
                  `/sales-history/${encodeURIComponent(productId)}?limit=25`,
                  COST.sales,
                  'sales-history',
                  capturedAt,
                );
                if (salesResult) {
                  addSaleRecords(productId, card, salesResult.body, salesResult.data, capturedAt);
                }
              }
            }
          }
        }
      } catch (error) {
        if (error instanceof TrialCreditsExhausted) {
          if (!state.errors.includes(TRIAL_ERROR)) state.errors.push(TRIAL_ERROR);
        } else {
          state.errors.push(sanitizeError(error, [options.key]));
        }
      }
      return { items: state.items, meta: meta() };
    },
  };

  function meta(): Record<string, unknown> {
    return {
      games: state.games,
      expansions: state.expansions,
      cards: state.cards,
      prices: state.prices,
      sales: state.sales,
      creditsSpent: state.creditsSpent,
      stoppedAtBudget: state.stoppedAtBudget,
      errors: [...state.errors],
    };
  }

  return adapter;
}

/** Run one bounded harvest and write its raw evidence through the ledger. */
export async function runTcgapisHarvest(deps: HarvestDeps): Promise<HarvestResult> {
  const env = deps.env ?? process.env;
  const empty: HarvestResult = {
    games: 0,
    expansions: 0,
    cards: 0,
    prices: 0,
    sales: 0,
    evidenceWritten: 0,
    creditsSpent: 0,
    stoppedAtBudget: false,
    errors: [],
  };
  if (!enabled(env)) return empty;
  const key = apiKeyFromEnv(env);
  if (!key) return { ...empty, errors: ['TCGAPI_KEY_MISSING'] };

  const adapter = createChainAdapter({
    key,
    budget: budgetFromEnv(env, deps.budget),
    fetchImpl: deps.fetchImpl ?? (globalThis.fetch as unknown as HarvestFetch),
    includeSalesHistory: deps.includeSalesHistory ?? true,
    maxGames: deps.maxGames ?? 10,
    maxExpansions: deps.maxExpansions ?? 10,
    maxCardsPerExpansion: deps.maxCardsPerExpansion ?? 100,
  });

  const result = await runIngest(adapter, deps.repos, {
    mode: 'backfill',
    capturedAt: deps.capturedAt,
    options: {},
  });
  const state = adapter.getState();
  return {
    games: state.games,
    expansions: state.expansions,
    cards: state.cards,
    prices: state.prices,
    sales: state.sales,
    evidenceWritten: result.run.counts.created,
    creditsSpent: state.creditsSpent,
    stoppedAtBudget: state.stoppedAtBudget,
    errors: [...state.errors, ...result.run.errors.map((error) => error.message)],
  };
}
