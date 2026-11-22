// Ingest HTTP routes. Mount with `app.use(createIngestRouter(repos))`; the
// router owns full /api paths so the integrator only adds one line to server.ts.
// All writes go through the runner, so adapters never touch canonical facts.

import { Router, type Request, type Response } from 'express';
import { AdapterRegistry } from './registry.ts';
import { createCsvAdapter, previewCsv } from './adapters/csv.ts';
import { createManualAdapter } from './adapters/manual.ts';
import {
  createLegacyAdapter,
  DEFAULT_LEGACY_DB,
  loadLegacySnapshot,
  type LegacySnapshot,
} from './adapters/legacy.ts';
import { createTcgapisAdapter } from './adapters/tcgapis.ts';
import { runIngest } from './runner.ts';
import { createDurableRepositories } from './store.ts';
import type { IngestRepositories } from './types.ts';

type Filters = Record<string, unknown>;

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
  res.status(404).json({ error: `${label} not found` });
}

export function createIngestRouter(
  // Default to the durable ledger so server restarts keep all ingested
  // evidence. Tests may still inject an isolated repository bundle.
  repos: IngestRepositories = createDurableRepositories(),
): Router {
  const router = Router();
  const registry = new AdapterRegistry([
    createLegacyAdapter({ path: DEFAULT_LEGACY_DB }),
    createCsvAdapter(),
    createManualAdapter(),
    createTcgapisAdapter(),
  ]);

  // Evidence ---------------------------------------------------------------
  router.get('/api/evidence', async (req, res) => {
    res.json({ evidence: await repos.evidence.list(filters(req.query)) });
  });

  router.get('/api/evidence/:id', async (req, res) => {
    const record = await repos.evidence.get(req.params.id);
    if (!record) return notFound(res, 'evidence');
    res.json({ evidence: record });
  });

  // Ingest runs ------------------------------------------------------------
  router.get('/api/ingest/runs', async (req, res) => {
    res.json({ runs: await repos.runs.list(filters(req.query)) });
  });

  router.get('/api/ingest/runs/:id', async (req, res) => {
    const run = await repos.runs.get(req.params.id);
    if (!run) return notFound(res, 'ingest run');
    res.json({ run });
  });

  router.get('/api/ingest/adapters', (_req, res) => {
    res.json({ adapters: registry.list().map((adapter) => adapter.id) });
  });

  // Manual notes -----------------------------------------------------------
  router.post('/api/ingest/manual', async (req, res) => {
    const note = req.body;
    if (note === null || typeof note !== 'object' || Array.isArray(note)) {
      res.status(400).json({ error: 'note object is required' });
      return;
    }
    if (typeof note.text !== 'string' || note.text.trim() === '') {
      res.status(400).json({ error: 'text is required' });
      return;
    }
    const result = await runIngest(createManualAdapter(), repos, {
      mode: 'backfill',
      options: { note },
    });
    res.json({ evidence: result.evidence, candidates: result.candidates, run: result.run });
  });

  // CSV --------------------------------------------------------------------
  router.post('/api/ingest/csv', async (req, res) => {
    const csv = req.body?.csv;
    if (typeof csv !== 'string') {
      res.status(400).json({ error: 'csv text is required' });
      return;
    }
    if (req.body?.preview === true) {
      res.json({ preview: previewCsv(csv) });
      return;
    }
    const result = await runIngest(createCsvAdapter(), repos, {
      mode: 'backfill',
      options: { csv },
    });
    res.json({ evidence: result.evidence, candidates: result.candidates, run: result.run });
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
          typeof req.body?.snapshotPath === 'string' ? req.body.snapshotPath : DEFAULT_LEGACY_DB,
        );
      } catch (error) {
        res.status(400).json({
          error: error instanceof Error ? error.message : 'legacy snapshot unavailable',
        });
        return;
      }
    }
    const mode = req.body?.mode === 'forward' ? 'forward' : 'backfill';
    const result = await runIngest(createLegacyAdapter({ snapshot }), repos, {
      mode,
      options: {},
    });
    res.json({ evidence: result.evidence, candidates: result.candidates, run: result.run });
  });

  return router;
}

export default createIngestRouter;
