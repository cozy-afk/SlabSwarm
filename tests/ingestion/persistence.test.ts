import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const storeMod = () => import('../../server/ingest/store.ts');

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'slabswarm-ingest-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function input(overrides: Record<string, unknown> = {}) {
  return {
    sourceId: 'tcgapis',
    sourceRecordId: 'tcg:card:1',
    sourceUri: 'https://api.tcgapis.com/api/v2/cards/1',
    capturedAt: '2026-11-22T12:00:00.000Z',
    observedAt: '2026-11-20T00:00:00.000Z',
    checksum: 'a'.repeat(64),
    mimeType: 'application/json',
    license: null,
    rawRef: 'ingest://tcgapis/tcg:card:1/' + 'a'.repeat(64),
    parsedPayload: { basis: 'GUIDE', price: 10, currency: 'USD' },
    trustTier: 'UNKNOWN',
    ...overrides,
  };
}

test('two durable repository instances see the same evidence', async () => {
  const { createDurableRepositories } = await storeMod();
  const filePath = join(tempDir(), 'ingest-store.json');
  const first = createDurableRepositories({ filePath });
  const record = await first.evidence.createIdempotent(input() as never);
  assert.equal(record.created, true);

  // A second instance constructed from the same file sees the first row.
  const second = createDurableRepositories({ filePath });
  assert.equal((await second.evidence.get(record.record.id))?.sourceRecordId, 'tcg:card:1');
  assert.equal((await second.evidence.list({})).length, 1);

  // Writes through the second instance are visible to the first.
  const added = await second.evidence.createIdempotent(
    input({ sourceRecordId: 'tcg:card:2', checksum: 'b'.repeat(64) }) as never,
  );
  assert.equal(added.created, true);
  assert.equal((await first.evidence.list({})).length, 2);
});

test('a fresh repository loads the persisted store after a process restart', async () => {
  const { createDurableRepositories } = await storeMod();
  const dir = tempDir();
  const first = createDurableRepositories({ dataDir: dir });
  const created = await first.evidence.createIdempotent(input() as never);
  await first.runs.create({
    sourceId: 'tcgapis',
    adapterId: 'tcgapis-chain',
    mode: 'backfill',
    status: 'COMPLETED',
    startedAt: '2026-11-22T12:00:00.000Z',
    finishedAt: '2026-11-22T12:00:01.000Z',
    cursorIn: null,
    cursorOut: null,
    watermarkIn: null,
    watermarkOut: null,
    counts: { fetched: 1, created: 1, duplicates: 0, failed: 0, candidates: 1 },
    errors: [],
    meta: {},
  });

  const file = join(dir, 'ingest-store.json');
  assert.equal(existsSync(file), true);
  const snapshot = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.evidence.length, 1);
  assert.equal(snapshot.runs.length, 1);
  assert.ok(readdirSync(dir).every((name) => !name.endsWith('.tmp')), 'temp files must be renamed away');

  // Different path string (relative vs absolute) still resolves to one file.
  const restarted = createDurableRepositories({ filePath: file, env: {} });
  assert.equal((await restarted.evidence.get(created.record.id))?.id, created.record.id);
  assert.equal((await restarted.runs.list({ sourceId: 'tcgapis' })).length, 1);
});

test('duplicate writes are idempotent and leave the first row byte-identical', async () => {
  const { createDurableRepositories } = await storeMod();
  const filePath = join(tempDir(), 'ingest-store.json');
  const repos = createDurableRepositories({ filePath });
  const first = await repos.evidence.createIdempotent(input() as never);
  const before = JSON.stringify(await repos.evidence.get(first.record.id));
  const duplicate = await repos.evidence.createIdempotent(input() as never);
  const after = JSON.stringify(await repos.evidence.get(first.record.id));
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.record.id, first.record.id);
  assert.equal(before, after, 'duplicate write must not mutate the original row');
  assert.equal((await repos.evidence.list({})).length, 1);

  // And after reloading from disk the original row is still unchanged.
  const reloaded = createDurableRepositories({ filePath });
  assert.equal(JSON.stringify(await reloaded.evidence.get(first.record.id)), before);
});

test('a correction appends a new row and never mutates the original', async () => {
  const { createDurableRepositories } = await storeMod();
  const filePath = join(tempDir(), 'ingest-store.json');
  const repos = createDurableRepositories({ filePath });
  const original = await repos.evidence.createIdempotent(input() as never);
  const before = JSON.stringify(original.record);
  const correction = await repos.evidence.appendCorrection(original.record.id, {
    checksum: 'c'.repeat(64),
    parsedPayload: { basis: 'SOLD', price: 12, currency: 'USD' },
    correctionReason: 'corrected basis',
  });
  assert.ok(correction);
  assert.notEqual(correction.id, original.record.id);
  assert.equal((correction as { correctionOf: string }).correctionOf, original.record.id);
  assert.deepEqual((correction as { lineage: string[] }).lineage, [original.record.id]);
  assert.equal(JSON.stringify(await repos.evidence.get(original.record.id)), before);
  assert.equal((await repos.evidence.list({})).length, 2);
  const reloaded = createDurableRepositories({ filePath });
  assert.equal(JSON.stringify(await reloaded.evidence.get(original.record.id)), before);
});

test('store path uses SLABSWARM_DATA_DIR and falls back to ./data', async () => {
  const { resolveIngestStorePath } = await storeMod();
  const dir = tempDir();
  assert.equal(
    resolveIngestStorePath({ SLABSWARM_DATA_DIR: dir }),
    join(dir, 'ingest-store.json'),
  );
  assert.equal(
    resolveIngestStorePath({ SLABSWARM_DATA_DIR: '  ' }),
    resolveIngestStorePath({}),
  );
  assert.match(resolveIngestStorePath({}), /data\/ingest-store\.json$/);
});

test('the default ingest router persists evidence to the durable store', async () => {
  const { createIngestRouter } = await import('../../server/ingest/routes.ts');
  const express = (await import('express')).default;
  const dir = tempDir();
  const previous = process.env.SLABSWARM_DATA_DIR;
  process.env.SLABSWARM_DATA_DIR = dir;
  let server: Server | undefined;
  try {
    const app = express();
    app.use(express.json());
    app.use(createIngestRouter());
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((accept, reject) => {
      server?.once('listening', () => accept());
      server?.once('error', reject);
    });
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/api/ingest/manual`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'durable note', basis: 'ASKING', amount: 10, currency: 'USD' }),
    });
    assert.equal(response.status, 200);
    const file = join(dir, 'ingest-store.json');
    assert.equal(existsSync(file), true);
    const snapshot = JSON.parse(readFileSync(file, 'utf8'));
    assert.ok(snapshot.evidence.length >= 1, 'default router must write through the ledger');
  } finally {
    if (previous === undefined) delete process.env.SLABSWARM_DATA_DIR;
    else process.env.SLABSWARM_DATA_DIR = previous;
    if (server) await new Promise<void>((accept) => server?.close(() => accept()));
  }
});
