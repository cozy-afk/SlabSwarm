import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { backfillJson } from '../../scripts/backfill-json.ts';
import { createMemoryStore } from '../../server/db/store.ts';
import { createRepositories } from '../../server/db/repositories/index.ts';
import type { MarketObservationInput } from '../../server/contracts/dataProduct.ts';

const WORKTREE = path.resolve(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), '../..');
const FIXTURE = path.join(WORKTREE, 'tests/db/fixtures/slabgraph-fixture.json');
const REAL_SNAPSHOT = process.env.SLABGRAPH_DB_PATH?.trim()
  || '/opt/slabswarm/data/slabgraph-db.json';
const CAPTURED_AT = '2026-11-22T12:00:00.000Z';

function stats(samples: number[]): { p50: number; p95: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    p50: sorted[Math.floor(sorted.length * 0.5)] ?? 0,
    p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
  };
}

test('benchmark: JSON backfill parity on the checked-in fixture', async () => {
  const raw = fs.readFileSync(FIXTURE, 'utf-8');
  const started = performance.now();
  const report = await backfillJson(raw, createMemoryStore(), { capturedAt: CAPTURED_AT, source: 'fixture.json' });
  const elapsed = performance.now() - started;
  assert.equal(report.parity, true);
  assert.equal(report.imported.cards, 2);
  console.log(`# fixture_backfill_ms=${elapsed.toFixed(2)} bytes=${raw.length} invalid=${report.invalid.length}`);
  assert.ok(elapsed < 2000, `fixture backfill took ${elapsed.toFixed(2)}ms (limit 2000ms)`);
});

test('benchmark: JSON backfill parity on the real slabgraph snapshot (when present)', async (t) => {
  if (!fs.existsSync(REAL_SNAPSHOT)) {
    t.skip(`real snapshot not present at ${REAL_SNAPSHOT}`);
    return;
  }
  const raw = fs.readFileSync(REAL_SNAPSHOT, 'utf-8');
  const started = performance.now();
  const report = await backfillJson(raw, createMemoryStore(), { capturedAt: CAPTURED_AT, source: REAL_SNAPSHOT });
  const elapsed = performance.now() - started;
  assert.equal(report.parity, true, `real snapshot parity failed: ${JSON.stringify(report.notes)}`);
  console.log(
    `# real_backfill_ms=${elapsed.toFixed(2)} bytes=${raw.length} ` +
    `assets=${report.sourceCounts.assets} sales=${report.sourceCounts.sales} ` +
    `researchNotes=${report.sourceCounts.researchNotes} invalid=${report.invalid.length} ` +
    `imported=${JSON.stringify(report.imported)}`,
  );
  assert.ok(elapsed < 10_000, `real backfill took ${elapsed.toFixed(2)}ms (limit 10000ms)`);
});

test('benchmark: repository query latency over 1000 market observations', async () => {
  const repos = createRepositories(createMemoryStore());
  const input: MarketObservationInput = {
    evidenceId: 'evidence-bench',
    targetIdentityRef: 'card-bench',
    basis: 'SOLD',
    amount: 100,
    currency: 'USD',
    observedAt: '2026-11-22T00:00:00.000Z',
  };
  const seedStarted = performance.now();
  for (let i = 0; i < 1000; i += 1) {
    await repos.marketObservations.create({
      ...input,
      targetIdentityRef: `card-${i % 50}`,
      observedAt: new Date(Date.UTC(2026, 0, 1 + (i % 300))).toISOString(),
    });
  }
  const seedMs = performance.now() - seedStarted;

  const samples: number[] = [];
  for (let i = 0; i < 200; i += 1) {
    const started = performance.now();
    const rows = await repos.marketObservations.list({ basis: 'SOLD' });
    samples.push(performance.now() - started);
    assert.equal(rows.length, 1000);
  }
  const { p50, p95 } = stats(samples);
  console.log(`# repo_list_seed_ms=${seedMs.toFixed(2)} p50_ms=${p50.toFixed(3)} p95_ms=${p95.toFixed(3)} samples=${samples.length}`);
  assert.ok(p95 < 100, `p95 list latency ${p95.toFixed(3)}ms exceeds 100ms in-memory budget`);
});
