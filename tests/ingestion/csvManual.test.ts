import assert from 'node:assert/strict';
import { test } from 'node:test';

const csvMod = () => import('../../server/ingest/adapters/csv.ts');
const manualMod = () => import('../../server/ingest/adapters/manual.ts');
const storeMod = () => import('../../server/ingest/store.ts');
const runnerMod = () => import('../../server/ingest/runner.ts');

const CSV = [
  'title,price,date,basis,currency,marketplace,url,grade,condition',
  'Charizard,250.00,2026-11-20,SOLD,USD,ebay_sold,https://example.com/1,PSA 10,NM',
  '"Pikachu, Reverse",80,2026-11-21,ASKING,USD,tcgplayer,https://example.com/2,Raw NM,LP',
  'Broken Row,not-a-price,2026-11-21,WILDGUESS,usd,,not-a-url,,',
  'Short Row,10',
].join('\r\n');

test('parseCsv handles quoted commas, CRLF and reports malformed rows', async () => {
  const { parseCsv } = await csvMod();
  const parsed = parseCsv(CSV);
  assert.deepEqual(parsed.headers.slice(0, 3), ['title', 'price', 'date']);
  assert.equal(parsed.rows.length, 4);
  assert.equal(parsed.rows[1]?.cells[0], 'Pikachu, Reverse');
  assert.ok(parsed.errors.some((e: { message: string }) => /column|field/i.test(e.message)));
});

test('previewCsv maps columns, keeps unknown values UNKNOWN and writes nothing', async () => {
  const { previewCsv } = await csvMod();
  const preview = previewCsv(CSV);
  assert.equal(preview.totalRows, 4);
  assert.ok(preview.validRows >= 2);
  assert.ok(preview.invalidRows >= 1);
  const good = preview.rows.find((r: Record<string, unknown>) => r.title === 'Charizard');
  assert.equal(good?.basis, 'SOLD');
  assert.equal(good?.price, 250);
  const unknown = preview.rows.find((r: Record<string, unknown>) => r.title === 'Broken Row');
  assert.equal(unknown?.basis, 'UNKNOWN', 'invalid basis is UNKNOWN, never guessed');
  assert.equal(unknown?.price, null, 'invalid price is null, not zero');
  assert.equal(unknown?.currency, 'UNKNOWN');
  assert.equal(unknown?.grade, null);
  assert.equal(unknown?.condition, null);
});

test('CSV adapter ingests valid rows and captures malformed row errors in the run', async () => {
  const { createInMemoryRepositories } = await storeMod();
  const { runIngest } = await runnerMod();
  const { createCsvAdapter } = await csvMod();
  const repos = createInMemoryRepositories();
  const adapter = createCsvAdapter();
  const result = await runIngest(adapter, repos, {
    mode: 'backfill',
    options: { csv: CSV },
  });
  assert.equal(result.run.status, 'PARTIAL');
  assert.equal(result.run.counts.created, 3, 'three structurally complete rows');
  assert.ok(
    result.run.errors.some((e) => /column|field/i.test(e.message)),
    'malformed rows are captured, not silently dropped',
  );
  assert.equal((await repos.evidence.list({ sourceId: 'csv' })).length, 3);
});

test('manual note adapter accepts URL, date and source fields', async () => {
  const { createInMemoryRepositories } = await storeMod();
  const { runIngest } = await runnerMod();
  const { createManualAdapter } = await manualMod();
  const repos = createInMemoryRepositories();
  const result = await runIngest(createManualAdapter(), repos, {
    mode: 'backfill',
    options: {
      note: {
        text: 'Seller listed a PSA 10 Charizard at $250',
        sourceUrl: 'https://example.com/listing',
        observedAt: '2026-11-19',
        source: 'user-note',
        basis: 'CLAIM',
        amount: 250,
        currency: 'USD',
        confidence: 'LOW',
      },
    },
  });
  assert.equal(result.run.status, 'COMPLETED');
  assert.equal(result.evidence.length, 1);
  const evidence = result.evidence[0];
  assert.equal(evidence?.sourceUri, 'https://example.com/listing');
  assert.equal(evidence?.observedAt, '2026-11-19');
  assert.equal((evidence?.parsedPayload as Record<string, unknown>).source, 'user-note');
  const candidate = result.candidates[0];
  assert.equal(candidate?.basis, 'CLAIM');
  assert.equal(candidate?.amount, 250);
  assert.equal(candidate?.confidence, 'LOW');
});

test('manual note with unknown date/basis keeps UNKNOWN values and records a parse error', async () => {
  const { createInMemoryRepositories } = await storeMod();
  const { runIngest } = await runnerMod();
  const { createManualAdapter } = await manualMod();
  const repos = createInMemoryRepositories();
  const result = await runIngest(createManualAdapter(), repos, {
    mode: 'backfill',
    options: { note: { text: 'Heard it sold for a lot', observedAt: 'not-a-date' } },
  });
  assert.equal(result.candidates[0]?.basis, 'UNKNOWN');
  assert.equal(result.candidates[0]?.amount, null);
  assert.ok(result.run.errors.some((e) => /date/i.test(e.message)));
});

test('manual note adapter rejects empty text without creating evidence', async () => {
  const { createInMemoryRepositories } = await storeMod();
  const { runIngest } = await runnerMod();
  const { createManualAdapter } = await manualMod();
  const repos = createInMemoryRepositories();
  const result = await runIngest(createManualAdapter(), repos, {
    mode: 'backfill',
    options: { note: { text: '  ' } },
  });
  assert.equal(result.run.counts.created, 0);
  assert.equal(result.run.status, 'FAILED');
  assert.ok(result.run.errors.some((e) => /text/i.test(e.message)));
});
