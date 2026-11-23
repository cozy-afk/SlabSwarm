/**
 * Task 17 HTTP surface. Router + mount only: no listener, no firewall/DNS
 * change and no canonical write. The integrator mounts it behind the existing
 * operator/shared auth gate. Every response uses the { data, meta } envelope,
 * every value carries basis and source, and every warning is visible.
 */

import { Router, type Express, type Request, type Response, type NextFunction } from 'express';
import type { AssetNode } from '../../src/types/graph.ts';
import type { EvidenceRecord, MarketObservation } from '../contracts/dataProduct.ts';
import {
  UNKNOWN,
  envelope,
  errorEnvelope,
  newContext,
  toCatalogItem,
  type MarketBasis,
  type RequestContext,
} from '../serving/catalog.ts';
import { loadFacts } from '../serving/market.ts';
import { computeFmv, fromObservationFact, type FmvResult } from '../valuation/fmv.ts';
import {
  buildPortfolio,
  buildWatchView,
  estimateFees,
  estimateTax,
  evaluateAlerts,
  type EstimateArtifact,
  type FeeEstimateInput,
  type IdentityView,
  type MetricSnapshot,
  type TaxEstimateInput,
} from './tracking.ts';
import {
  TrackingValidationError,
  createTrackingStore,
  type AlertRuleInput,
  type HoldingInput,
  type SaleInput,
  type TrackingStore,
  type WatchInput,
} from './trackingStore.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

export const TRACKING_WARNINGS = [
  'No external delivery, billing or notification provider is used; alerts are stored rules plus in-app state.',
  'All values carry explicit basis and source; missing fees, shipping and dates stay UNKNOWN, never zero.',
  'FMV is derived from first-party SOLD evidence only; fee and tax outputs are labelled ESTIMATE with visible assumptions.',
  'No model writes canonical facts; these routes perform no canonical write.',
] as const;

export interface TrackingLedger {
  evidence: { get(id: string): Promise<EvidenceRecord | null> };
  marketObservations: { list(): Promise<MarketObservation[]> };
}

export interface TrackingEngine {
  getState(): { assets?: AssetNode[] };
}

export interface TrackingRouteOptions {
  store?: TrackingStore;
  ledger?: TrackingLedger;
  engine?: TrackingEngine;
  now?: () => Date;
  halfLifeDays?: number;
}

interface MetaExtras {
  basis?: string;
  source?: string;
  currency?: string;
  warnings?: string[];
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function bodyObject(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : {};
}

/** Build isolated routes. The caller owns the prefix and the auth gate. */
export function createTrackingRouter(options: TrackingRouteOptions = {}): Router {
  const router = Router();
  const store = options.store ?? createTrackingStore();
  const ledger = options.ledger;
  const engine = options.engine;
  const now = options.now ?? (() => new Date());
  const halfLifeDays = options.halfLifeDays;

  function route(
    handler: (req: Request, res: Response, context: RequestContext) => Promise<void> | void,
  ) {
    return (req: Request, res: Response, next: NextFunction): void => {
      const context = newContext(now);
      Promise.resolve()
        .then(() => handler(req, res, context))
        .catch((error: unknown) => {
          if (error instanceof TrackingValidationError) {
            respondError(res, 400, context, error.message, 'validation_error');
            return;
          }
          respondError(
            res,
            500,
            context,
            error instanceof Error ? error.message : 'Tracking request failed.',
            'internal_error',
          );
        });
    };
  }

  function respond(
    res: Response,
    status: number,
    context: RequestContext,
    data: unknown,
    extras: MetaExtras = {},
  ): void {
    res.status(status).json(envelope(data, context, {
      basis: (extras.basis ?? UNKNOWN) as MarketBasis,
      source: extras.source ?? UNKNOWN,
      currency: extras.currency ?? UNKNOWN,
      warnings: dedupe([...TRACKING_WARNINGS, ...(extras.warnings ?? [])]),
    }));
  }

  function respondError(
    res: Response,
    status: number,
    context: RequestContext,
    error: string,
    code: string,
  ): void {
    res.status(status).json(errorEnvelope(error, code, context, {
      basis: UNKNOWN as MarketBasis,
      source: UNKNOWN,
      currency: UNKNOWN,
      warnings: [...TRACKING_WARNINGS],
    }));
  }

  function gradeFilter(grade: string | unknown): string | undefined {
    return typeof grade === 'string' && grade.trim() !== '' && grade !== UNKNOWN
      ? grade.trim()
      : undefined;
  }

  /**
   * Per-request memoized FMV lookup. Facts are read from the first-party
   * ledger; the clock and optional grade are injected. A grade on a holding
   * or rule is an exact filter: without matching SOLD comps the mark stays
   * UNKNOWN rather than silently using all grades. No value is synthesized.
   */
  function makeValuationLookup() {
    const cache = new Map<string, Promise<{
      fmv: FmvResult;
      priorFmv: FmvResult;
      warnings: string[];
    }>>();
    return (targetId: string, requestedGrade?: string | unknown) => {
      const grade = gradeFilter(requestedGrade);
      const key = `${targetId}::${grade ?? ''}`;
      let entry = cache.get(key);
      if (!entry) {
        entry = (async () => {
          const gradeOptions = { ...(grade ? { grade } : {}) };
          if (!ledger) {
            return {
              fmv: computeFmv(targetId, [], { now: now(), ...gradeOptions, ...(halfLifeDays ? { halfLifeDays } : {}) }),
              priorFmv: computeFmv(targetId, [], { now: now(), ...gradeOptions, ...(halfLifeDays ? { halfLifeDays } : {}) }),
              warnings: ['No ledger was injected; all valuations stay UNKNOWN.'],
            };
          }
          const { facts, warnings } = await loadFacts(
            ledger.marketObservations,
            ledger.evidence,
            targetId,
          );
          const gradeById = new Map<string, string | undefined>();
          for (const row of await ledger.marketObservations.list()) {
            const components = row.priceComponents as Record<string, unknown> | null | undefined;
            const raw = components?.grade ?? components?.gradedGrade ?? components?.gradeLabel;
            if (typeof raw === 'string' && raw.trim() !== '') gradeById.set(row.id, raw.trim());
          }
          // Only a grade explicitly recorded on the source observation may tag
          // a comp; the requested filter is never copied onto every row.
          const evidence = facts.map((fact) =>
            fromObservationFact(fact, gradeById.get(fact.id) ?? null),
          );
          const options = { ...gradeOptions, ...(halfLifeDays ? { halfLifeDays } : {}) };
          const fmv = computeFmv(targetId, evidence, { ...options, now: now() });
          const priorFmv = computeFmv(targetId, evidence, {
            ...options,
            now: new Date(now().getTime() - 30 * DAY_MS),
          });
          const gradeWarnings = grade
            ? [`FMV is filtered to grade ${grade}; comps with another or UNKNOWN grade are excluded, never relabelled.`]
            : [];
          const gradedFmv: FmvResult = gradeWarnings.length
            ? { ...fmv, warnings: [...fmv.warnings, ...gradeWarnings] }
            : fmv;
          return {
            fmv: gradedFmv,
            priorFmv,
            warnings: dedupe([...warnings, ...gradeWarnings, ...fmv.warnings]),
          };
        })();
        cache.set(key, entry);
      }
      return entry;
    };
  }

  function identityFor(targetId: string, generatedAt: string): IdentityView | null {
    const asset = engine?.getState().assets?.find((item) => item.id === targetId);
    if (!asset) return null;
    const item = toCatalogItem(asset, generatedAt);
    return {
      id: item.id,
      name: item.name,
      game: item.game,
      set: item.set,
      number: item.number,
      identityConfidence: item.identityConfidence,
      facets: {
        game: item.game,
        set: item.set,
        number: item.number,
        segment: item.segment,
        variant: item.variant,
      },
    };
  }

  // GET /api/tracking/summary ------------------------------------------------
  router.get('/api/tracking/summary', route(async (_req, res, context) => {
    const valuationFor = makeValuationLookup();
    const warnings: string[] = [];

    const watchlist = await Promise.all(store.listWatchlist().map(async (item) => {
      const { fmv, warnings: rowWarnings } = await valuationFor(item.targetId, item.grade);
      warnings.push(...rowWarnings);
      return buildWatchView(item, fmv, identityFor(item.targetId, context.generatedAt));
    }));

    const holdings = store.listHoldings();
    const sales = store.listSales();
    const valuations: Record<string, FmvResult> = {};
    const valuationByHolding: Record<string, FmvResult> = {};
    for (const holding of holdings) {
      const fmv = (await valuationFor(holding.assetId, holding.grade)).fmv;
      valuations[holding.assetId] = fmv;
      valuationByHolding[holding.id] = fmv;
    }
    const portfolio = buildPortfolio(holdings, sales, valuations, valuationByHolding);
    warnings.push(...portfolio.warnings);

    const rules = store.listRules();
    const snapshots: MetricSnapshot[] = await Promise.all(rules.map(async (rule) => {
      const { fmv, priorFmv } = await valuationFor(rule.targetId, rule.grade);
      return {
        targetId: rule.targetId,
        basis: fmv.basis,
        source: fmv.source,
        value: fmv.value,
        sampleSize: fmv.sampleSize,
        previousValue: priorFmv.value,
        previousAsOf: priorFmv.generatedAt,
        observedAt: fmv.generatedAt,
      };
    }));
    const evaluation = evaluateAlerts(rules, snapshots, { now: now() });
    warnings.push(...evaluation.warnings);
    const alerts = store.replaceAlertStates(evaluation.states);

    respond(res, 200, context, {
      watchlist,
      holdings,
      sales,
      ...portfolio,
      rules,
      alerts,
      warnings: dedupe(warnings),
    }, { basis: 'SOLD_DERIVED', warnings: dedupe(warnings) });
  }));

  // GET/POST/DELETE /api/tracking/watchlist ---------------------------------
  router.get('/api/tracking/watchlist', route(async (_req, res, context) => {
    const valuationFor = makeValuationLookup();
    const warnings: string[] = [];
    const items = await Promise.all(store.listWatchlist().map(async (item) => {
      const { fmv, warnings: rowWarnings } = await valuationFor(item.targetId, item.grade);
      warnings.push(...rowWarnings);
      return buildWatchView(item, fmv, identityFor(item.targetId, context.generatedAt));
    }));
    respond(res, 200, context, { items }, {
      basis: 'SOLD_DERIVED',
      warnings: dedupe(warnings),
    });
  }));

  router.post('/api/tracking/watchlist', route((req, res, context) => {
    const created = store.addWatchlist(bodyObject(req.body) as unknown as WatchInput);
    respond(res, 201, context, created, { basis: UNKNOWN });
  }));

  router.delete('/api/tracking/watchlist/:id', route((req, res, context) => {
    const deleted = store.removeWatchlist(req.params.id);
    if (!deleted) {
      respondError(res, 404, context, 'Watchlist item not found.', 'not_found');
      return;
    }
    respond(res, 200, context, { deleted: true });
  }));

  // GET/POST/DELETE /api/tracking/holdings ----------------------------------
  router.get('/api/tracking/holdings', route((_req, res, context) => {
    respond(res, 200, context, { holdings: store.listHoldings() });
  }));

  router.post('/api/tracking/holdings', route((req, res, context) => {
    const created = store.addHolding(bodyObject(req.body) as unknown as HoldingInput);
    respond(res, 201, context, created);
  }));

  router.delete('/api/tracking/holdings/:id', route((req, res, context) => {
    const deleted = store.removeHolding(req.params.id);
    if (!deleted) {
      respondError(res, 404, context, 'Holding not found.', 'not_found');
      return;
    }
    respond(res, 200, context, { deleted: true });
  }));

  // GET/POST/DELETE /api/tracking/sales -------------------------------------
  router.get('/api/tracking/sales', route((_req, res, context) => {
    respond(res, 200, context, { sales: store.listSales() });
  }));

  router.post('/api/tracking/sales', route((req, res, context) => {
    const created = store.addSale(bodyObject(req.body) as unknown as SaleInput);
    respond(res, 201, context, created);
  }));

  router.delete('/api/tracking/sales/:id', route((req, res, context) => {
    const deleted = store.removeSale(req.params.id);
    if (!deleted) {
      respondError(res, 404, context, 'Sale not found.', 'not_found');
      return;
    }
    respond(res, 200, context, { deleted: true });
  }));

  // GET /api/tracking/valuation/:targetId -----------------------------------
  router.get('/api/tracking/valuation/:targetId', route(async (req, res, context) => {
    const valuationFor = makeValuationLookup();
    const requestedGrade = typeof req.query.grade === 'string' ? req.query.grade : undefined;
    const { fmv, warnings } = await valuationFor(req.params.targetId, requestedGrade);
    const view = buildWatchView(
      { id: 'ephemeral', targetId: req.params.targetId, grade: UNKNOWN, addedAt: context.generatedAt },
      fmv,
      identityFor(req.params.targetId, context.generatedAt),
    );
    respond(res, 200, context, view.valuation, {
      basis: fmv.basis,
      source: fmv.source,
      currency: fmv.currency,
      warnings: dedupe([...warnings, ...view.valuation.warnings]),
    });
  }));

  // Alert rules and in-app state ---------------------------------------------
  router.get('/api/tracking/alerts/rules', route((_req, res, context) => {
    respond(res, 200, context, { rules: store.listRules() });
  }));

  router.post('/api/tracking/alerts/rules', route((req, res, context) => {
    const created = store.addRule(bodyObject(req.body) as unknown as AlertRuleInput);
    respond(res, 201, context, created, { basis: created.basis });
  }));

  router.patch('/api/tracking/alerts/rules/:id', route((req, res, context) => {
    const updated = store.toggleRule(req.params.id);
    if (!updated) {
      respondError(res, 404, context, 'Alert rule not found.', 'not_found');
      return;
    }
    respond(res, 200, context, { rule: updated }, { basis: updated.basis });
  }));

  router.delete('/api/tracking/alerts/rules/:id', route((req, res, context) => {
    const deleted = store.removeRule(req.params.id);
    if (!deleted) {
      respondError(res, 404, context, 'Alert rule not found.', 'not_found');
      return;
    }
    respond(res, 200, context, { deleted: true });
  }));

  router.get('/api/tracking/alerts', route((_req, res, context) => {
    respond(res, 200, context, { states: store.listAlertStates() });
  }));

  router.post('/api/tracking/alerts/evaluate', route(async (_req, res, context) => {
    const valuationFor = makeValuationLookup();
    const rules = store.listRules();
    const snapshots: MetricSnapshot[] = await Promise.all(rules.map(async (rule) => {
      const { fmv, priorFmv } = await valuationFor(rule.targetId, rule.grade);
      return {
        targetId: rule.targetId,
        basis: fmv.basis,
        source: fmv.source,
        value: fmv.value,
        sampleSize: fmv.sampleSize,
        previousValue: priorFmv.value,
        previousAsOf: priorFmv.generatedAt,
        observedAt: fmv.generatedAt,
      };
    }));
    const evaluation = evaluateAlerts(rules, snapshots, { now: now() });
    const states = store.replaceAlertStates(evaluation.states);
    respond(res, 200, context, { states, warnings: evaluation.warnings }, {
      basis: 'SOLD_DERIVED',
      warnings: evaluation.warnings,
    });
  }));

  router.post('/api/tracking/alerts/:id/ack', route((req, res, context) => {
    const state = store.acknowledgeAlert(req.params.id);
    if (!state) {
      respondError(res, 404, context, 'Alert state not found.', 'not_found');
      return;
    }
    respond(res, 200, context, state, {
      basis: state.basis,
      source: state.source,
      warnings: [state.detail],
    });
  }));

  // Estimate endpoints -------------------------------------------------------
  router.post('/api/tracking/fees/estimate', route((req, res, context) => {
    const result = estimateFees(bodyObject(req.body) as unknown as FeeEstimateInput);
    respondEstimate(res, context, result, 'ASSUMED_FEE_SCHEDULE');
  }));

  router.post('/api/tracking/tax/estimate', route((req, res, context) => {
    const result = estimateTax(bodyObject(req.body) as unknown as TaxEstimateInput);
    respondEstimate(res, context, result, 'ASSUMED_TAX_RATE');
  }));

  function respondEstimate(res: Response, context: RequestContext, result: EstimateArtifact, basis: string): void {
    respond(res, 200, context, result, {
      basis,
      source: result.source,
      currency: result.currency,
      warnings: [...result.warnings, ...result.assumptions],
    });
  }

  return router;
}

/** Integrator entry point: register the router on an existing Express app. */
export function mountTrackingRouter(app: Express, options: TrackingRouteOptions = {}): Router {
  const router = createTrackingRouter(options);
  app.use(router);
  return router;
}

export default createTrackingRouter;
