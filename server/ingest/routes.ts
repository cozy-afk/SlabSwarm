// Ingest HTTP routes. Mount with `app.use(createIngestRouter(repos))`; the
// router owns full /api paths so the integrator only adds one line to server.ts.
// All writes go through the runner, so adapters never touch canonical facts.

import { Router, type Request, type Response } from 'express';
import { AdapterRegistry } from './registry.ts';
import { createCsvAdapter, previewCsv } from './adapters/csv.ts';
import { createManualAdapter } from './adapters/manual.ts';
import {
  createLegacyAdapter,
  loadLegacySnapshot,
  resolveLegacyDbPath,
  type LegacySnapshot,
} from './adapters/legacy.ts';
import { createTcgapisAdapter } from './adapters/tcgapis.ts';
import {
  CARDEX_DAILY_REQUEST_LIMIT,
  createFreeFeedAdapter,
  type FreeFeedFetchImpl,
} from './adapters/freeCatalog.ts';
import { FREE_FEEDS, getFreeFeed } from './freeFeeds.ts';
import type { FreeFeedConfig } from '../contracts/freeFeed.ts';
import {
  createWebSourceAdapter,
  harvestWebSources,
  type WebFetchImpl,
} from './adapters/web.ts';
import { WebSourceConfigError, WebSourceRegistry } from './sources.ts';
import type { WebSourceConfig } from '../contracts/webHarvest.ts';
import { promoteCandidates } from './promotion.ts';
import { runIngest } from './runner.ts';
import { createDurableRepositories } from './store.ts';
import type { IngestRepositories } from './types.ts';
import { envelope, errorEnvelope, newContext, UNKNOWN } from '../serving/catalog.ts';

type Filters = Record<string, unknown>;

/** Warnings that apply to every ingest response. No secret values are logged. */
const INGEST_WARNINGS = [
  'Raw evidence is immutable; corrections append.',
  'Missing prices, shipping, fees, grade and condition stay UNKNOWN, never zero.',
];

/** Free-feed-only warnings: catalog/price-guide data is never a SOLD comp. */
const FREE_FEED_WARNINGS = [
  'Free feed records are catalog or GUIDE proposals with explicit basis; never SOLD sales evidence.',
  'License and attribution are preserved verbatim; a feed without a license is disabled.',
  'Keys stay server-side. Public metadata exposes no key or environment value.',
];

/** Human-readable attribution for the public feed list. Mirrors the adapter's
 * deterministic mapping; no key material or environment value is included. */
const FREE_FEED_ATTRIBUTION: Record<string, string> = {
  scryfall: 'Scryfall API (scryfall.com); card data (c) Wizards of the Coast',
  pokemontcg: 'Pokemon TCG API (pokemontcg.io)',
  carddex: 'CardDex API (carddex.io) - attribution required by license',
  cardex: 'Cardex public catalog (cardex.com)',
};

/** Project a frozen feed config onto operator-safe public metadata. Only the
 * config's own fields are used; no environment value is ever read here. */
function publicFreeFeed(config: FreeFeedConfig) {
  return {
    sourceId: config.sourceId,
    vertical: config.vertical,
    license: config.license,
    attribution: FREE_FEED_ATTRIBUTION[config.sourceId] ?? `${config.sourceId} public catalog`,
    attributionRequired: config.attributionRequired,
    rateLimitMs: config.rateLimitMs,
    enabled: config.license.trim() !== '',
    ...(config.sourceId === 'cardex'
      ? { dailyRequestLimit: CARDEX_DAILY_REQUEST_LIMIT }
      : {}),
  };
}

/** Collect the lane's configured secret values from the injected env map (or
 * the server process environment) so the runner redacts them from every error
 * before it is returned or persisted in a run record. These values are never
 * copied into response data or public feed metadata. */
function freeFeedSecretValues(env: Record<string, unknown> | undefined): string[] {
  const source = env ?? (process.env as Record<string, unknown>);
  const values: string[] = [];
  for (const config of FREE_FEEDS) {
    const name = config.apiKeyEnv;
    if (!name) continue;
    const value = source[name];
    if (typeof value === 'string' && value.length >= 4) values.push(value);
  }
  return values;
}

function respond<T>(
  res: Response,
  status: number,
  data: T,
  legacy: Record<string, unknown> = {},
  extraWarnings: string[] = [],
): void {
  res.status(status).json({
    ...legacy,
    ...envelope(data, newContext(), {
      basis: UNKNOWN,
      currency: UNKNOWN,
      warnings: [...INGEST_WARNINGS, ...extraWarnings],
    }),
  });
}

function respondError(
  res: Response,
  status: number,
  error: string,
  code: string,
): void {
  res.status(status).json({
    ...errorEnvelope(error, code, newContext(), {
      basis: UNKNOWN,
      currency: UNKNOWN,
      warnings: INGEST_WARNINGS,
    }),
  });
}

function filters(query: Request['query']): Filters {
  const out: Filters = {};
  for (const key of ['sourceId', 'sourceRecordId', 'parseStatus', 'status', 'adapterId', 'basis']) {
    const value = query[key];
    if (typeof value === 'string') out[key] = value;
  }
  if (typeof query.limit === 'string') {
    const limit = Number(query.limit);
    if (Number.isFinite(limit) && limit > 0) out.limit = limit;
  }
  return out;
}

function notFound(res: Response, label: string): void {
  respondError(res, 404, `${label} not found`, 'not_found');
}

export interface IngestRouterOptions {
  /** Web harvesting is opt-in: no sources are configured by default. */
  web?: {
    sources?: WebSourceConfig[];
    fetchImpl?: WebFetchImpl;
    now?: () => number;
  };
  /** Free feeds are keyless by default. Tests inject the fetch so a harvest
   * never makes a live third-party call; production falls back to global fetch
   * inside the adapter. An optional env map stays strictly server-side. */
  freeFeeds?: {
    fetchImpl?: FreeFeedFetchImpl;
    env?: Record<string, unknown>;
    /** Deterministic clock for capture timestamps. Tests inject this; the
     * HTTP request body is never allowed to choose capturedAt. */
    now?: () => Date;
  };
}

export function createIngestRouter(
  // Default to the durable ledger so server restarts keep all ingested
  // evidence. Tests may still inject an isolated repository bundle.
  repos: IngestRepositories = createDurableRepositories(),
  options: IngestRouterOptions = {},
): Router {
  const router = Router();
  const webRegistry = new WebSourceRegistry({ sources: options.web?.sources ?? [] });
  const webFetch: WebFetchImpl =
    options.web?.fetchImpl ?? (globalThis.fetch as unknown as WebFetchImpl);
  // The adapter decides whether to call; tests inject fetchImpl so no live
  // third-party request can be issued from a test process.
  const freeFetch: FreeFeedFetchImpl =
    options.freeFeeds?.fetchImpl ?? (globalThis.fetch as unknown as FreeFeedFetchImpl);
  const freeFeedEnv = options.freeFeeds?.env;
  const freeFeedSecrets = freeFeedSecretValues(freeFeedEnv);
  // One adapter per feed: Cardex's daily request counter must survive across
  // separate harvest requests within the same process.
  const freeFeedAdapters = new Map(
    FREE_FEEDS.map((config) => [config.sourceId, createFreeFeedAdapter(config)]),
  );
  const registry = new AdapterRegistry([
    // No path captured here: the adapter resolves SLABGRAPH_DATA_DIR on each fetch.
    createLegacyAdapter({}),
    createCsvAdapter(),
    createManualAdapter(),
    createTcgapisAdapter(),
    createWebSourceAdapter({ registry: webRegistry, fetchImpl: webFetch, now: options.web?.now }),
  ]);

  // Evidence ---------------------------------------------------------------
  router.get('/api/evidence', async (req, res) => {
    const evidence = await repos.evidence.list(filters(req.query));
    respond(res, 200, evidence, { evidence });
  });

  router.get('/api/evidence/:id', async (req, res) => {
    const record = await repos.evidence.get(req.params.id);
    if (!record) return notFound(res, 'evidence');
    respond(res, 200, record, { evidence: record });
  });

  // Ingest runs ------------------------------------------------------------
  router.get('/api/ingest/runs', async (req, res) => {
    const runs = await repos.runs.list(filters(req.query));
    respond(res, 200, runs, { runs });
  });

  router.get('/api/ingest/runs/:id', async (req, res) => {
    const run = await repos.runs.get(req.params.id);
    if (!run) return notFound(res, 'ingest run');
    respond(res, 200, run, { run });
  });

  router.get('/api/ingest/adapters', (_req, res) => {
    const adapters = registry.list().map((adapter) => adapter.id);
    respond(res, 200, adapters, { adapters });
  });

  // Free public catalog feeds (Task 3) -------------------------------------
  // Public metadata only. The frozen configs carry no key material; the
  // optional env map is passed to the adapter's fetch options, never to data.
  router.get('/api/ingest/free-feeds', (_req, res) => {
    const feeds = FREE_FEEDS.map(publicFreeFeed);
    const data = { feeds };
    respond(res, 200, data, data, FREE_FEED_WARNINGS);
  });

  router.post('/api/ingest/free-feeds/:sourceId/harvest', async (req, res) => {
    const config = getFreeFeed(req.params.sourceId);
    if (!config || !freeFeedAdapters.has(config.sourceId)) {
      notFound(res, 'free feed');
      return;
    }
    // capturedAt is server-generated from the injected clock (production: the
    // real clock). The HTTP body is deliberately never read for provenance.
    const capturedAt = (options.freeFeeds?.now?.() ?? new Date()).toISOString();
    // Failures are captured in the run record, not thrown at the caller: the
    // view can surface the counts and the plain-text errors deterministically.
    const result = await runIngest(freeFeedAdapters.get(config.sourceId)!, repos, {
      mode: 'backfill',
      capturedAt,
      secrets: freeFeedSecrets,
      options: { fetchImpl: freeFetch, ...(freeFeedEnv ? { env: freeFeedEnv } : {}) },
    });
    const { counts } = result.run;
    const meta = result.run.meta ?? {};
    const data = {
      sourceId: config.sourceId,
      license: config.license,
      attribution: publicFreeFeed(config).attribution,
      status: result.run.status,
      runId: result.run.id,
      capturedAt,
      counts: {
        fetched: counts.fetched,
        created: counts.created,
        duplicates: counts.duplicates,
        failed: counts.failed,
        candidates: counts.candidates,
      },
      errors: result.run.errors.map((error) => error.message),
      adapterMeta: {
        requestsIssued: meta.requestsIssued ?? 0,
        dailyRequestsIssued: meta.dailyRequestsIssued ?? 0,
        dailyCapReached: meta.dailyCapReached === true,
        skipped: typeof meta.skipped === 'string' ? meta.skipped : null,
      },
    };
    respond(res, 200, data, data, FREE_FEED_WARNINGS);
  });

  // Manual notes -----------------------------------------------------------
  router.post('/api/ingest/manual', async (req, res) => {
    const note = req.body;
    if (note === null || typeof note !== 'object' || Array.isArray(note)) {
      respondError(res, 400, 'note object is required', 'validation_error');
      return;
    }
    if (typeof note.text !== 'string' || note.text.trim() === '') {
      respondError(res, 400, 'text is required', 'validation_error');
      return;
    }
    const result = await runIngest(createManualAdapter(), repos, {
      mode: 'backfill',
      options: { note },
    });
    const payload = { evidence: result.evidence, candidates: result.candidates, run: result.run };
    respond(res, 200, payload, payload);
  });

  // CSV --------------------------------------------------------------------
  router.post('/api/ingest/csv', async (req, res) => {
    const csv = req.body?.csv;
    if (typeof csv !== 'string') {
      respondError(res, 400, 'csv text is required', 'validation_error');
      return;
    }
    if (req.body?.preview === true) {
      const preview = previewCsv(csv);
      respond(res, 200, preview, { preview });
      return;
    }
    const result = await runIngest(createCsvAdapter(), repos, {
      mode: 'backfill',
      options: { csv },
    });
    const payload = { evidence: result.evidence, candidates: result.candidates, run: result.run };
    respond(res, 200, payload, payload);
  });

  // Deterministic candidate -> observation promotion -----------------------
  router.post('/api/ingest/promote', async (_req, res) => {
    const result = await promoteCandidates(repos);
    const payload: Record<string, unknown> = { ...result };
    respond(res, 200, payload, payload);
  });

  // Legacy graph harvest ---------------------------------------------------
  router.post('/api/intelligence/harvest-legacy', async (req, res) => {
    let snapshot: LegacySnapshot;
    const provided = req.body?.snapshot;
    if (provided && typeof provided === 'object' && !Array.isArray(provided)) {
      snapshot = provided as LegacySnapshot;
    } else {
      try {
        snapshot = loadLegacySnapshot(
          typeof req.body?.snapshotPath === 'string'
            ? req.body.snapshotPath
            : resolveLegacyDbPath(),
        );
      } catch (error) {
        respondError(
          res,
          400,
          error instanceof Error ? error.message : 'legacy snapshot unavailable',
          'legacy_snapshot_unavailable',
        );
        return;
      }
    }
    const mode = req.body?.mode === 'forward' ? 'forward' : 'backfill';
    const result = await runIngest(createLegacyAdapter({ snapshot }), repos, {
      mode,
      options: {},
    });
    const payload = { evidence: result.evidence, candidates: result.candidates, run: result.run };
    respond(res, 200, payload, payload);
  });

  // Operator-controlled first-party web sources ----------------------------
  router.get('/api/ingest/web-sources', (_req, res) => {
    const sources = webRegistry.list();
    respond(res, 200, { sources }, { sources });
  });

  router.post('/api/ingest/web-sources', (req, res) => {
    const body = req.body;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      respondError(res, 400, 'source config object is required', 'validation_error');
      return;
    }
    const action = typeof body.action === 'string' ? body.action : 'upsert';
    if (action === 'enable' || action === 'disable' || action === 'remove') {
      const id = typeof body.id === 'string' ? body.id : '';
      const before = webRegistry.get(id);
      if (!before) {
        notFound(res, 'web source');
        return;
      }
      if (action === 'remove') webRegistry.remove(id);
      else webRegistry.setEnabled(id, action === 'enable');
      const sources = webRegistry.list();
      const updated = webRegistry.get(id) ?? null;
      respond(res, 200, { source: updated, sources }, { source: updated, sources });
      return;
    }
    const candidate = body.source !== undefined ? body.source : body;
    try {
      const source = webRegistry.upsert(candidate as WebSourceConfig);
      const sources = webRegistry.list();
      respond(res, 200, { source, sources }, { source, sources });
    } catch (error) {
      respondError(
        res,
        400,
        error instanceof WebSourceConfigError ? error.message : 'invalid web source config',
        'validation_error',
      );
    }
  });

  router.post('/api/ingest/web-harvest', async (req, res) => {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
      ? req.body as Record<string, unknown>
      : {};
    const requested = Array.isArray(body.sourceIds)
      ? body.sourceIds.filter((value): value is string => typeof value === 'string')
      : null;
    const sources = requested === null
      ? webRegistry.enabled()
      : webRegistry.enabled().filter((source) => requested.includes(source.id));
    const capturedAt = typeof body.capturedAt === 'string' && Number.isFinite(Date.parse(body.capturedAt))
      ? body.capturedAt
      : undefined;
    const results = await harvestWebSources({
      repos,
      registry: webRegistry,
      fetchImpl: webFetch,
      sources,
      capturedAt,
      now: options.web?.now,
    });
    const harvested = new Set(results.map((result) => `web:${result.sourceId}`));
    const evidence = (await repos.evidence.list({})).filter((row) => harvested.has(row.sourceId));
    const payload = { results, evidence };
    respond(res, 200, payload, payload);
  });

  return router;
}

export default createIngestRouter;
