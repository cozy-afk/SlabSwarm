/**
 * Catalog read models and shared response helpers for the Phase 5 serving API.
 *
 * This module is pure: it reads a GraphStatePayload snapshot and the ingest
 * ledger passed in by the caller, and never writes to the graph, the ledger,
 * or any external system. Graph assets are the primary source of catalog
 * identity; when no asset matches an id, identity facets are derived from
 * first-party evidence `parsedPayload` and marked identityConfidence LOW.
 * No price is derived here.
 *
 * Missing values are the literal string UNKNOWN (never null and never zero),
 * as required by the serving binding constraints. Every row carries an
 * explicit basis, currency and provenance object. Both camelCase (view types)
 * and snake_case (spec wording) provenance field names are emitted so the
 * response satisfies both contract spellings.
 */

import { randomUUID } from 'node:crypto';
import type { AssetNode, GraphStatePayload } from '../../src/types/graph.ts';
import { BASIS_VALUES } from '../../src/types/dataProduct.ts';
import { CONTRACT_VERSION, type MarketBasis } from '../contracts/dataProduct.ts';

export type { MarketBasis } from '../contracts/dataProduct.ts';

export const UNKNOWN = 'UNKNOWN';
export type UnknownValue = typeof UNKNOWN;
export type ConfidenceBand = 'UNKNOWN' | 'LOW' | 'MEDIUM' | 'HIGH';

/** Provenance attached to every fact row and optionally to meta. */
export interface ServingProvenance {
  source: string;
  basis: MarketBasis;
  currency: string;
  observedAt: string;
  capturedAt: string;
  observed_at: string;
  captured_at: string;
  lineage: string[];
  confidence: ConfidenceBand;
}

export interface ApiMeta {
  requestId: string;
  generatedAt: string;
  contractVersion: string;
  correctionPolicy: 'APPEND_ONLY';
  source?: string;
  basis?: MarketBasis;
  currency?: string;
  provenance?: ServingProvenance;
  warnings: string[];
}

export interface ApiEnvelope<T> {
  data: T;
  meta: ApiMeta;
}

export interface ErrorEnvelope {
  data: null;
  error: string;
  code: string;
  meta: ApiMeta;
}

export interface RequestContext {
  requestId: string;
  generatedAt: string;
}

export interface MetaExtras {
  source?: string;
  basis?: MarketBasis;
  currency?: string;
  provenance?: ServingProvenance;
  warnings?: string[];
}

export function isMarketBasis(value: unknown): value is MarketBasis {
  return typeof value === 'string' && (BASIS_VALUES as readonly string[]).includes(value);
}

export function dedupe(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

/** Create a per-request correlation id and deterministic timestamp source. */
export function newContext(now: () => Date = () => new Date()): RequestContext {
  // randomUUID is only an identifier, never a valuation or fact.
  return {
    requestId: randomUUID(),
    generatedAt: now().toISOString(),
  };
}

export function makeMeta(context: RequestContext, extra: MetaExtras = {}): ApiMeta {
  return {
    requestId: context.requestId,
    generatedAt: context.generatedAt,
    contractVersion: CONTRACT_VERSION,
    correctionPolicy: 'APPEND_ONLY',
    ...(extra.source !== undefined ? { source: extra.source } : {}),
    ...(extra.basis !== undefined ? { basis: extra.basis } : {}),
    ...(extra.currency !== undefined ? { currency: extra.currency } : {}),
    ...(extra.provenance !== undefined ? { provenance: extra.provenance } : {}),
    warnings: dedupe(extra.warnings ?? []),
  };
}

export function envelope<T>(
  data: T,
  context: RequestContext,
  extra: MetaExtras = {},
): ApiEnvelope<T> {
  return { data, meta: makeMeta(context, extra) };
}

export function errorEnvelope(
  error: string,
  code: string,
  context: RequestContext,
  extra: MetaExtras = {},
): ErrorEnvelope {
  return { data: null, error, code, meta: makeMeta(context, extra) };
}

/** Provenance for a row that came straight from the canonical graph snapshot. */
export function graphProvenance(
  assetId: string,
  generatedAt: string,
  confidence: ConfidenceBand = 'HIGH',
): ServingProvenance {
  return {
    source: 'graphEngine.getState()',
    basis: UNKNOWN as MarketBasis,
    currency: UNKNOWN,
    observedAt: UNKNOWN,
    capturedAt: generatedAt,
    observed_at: UNKNOWN,
    captured_at: generatedAt,
    lineage: ['graphEngine.getState()', 'assets', assetId],
    confidence,
  };
}

export function syntheticProvenance(
  source: string,
  basis: MarketBasis,
  currency: string,
  generatedAt: string,
  lineage: string[] = [source],
): ServingProvenance {
  return {
    source,
    basis,
    currency,
    observedAt: UNKNOWN,
    capturedAt: generatedAt,
    observed_at: UNKNOWN,
    captured_at: generatedAt,
    lineage: dedupe(lineage).length ? dedupe(lineage) : [source],
    confidence: 'UNKNOWN',
  };
}

/** Minimal immutable ledger evidence shape used for catalog identity. */
export interface LedgerEvidenceRow {
  id: string;
  sourceId: string;
  capturedAt: string;
  observedAt: string;
  parsedPayload?: Record<string, unknown>;
  lineage?: string[];
}

/** Minimal read port over the ingest ledger; IngestRepositories.evidence satisfies it. */
export interface LedgerEvidenceReader {
  list(filters?: Record<string, unknown>): Promise<LedgerEvidenceRow[]>;
}

/**
 * Provenance for identity derived from a first-party ledger evidence record.
 * The ledger source id and the immutable evidence id are both named; the
 * source's own observed/captured timestamps are preserved verbatim. There is
 * no price and no synthesized set/game — identityConfidence is LOW.
 */
export function ledgerProvenance(evidence: LedgerEvidenceRow): ServingProvenance {
  const sourceId = typeof evidence.sourceId === 'string' && evidence.sourceId.trim() !== ''
    ? evidence.sourceId
    : UNKNOWN;
  const observedAt = typeof evidence.observedAt === 'string' && evidence.observedAt.trim() !== ''
    ? evidence.observedAt
    : UNKNOWN;
  const capturedAt = typeof evidence.capturedAt === 'string' && evidence.capturedAt.trim() !== ''
    ? evidence.capturedAt
    : UNKNOWN;
  return {
    source: `ingest-ledger:${sourceId}`,
    basis: UNKNOWN as MarketBasis,
    currency: UNKNOWN,
    observedAt,
    capturedAt,
    observed_at: observedAt,
    captured_at: capturedAt,
    lineage: dedupe([
      'ingest-ledger',
      `source:${sourceId}`,
      `evidence:${evidence.id}`,
      ...(Array.isArray(evidence.lineage) ? evidence.lineage : []),
    ]),
    confidence: 'LOW',
  };
}

// --- Catalog read models ---------------------------------------------------

export interface CatalogItemView {
  id: string;
  name: string;
  game: string;
  set: string;
  number: string;
  segment: string;
  variant: string;
  releaseYear: number | UnknownValue;
  identityConfidence: ConfidenceBand;
  source: string;
  basis: MarketBasis;
  currency: string;
  provenance: ServingProvenance;
}

/**
 * A canonical asset node in the graph is a resolved identity. That is a
 * deterministic policy, not a model claim; getState() does not expose
 * identity-decision records, so no finer confidence is asserted here.
 */
export function toCatalogItem(asset: AssetNode, generatedAt: string): CatalogItemView {
  const provenance = graphProvenance(asset.id, generatedAt, 'HIGH');
  return {
    id: asset.id,
    name: asset.title,
    game: asset.franchise || UNKNOWN,
    set: asset.setName || UNKNOWN,
    number: asset.cardNumber || UNKNOWN,
    segment: asset.segment || UNKNOWN,
    variant: asset.variant || UNKNOWN,
    releaseYear: Number.isFinite(asset.releaseYear) ? asset.releaseYear : UNKNOWN,
    identityConfidence: 'HIGH',
    source: provenance.source,
    basis: provenance.basis,
    currency: provenance.currency,
    provenance,
  };
}

/** Substring search over the identity facets available in the graph snapshot. */
export function searchCatalog(
  state: GraphStatePayload,
  query: string,
  generatedAt: string,
  limit: number,
): CatalogItemView[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [];
  const assets = (state.assets ?? [])
    .filter((asset) =>
      [
        asset.id,
        asset.title,
        asset.franchise,
        asset.setName,
        asset.cardNumber,
        asset.variant,
        asset.segment,
        asset.subjectName,
      ].some((field) => String(field ?? '').toLowerCase().includes(needle)),
    )
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, limit);
  return assets.map((asset) => toCatalogItem(asset, generatedAt));
}

export function findCatalogAsset(state: GraphStatePayload, id: string): AssetNode | null {
  return (state.assets ?? []).find((asset) => asset.id === id) ?? null;
}

// --- Ledger-backed catalog identity fallback -------------------------------

const IDENTITY_FACET_KEYS = ['name', 'gameName', 'expansionName'] as const;

/** Read a ledger payload field as text, or UNKNOWN when absent/empty. */
function payloadText(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === 'string' && value.trim() !== '' ? value : UNKNOWN;
}

/** Same ref spelling tolerance as the market facts: exact or trailing segment. */
function payloadRefMatches(ref: string, id: string): boolean {
  return ref === id || (ref.split(/[:/#]/).pop() ?? '') === id;
}

function identityFacetScore(row: LedgerEvidenceRow): number {
  const payload = row.parsedPayload ?? {};
  return IDENTITY_FACET_KEYS.filter((key) => payloadText(payload, key) !== UNKNOWN).length;
}

function catalogKindRank(row: LedgerEvidenceRow): number {
  const payload = row.parsedPayload ?? {};
  const kind = String(payload.recordKind ?? '').toUpperCase();
  if (kind.includes('CATALOG')) return 3;
  if (row.sourceId === 'tcgapis') return 2;
  return 1;
}

/** Pick the evidence row that best documents this id, deterministically. */
export function findLedgerIdentityEvidence(
  rows: LedgerEvidenceRow[],
  id: string,
): LedgerEvidenceRow | null {
  const matches = rows.filter((row) => {
    const payload = row.parsedPayload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
    const ref = payload.targetIdentityRef;
    return typeof ref === 'string' && payloadRefMatches(ref, id);
  });
  matches.sort((a, b) =>
    identityFacetScore(b) - identityFacetScore(a) ||
    catalogKindRank(b) - catalogKindRank(a) ||
    String(a.sourceId ?? '').localeCompare(String(b.sourceId ?? '')) ||
    a.id.localeCompare(b.id));
  return matches[0] ?? null;
}

/**
 * Derive a LOW-confidence catalog identity solely from first-party evidence.
 * The three facets come from `name`, `gameName` and `expansionName`; every
 * absent field is the literal UNKNOWN. No set, game, price or date is invented.
 */
export function toLedgerCatalogItem(
  id: string,
  evidence: LedgerEvidenceRow,
): CatalogItemView {
  const payload = evidence.parsedPayload ?? {};
  const provenance = ledgerProvenance(evidence);
  return {
    id,
    name: payloadText(payload, 'name'),
    game: payloadText(payload, 'gameName'),
    set: payloadText(payload, 'expansionName'),
    number: payloadText(payload, 'number'),
    segment: UNKNOWN,
    variant: UNKNOWN,
    releaseYear: UNKNOWN,
    identityConfidence: 'LOW',
    source: provenance.source,
    basis: provenance.basis,
    currency: provenance.currency,
    provenance,
  };
}

/**
 * Resolve an id first against the canonical graph snapshot, then against the
 * first-party ingest ledger. Returns null only when neither source documents
 * the id, so callers can keep returning a 404 for genuinely unknown ids.
 */
export async function resolveCatalogIdentity(
  id: string,
  state: GraphStatePayload,
  evidence: LedgerEvidenceReader,
  generatedAt: string,
): Promise<CatalogItemView | null> {
  const asset = findCatalogAsset(state, id);
  if (asset) return toCatalogItem(asset, generatedAt);
  const row = findLedgerIdentityEvidence(await evidence.list(), id);
  return row ? toLedgerCatalogItem(id, row) : null;
}

/** Search ledger-derived identities by the documented identity facets. */
export async function searchLedgerCatalog(
  evidence: LedgerEvidenceReader,
  query: string,
): Promise<CatalogItemView[]> {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [];
  const bestById = new Map<string, LedgerEvidenceRow>();
  for (const row of await evidence.list()) {
    const payload = row.parsedPayload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue;
    const ref = payload.targetIdentityRef;
    if (typeof ref !== 'string' || ref.trim() === '') continue;
    const searchable = [...IDENTITY_FACET_KEYS, 'number']
      .map((key) => payloadText(payload, key))
      .filter((value) => value !== UNKNOWN);
    if (!searchable.some((value) => value.toLowerCase().includes(needle))) continue;
    const current = bestById.get(ref);
    if (!current || identityFacetScore(row) > identityFacetScore(current)) bestById.set(ref, row);
  }
  return [...bestById.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, row]) => toLedgerCatalogItem(id, row));
}

export interface PrintingView {
  id: string;
  label: string;
  finish: string;
  language: string;
  gradingPopulation: number | UnknownValue;
  basis: MarketBasis;
  currency: string;
  source: string;
  provenance: ServingProvenance;
}

/**
 * Printings are derived from the deterministic grade/population facets on a
 * canonical asset. Language is not present in the snapshot and stays UNKNOWN;
 * a zero population count is treated as UNKNOWN, never as a measured zero.
 */
export function listPrintings(
  state: GraphStatePayload,
  id: string,
  generatedAt: string,
): PrintingView[] | null {
  const asset = findCatalogAsset(state, id);
  if (!asset) return null;
  return (asset.grades ?? []).map((grade) => {
    const hasPopulation = Number.isFinite(grade.popCount) && grade.popCount > 0;
    const basis: MarketBasis = hasPopulation ? 'POPULATION' : UNKNOWN;
    const provenance: ServingProvenance = {
      source: 'graphEngine.getState():assets[].grades',
      basis,
      currency: UNKNOWN,
      observedAt: UNKNOWN,
      capturedAt: generatedAt,
      observed_at: UNKNOWN,
      captured_at: generatedAt,
      lineage: dedupe(['graphEngine.getState()', 'assets', asset.id, 'grades', grade.grade]),
      confidence: hasPopulation ? 'HIGH' : 'UNKNOWN',
    };
    return {
      id: `${asset.id}::${grade.grade}`,
      label: `${asset.title} (${grade.grade})`,
      finish: asset.variant || UNKNOWN,
      language: UNKNOWN,
      gradingPopulation: hasPopulation ? grade.popCount : UNKNOWN,
      basis,
      currency: provenance.currency,
      source: provenance.source,
      provenance,
    };
  });
}
