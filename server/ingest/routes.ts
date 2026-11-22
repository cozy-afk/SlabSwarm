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

function respond<T>(
  res: Response,
  status: number,
  data: T,
  legacy: Record<string, unknown> = {},
): void {
  res.status(status).json({
    ...legacy,
    ...envelope(data, newContext(), {
      basis: UNKNOWN,
      currency: UNKNOWN,
      warnings: INGEST_WARNINGS,
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

export function createIngestRouter(
  // Default to the durable ledger so server restarts keep all ingested
  // evidence. Tests may still inject an isolated repository bundle.
  repos: IngestRepositories = createDurableRepositories(),
): Router {
  const router = Router();
  const registry = new AdapterRegistry([
    // No path captured here: the adapter resolves SLABGRAPH_DATA_DIR on each fetch.
    createLegacyAdapter({}),
    createCsvAdapter(),
    createManualAdapter(),
    createTcgapisAdapter(),
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

  return router;
}

export default createIngestRouter;
