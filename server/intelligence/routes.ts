/**
 * Compatibility entry point for the intelligence HTTP surface.
 *
 * The canonical Phase 4 router lives in ../routes/intelligence.ts. This module
 * wraps that factory with the two insight-report routes so an integrator can
 * mount one router and get the whole intelligence surface. It registers no
 * listener of its own: every path below is a full `/api/...` path, as in the
 * canonical router.
 */

import express from 'express';
import type { Express, Request, RequestHandler, Response, Router } from 'express';
import {
  createIntelligenceRouter as createBaseIntelligenceRouter,
  mountIntelligenceRoutes as mountBaseIntelligenceRoutes,
} from '../routes/intelligence.ts';
import type { ActiveReport } from '../contracts/activeReport.ts';
import { buildActiveReport, getActiveReportRepositories } from './active-report.ts';
import { forecastFromReport } from './report-forecast.ts';

export { createBaseIntelligenceRouter, mountBaseIntelligenceRoutes };
export { default as baseIntelligenceRouterFactory } from '../routes/intelligence.ts';

const BAD_REQUEST_CODES = new Set<string>([
  'REPORT_REQUIRED',
  'INVALID_REPORT',
  'FORECAST_INPUT_REQUIRED',
  'INVALID_HORIZON',
  'PRICE_BANDS_REQUIRED',
  'INVALID_PRICE_BAND',
  'PRICE_BANDS_OUT_OF_ORDER',
  'CURRENCY_REQUIRED',
  'EVIDENCE_IDS_REQUIRED',
  'DRIVERS_REQUIRED',
  'INVALIDATORS_REQUIRED',
  'INVALID_CONFIDENCE',
]);

function sendError(res: Response, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const status = error instanceof Error && BAD_REQUEST_CODES.has(error.message) ? 400 : 500;
  res.status(status).json({
    ok: false,
    error: status === 400 ? message : 'INTERNAL_ERROR',
    ...(status === 500 ? { detail: message } : {}),
  });
}

function bodyObject(req: Request): Record<string, unknown> {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? req.body as Record<string, unknown>
    : {};
}

/**
 * Build the full intelligence router. Optional middleware (typically auth) is
 * forwarded to the canonical factory and therefore guards these routes too.
 */
export function createIntelligenceRouter(...middleware: RequestHandler[]): Router {
  const router = createBaseIntelligenceRouter(...middleware);

  // GET the composed, source-cited "what is actively trading" report.
  router.get('/api/intelligence/active-report', async (_req, res) => {
    try {
      res.json(await buildActiveReport({ repositories: getActiveReportRepositories() }));
    } catch (error) {
      sendError(res, error);
    }
  });

  // POST a report to derive deterministic, evidence-cited forecast drafts.
  router.post('/api/intelligence/forecast-from-report', (req, res) => {
    try {
      const body = bodyObject(req);
      if (!body.report || typeof body.report !== 'object' || Array.isArray(body.report)) {
        res.status(400).json({ ok: false, error: 'REPORT_REQUIRED' });
        return;
      }
      const report = body.report as ActiveReport;
      if (!Array.isArray(report.cards) || !report.summary || typeof report.generatedAt !== 'string') {
        res.status(400).json({ ok: false, error: 'INVALID_REPORT' });
        return;
      }
      res.json(forecastFromReport(report));
    } catch (error) {
      sendError(res, error);
    }
  });

  return router;
}

/** Convenience for integrators that mount onto an Express app directly. */
export function mountIntelligenceRoutes(app: Express, ...middleware: RequestHandler[]): Router {
  const router = createIntelligenceRouter(...middleware);
  app.use(router);
  return router;
}

export default createIntelligenceRouter;
