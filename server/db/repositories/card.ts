/** Canonical card identity with JSONB facets and raw payloads. */

import { randomUUID } from 'node:crypto';
import { reusedIso } from './dates.ts';
import type { DbStore, Row } from '../store.ts';
import { requireNonEmpty } from '../validation.ts';

export interface CardInput {
  id?: string;
  setId?: string | null;
  name: string;
  cardNumber?: string | null;
  variant?: string | null;
  identityKey: string;
  facets?: Record<string, unknown> | null;
  rawPayload?: Record<string, unknown> | null;
}

export interface Card extends CardInput {
  id: string;
  createdAt: string;
}

export interface CardRepository {
  create(input: CardInput): Promise<Card>;
  get(id: string): Promise<Card | null>;
  list(filters?: Record<string, unknown>): Promise<Card[]>;
  upsert(input: CardInput): Promise<Card>;
  /** Deterministic facet-filtered, typo-tolerant search over canonical cards. */
  search(options?: CatalogSearchOptions): Promise<CatalogFacetView[]>;
}

const TABLE = 'cards';
const CONFLICT_KEYS = ['identityKey'];

// --- Searchable catalog facets --------------------------------------------
// These are read-only projections of the JSONB facets already on a canonical
// card. They never change identityKey, the resolver or any stored row.

export const UNKNOWN = 'UNKNOWN' as const;
export type UnknownValue = typeof UNKNOWN;

export const CATALOG_FACET_KEYS = ['set', 'parallel', 'serialRun', 'grade', 'rookie', 'category'] as const;
export type CatalogFacetKey = (typeof CATALOG_FACET_KEYS)[number];

export interface CatalogFacetView {
  id: string;
  name: string;
  set: string;
  parallel: string;
  serialRun: string;
  grade: string;
  rookie: string;
  category: string;
}

export interface CatalogSearchOptions extends Partial<Record<CatalogFacetKey, string>> {
  /** Free text; matched against name and every facet with typo tolerance. */
  q?: string;
  limit?: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function facetText(
  facets: Record<string, unknown>,
  keys: readonly string[],
  fallback?: unknown,
): string {
  for (const key of keys) {
    const value = facets[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  if (typeof fallback === 'string' && fallback.trim() !== '') return fallback.trim();
  return UNKNOWN;
}

function serialRunText(facets: Record<string, unknown>): string {
  for (const key of ['serialRun', 'serial_run', 'printRun', 'print_run', 'serial'] as const) {
    const value = facets[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
    // A numeric print run is real metadata; zero or negative is not a run.
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return String(value);
  }
  return UNKNOWN;
}

function rookieText(facets: Record<string, unknown>): string {
  for (const key of ['rookie', 'isRookie', 'rookieFlag'] as const) {
    const value = facets[key];
    if (typeof value === 'boolean') return value ? 'YES' : 'NO';
    if (typeof value === 'string') {
      const token = value.trim().toLowerCase();
      if (['yes', 'y', 'true', '1', 'rookie'].includes(token)) return 'YES';
      if (['no', 'n', 'false', '0', 'veteran'].includes(token)) return 'NO';
    }
  }
  return UNKNOWN;
}

/** Project a stored card into the six searchable facets; never mutate it. */
export function extractCatalogFacets(card: Card | null | undefined): CatalogFacetView {
  const source = isObject(card) ? card as Card : null;
  const facets = source && isObject(source.facets) ? source.facets : {};
  return {
    id: typeof source?.id === 'string' ? source.id : UNKNOWN,
    name: typeof source?.name === 'string' && source.name.trim() !== '' ? source.name.trim() : UNKNOWN,
    set: facetText(facets, ['set', 'setName', 'expansionName', 'set_code'], source?.setId),
    parallel: facetText(facets, ['parallel', 'parallelName']),
    serialRun: serialRunText(facets),
    grade: facetText(facets, ['grade', 'gradeLabel', 'grade_label']),
    rookie: rookieText(facets),
    category: facetText(facets, ['category', 'property', 'vertical', 'gameName', 'game']),
  };
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Optimal-string-alignment Levenshtein: adjacent transpositions cost one. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev2: number[] | null = null;
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current: number[] = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(current[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, prev2![j - 2] + 1);
      }
      current[j] = best;
    }
    prev2 = prev;
    prev = current;
  }
  return prev[b.length];
}

function allowedDistance(a: string, b: string): number {
  const length = Math.max(a.length, b.length);
  if (length <= 3) return 0;
  if (length <= 6) return 1;
  return 2;
}

/** Score a text match: 0 substring, small integer edit distance, null no match. */
function scoreText(query: string, text: string): number | null {
  if (text === UNKNOWN) return null;
  const needle = normalize(query);
  const haystack = normalize(text);
  if (needle === '' || haystack === '') return null;
  if (haystack.includes(needle)) return 0;
  const tokens = haystack.split(' ').filter((token) => token !== '');
  const candidates = [haystack, ...tokens];
  let total = 0;
  for (const part of needle.split(' ').filter((token) => token !== '')) {
    let best: number | null = null;
    for (const candidate of candidates) {
      const distance = editDistance(part, candidate);
      if (distance <= allowedDistance(part, candidate) && (best === null || distance < best)) {
        best = distance;
      }
    }
    if (best === null) return null;
    total += best;
  }
  return total === 0 ? 1 : total;
}

const SEARCH_FIELDS = ['name', ...CATALOG_FACET_KEYS] as const;

interface ScoredRow {
  view: CatalogFacetView;
  distance: number;
  field: number;
}

/**
 * Pure, deterministic search over injected canonical cards. Facet filters are
 * ANDed with exact case-insensitive equality; the text query is typo-tolerant.
 * Ties break on field priority then id, so repeated calls return the same rows.
 */
export function searchCatalogCards(
  cards: readonly Card[] | null | undefined,
  options: CatalogSearchOptions = {},
): CatalogFacetView[] {
  const limit = typeof options.limit === 'number' && Number.isInteger(options.limit) && options.limit > 0
    ? options.limit
    : 100;
  const query = typeof options.q === 'string' ? options.q : undefined;
  // An explicitly blank query is a no-match, matching the existing catalog
  // search semantics; an omitted query means "filters only".
  if (query !== undefined && query.trim() === '') return [];
  const hasQuery = query !== undefined;
  const filters = CATALOG_FACET_KEYS
    .map((key) => [key, options[key]] as const)
    .filter((entry): entry is readonly [CatalogFacetKey, string] =>
      typeof entry[1] === 'string' && entry[1].trim() !== '');

  const matches: ScoredRow[] = [];
  for (const card of cards ?? []) {
    const view = extractCatalogFacets(card);
    if (!filters.every(([key, expected]) => view[key].toLowerCase() === expected.trim().toLowerCase())) {
      continue;
    }
    let distance = 0;
    let field = 0;
    if (hasQuery) {
      let best: { distance: number; field: number } | null = null;
      for (const [index, name] of SEARCH_FIELDS.entries()) {
        const score = scoreText(query, view[name]);
        if (score !== null && (
          best === null || score < best.distance || (score === best.distance && index < best.field)
        )) {
          best = { distance: score, field: index };
        }
      }
      if (best === null) continue;
      distance = best.distance;
      field = best.field;
    }
    matches.push({ view, distance, field });
  }
  matches.sort((a, b) =>
    a.distance - b.distance ||
    a.field - b.field ||
    a.view.id.localeCompare(b.view.id) ||
    a.view.name.localeCompare(b.view.name));
  return matches.slice(0, limit).map((match) => match.view);
}

function toRow(input: CardInput, id: string, createdAt: string, existing?: Row): Row {
  return {
    id,
    setId: input.setId ?? existing?.setId ?? null,
    name: input.name,
    cardNumber: input.cardNumber ?? existing?.cardNumber ?? null,
    variant: input.variant ?? existing?.variant ?? null,
    identityKey: input.identityKey,
    facets: input.facets ?? null,
    rawPayload: input.rawPayload === undefined ? (existing?.rawPayload ?? null) : input.rawPayload,
    createdAt,
  };
}

export function createCardRepository(store: DbStore): CardRepository {
  const repository: CardRepository = {
    create(input): Promise<Card> {
      requireNonEmpty(input.name, 'name');
      requireNonEmpty(input.identityKey, 'identityKey');
      return store.insert(TABLE, toRow(input, input.id ?? randomUUID(), new Date().toISOString())) as unknown as Promise<Card>;
    },
    async get(id): Promise<Card | null> {
      const row = await store.findById(TABLE, id);
      return row ? (row as unknown as Card) : null;
    },
    async list(filters = {}): Promise<Card[]> {
      return (await store.findAll(TABLE, filters)) as unknown as Card[];
    },
    async search(options = {}): Promise<CatalogFacetView[]> {
      return searchCatalogCards(await repository.list(), options);
    },
    async upsert(input): Promise<Card> {
      requireNonEmpty(input.name, 'name');
      requireNonEmpty(input.identityKey, 'identityKey');
      const [existing] = await store.findAll(TABLE, { identityKey: input.identityKey });
      const row = toRow(input, String(existing?.id ?? input.id ?? randomUUID()), reusedIso(existing?.createdAt), existing);
      return (await store.upsert(TABLE, row, CONFLICT_KEYS)) as unknown as Card;
    },
  };
  return repository;
}
