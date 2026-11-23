// Internal operator QA surface for quarantined listing-title matches.
//
// Router + mount only: no listener, no firewall/DNS change. The integrator
// mounts it behind the existing operator gate on the shared Express app. Every
// response uses the project's { data, meta } envelope; canonical writes happen
// exclusively inside the review store's human APPROVE path.

import { Router, type Express, type NextFunction, type Request, type Response } from 'express';
import type { MarketBasis } from '../contracts/dataProduct.ts';
import type { FreeFeedRecord } from '../contracts/freeFeed.ts';
import { UNKNOWN, envelope, errorEnvelope, newContext, type RequestContext } from '../serving/catalog.ts';
import {
  QaError,
  createMatchReviewQueue,
  type MatchReviewQueue,
  type QaAction,
  type QaStatus,
} from './qaQueue.ts';

export interface MatchReviewRouteOptions {
  store?: MatchReviewQueue;
  now?: () => Date;
}

const WARNINGS = [
  'Listing-title matches below the configured confidence floor are quarantined; they never enter FMV or canonical price observations.',
  'No model decides identity: an internal operator APPROVE is the only release path.',
  'Corrections are append-only and carry source, basis, currency, lineage and confidence provenance.',
];
const STATUSES: ReadonlySet<string> = new Set<QaStatus>(['PENDING', 'APPROVED', 'REJECTED']);

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringField(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new QaError(`${label} is required and must be a non-empty string.`, 'validation_error');
  }
  return value;
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
export function createMatchReviewRouter(options: MatchReviewRouteOptions = {}): Router {
  const router = Router();
  const store = options.store ?? createMatchReviewQueue();
  const now = options.now ?? (() => new Date());

  function route(
    handler: (req: Request, res: Response, context: RequestContext) => Promise<void> | void,
  ) {
    return (req: Request, res: Response, next: NextFunction): void => {
      const context = newContext(now);
      Promise.resolve()
        .then(() => handler(req, res, context))
        .catch((error: unknown) => {
          if (error instanceof QaError) {
            respondError(res, error.httpStatus, context, error.message, error.code);
            return;
          }
          respondError(
            res,
            500,
            context,
            error instanceof Error ? error.message : 'QA review request failed.',
            'internal_error',
          );
        });
    };
  }

  router.get('/api/qa/match-queue', route(async (req, res, context) => {
    const raw = req.query.status;
    const status = typeof raw === 'string' ? raw : undefined;
    if (status !== undefined && !STATUSES.has(status)) {
      throw new QaError('status must be PENDING, APPROVED or REJECTED.', 'validation_error');
    }
    const candidates = await store.list(status === undefined ? {} : { status: status as QaStatus });
    const counts = {
      PENDING: (await store.list({ status: 'PENDING' })).length,
      APPROVED: (await store.list({ status: 'APPROVED' })).length,
      REJECTED: (await store.list({ status: 'REJECTED' })).length,
    };
    respond(res, 200, context, { candidates, counts });
  }));

  router.post('/api/qa/match-queue', route(async (req, res, context) => {
    if (!isObject(req.body)) {
      throw new QaError('A proposal object is required.', 'validation_error');
    }
    stringField(req.body.sourceId, 'sourceId');
    stringField(req.body.externalId, 'externalId');
    stringField(req.body.title, 'title');
    const candidate = await store.enqueue(req.body as unknown as FreeFeedRecord);
    respond(res, 200, context, { candidate });
  }));

  router.get('/api/qa/match-corrections', route(async (req, res, context) => {
    const raw = req.query.candidateId;
    if (raw !== undefined && typeof raw !== 'string') {
      throw new QaError('candidateId must be a string.', 'validation_error');
    }
    const corrections = await store.listCorrections(
      typeof raw === 'string' && raw !== '' ? { candidateId: raw } : {},
    );
    respond(res, 200, context, { corrections });
  }));

  router.post('/api/qa/match-review', route(async (req, res, context) => {
    if (!isObject(req.body)) {
      throw new QaError('A review object is required.', 'validation_error');
    }
    const candidateId = stringField(req.body.candidateId, 'candidateId');
    const action = stringField(req.body.action, 'action');
    if (action !== 'APPROVE' && action !== 'REJECT') {
      throw new QaError('action must be APPROVE or REJECT.', 'validation_error');
    }
    const reviewer = stringField(req.body.reviewer, 'reviewer');
    if (req.body.note !== undefined && typeof req.body.note !== 'string') {
      throw new QaError('note must be a string.', 'validation_error');
    }
    const result = await store.review(candidateId, action as QaAction, {
      reviewer,
      note: req.body.note as string | undefined,
    });
    if (!result) {
      respondError(res, 404, context, 'Quarantined match not found.', 'not_found');
      return;
    }
    respond(res, 200, context, result);
  }));

  return router;
}

/** Integrator entry point: register the router on an existing Express app. */
export function mountMatchReviewRouter(app: Express, options: MatchReviewRouteOptions = {}): Router {
  const router = createMatchReviewRouter(options);
  app.use(router);
  return router;
}

export default createMatchReviewRouter;
