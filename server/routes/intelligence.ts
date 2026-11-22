/**
 * Phase 4 — INTELLIGENCE lane: HTTP surface.
 *
 * Express router module only: it exports a factory and a mount function and
 * never registers a listener or edits server.ts. The integrator owns mounting
 * (and should apply operatorAuth.requireAuth to the mutating routes).
 *
 * All work is delegated to deterministic lane code; the router validates
 * untrusted JSON and translates thrown domain errors into HTTP statuses.
 */

import express from 'express';
import type { Express, Request, RequestHandler, Response, Router } from 'express';

import {
  buildEvidencePacket,
  type EvidenceItem,
  invokeTool,
  isRegisteredTool,
  REGISTERED_TOOLS,
} from '../swarm/tools.ts';
import { ROLES } from '../swarm/roles.ts';
import { runSwarmResearch, swarmRunStore } from '../swarm/run.ts';
import { runSimulation, simulationToForecastProposal, type ScenarioSpec } from '../simulation/engine.ts';
import { createForecast, forecastRepository } from '../forecast/repository.ts';
import {
  forecastScoreRepository,
  scoreAndRecord,
} from '../forecast/scoring.ts';
import { backtestRepository, runBacktest } from '../forecast/backtest.ts';
import {
  addLearningFeedback,
  getLearningState,
  learningEventRepository,
  runLearningCycle,
} from '../forecast/learning.ts';

const BAD_REQUEST_CODES = new Set<string>([
  'FORECAST_INPUT_REQUIRED',
  'FORECASTS_START_AS_HYPOTHESIS',
  'INVALID_HORIZON',
  'PRICE_BANDS_REQUIRED',
  'INVALID_PRICE_BAND',
  'PRICE_BANDS_OUT_OF_ORDER',
  'CURRENCY_REQUIRED',
  'EVIDENCE_IDS_REQUIRED',
  'EVIDENCE_REQUIRED',
  'EVENT_EVIDENCE_REQUIRED',
  'DRIVERS_REQUIRED',
  'INVALIDATORS_REQUIRED',
  'INVALID_CONFIDENCE',
  'INVALID_DEMAND_PRESSURE',
  'INVALID_SUPPLY_PRESSURE',
  'INVALID_TARGET_TYPE',
  'TARGET_ID_REQUIRED',
  'INVALID_BASELINE',
  'UNKNOWN_PERSONA',
  'OUTCOME_EVIDENCE_REQUIRED',
  'INVALID_OUTCOME',
  'FEEDBACK_EVIDENCE_REQUIRED',
  'EVIDENCE_ID_NOT_IN_PACKET',
  'TOOL_NOT_REGISTERED',
  'RoleEvidenceError',
  'ForecastValidationError',
]);

function sendError(res: Response, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const status = error instanceof Error && BAD_REQUEST_CODES.has(error.message)
    ? 400
    : 500;
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
 * Build the intelligence router. Optional middleware (typically auth) is
 * applied to every route in registration order.
 */
export function createIntelligenceRouter(...middleware: RequestHandler[]): Router {
  const router = express.Router();
  // This router is mounted at the app root and owns full `/api` paths. A bare
  // router.use(auth) would therefore guard every later route, including
  // /api/auth/login. Scope the middleware to this router's own path family.
  const OWNED_PREFIXES = [
    '/api/intelligence',
    '/api/swarm',
    '/api/simulations',
    '/api/forecasts',
    '/api/learning',
  ];
  if (middleware.length > 0) {
    router.use((req, res, next) => {
      const owned = OWNED_PREFIXES.some(
        (prefix) => req.path === prefix || req.path.startsWith(`${prefix}/`),
      );
      if (!owned) return next();
      let index = 0;
      const runNext = (): void => {
        if (index >= middleware.length) return next();
        middleware[index++](req, res, runNext);
      };
      runNext();
    });
  }

  // --- Tool registry introspection (read-only) ---
  router.get('/api/intelligence/tools', (_req, res) => {
    res.json({ tools: [...REGISTERED_TOOLS], roles: [...ROLES] });
  });

  // --- Swarm v2 ---
  router.post('/api/swarm/research/run', (req, res) => {
    try {
      const body = bodyObject(req);
      if (!Array.isArray(body.evidence) || body.evidence.length === 0) {
        res.status(400).json({ ok: false, error: 'EVIDENCE_REQUIRED' });
        return;
      }
      if (typeof body.targetId !== 'string' || body.targetId.length === 0) {
        res.status(400).json({ ok: false, error: 'TARGET_ID_REQUIRED' });
        return;
      }
      const run = runSwarmResearch({
        targetId: body.targetId,
        evidence: body.evidence as EvidenceItem[],
        ...(typeof body.maxItems === 'number' ? { maxItems: body.maxItems } : {}),
        ...(typeof body.maxCharsPerItem === 'number' ? { maxCharsPerItem: body.maxCharsPerItem } : {}),
        ...(typeof body.asOf === 'string' ? { asOf: body.asOf } : {}),
      });
      res.status(201).json(run);
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/api/swarm/runs/:id', (req, res) => {
    const run = swarmRunStore.get(req.params.id);
    if (!run) {
      res.status(404).json({ ok: false, error: 'SWARM_RUN_NOT_FOUND' });
      return;
    }
    res.json(run);
  });

  // --- Bounded tool invocation (read-only over a supplied packet) ---
  router.post('/api/intelligence/tools/invoke', (req, res) => {
    try {
      const body = bodyObject(req);
      if (typeof body.tool !== 'string' || !isRegisteredTool(body.tool)) {
        res.status(400).json({ ok: false, error: 'TOOL_NOT_REGISTERED' });
        return;
      }
      if (!Array.isArray(body.evidence) || body.evidence.length === 0) {
        res.status(400).json({ ok: false, error: 'EVIDENCE_REQUIRED' });
        return;
      }
      const packet = buildEvidencePacket({
        items: body.evidence as EvidenceItem[],
        ...(typeof body.maxItems === 'number' ? { maxItems: body.maxItems } : {}),
        ...(typeof body.maxCharsPerItem === 'number' ? { maxCharsPerItem: body.maxCharsPerItem } : {}),
      });
      const result = invokeTool(
        { tool: body.tool, args: bodyObject(req).args as Record<string, unknown> },
        { packet },
      );
      res.json({ result, packetDigest: packet.digest, packetEvidenceIds: packet.evidenceIds });
    } catch (error) {
      sendError(res, error);
    }
  });

  // --- Simulation (always a HYPOTHESIS, never sales evidence) ---
  router.post('/api/simulations/run', (req, res) => {
    try {
      const spec = bodyObject(req) as unknown as ScenarioSpec;
      const sim = runSimulation(spec);
      res.status(201).json({ ...sim, forecastProposal: simulationToForecastProposal(sim) });
    } catch (error) {
      sendError(res, error);
    }
  });

  // --- Forecasts and scoring ---
  router.post('/api/forecasts', (req, res) => {
    try {
      res.status(201).json(createForecast(req.body));
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/api/forecasts/:id', (req, res) => {
    const forecast = forecastRepository.get(req.params.id);
    if (!forecast) {
      res.status(404).json({ ok: false, error: 'FORECAST_NOT_FOUND' });
      return;
    }
    res.json({ ...forecast, scores: forecastScoreRepository.forForecast(forecast.id) });
  });

  router.post('/api/forecasts/:id/score', (req, res) => {
    try {
      const body = bodyObject(req);
      res.status(201).json(scoreAndRecord(req.params.id, {
        realizedPrice: body.realizedPrice as number,
        observedAt: typeof body.observedAt === 'string' ? body.observedAt : new Date().toISOString(),
        evidenceIds: body.evidenceIds as string[],
      }));
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/api/forecasts/:id/backtest', (req, res) => {
    try {
      const body = bodyObject(req);
      res.status(201).json(runBacktest({
        forecastId: req.params.id,
        events: (body.events ?? []) as never,
        evidence: (body.evidence ?? []) as never,
        ...(typeof body.asOf === 'string' ? { asOf: body.asOf } : {}),
      }));
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get('/api/forecasts/:id/backtests', (req, res) => {
    res.json(backtestRepository.forForecast(req.params.id));
  });

  // --- Learning (promotion gated by benchmark non-regression) ---
  router.get('/api/learning/state', (_req, res) => {
    res.json(getLearningState());
  });

  router.get('/api/learning/events', (_req, res) => {
    res.json(learningEventRepository.all());
  });

  router.post('/api/learning/feedback', (req, res) => {
    try {
      const body = bodyObject(req);
      res.status(201).json(addLearningFeedback({
        signal: body.signal as string,
        ...(typeof body.scoreId === 'string' ? { scoreId: body.scoreId } : {}),
        evidenceIds: body.evidenceIds as string[],
        ...(typeof body.createdAt === 'string' ? { createdAt: body.createdAt } : {}),
      }));
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/api/learning/run-cycle', (req, res) => {
    try {
      const body = bodyObject(req);
      res.json(runLearningCycle({
        ...(body.benchmark ? { benchmark: body.benchmark as never } : {}),
        ...(typeof body.asOf === 'string' ? { asOf: body.asOf } : {}),
      }));
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
