/**
 * Analytics HTTP surface (Phase 3).
 *
 * This module exports a mount function only. It never opens a listener and
 * never writes canonical facts: discovery writes research-note findings and
 * the export job writes a rebuildable Parquet lake. The integrator mounts the
 * router in server.ts and decides which middleware protects the admin route.
 */

import express, { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { runDiscoverySweep, type DiscoveryOptions } from './discovery.ts';
import { exportAnalyticsParquet } from './parquet.ts';
import {
  getBuiltInQueries,
  listSavedQueries,
  QueryEngineError,
  ReadOnlyViolation,
  runSqlQuery,
  saveQuery,
  ValidationError,
} from './sqlLab.ts';
import { getAnalyticsStore } from './store.ts';
import type { AnalyticsStore, FindingFilters } from './types.ts';

export interface AnalyticsRouteOptions {
  store?: AnalyticsStore;
  lakeDir?: string;
  /** Server-owned sweep defaults; request bodies may narrow numeric windows. */
  sweepOptions?: Omit<DiscoveryOptions, 'now'>;
}

type AsyncHandler = (req: Request, res: Response) => Promise<void> | void;

function wrap(handler: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve()
      .then(() => handler(req, res))
      .catch(next);
  };
}

function optionalNumber(value: unknown, label: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new ValidationError(`${label} must be a number between ${min} and ${max}.`);
  }
  return value;
}

function requestSweepOptions(body: unknown, base: Omit<DiscoveryOptions, 'now'> = {}): Omit<DiscoveryOptions, 'now'> {
  if (body === undefined || body === null) return { ...base };
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('Request body must be an object.');
  }
  const input = body as Record<string, unknown>;
  const merged = { ...base };
  const fields: Array<[keyof Omit<DiscoveryOptions, 'now'>, number, number]> = [
    ['activeWindowDays', 1, 3650],
    ['staleDays', 1, 3650],
    ['minActiveObservations', 1, 100000],
    ['anomalyRatio', 1.01, 1000],
    ['spreadRatio', 1.01, 1000],
  ];
  for (const [key, min, max] of fields) {
    const value = optionalNumber(input[key], String(key), min, max);
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

/**
 * Mount every analytics endpoint on an existing Express app or router.
 * Returns the same instance for chaining.
 */
export function mountAnalyticsRoutes(target: Router, options: AnalyticsRouteOptions = {}): Router {
  const store = options.store ?? getAnalyticsStore();
  target.use(express.json({ limit: '1mb' }));

  // Admin-only at the integrator's discretion: export writes the derived lake.
  target.post('/api/admin/export-parquet', wrap(async (_req, res) => {
    const manifest = await exportAnalyticsParquet(store, { lakeDir: options.lakeDir });
    res.status(200).json({ ok: true, ...manifest });
  }));

  target.post('/api/intelligence/discovery-sweep', wrap((req, res) => {
    const sweepOptions = requestSweepOptions(req.body, options.sweepOptions);
    const result = runDiscoverySweep(store, sweepOptions);
    res.status(200).json({ ok: true, ...result });
  }));

  target.get('/api/intelligence/findings', wrap((req, res) => {
    const { type, targetId } = req.query;
    if (type !== undefined && typeof type !== 'string') {
      throw new ValidationError('type must be a string.');
    }
    if (targetId !== undefined && typeof targetId !== 'string') {
      throw new ValidationError('targetId must be a string.');
    }
    const allowed = new Set(['ACTIVE_CARD', 'MOMENTUM', 'SPREAD', 'ANOMALY', 'SOURCE_FRESHNESS', 'EVIDENCE_GAP']);
    if (typeof type === 'string' && !allowed.has(type)) {
      throw new ValidationError(`Unknown finding type: ${type}`);
    }
    const limit = optionalNumber(
      typeof req.query.limit === 'string' ? Number(req.query.limit) : req.query.limit,
      'limit', 0, 1000,
    );
    const findings = store.listFindings({
      ...(typeof type === 'string' ? { type: type as FindingFilters['type'] } : {}),
      ...(typeof targetId === 'string' ? { targetId } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    res.status(200).json({ ok: true, findings, count: findings.length });
  }));

  target.get('/api/sql/queries', wrap((_req, res) => {
    res.status(200).json({ ok: true, queries: getBuiltInQueries() });
  }));

  target.post('/api/sql/query', wrap(async (req, res) => {
    const result = await runSqlQuery(store, {
      ...(req.body ?? {}) as Record<string, unknown>,
    });
    res.status(200).json({ ok: true, result });
  }));

  target.get('/api/sql/saved', wrap((_req, res) => {
    res.status(200).json({ ok: true, queries: listSavedQueries(store) });
  }));

  target.post('/api/sql/saved', wrap((req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const saved = saveQuery(store, {
      name: String(body.name ?? ''),
      sql: String(body.sql ?? ''),
      description: typeof body.description === 'string' ? body.description : null,
    });
    res.status(201).json({ ok: true, query: saved });
  }));

  target.delete('/api/sql/saved/:id', wrap((req, res) => {
    const deleted = store.deleteSavedQuery(req.params.id);
    if (!deleted) {
      res.status(404).json({ ok: false, error: 'not_found', message: 'Saved query not found.' });
      return;
    }
    res.status(200).json({ ok: true, deleted: true });
  }));

  target.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
    if (error instanceof ReadOnlyViolation) {
      res.status(403).json({ ok: false, error: 'read_only_violation', message: error.message });
      return;
    }
    if (error instanceof ValidationError) {
      res.status(400).json({ ok: false, error: 'validation_error', message: error.message });
      return;
    }
    if (error instanceof QueryEngineError) {
      res.status(503).json({ ok: false, error: 'query_engine_error', message: error.message });
      return;
    }
    res.status(500).json({
      ok: false,
      error: 'internal_error',
      message: error instanceof Error ? error.message : String(error),
    });
  });

  return target;
}

/** Convenience factory for an isolated router (used by tests and integrators). */
export function createAnalyticsRouter(options: AnalyticsRouteOptions = {}): Router {
  return mountAnalyticsRoutes(Router(), options);
}
