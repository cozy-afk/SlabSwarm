/**
 * Data-product contract routes that the product UI reads with useEnvelope().
 *
 * These three paths drifted from the server: /api/observations and GET
 * /api/forecasts did not exist, and /api/learning/state still used the old
 * bare response shape. This router is mounted before the legacy intelligence
 * router so the UI gets the shared { data, meta } envelope it already expects.
 * No listener, firewall rule or DNS change; all routes reuse the operator gate.
 */

import express from 'express';
import type { RequestHandler, Response, Router } from 'express';

import type { MarketObservation } from '../contracts/dataProduct.ts';
import { forecastRepository } from '../forecast/repository.ts';
import { getLearningState } from '../forecast/learning.ts';
import { envelope, newContext, UNKNOWN } from './catalog.ts';

interface ObservationListSource {
  marketObservations: {
    list(filters?: Record<string, unknown>): Promise<MarketObservation[]>;
  };
}

function send(res: Response, data: unknown, source: string, warnings: string[]): void {
  res.status(200).json(envelope(data, newContext(), {
    source,
    basis: UNKNOWN as never,
    currency: UNKNOWN,
    warnings,
  }));
}

export function createDataProductContractRouter(
  repositories: ObservationListSource,
  ...middleware: RequestHandler[]
): Router {
  const router = express.Router();

  router.get('/api/observations', ...middleware, async (_req, res) => {
    const rows = await repositories.marketObservations.list();
    const observations = rows.map((row) => {
      const raw = row as unknown as Record<string, unknown>;
      return {
        id: row.id,
        targetIdentityRef: typeof raw.targetIdentityRef === 'string'
          ? raw.targetIdentityRef
          : (typeof raw.targetIdentityId === 'string' ? raw.targetIdentityId : UNKNOWN),
        basis: row.basis,
        amount: row.amount,
        currency: row.currency,
        observedAt: row.observedAt,
        status: row.status,
        ...(raw.priceComponents && typeof raw.priceComponents === 'object'
          ? { provenance: raw.priceComponents as Record<string, unknown> }
          : {}),
      };
    });
    send(res, observations, 'canonical.marketObservations', [
      'Rows are canonical market observations; basis and currency are explicit.',
      'Missing values remain UNKNOWN and are never coerced to zero.',
    ]);
  });

  router.get('/api/forecasts', ...middleware, (_req, res) => {
    send(res, forecastRepository.list(), 'forecastRepository', [
      'Forecasts are hypotheses until scored against realized outcomes.',
      'Empty list means no forecast has been created, not that prices are zero.',
    ]);
  });

  router.get('/api/learning/state', ...middleware, (_req, res) => {
    send(res, getLearningState(), 'forecast.learning', [
      'Learning state is derived from scored outcomes and benchmark gates.',
    ]);
  });

  return router;
}
