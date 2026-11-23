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
import type { Request, RequestHandler, Response, Router } from 'express';

import type { MarketObservation } from '../contracts/dataProduct.ts';
import { forecastRepository } from '../forecast/repository.ts';
import { getLearningState } from '../forecast/learning.ts';
import { runSwarmResearch, swarmRunStore } from '../swarm/run.ts';
import type { EvidenceItem } from '../swarm/tools.ts';
import { envelope, errorEnvelope, newContext, UNKNOWN } from './catalog.ts';

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

function bodyObject(req: Request): Record<string, unknown> {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? req.body as Record<string, unknown>
    : {};
}

function isoText(value: unknown, fallback: string): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Date.parse(value))) {
    return new Date(Date.parse(value)).toISOString();
  }
  return fallback;
}

function bandOf(value: unknown): EvidenceItem['confidence'] {
  if (value === 'HIGH' || value === 'MEDIUM' || value === 'LOW') return value;
  if (typeof value === 'number') return value >= 0.8 ? 'HIGH' : value >= 0.5 ? 'MEDIUM' : 'LOW';
  return 'LOW';
}

function targetRefOf(row: MarketObservation): string {
  const raw = row as unknown as Record<string, unknown>;
  if (typeof raw.targetIdentityRef === 'string' && raw.targetIdentityRef.trim() !== '') {
    return raw.targetIdentityRef;
  }
  return typeof raw.targetIdentityId === 'string' ? raw.targetIdentityId : UNKNOWN;
}

function evidenceForTarget(rows: MarketObservation[], targetId: string): EvidenceItem[] {
  return rows
    .filter((row) => targetRefOf(row) === targetId)
    .map((row) => {
      const raw = row as unknown as Record<string, unknown>;
      return {
        id: row.evidenceId || row.id,
        source: typeof raw.sourceId === 'string' ? raw.sourceId : 'canonical.marketObservations',
        observedAt: isoText(row.observedAt, UNKNOWN),
        capturedAt: isoText(raw.capturedAt ?? row.observedAt, UNKNOWN),
        summary: `${row.basis} ${row.amount} ${row.currency} observed for ${targetId}`,
        basis: row.basis,
        confidence: bandOf(raw.confidence),
        kind: 'MARKET_OBSERVATION',
        amount: row.amount,
      };
    });
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

  router.post('/api/swarm/research/run', ...middleware, async (req, res) => {
    const body = bodyObject(req);
    const rows = await repositories.marketObservations.list();
    const counts = new Map<string, number>();
    for (const row of rows) {
      const target = targetRefOf(row);
      if (target && target !== UNKNOWN) counts.set(target, (counts.get(target) ?? 0) + 1);
    }
    const selected = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    const bodyTarget = typeof body.targetId === 'string' ? body.targetId.trim() : '';
    const targetId = bodyTarget || selected?.[0] || '';
    const evidence = evidenceForTarget(rows, targetId);
    if (!targetId || evidence.length === 0) {
      res.status(422).json(errorEnvelope(
        'No canonical evidence is available for a research run.',
        'NO_CANONICAL_EVIDENCE',
        newContext(),
        { warnings: ['A question is not evidence; no facts are invented to run research.'] },
      ));
      return;
    }
    const run = runSwarmResearch({
      targetId,
      evidence,
      ...(typeof body.maxItems === 'number' ? { maxItems: body.maxItems } : {}),
      ...(typeof body.asOf === 'string' ? { asOf: body.asOf } : {}),
    });
    res.status(201).json(envelope(run, newContext(), {
      source: 'canonical.marketObservations',
      basis: UNKNOWN as never,
      currency: UNKNOWN,
      warnings: [
        'Role claims are proposals, never canonical facts.',
        'The question text is not used as evidence.',
      ],
    }));
  });

  router.get('/api/swarm/runs/:id', ...middleware, (req, res) => {
    const run = swarmRunStore.get(req.params.id);
    if (!run) {
      res.status(404).json(errorEnvelope('Swarm run not found', 'SWARM_RUN_NOT_FOUND', newContext()));
      return;
    }
    send(res, run, 'swarmRunStore', [
      'Role claims are proposals, never canonical facts.',
    ]);
  });

  return router;
}
