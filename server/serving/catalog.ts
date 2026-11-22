/**
 * Catalog read models and shared response helpers for the Phase 5 serving API.
 *
 * This module is pure: it reads a GraphStatePayload snapshot and never writes
 * to the graph, the ledger, or any external system. The graph snapshot is the
 * only source of catalog identity facts; no price is derived here.
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
