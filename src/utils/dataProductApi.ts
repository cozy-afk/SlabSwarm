import { useEffect, useState } from 'react';

import type { ActiveReport, ApiEnvelope, ApiMeta } from '../types/dataProduct.ts';
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
