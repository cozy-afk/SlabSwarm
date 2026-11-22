import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import express, { type Request, type Response, type NextFunction } from 'express';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createMemoryStore, type DbStore } from '../../server/db/store.ts';
import { runMigrations } from '../../server/db/migrate.ts';
import { createDbRouter } from '../../server/db/routes.ts';

const fixturePath = path.resolve(
  import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
  'fixtures/slabgraph-fixture.json',
);
const FIXTURE_RAW = fs.readFileSync(fixturePath, 'utf-8');

async function withServer(
  router: ReturnType<typeof createDbRouter>,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use(router);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

const allowOperator: (req: Request, res: Response, next: NextFunction) => void = (_req, _res, next) => next();

function tempSource(): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slabswarm-routes-'));
  const file = path.join(dir, 'snapshot.json');
  fs.writeFileSync(file, FIXTURE_RAW, 'utf-8');
  return { dir, file };
}

test('GET /api/db/status reports migration state and per-table counts when current', async () => {
  const store = createMemoryStore();
  await runMigrations(store);
  await withServer(createDbRouter({ store }), async (base) => {
    const res = await fetch(`${base}/api/db/status`);
    assert.equal(res.status, 200);
    const body = await res.json() as {
      ok: boolean; migrations: { state: string; applied: string[]; pending: string[] };
      tables: Record<string, number | null>;
    };
    assert.equal(body.ok, true);
    assert.equal(body.migrations.state, 'CURRENT');
    assert.deepEqual(body.migrations.pending, []);
    assert.ok(body.migrations.applied.includes('0001_init.sql'));
    assert.equal(body.tables['evidence_records'], 0);
    assert.equal(body.tables['jobs'], 0);
    assert.ok('market_observations' in body.tables);
  });
});

test('GET /api/db/status returns 503 and UNKNOWN counts when migrations are pending', async () => {
  const store = createMemoryStore();
  await withServer(createDbRouter({ store }), async (base) => {
    const res = await fetch(`${base}/api/db/status`);
    assert.equal(res.status, 503);
    const body = await res.json() as { ok: boolean; migrations: { state: string; applied: string[] } };
    assert.equal(body.ok, false);
    assert.equal(body.migrations.state, 'PENDING');
    assert.deepEqual(body.migrations.applied, []);
  });
});

test('GET /api/db/status marks tables as UNKNOWN when the table does not exist', async () => {
  const base = createMemoryStore();
  const missingTableStore: DbStore = {
    insert: base.insert.bind(base),
    findById: base.findById.bind(base),
    findAll: base.findAll.bind(base),
    upsert: base.upsert.bind(base),
    count: async () => { throw new Error('relation does not exist'); },
    exec: base.exec.bind(base),
    transaction: base.transaction.bind(base),
  };
  await withServer(createDbRouter({ store: missingTableStore }), async (address) => {
    const res = await fetch(`${address}/api/db/status`);
    const body = await res.json() as { tables: Record<string, number | null> };
    assert.equal(body.tables['cards'], null, 'unmigrated tables must be UNKNOWN, not zero');
  });
});

test('POST /api/admin/backfill-json fails closed without operator auth', async () => {
  const store = createMemoryStore();
  await withServer(createDbRouter({ store, sourcePath: fixturePath }), async (base) => {
    const res = await fetch(`${base}/api/admin/backfill-json`, { method: 'POST' });
    assert.equal(res.status, 403);
    assert.equal(await store.count('cards'), 0, 'unauthenticated call must not write');
  });
});

test('POST /api/admin/backfill-json with auth imports data and returns a parity report', async () => {
  const store = createMemoryStore();
  await runMigrations(store);
  const { dir, file } = tempSource();
  const before = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  try {
    await withServer(createDbRouter({ store, sourcePath: file, requireAuth: allowOperator }), async (base) => {
      const res = await fetch(`${base}/api/admin/backfill-json`, { method: 'POST' });
      assert.equal(res.status, 200);
      const body = await res.json() as { ok: boolean; report: { parity: boolean; imported: Record<string, number> } };
      assert.equal(body.ok, true);
      assert.equal(body.report.parity, true);
      assert.equal(body.report.imported.cards, 2);
      assert.equal(await store.count('cards'), 2);
      assert.equal(await store.count('research_notes'), 1);
    });
    const after = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    assert.equal(after, before, 'backfill route must not mutate the source JSON');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the mounted router exposes only the two foundation endpoints and opens no listener', () => {
  const router = createDbRouter({ store: createMemoryStore() }) as unknown as {
    stack: Array<{ route?: { path?: string; methods?: Record<string, boolean> } }>;
  };
  const paths = router.stack
    .filter((layer) => layer.route?.path)
    .map((layer) => `${Object.keys(layer.route?.methods ?? {})[0]?.toUpperCase()} ${layer.route?.path}`)
    .sort();
  assert.deepEqual(paths, ['GET /api/db/status', 'POST /api/admin/backfill-json']);
});

test('backfill source defaults to SLABGRAPH_DATA_DIR/slabgraph-db.json, resolved at call time', async () => {
  const store = createMemoryStore();
  await runMigrations(store);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slabswarm-db-env-'));
  const source = path.join(dir, 'slabgraph-db.json');
  fs.writeFileSync(source, FIXTURE_RAW, 'utf-8');
  const originalDataDir = process.env.SLABGRAPH_DATA_DIR;
  const originalDbPath = process.env.SLABGRAPH_DB_PATH;
  try {
    delete process.env.SLABGRAPH_DB_PATH;
    process.env.SLABGRAPH_DATA_DIR = dir;
    await withServer(createDbRouter({ store, requireAuth: allowOperator }), async (base) => {
      const res = await fetch(`${base}/api/admin/backfill-json`, { method: 'POST' });
      assert.equal(res.status, 200, 'default source must follow SLABGRAPH_DATA_DIR');
      const body = await res.json() as { ok: boolean; report: { parity: boolean } };
      assert.equal(body.ok, true);
      assert.equal(body.report.parity, true);
      assert.equal(await store.count('cards'), 2);
    });
  } finally {
    if (originalDataDir === undefined) delete process.env.SLABGRAPH_DATA_DIR;
    else process.env.SLABGRAPH_DATA_DIR = originalDataDir;
    if (originalDbPath === undefined) delete process.env.SLABGRAPH_DB_PATH;
    else process.env.SLABGRAPH_DB_PATH = originalDbPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
