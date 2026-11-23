import { useEffect, useState } from 'react';

import type { ActiveReport, ApiEnvelope, ApiMeta, Provenance } from '../types/dataProduct.ts';
import { apiFetch } from './apiClient.ts';

/**
 * Route templates from the approved data-product design spec. The UI is built
 * contract-first: these are the planned endpoints the backend lanes serve.
 * The literal `:id` / `:source` route tokens make the contract greppable.
 */
export const ROUTES = {
  evidence: '/api/evidence',
  observations: '/api/observations',
  ingest: '/api/ingest/:source',
  catalogSearch: '/api/catalog/search',
  catalogById: '/api/catalog/:id',
  catalogPrintings: '/api/catalog/:id/printings',
  pricing: '/api/pricing/:id',
  comps: '/api/comps/:id',
  market: '/api/market/:id',
  harvestLegacy: '/api/intelligence/harvest-legacy',
  freeFeeds: '/api/ingest/free-feeds',
  freeFeedsHarvest: '/api/ingest/free-feeds/:sourceId/harvest',
  activeReport: '/api/intelligence/active-report',
  discoverySweep: '/api/intelligence/discovery-sweep',
  findings: '/api/intelligence/findings',
  swarmRun: '/api/swarm/research/run',
  swarmRunById: '/api/swarm/runs/:id',
  forecasts: '/api/forecasts',
  forecastById: '/api/forecasts/:id',
  forecastScore: '/api/forecasts/:id/score',
  forecastBacktest: '/api/forecasts/:id/backtest',
  learningState: '/api/learning/state',
  learningFeedback: '/api/learning/feedback',
  learningRunCycle: '/api/learning/run-cycle',
  sqlQuery: '/api/sql/query',
  sqlSaved: '/api/sql/saved',
  webSources: '/api/web-harvest/sources',
  webHarvestQueue: '/api/web-harvest/review-queue',
  webHarvestCandidates: '/api/web-harvest/candidates',
  webHarvestReview: '/api/web-harvest/review',
} as const;

/** Substitute route tokens without ever emitting an unencoded value. */
export function buildRoute(
  template: string,
  params: Record<string, string | number>
): string {
  return template.replace(/:([A-Za-z]+)/g, (_match, key: string) =>
    encodeURIComponent(String(params[key] ?? ''))
  );
}

/** Append a query object to a route, omitting blank values. */
export function withQuery(
  route: string,
  query: Record<string, string | number | undefined | null>
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && String(value).length > 0) {
      params.set(key, String(value));
    }
  }
  const qs = params.toString();
  return qs ? `${route}?${qs}` : route;
}

async function parseEnvelope<T>(response: Response): Promise<ApiEnvelope<T>> {
  const json = (await response.json()) as Partial<ApiEnvelope<T>> & {
    error?: string;
  };
  if (!response.ok) {
    throw new Error(json.error || `Request failed (${response.status})`);
  }
  if (!json || typeof json !== 'object' || !('data' in json)) {
    throw new Error('Response did not use the { data, meta } envelope.');
  }
  return json as ApiEnvelope<T>;
}

export async function fetchEnvelope<T>(path: string): Promise<ApiEnvelope<T>> {
  return parseEnvelope<T>(await apiFetch(path));
}

export async function postEnvelope<T>(
  path: string,
  body: unknown
): Promise<ApiEnvelope<T>> {
  return parseEnvelope<T>(
    await apiFetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
}

/** Typed read of the real, evidence-backed active trading report. */
export function fetchActiveReport(): Promise<ApiEnvelope<ActiveReport>> {
  return fetchEnvelope<ActiveReport>(ROUTES.activeReport);
}

// --- Free catalog feeds -----------------------------------------------------
// Local mirrors of the operator-only metadata returned by the ingest router.
// Browser code never imports server modules; no key value or environment
// value is ever part of these shapes.

export interface FreeFeedView {
  sourceId: string;
  vertical: string;
  license: string;
  attribution: string;
  attributionRequired: boolean;
  rateLimitMs: number;
  enabled: boolean;
  dailyRequestLimit?: number;
}

export interface FreeFeedsResponse {
  feeds: FreeFeedView[];
}

export interface FreeFeedHarvestCounts {
  fetched: number;
  created: number;
  duplicates: number;
  failed: number;
  candidates: number;
}

export interface FreeFeedHarvestResponse {
  sourceId: string;
  license: string;
  attribution: string;
  status: string;
  runId: string;
  capturedAt: string;
  counts: FreeFeedHarvestCounts;
  errors: string[];
  adapterMeta: {
    requestsIssued: number;
    dailyRequestsIssued: number;
    dailyCapReached: boolean;
    skipped: string | null;
  };
}

export function fetchFreeFeeds(): Promise<ApiEnvelope<FreeFeedsResponse>> {
  return fetchEnvelope<FreeFeedsResponse>(ROUTES.freeFeeds);
}

export function harvestFreeFeed(
  sourceId: string
): Promise<ApiEnvelope<FreeFeedHarvestResponse>> {
  return postEnvelope<FreeFeedHarvestResponse>(buildRoute(ROUTES.freeFeedsHarvest, { sourceId }), {});
}

// --- Web source review queue -------------------------------------------------
// Local mirrors of the frozen server/contracts/webHarvest.ts shapes. Browser
// code never imports server modules; UNKNOWN stays a literal, never zero.

export type ReviewStatus = 'PENDING' | 'APPROVED' | 'REJECTED';
export type ReviewAction = 'APPROVE' | 'REJECT';
export type WebHarvestBasis =
  | 'SOLD' | 'ASKING' | 'OFFER' | 'GUIDE' | 'CLAIM' | 'POPULATION' | 'UNKNOWN';
export type WebHarvestConfidence = 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';

export interface WebSourceConfigView {
  id: string;
  name: string;
  url: string;
  kind: 'json' | 'html';
  enabled: boolean;
  license: string;
  respectRobots: boolean;
  rateLimitMs: number;
  recordPath?: string;
  selectors?: Record<string, string>;
  provenanceNote?: string;
}

export interface WebHarvestCandidateView {
  id: string;
  sourceId: string;
  evidenceId: string;
  name: string;
  set: string | 'UNKNOWN';
  game: string | 'UNKNOWN';
  number: string | 'UNKNOWN';
  basis: WebHarvestBasis;
  amount: number | 'UNKNOWN';
  currency: string | 'UNKNOWN';
  observedAt: string;
  capturedAt: string;
  license: string;
  confidence: WebHarvestConfidence;
  warnings: string[];
}

export interface ReviewCandidateView extends WebHarvestCandidateView {
  status: ReviewStatus;
  reviewedAt?: string;
  reviewNote?: string;
}

export interface WebSourcesResponse {
  sources: WebSourceConfigView[];
}

export interface WebHarvestQueueResponse {
  candidates: ReviewCandidateView[];
  counts: Record<ReviewStatus, number>;
}

export interface WebHarvestCardView {
  id: string;
  name: string;
  identityKey: string;
  facets?: Record<string, unknown> | null;
}

export interface WebHarvestObservationView {
  id: string;
  evidenceId: string;
  targetIdentityId: string;
  basis: WebHarvestBasis;
  amount: number;
  currency: string;
  observedAt: string;
}

export interface WebHarvestReviewResponse {
  candidate: ReviewCandidateView;
  card: WebHarvestCardView | null;
  observation: WebHarvestObservationView | null;
  provenance?: Provenance;
}

export interface WebHarvestEnqueueResponse {
  candidates: ReviewCandidateView[];
  enqueued: number;
  duplicates: number;
}

export function fetchWebSources(): Promise<ApiEnvelope<WebSourcesResponse>> {
  return fetchEnvelope<WebSourcesResponse>(ROUTES.webSources);
}

export function fetchWebHarvestQueue(status?: ReviewStatus): Promise<ApiEnvelope<WebHarvestQueueResponse>> {
  return fetchEnvelope<WebHarvestQueueResponse>(withQuery(ROUTES.webHarvestQueue, { status }));
}

export function enqueueWebCandidates(candidates: WebHarvestCandidateView[]): Promise<ApiEnvelope<WebHarvestEnqueueResponse>> {
  return postEnvelope<WebHarvestEnqueueResponse>(ROUTES.webHarvestCandidates, { candidates });
}

export function reviewWebCandidate(
  candidateId: string,
  action: ReviewAction,
  note?: string
): Promise<ApiEnvelope<WebHarvestReviewResponse>> {
  return postEnvelope<WebHarvestReviewResponse>(ROUTES.webHarvestReview, { candidateId, action, note });
}

export interface EnvelopeState<T> {
  data: T | null;
  meta: ApiMeta | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/**
 * Minimal fetch hook for a planned endpoint. A missing or not-yet-deployed
 * backend is surfaced as an explicit error state, never as invented data.
 */
export function useEnvelope<T>(path: string | null): EnvelopeState<T> {
  const [data, setData] = useState<T | null>(null);
  const [meta, setMeta] = useState<ApiMeta | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (path === null) {
      setData(null);
      setMeta(null);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchEnvelope<T>(path)
      .then((envelope) => {
        if (cancelled) return;
        setData(envelope.data);
        setMeta(envelope.meta);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setData(null);
        setMeta(null);
        setError(err instanceof Error ? err.message : 'Request failed.');
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path, nonce]);

  return { data, meta, loading, error, reload: () => setNonce((n) => n + 1) };
}
