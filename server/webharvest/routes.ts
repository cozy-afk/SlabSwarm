/**
 * Operator review HTTP surface for harvested web candidates.
 *
 * Exposes a router plus a mount function only — no listener, no firewall or
 * DNS changes. The integrator adds one line to server.ts:
 *   mountWebHarvestRouter(app, { store });
 * Every response is a { data, meta } envelope (errors add error/code), and
 * canonical writes happen exclusively inside the store's approval path.
 */

import { Router, type Express, type NextFunction, type Request, type Response } from 'express';
import type { MarketBasis } from '../contracts/dataProduct.ts';
import type {
  ReviewStatus,
  WebHarvestCandidate,
  WebSourceConfig,
} from '../contracts/webHarvest.ts';
import { UNKNOWN, envelope, errorEnvelope, newContext, type RequestContext } from '../serving/catalog.ts';
import {
  ReviewError,
  createWebHarvestStore,
  type ReviewAction,
  type WebHarvestStore,
} from './store.ts';

export interface WebHarvestRouteOptions {
  /** Inject an isolated queue/repository bundle; defaults to durable repos. */
  store?: WebHarvestStore;
  /** Deterministic clock for per-request meta timestamps. */
  now?: () => Date;
}

const WARNINGS = [
  'Harvested candidates are proposals; only operator approval writes canonical facts.',
  'Basis is explicit: SOLD / ASKING / OFFER / GUIDE / CLAIM / POPULATION / UNKNOWN.',
  'Missing values stay UNKNOWN, never zero. Raw evidence is immutable; corrections append.',
  'Web candidates are LOW confidence; no model writes canonical data.',
];

const BASES: ReadonlySet<string> = new Set([
  'SOLD', 'ASKING', 'OFFER', 'GUIDE', 'CLAIM', 'POPULATION', 'UNKNOWN',
]);
const CONFIDENCES: ReadonlySet<string> = new Set(['HIGH', 'MEDIUM', 'LOW', 'UNKNOWN']);
const STATUSES: ReadonlySet<string> = new Set(['PENDING', 'APPROVED', 'REJECTED']);

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringField(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ReviewError(`${label} is required and must be a non-empty string.`, 'validation_error');
  }
  return value;
}

function parseCandidate(value: unknown): WebHarvestCandidate {
  if (!isObject(value)) {
    throw new ReviewError('Each candidate must be an object.', 'validation_error');
  }
  const basis = stringField(value.basis, 'basis');
  if (!BASES.has(basis)) {
    throw new ReviewError('basis must be an explicit market basis.', 'validation_error');
  }
  const confidence = stringField(value.confidence, 'confidence');
  if (!CONFIDENCES.has(confidence)) {
    throw new ReviewError('confidence must be HIGH, MEDIUM, LOW or UNKNOWN.', 'validation_error');
  }
  if (!Array.isArray(value.warnings) || value.warnings.some((item) => typeof item !== 'string')) {
    throw new ReviewError('warnings must be an array of strings.', 'validation_error');
  }
  if (typeof value.amount !== 'number' && value.amount !== 'UNKNOWN') {
    throw new ReviewError("amount must be a number or the literal 'UNKNOWN'.", 'validation_error');
  }
  if (typeof value.amount === 'number' && !Number.isFinite(value.amount)) {
    throw new ReviewError('amount must be finite.', 'validation_error');
  }
  return {
    id: stringField(value.id, 'id'),
    sourceId: stringField(value.sourceId, 'sourceId'),
    evidenceId: stringField(value.evidenceId, 'evidenceId'),
    name: stringField(value.name, 'name'),
    set: stringField(value.set, 'set'),
    game: stringField(value.game, 'game'),
    number: stringField(value.number, 'number'),
    basis: basis as WebHarvestCandidate['basis'],
    amount: value.amount as WebHarvestCandidate['amount'],
    currency: stringField(value.currency, 'currency'),
    observedAt: stringField(value.observedAt, 'observedAt'),
    capturedAt: stringField(value.capturedAt, 'capturedAt'),
    license: stringField(value.license, 'license'),
    confidence: confidence as WebHarvestCandidate['confidence'],
    warnings: [...(value.warnings as string[])],
  };
}

function parseCandidates(body: unknown): WebHarvestCandidate[] {
  if (Array.isArray(body)) return body.map(parseCandidate);
  if (!isObject(body)) {
    throw new ReviewError('A candidate or candidates array is required.', 'validation_error');
  }
  if (Array.isArray(body.candidates)) return body.candidates.map(parseCandidate);
  if (body.candidate !== undefined) return [parseCandidate(body.candidate)];
  if ('evidenceId' in body && 'sourceId' in body) return [parseCandidate(body)];
  throw new ReviewError('A candidate or candidates array is required.', 'validation_error');
}

function respond(res: Response, status: number, context: RequestContext, data: unknown): void {
  res.status(status).json(envelope(data, context, {
    basis: UNKNOWN as MarketBasis,
    currency: UNKNOWN,
    warnings: WARNINGS,
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
    currency: UNKNOWN,
    warnings: WARNINGS,
  }));
}

/** Build the isolated router. Owns full /api paths so mounting is one line. */
export function createWebHarvestRouter(options: WebHarvestRouteOptions = {}): Router {
  const router = Router();
  const store = options.store ?? createWebHarvestStore();
  const now = options.now ?? (() => new Date());

  function route(
    handler: (req: Request, res: Response, context: RequestContext) => Promise<void> | void,
  ) {
    return (req: Request, res: Response, next: NextFunction): void => {
      const context = newContext(now);
      Promise.resolve()
        .then(() => handler(req, res, context))
        .catch((error: unknown) => {
          if (error instanceof ReviewError) {
            respondError(res, error.httpStatus, context, error.message, error.code);
            return;
          }
          respondError(
            res,
            500,
            context,
            error instanceof Error ? error.message : 'Review request failed.',
            'internal_error',
          );
        });
    };
  }

  router.get('/api/web-harvest/sources', route(async (_req, res, context) => {
    const sources: WebSourceConfig[] = await store.listSources();
    respond(res, 200, context, { sources });
  }));

  router.get('/api/web-harvest/review-queue', route(async (req, res, context) => {
    const raw = req.query.status;
    const status = typeof raw === 'string' ? raw : undefined;
    if (status !== undefined && !STATUSES.has(status)) {
      throw new ReviewError('status must be PENDING, APPROVED or REJECTED.', 'validation_error');
    }
    const candidates = await store.listCandidates(
      status === undefined ? {} : { status: status as ReviewStatus },
    );
    const counts = {
      PENDING: (await store.listCandidates({ status: 'PENDING' })).length,
      APPROVED: (await store.listCandidates({ status: 'APPROVED' })).length,
      REJECTED: (await store.listCandidates({ status: 'REJECTED' })).length,
    };
    respond(res, 200, context, { candidates, counts });
  }));

  router.post('/api/web-harvest/candidates', route(async (req, res, context) => {
    const candidates = parseCandidates(req.body);
    const result = await store.enqueueMany(candidates);
    respond(res, 200, context, result);
  }));

  router.post('/api/web-harvest/review', route(async (req, res, context) => {
    if (!isObject(req.body)) {
      throw new ReviewError('A review object is required.', 'validation_error');
    }
    const candidateId = stringField(req.body.candidateId, 'candidateId');
    const action = stringField(req.body.action, 'action');
    if (action !== 'APPROVE' && action !== 'REJECT') {
      throw new ReviewError('action must be APPROVE or REJECT.', 'validation_error');
    }
    if (req.body.note !== undefined && typeof req.body.note !== 'string') {
      throw new ReviewError('note must be a string.', 'validation_error');
    }
    const result = await store.review(
      candidateId,
      action as ReviewAction,
      req.body.note as string | undefined,
    );
    if (!result) {
      respondError(res, 404, context, 'Candidate not found.', 'not_found');
      return;
    }
    res.status(200).json(envelope(result, context, {
      source: result.provenance.source,
      basis: result.provenance.basis,
      currency: result.provenance.currency,
      provenance: result.provenance,
      warnings: WARNINGS,
    }));
  }));

  return router;
}

/** Integrator entry point: register the router on an existing Express app. */
export function mountWebHarvestRouter(app: Express, options: WebHarvestRouteOptions = {}): Router {
  const router = createWebHarvestRouter(options);
  app.use(router);
  return router;
}

export default createWebHarvestRouter;
