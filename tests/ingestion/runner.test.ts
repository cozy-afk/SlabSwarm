import assert from 'node:assert/strict';
import { test } from 'node:test';

const storeMod = () => import('../../server/ingest/store.ts');
const registryMod = () => import('../../server/ingest/registry.ts');
const runnerMod = () => import('../../server/ingest/runner.ts');

function item(nativeId: string, observedAt: string, payload: Record<string, unknown> = {}) {
  return { nativeId, observedAt, payload };
}

function fakeAdapter(
  items: ReturnType<typeof item>[],
  behaviour: { fail?: boolean; parseErrors?: Array<{ nativeId: string; message: string }> } = {},
) {
  const calls: Array<Record<string, unknown>> = [];
  return {
    adapter: {
      id: 'fake',
      sourceId: 'fake-source',
      async fetch(ctx: { since: string | null; cursor: string | null }) {
        calls.push({ ...ctx });
        if (behaviour.fail) throw new Error('fetch exploded');
        return {
          items,
          cursor: 'cursor-next',
          meta: behaviour.parseErrors ? { parseErrors: behaviour.parseErrors } : {},
        };
      },
    },
    calls,
  };
}

test('registry registers adapters, lists them and rejects unknown/duplicate ids', async () => {
  const { AdapterRegistry } = await registryMod();
  const registry = new AdapterRegistry();
  const a = { id: 'a', sourceId: 'src-a', fetch: async () => ({ items: [] }) };
  registry.register(a);
  assert.equal(registry.get('a'), a);
  assert.deepEqual(registry.list().map((x: { id: string }) => x.id), ['a']);
  assert.throws(() => registry.register(a), /duplicate/i);
  assert.throws(() => registry.get('nope'), /unknown adapter/i);
});

test('backfill processes every item and ignores the stored watermark', async () => {
  const { createInMemoryRepositories } = await storeMod();
  const { runIngest } = await runnerMod();
  const repos = createInMemoryRepositories();
  // Seed a prior completed run with a high watermark.
  await repos.runs.create({
    id: 'run-old',
    sourceId: 'fake-source',
    adapterId: 'fake',
    mode: 'forward',
    status: 'COMPLETED',
    startedAt: '2026-11-01T00:00:00.000Z',
    finishedAt: '2026-11-01T00:00:00.000Z',
    watermarkIn: null,
    watermarkOut: '2026-11-15T00:00:00.000Z',
    cursorIn: null,
    cursorOut: null,
    counts: { fetched: 0, created: 0, duplicates: 0, failed: 0, candidates: 0 },
    errors: [],
    meta: {},
  });
  const { adapter, calls } = fakeAdapter([
    item('n1', '2026-11-10T00:00:00.000Z', { price: 100, basis: 'SOLD' }),
    item('n2', '2026-11-20T00:00:00.000Z', { price: 200, basis: 'ASKING' }),
  ]);
  const result = await runIngest(adapter, repos, { mode: 'backfill' });
  assert.equal(result.run.status, 'COMPLETED');
  assert.equal(result.run.counts.created, 2);
  assert.equal(result.evidence.length, 2);
  assert.equal(calls[0]?.since, null, 'backfill must not pass a watermark');
  assert.equal(result.run.watermarkOut, '2026-11-20T00:00:00.000Z');
});

test('forward mode filters items at or before the last successful watermark', async () => {
  const { createInMemoryRepositories } = await storeMod();
  const { runIngest } = await runnerMod();
  const repos = createInMemoryRepositories();
  const first = fakeAdapter([item('n1', '2026-11-10T00:00:00.000Z', { price: 100 })]);
  await runIngest(first.adapter, repos, { mode: 'forward' });

  // Second adapter deliberately ignores `since` and returns old + new items.
  const second = fakeAdapter([
    item('n1', '2026-11-10T00:00:00.000Z', { price: 100 }),
    item('n2', '2026-11-20T00:00:00.000Z', { price: 200 }),
  ]);
  const result = await runIngest(second.adapter, repos, { mode: 'forward' });
  assert.equal(second.calls[0]?.since, '2026-11-10T00:00:00.000Z');
  assert.equal(result.run.counts.fetched, 1, 'runner must enforce the watermark defensively');
  assert.equal(result.run.counts.created, 1);
  assert.equal(result.run.watermarkOut, '2026-11-20T00:00:00.000Z');
  assert.equal(result.run.cursorIn, 'cursor-next', 'cursor is reused from last run');
});

test('duplicate raw items create one evidence record and one candidate per evidence', async () => {
  const { createInMemoryRepositories } = await storeMod();
  const { runIngest } = await runnerMod();
  const repos = createInMemoryRepositories();
  const batch = [
    item('n1', '2026-11-10T00:00:00.000Z', { price: 100, basis: 'SOLD' }),
    item('n1', '2026-11-10T00:00:00.000Z', { price: 100, basis: 'SOLD' }),
  ];
  const first = await runIngest(fakeAdapter(batch).adapter, repos, { mode: 'backfill' });
  assert.equal(first.run.counts.created, 1);
  assert.equal(first.run.counts.duplicates, 1);
  assert.equal(first.candidates.length, 1);

  const second = await runIngest(fakeAdapter(batch).adapter, repos, { mode: 'backfill' });
  assert.equal(second.run.counts.created, 0);
  assert.equal(second.run.counts.duplicates, 2);
  assert.equal((await repos.evidence.list({})).length, 1);
});

test('per-item failures and adapter parse errors are captured without aborting the run', async () => {
  const { createInMemoryRepositories } = await storeMod();
  const { runIngest } = await runnerMod();
  const repos = createInMemoryRepositories();
  const { adapter } = fakeAdapter([item('n1', '2026-11-10T00:00:00.000Z', { price: 100 })], {
    parseErrors: [{ nativeId: 'row:7', message: 'malformed row skipped' }],
  });
  const result = await runIngest(adapter, repos, { mode: 'backfill' });
  assert.equal(result.run.status, 'PARTIAL');
  assert.equal(result.run.counts.failed, 1);
  assert.ok(result.run.errors.some((e: { message: string }) => /malformed row/.test(e.message)));
});

test('adapter fetch failure marks the run FAILED and never throws to the caller', async () => {
  const { createInMemoryRepositories } = await storeMod();
  const { runIngest } = await runnerMod();
  const repos = createInMemoryRepositories();
  const result = await runIngest(fakeAdapter([], { fail: true }).adapter, repos, {
    mode: 'backfill',
  });
  assert.equal(result.run.status, 'FAILED');
  assert.ok(result.run.errors.some((e: { message: string }) => /fetch exploded/.test(e.message)));
  assert.ok(result.run.finishedAt);
});

test('run repository supports create/get/list and sanitizes secrets from error text', async () => {
  const { createInMemoryRepositories } = await storeMod();
  const { sanitizeError } = await runnerMod();
  const repos = createInMemoryRepositories();
  const run = await repos.runs.create({
    sourceId: 'src',
    adapterId: 'a',
    mode: 'forward',
    status: 'RUNNING',
    startedAt: '2026-11-22T00:00:00.000Z',
    finishedAt: null,
    watermarkIn: null,
    watermarkOut: null,
    cursorIn: null,
    cursorOut: null,
    counts: { fetched: 0, created: 0, duplicates: 0, failed: 0, candidates: 0 },
    errors: [],
    meta: {},
  });
  assert.equal((await repos.runs.get(run.id))?.status, 'RUNNING');
  assert.equal((await repos.runs.list({ sourceId: 'src' })).length, 1);
  assert.equal((await repos.runs.list({ status: 'COMPLETED' })).length, 0);
  const cleaned = sanitizeError('request failed with key SECRET123 at https://x', ['SECRET123']);
  assert.ok(!cleaned.includes('SECRET123'));
  assert.ok(cleaned.includes('[REDACTED]'));
});
