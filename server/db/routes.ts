/**
 * Mountable Express router for the data-product foundation.
 *
 * The integrator wires this into server.ts with:
 *   mountDbRoutes(app, { requireAuth: auth.requireAuth });
 *
 * No listener is opened here and server.ts is not modified by this lane.
 * Backfill fails closed: without an injected operator-auth middleware (or an
 * explicit opt-out for local tooling) the endpoint returns 403.
 */

import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
  type Router,
} from 'express';
import { readFile } from 'node:fs/promises';
import { backfillJson, type BackfillReport } from '../../scripts/backfill-json.ts';
import { DEFAULT_MIGRATIONS } from './migrate.ts';
import { TABLE_REGISTRY, createDefaultStore, type DbStore } from './store.ts';

export type OperatorAuthMiddleware = (req: Request, res: Response, next: NextFunction) => void;

export interface DbRoutesOptions {
  store?: DbStore;
  sourcePath?: string;
  requireAuth?: OperatorAuthMiddleware;
  /** Explicit opt-out for local, non-network tooling. Never enable in production. */
  allowUnauthenticatedBackfill?: boolean;
}

export interface DbStatusPayload {
  ok: boolean;
  migrations: {
    applied: string[];
    pending: string[];
    state: 'CURRENT' | 'PENDING';
  };
  tables: Record<string, number | null>;
  generatedAt: string;
}

const DB_PATH = () => process.env.SLABGRAPH_DB_PATH?.trim() || '/opt/slabswarm/data/slabgraph-db.json';

const denyUnauthenticated: OperatorAuthMiddleware = (_req, res) => {
  res.status(403).json({
    error: 'Operator authentication is required for the JSON backfill endpoint.',
  });
};

function statusPayload(store: DbStore): Promise<DbStatusPayload> {
  const expected = DEFAULT_MIGRATIONS.map((migration) => migration.name).sort();
  return (async () => {
    let applied: string[] = [];
    try {
      const rows = await store.findAll('__schema_migrations');
      applied = rows.map((row) => String(row.name)).sort();
    } catch {
      applied = [];
    }
    const appliedSet = new Set(applied);
    const pending = expected.filter((name) => !appliedSet.has(name));
    const tables: Record<string, number | null> = {};
    for (const name of Object.keys(TABLE_REGISTRY).sort()) {
      try {
        tables[name] = await store.count(name);
      } catch {
        // A table that has not been migrated yet is UNKNOWN, not zero.
        tables[name] = null;
      }
    }
    return {
      ok: pending.length === 0,
      migrations: {
        applied,
        pending,
        state: pending.length === 0 ? 'CURRENT' : 'PENDING',
      },
      tables,
      generatedAt: new Date().toISOString(),
    };
  })();
}

/** Build the router without touching the Express application. */
export function createDbRouter(options: DbRoutesOptions = {}): Router {
  const store = options.store ?? createDefaultStore();
  const router = express.Router();

  router.get('/api/db/status', async (_req, res) => {
    try {
      const payload = await statusPayload(store);
      res.status(payload.ok ? 200 : 503).json(payload);
    } catch (error) {
      res.status(500).json({
        error: `Database status unavailable: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  });

  const authorize: OperatorAuthMiddleware =
    options.requireAuth ?? (options.allowUnauthenticatedBackfill ? (_req, _res, next) => next() : denyUnauthenticated);

  router.post('/api/admin/backfill-json', authorize, async (req, res) => {
    const filePath = options.sourcePath ?? DB_PATH();
    try {
      const raw = await readFile(filePath, 'utf-8');
      const report: BackfillReport = await backfillJson(raw, store, { source: filePath });
      // Confirm the source file is byte-identical after the import.
      const { createHash } = await import('node:crypto');
      const after = createHash('sha256').update(await readFile(filePath, 'utf-8')).digest('hex');
      if (`sha256:${after}` !== report.sourceChecksum) {
        res.status(500).json({ error: 'Source JSON changed during backfill; import aborted.' });
        return;
      }
      res.status(report.parity ? 200 : 206).json({ ok: report.parity, report });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT') {
        res.status(404).json({ error: `Backfill source not found: ${filePath}` });
        return;
      }
      res.status(500).json({
        error: `Backfill failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  });

  return router;
}

/** Mount onto an existing Express app. Returns the router for testing. */
export function mountDbRoutes(app: Express, options: DbRoutesOptions = {}): Router {
  const router = createDbRouter(options);
  app.use(router);
  return router;
}
