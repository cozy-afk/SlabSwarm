import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { getJson, makeState, seedObservations, startApp, type StartedApp } from './fixtures.ts';

let app: StartedApp;

before(async () => {
  app = await startApp(makeState());
  await seedObservations(app.repositories);
});

after(() => {
  app?.server.close();
});

const SUCCESS_PATHS = [
  '/api/catalog/search?q=charizard',
  '/api/catalog/A1',
  '/api/catalog/A1/printings',
  '/api/pricing/A1',
  '/api/comps/A1',
  '/api/market/A1',
];

test('all six serving routes emit { data, meta } with contract metadata', async () => {
  for (const path of SUCCESS_PATHS) {
    const { status, body } = await getJson(app.baseUrl, path);
    assert.equal(status, 200, path);
    assert.deepEqual(Object.keys(body).sort(), ['data', 'meta'], path);
    assert.equal(body.meta.contractVersion, '2026-11-22.1', path);
    assert.equal(body.meta.correctionPolicy, 'APPEND_ONLY', path);
    assert.ok(body.meta.requestId, path);
    assert.ok(body.meta.generatedAt, path);
    assert.ok(Array.isArray(body.meta.warnings), path);
  }
});

test('all fact rows carry source, basis, currency and provenance timestamps', async () => {
  for (const path of SUCCESS_PATHS) {
    const { body } = await getJson(app.baseUrl, path);
    const rows = Array.isArray(body.data) ? body.data : [body.data];
    for (const row of rows) {
      assert.ok(typeof row.source === 'string' && row.source.length > 0, `${path} source`);
      assert.ok(typeof row.basis === 'string' && row.basis.length > 0, `${path} basis`);
      assert.ok(typeof row.currency === 'string' && row.currency.length > 0, `${path} currency`);
      const p = row.provenance;
      assert.ok(p, `${path} provenance`);
      for (const key of ['source', 'basis', 'currency', 'observedAt', 'capturedAt', 'lineage', 'confidence']) {
        assert.ok(key in p, `${path} provenance.${key}`);
      }
      assert.equal(p.observed_at, p.observedAt, path);
      assert.equal(p.captured_at, p.capturedAt, path);
    }
  }
});

test('basis is explicit and never silently promoted across market endpoints', async () => {
  const pricing = (await getJson(app.baseUrl, '/api/pricing/A1')).body;
  const comps = (await getJson(app.baseUrl, '/api/comps/A1')).body;
  const market = (await getJson(app.baseUrl, '/api/market/A1')).body;
  assert.equal(pricing.meta.basis, 'SOLD');
  assert.equal(pricing.data.basis, 'SOLD');
  assert.equal(comps.meta.basis, 'SOLD');
  assert.ok(comps.data.every((row: any) => row.basis === 'SOLD'));
  assert.equal(market.meta.basis, 'UNKNOWN');
  const breakdown = market.data.sources.flatMap((s: any) => Object.keys(s.basisBreakdown));
  assert.ok(breakdown.includes('ASKING'));
  assert.ok(breakdown.includes('SOLD'));
  assert.ok(!JSON.stringify(pricing).includes('9999'), 'contested quote never enters pricing');
});

test('missing values are the literal UNKNOWN, never null or zero', async () => {
  const paths = [
    '/api/catalog/A1/printings',
    '/api/pricing/A2',
    '/api/market/A2',
  ];
  for (const path of paths) {
    const { body } = await getJson(app.baseUrl, path);
    const text = JSON.stringify(body);
    assert.ok(text.includes('UNKNOWN'), path);
    assert.ok(!text.includes(':null'), `${path} must not use null for missing values`);
  }
  const printings = (await getJson(app.baseUrl, '/api/catalog/A1/printings')).body.data;
  assert.ok(printings.every((p: any) => p.language === 'UNKNOWN'));
  assert.ok(printings.some((p: any) => p.gradingPopulation === 'UNKNOWN'));
});
