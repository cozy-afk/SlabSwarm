/**
 * Phase 5 serving HTTP surface.
 *
 * Exposes a mount function only — no listener, no firewall/DNS changes and no
 * canonical writes. The integrator mounts this router in server.ts. By default
 * catalog identity comes from graphEngine.getState() and observations come
 * from a process-local ingest ledger created by createInMemoryRepositories();
 * pass the same repository bundle used by the ingest router to see live rows.
 *
 * Every response uses { data, meta } (errors: { data: null, error, code, meta })
 * and every fact row carries source, basis, currency and provenance.
 */

import express, { type Express, type Request, type Response, type NextFunction, type Router } from 'express';
import {
  UNKNOWN,
  envelope,
  errorEnvelope,
  isMarketBasis,
  listPrintings,
  newContext,
  resolveCatalogIdentity,
  searchCatalog,
  searchLedgerCatalog,
  type CatalogItemView,
  type MarketBasis,
  type RequestContext,
} from './catalog.ts';
import {
  buildComps,
  buildMarketSnapshot,
  buildPriceSummary,
  loadFacts,
} from './market.ts';
import { graphEngine } from '../graphEngine.ts';
import { createInMemoryRepositories } from '../ingest/store.ts';
import type { IngestRepositories } from '../ingest/types.ts';

/** The default ledger is process-local; the integrator can share a bundle. */
const defaultRepositories = createInMemoryRepositories();

export interface ServingRouteOptions {
  engine?: Pick<typeof graphEngine, 'getState'>;
  repositories?: IngestRepositories;
  now?: () => Date;
  defaultLimit?: number;
  maxLimit?: number;
}

class ServingValidationError extends Error {}
class ServingNotFoundError extends Error {}

function stringQuery(value: Request['query'][string]): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

function parseLimit(value: Request['query'][string], fallback: number, max: number): number {
  const raw = stringQuery(value);
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new ServingValidationError(`limit must be an integer between 1 and ${max}.`);
  }
  return parsed;
}

function parseBasis(value: Request['query'][string]): MarketBasis {
  const raw = stringQuery(value);
  if (raw === undefined || raw.trim() === '') return 'SOLD';
  if (!isMarketBasis(raw)) {
    throw new ServingValidationError(`basis must be one of SOLD, ASKING, OFFER, GUIDE, CLAIM, POPULATION, UNKNOWN.`);
  }
  return raw;
}

function notFound(res: Response, context: RequestContext, label: string, warnings: string[] = []): void {
  res.status(404).json(
    errorEnvelope(`${label} not found`, 'not_found', context, { warnings }),
  );
}

/**
 * Create an isolated router with all six serving endpoints. Useful for tests
 * and for integrators that want to apply their own prefix/middleware.
 */
export function createServingRouter(options: ServingRouteOptions = {}): Router {
  const router = express.Router();
  const engine = options.engine ?? graphEngine;
  const repositories = options.repositories ?? defaultRepositories;
  const now = options.now ?? (() => new Date());
  const defaultLimit = options.defaultLimit ?? 100;
  const maxLimit = options.maxLimit ?? 500;

  function route(
    handler: (req: Request, res: Response, context: RequestContext) => Promise<void> | void,
  ) {
    return (req: Request, res: Response, next: NextFunction): void => {
      const context = newContext(now);
      res.locals.servingContext = context;
      Promise.resolve().then(() => handler(req, res, context)).catch(next);
    };
  }

  const catalogWarnings = [
    'identityConfidence is derived from canonical graph presence; getState() exposes no identity-decision record.',
  ];
  const ledgerIdentityWarning =
    'Identity was derived from first-party ingest ledger evidence; identityConfidence is LOW.';

  function identityWarnings(identity: CatalogItemView): string[] {
    return identity.identityConfidence === 'LOW'
      ? [...catalogWarnings, ledgerIdentityWarning]
      : catalogWarnings;
  }

  // GET /api/catalog/search --------------------------------------------------
  router.get('/api/catalog/search', route(async (req, res, context) => {
    const q = stringQuery(req.query.q);
    if (q === undefined || q.trim() === '') {
      throw new ServingValidationError('Query parameter q is required and must be a non-empty string.');
    }
    const limit = parseLimit(req.query.limit, defaultLimit, maxLimit);
    const state = engine.getState();
    const warnings = [...catalogWarnings];
    if (!state.assets?.length) warnings.push('Catalog is empty; no identities are available.');
    // Search the graph first, then the ledger. Merge deterministically by id and
    // apply the limit once so neither source can crowd out the other.
    const graphItems = searchCatalog(state, q, context.generatedAt, maxLimit);
    const ledgerItems = await searchLedgerCatalog(repositories.evidence, q);
    const byId = new Map<string, CatalogItemView>();
    for (const item of [...graphItems, ...ledgerItems]) {
      if (!byId.has(item.id)) byId.set(item.id, item);
    }
    const items = [...byId.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, limit);
    if (!items.length && (state.assets?.length || ledgerItems.length)) {
      warnings.push(`No catalog items matched q=${q}.`);
    }
    if (ledgerItems.length) warnings.push(ledgerIdentityWarning);
    res.status(200).json(envelope(items, context, {
      source: ledgerItems.length ? 'graphEngine.getState() + ingest-ledger' : 'graphEngine.getState()',
      basis: UNKNOWN,
      currency: UNKNOWN,
      warnings,
    }));
  }));

  // GET /api/catalog/:id -----------------------------------------------------
  router.get('/api/catalog/:id', route(async (req, res, context) => {
    const identity = await resolveCatalogIdentity(
      req.params.id,
      engine.getState(),
      repositories.evidence,
      context.generatedAt,
    );
    if (!identity) return notFound(res, context, 'Catalog item', catalogWarnings);
    res.status(200).json(envelope(identity, context, {
      source: identity.source,
      basis: identity.basis,
      currency: identity.currency,
      provenance: identity.provenance,
      warnings: identityWarnings(identity),
    }));
  }));

  // GET /api/catalog/:id/printings ------------------------------------------
  router.get('/api/catalog/:id/printings', route((req, res, context) => {
    const state = engine.getState();
    const printings = listPrintings(state, req.params.id, context.generatedAt);
    if (!printings) return notFound(res, context, 'Catalog item', catalogWarnings);
    const warnings = [
      'Printings are derived from graph grade/population facets; language is not present and stays UNKNOWN.',
      'A zero grading population is treated as UNKNOWN, never as a measured zero.',
    ];
    res.status(200).json(envelope(printings, context, {
      source: 'graphEngine.getState():assets[].grades',
      basis: 'POPULATION',
      currency: UNKNOWN,
      warnings,
    }));
  }));

  // GET /api/pricing/:id ----------------------------------------------------
  router.get('/api/pricing/:id', route(async (req, res, context) => {
    const basis = parseBasis(req.query.basis);
    const source = stringQuery(req.query.source);
    const identity = await resolveCatalogIdentity(
      req.params.id,
      engine.getState(),
      repositories.evidence,
      context.generatedAt,
    );
    if (!identity) return notFound(res, context, 'Catalog item');
    const { facts, warnings } = await loadFacts(
      repositories.marketObservations,
      repositories.evidence,
      req.params.id,
    );
    const built = buildPriceSummary(req.params.id, facts, {
      basis,
      ...(source !== undefined && source.trim() !== '' ? { source } : {}),
      generatedAt: context.generatedAt,
    });
    res.status(200).json(envelope(built.value, context, {
      source: built.value.source,
      basis,
      currency: built.value.currency,
      provenance: built.value.provenance,
      warnings: [
        ...(identity.identityConfidence === 'LOW' ? [ledgerIdentityWarning] : []),
        ...warnings,
        ...built.warnings,
      ],
    }));
  }));

  // GET /api/comps/:id ------------------------------------------------------
  router.get('/api/comps/:id', route(async (req, res, context) => {
    const source = stringQuery(req.query.source);
    const identity = await resolveCatalogIdentity(
      req.params.id,
      engine.getState(),
      repositories.evidence,
      context.generatedAt,
    );
    if (!identity) return notFound(res, context, 'Catalog item');
    const { facts, warnings } = await loadFacts(
      repositories.marketObservations,
      repositories.evidence,
      req.params.id,
    );
    const built = buildComps(req.params.id, facts, {
      ...(source !== undefined && source.trim() !== '' ? { source } : {}),
      generatedAt: context.generatedAt,
    });
    res.status(200).json(envelope(built.value, context, {
      source: built.value.length ? built.value[0].source : 'ingest-ledger',
      basis: 'SOLD',
      currency: built.value.length ? built.value[0].currency : UNKNOWN,
      warnings: [
        ...(identity.identityConfidence === 'LOW' ? [ledgerIdentityWarning] : []),
        ...warnings,
        ...built.warnings,
      ],
    }));
  }));

  // GET /api/market/:id -----------------------------------------------------
  router.get('/api/market/:id', route(async (req, res, context) => {
    const identity = await resolveCatalogIdentity(
      req.params.id,
      engine.getState(),
      repositories.evidence,
      context.generatedAt,
    );
    if (!identity) return notFound(res, context, 'Catalog item');
    const { facts, warnings } = await loadFacts(
      repositories.marketObservations,
      repositories.evidence,
      req.params.id,
    );
    const built = buildMarketSnapshot(req.params.id, facts, { now: now() });
    res.status(200).json(envelope(built.value, context, {
      source: built.value.source,
      basis: UNKNOWN,
      currency: built.value.currency,
      provenance: built.value.provenance,
      warnings: [
        ...(identity.identityConfidence === 'LOW' ? [ledgerIdentityWarning] : []),
        ...warnings,
        ...built.warnings,
        'Snapshot counts are basis-separated under data.sources[].basisBreakdown; sources are never summed.',
      ],
    }));
  }));

  router.use((error: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    if (res.headersSent) return;
    const context: RequestContext = res.locals.servingContext ?? newContext(now);
    if (error instanceof ServingValidationError) {
      res.status(400).json(errorEnvelope(error.message, 'validation_error', context));
      return;
    }
    if (error instanceof ServingNotFoundError) {
      res.status(404).json(errorEnvelope(error.message, 'not_found', context));
      return;
    }
    res.status(500).json(errorEnvelope(
      error instanceof Error ? error.message : String(error),
      'internal_error',
      context,
    ));
  });

  return router;
}

/** Mount the serving API on an existing Express app or router (no listener). */
export function mountServingRoutes(app: Express | Router, options: ServingRouteOptions = {}): Router {
  const router = createServingRouter(options);
  app.use(router);
  return router;
}

export default mountServingRoutes;
