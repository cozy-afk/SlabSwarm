import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';

/**
 * Phase 2 / Task 6 — ingestion benchmark suite.
 *
 * Deterministic, fully in-process benchmarks over the ingestion lane:
 * duplicate rate, parse success rate, and run latency. No network, no live
 * keys, no DB. Metrics are printed as JSON so docs/benchmarks can quote them.
 */

import { createInMemoryRepositories } from '../../server/ingest/store.ts';
import { runIngest } from '../../server/ingest/runner.ts';
import { createCsvAdapter, parseCsv, previewCsv } from '../../server/ingest/adapters/csv.ts';

const HEADER = 'title,price,date,basis,currency,marketplace,url,grade,condition';

function csvFixture(validRows: number, malformedRows: number): string {
  const lines = [HEADER];
  for (let i = 0; i < validRows; i += 1) {
    lines.push(
      `Card ${i},${100 + i},2026-11-20,SOLD,USD,ebay_sold,https://example.com/${i},PSA 10,NM`,
    );
  }
  for (let i = 0; i < malformedRows; i += 1) {
    lines.push(`Broken ${i},10`); // too few columns
  }
  return lines.join('\n');
}

test('benchmark: duplicate rate on repeated CSV ingestion', async () => {
  const csv = csvFixture(30, 0);
  const repos = createInMemoryRepositories();
  const started = performance.now();
  const first = await runIngest(createCsvAdapter(), repos, {
    mode: 'backfill',
    options: { csv },
  });
  const second = await runIngest(createCsvAdapter(), repos, {
    mode: 'backfill',
    options: { csv },
  });
  const elapsedMs = performance.now() - started;
  const duplicateRate = second.run.counts.duplicates / first.run.counts.created;
  console.log(
    JSON.stringify({
      benchmark: 'ingestion-duplicate-rate',
      createdFirstRun: first.run.counts.created,
      duplicatesSecondRun: second.run.counts.duplicates,
      duplicateRate,
      elapsedMs: Number(elapsedMs.toFixed(2)),
    }),
  );
  assert.equal(first.run.counts.created, 30);
  assert.equal(second.run.counts.created, 0);
  assert.equal(duplicateRate, 1);
  assert.equal((await repos.evidence.list({ sourceId: 'csv' })).length, 30);
});

test('benchmark: parse success rate and UNKNOWN preservation', () => {
  const csv = csvFixture(97, 3);
  const parsed = parseCsv(csv);
  const preview = previewCsv(csv);
  const parseSuccessRate = preview.validRows / preview.totalRows;
  console.log(
    JSON.stringify({
      benchmark: 'ingestion-parse-success',
      totalRows: preview.totalRows,
      validRows: preview.validRows,
      invalidRows: preview.invalidRows,
      parseSuccessRate: Number(parseSuccessRate.toFixed(4)),
      parserErrors: parsed.errors.length,
    }),
  );
  assert.equal(preview.totalRows, 100);
  assert.equal(preview.validRows, 97);
  assert.equal(preview.invalidRows, 3);
  assert.ok(parseSuccessRate > 0.95);
  const unknownCsv = 'title,price,date,basis,currency\nUnknown Card,,2026-11-20,,\n';
  const unknownRow = previewCsv(unknownCsv).rows[0];
  assert.equal(unknownRow?.price, null, 'missing price stays null, never zero');
  assert.equal(unknownRow?.basis, 'UNKNOWN');
  assert.equal(unknownRow?.currency, 'UNKNOWN');
});

test('benchmark: run latency over 100 items', async () => {
  const items = Array.from({ length: 100 }, (_, i) => ({
    nativeId: `bench:${i}`,
    observedAt: '2026-11-20T00:00:00.000Z',
    payload: { title: `Card ${i}`, price: 100 + i, basis: 'SOLD', currency: 'USD' },
  }));
  const adapter = {
    id: 'bench',
    sourceId: 'bench-source',
    async fetch() {
      return { items };
    },
  };
  const started = performance.now();
  const result = await runIngest(adapter, createInMemoryRepositories(), { mode: 'backfill' });
  const elapsedMs = performance.now() - started;
  console.log(
    JSON.stringify({
      benchmark: 'ingestion-run-latency',
      items: items.length,
      created: result.run.counts.created,
      candidates: result.run.counts.candidates,
      elapsedMs: Number(elapsedMs.toFixed(2)),
      msPerItem: Number((elapsedMs / items.length).toFixed(3)),
    }),
  );
  assert.equal(result.run.status, 'COMPLETED');
  assert.equal(result.run.counts.created, 100);
  assert.ok(elapsedMs < 5000, `run latency ${elapsedMs.toFixed(1)}ms exceeded 5000ms budget`);
});
