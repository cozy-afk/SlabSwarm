import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { getJson, makeState, seedObservations, seedTcgLedger, startApp, TCG_LEDGER_ID, type StartedApp } from './fixtures.ts';

let app: StartedApp;
let ledgerApp: StartedApp;

before(async () => {
  app = await startApp(makeState());
  await seedObservations(app.repositories);
  ledgerApp = await startApp(makeState());
  await seedTcgLedger(ledgerApp.repositories);
});

after(() => {
  app?.server.close();
  ledgerApp?.server.close();
});

const ROWS_WITH_BASIS = new Set(['SOLD', 'ASKING', 'OFFER', 'GUIDE', 'CLAIM', 'POPULATION', 'UNKNOWN']);

function assertMeta(body: any): void {
  assert.deepEqual(Object.keys(body).sort(), ['data', 'meta']);
  assert.equal(body.meta.contractVersion, '2026-11-22.1');
  assert.equal(body.meta.correctionPolicy, 'APPEND_ONLY');
  assert.ok(Array.isArray(body.meta.warnings));
}

function assertFactRow(row: any): void {
  const p = row.provenance;
  assert.ok(p, 'fact row carries provenance');
  assert.ok(typeof p.source === 'string' && p.source.length > 0);
  assert.ok(ROWS_WITH_BASIS.has(p.basis));
  assert.ok(typeof p.currency === 'string' && p.currency.length > 0);
  assert.equal(p.observed_at, p.observedAt);
  assert.equal(p.captured_at, p.capturedAt);
  assert.ok(Array.isArray(p.lineage) && p.lineage.length > 0);
  assert.ok(['UNKNOWN', 'LOW', 'MEDIUM', 'HIGH'].includes(p.confidence));
}

test('GET /api/pricing/:id uses one explicit-basis source group and never invents prices', async () => {
  const { status, body } = await getJson(app.baseUrl, '/api/pricing/A1');
  assert.equal(status, 200);
  assertMeta(body);
  assert.equal(body.data.targetId, 'A1');
  assert.equal(body.data.basis, 'SOLD');
  assert.equal(body.data.source, 'ebay_sold');
  assert.equal(body.data.currency, 'USD');
  assert.deepEqual([body.data.low, body.data.median, body.data.high], [80, 110, 130]);
  assert.equal(body.data.sampleSize, 5);
  assertFactRow(body.data);
  assert.deepEqual(body.meta.provenance, body.data.provenance);
  assert.equal(body.meta.basis, 'SOLD');
  assert.ok(body.meta.warnings.some((w: string) => w.includes('no cross-source aggregation or FX conversion')));
  assert.ok(!JSON.stringify(body).includes('250'), 'ASKING quote is not priced as SOLD');
  assert.ok(!JSON.stringify(body).includes('"EUR"'), 'EUR quote is not mixed into USD summary');
});

test('GET /api/pricing/:id?basis=ASKING preserves the requested basis', async () => {
  const { status, body } = await getJson(app.baseUrl, '/api/pricing/A1?basis=ASKING');
  assert.equal(status, 200);
  assert.equal(body.data.basis, 'ASKING');
  assert.deepEqual([body.data.low, body.data.median, body.data.high], [250, 250, 250]);
  assert.equal(body.data.sampleSize, 1);
  assert.equal(body.meta.basis, 'ASKING');
  assertFactRow(body.data);
});

test('GET /api/pricing/:id with no observations returns UNKNOWN, not zero', async () => {
  const { status, body } = await getJson(app.baseUrl, '/api/pricing/A2');
  assert.equal(status, 200);
  assertMeta(body);
  assert.equal(body.data.low, 'UNKNOWN');
  assert.equal(body.data.median, 'UNKNOWN');
  assert.equal(body.data.high, 'UNKNOWN');
  assert.equal(body.data.currency, 'UNKNOWN');
  assert.equal(body.data.sampleSize, 0);
  assert.equal(body.data.provenance.confidence, 'UNKNOWN');
  assertFactRow(body.data);
  assert.ok(body.meta.warnings.some((w: string) => w.includes('all prices are UNKNOWN')));
});

test('GET /api/comps/:id returns SOLD-only comps with provenance and source separation', async () => {
  const { status, body } = await getJson(app.baseUrl, '/api/comps/A1');
  assert.equal(status, 200);
  assertMeta(body);
  assert.equal(body.data.length, 8);
  for (const row of body.data) {
    assert.equal(row.basis, 'SOLD');
    assertFactRow(row);
  }
  const currencies = new Set(body.data.map((row: any) => row.currency));
  assert.deepEqual([...currencies].sort(), ['EUR', 'USD']);
  const sources = new Set(body.data.map((row: any) => row.source));
  assert.deepEqual([...sources].sort(), ['cardmarket', 'ebay_sold', 'tcgplayer']);
  assert.ok(body.data.some((row: any) => row.amount === 'UNKNOWN'), 'zero amount stays UNKNOWN');
  assert.ok(!body.data.some((row: any) => row.amount === 0));
  assert.ok(!body.data.some((row: any) => row.amount === 9999 || row.amount === 1100));
  assert.ok(body.meta.warnings.some((w: string) => w.includes('non-SOLD')));
  assert.ok(body.meta.warnings.some((w: string) => w.includes('CONTESTED/SUPERSEDED')));
});

test('comps can be narrowed to one marketplace without cross-source math', async () => {
  const { status, body } = await getJson(app.baseUrl, '/api/comps/A1?source=ebay_sold');
  assert.equal(status, 200);
  assert.equal(body.data.length, 6);
  assert.ok(body.data.every((row: any) => row.source === 'ebay_sold'));
});

test('comps for a card with no observations are an empty array, not invented rows', async () => {
  const { status, body } = await getJson(app.baseUrl, '/api/comps/A2');
  assert.equal(status, 200);
  assert.deepEqual(body.data, []);
  assert.ok(body.meta.warnings.some((w: string) => w.includes('No eligible SOLD comps')));
});

test('GET /api/market/:id keeps marketplace sources separate and computes deterministic momentum', async () => {
  const { status, body } = await getJson(app.baseUrl, '/api/market/A1');
  assert.equal(status, 200);
  assertMeta(body);
  assert.equal(body.data.targetId, 'A1');
  assert.equal(body.data.askCount, 1);
  assert.equal(body.data.soldCount30d, 5);
  assert.equal(body.data.momentum, 'HEATING');
  assert.equal(body.data.sources.length, 3);
  for (const source of body.data.sources) {
    assert.ok(source.source && source.currency);
    assert.ok(source.basisBreakdown);
    assertFactRow(source);
  }
  assertFactRow(body.data);
  const cardmarket = body.data.sources.find((s: any) => s.source === 'cardmarket');
  assert.equal(cardmarket.currency, 'EUR');
  assert.equal(cardmarket.askCount, 'UNKNOWN');
  assert.equal(cardmarket.soldCount30d, 1);
  assert.ok(cardmarket.basisBreakdown.SOLD === 1);
  assert.ok(body.meta.warnings.some((w: string) => w.includes('never summed')));
  assert.ok(body.meta.warnings.some((w: string) => w.includes('no cross-source aggregation')));
});

test('market snapshot for an unobserved card returns UNKNOWN counts and momentum', async () => {
  const { status, body } = await getJson(app.baseUrl, '/api/market/A2');
  assert.equal(status, 200);
  assert.equal(body.data.askCount, 'UNKNOWN');
  assert.equal(body.data.soldCount30d, 'UNKNOWN');
  assert.equal(body.data.momentum, 'UNKNOWN');
  assert.deepEqual(body.data.sources, []);
  assertFactRow(body.data);
});

test('market provenance references the immutable evidence lineage', async () => {
  const { body } = await getJson(app.baseUrl, '/api/comps/A1');
  const comp = body.data.find((row: any) => row.provenance.source === 'ebay_sold');
  assert.ok(comp);
  assert.ok(comp.provenance.lineage.some((entry: string) => entry.startsWith('raw-ebay_sold')));
  assert.equal(comp.provenance.confidence, 'HIGH');
  assert.match(comp.provenance.capturedAt, /^\d{4}-\d\d-\d\dT/);
});

test('served valuations are deterministic across repeated calls', async () => {
  const first = (await getJson(app.baseUrl, '/api/pricing/A1')).body.data;
  const second = (await getJson(app.baseUrl, '/api/pricing/A1')).body.data;
  assert.deepEqual(second, first);
  const marketFirst = (await getJson(app.baseUrl, '/api/market/A1')).body.data;
  const marketSecond = (await getJson(app.baseUrl, '/api/market/A1')).body.data;
  assert.deepEqual(marketSecond, marketFirst);
});

test('pricing resolves a graph-unknown ledger id and preserves GUIDE basis and currency', async () => {
  const { status, body } = await getJson(
    ledgerApp.baseUrl,
    `/api/pricing/${TCG_LEDGER_ID}?basis=GUIDE`,
  );
  assert.equal(status, 200);
  assertMeta(body);
  assert.equal(body.data.targetId, TCG_LEDGER_ID);
  assert.equal(body.data.basis, 'GUIDE');
  assert.equal(body.data.currency, 'USD');
  assert.deepEqual([body.data.low, body.data.median, body.data.high], [0.2, 0.65, 1]);
  assert.equal(body.data.sampleSize, 3);
  assert.equal(body.meta.basis, 'GUIDE');
  assert.equal(body.meta.currency, 'USD');
  assertFactRow(body.data);
  assert.equal(body.data.provenance.confidence, 'MEDIUM');
});

test('comps resolves a graph-unknown ledger id with SOLD-only, basis-safe rows', async () => {
  const { status, body } = await getJson(ledgerApp.baseUrl, `/api/comps/${TCG_LEDGER_ID}`);
  assert.equal(status, 200);
  assertMeta(body);
  assert.equal(body.data.length, 3);
  for (const row of body.data) {
    assert.equal(row.basis, 'SOLD');
    assert.equal(row.currency, 'USD');
    assertFactRow(row);
  }
  assert.deepEqual(body.data.map((row: any) => row.amount).sort((a: number, b: number) => a - b), [10, 12, 14]);
  assert.equal(body.meta.basis, 'SOLD');
  assert.ok(body.meta.warnings.some((w: string) => w.includes('non-SOLD')), 'GUIDE rows excluded');
});

test('market resolves a graph-unknown ledger id with sources kept separate', async () => {
  const { status, body } = await getJson(ledgerApp.baseUrl, `/api/market/${TCG_LEDGER_ID}`);
  assert.equal(status, 200);
  assertMeta(body);
  assert.equal(body.data.targetId, TCG_LEDGER_ID);
  assert.equal(body.data.sources.length, 2);
  const guide = body.data.sources.find((s: any) => s.source === 'tcgapis');
  const sold = body.data.sources.find((s: any) => s.source === 'ebay_sold');
  assert.ok(guide && sold);
  assert.equal(guide.basisBreakdown.GUIDE, 3);
  assert.equal(sold.basisBreakdown.SOLD, 3);
  assert.equal(guide.askCount, 'UNKNOWN');
  assert.equal(sold.soldCount30d, 3);
  for (const source of body.data.sources) assertFactRow(source);
  assertFactRow(body.data);
  assert.ok(body.meta.warnings.some((w: string) => w.includes('never summed')));
});

test('pricing of a graph-unknown ledger id with no matching basis stays UNKNOWN, not zero', async () => {
  const { status, body } = await getJson(ledgerApp.baseUrl, `/api/pricing/${TCG_LEDGER_ID}?basis=OFFER`);
  assert.equal(status, 200);
  assert.equal(body.data.low, 'UNKNOWN');
  assert.equal(body.data.median, 'UNKNOWN');
  assert.equal(body.data.high, 'UNKNOWN');
  assert.equal(body.data.sampleSize, 0);
  assert.equal(body.meta.basis, 'OFFER');
  assert.ok(body.meta.warnings.some((w: string) => w.includes('all prices are UNKNOWN')));
});
