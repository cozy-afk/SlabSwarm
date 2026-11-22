import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import {
  getJson,
  makeEmptyState,
  makeState,
  seedObservations,
  startApp,
  type StartedApp,
} from './fixtures.ts';

let app: StartedApp;
let emptyApp: StartedApp;

before(async () => {
  app = await startApp(makeState());
  await seedObservations(app.repositories);
  emptyApp = await startApp(makeEmptyState());
});

after(() => {
  app?.server.close();
  emptyApp?.server.close();
});

function assertEnvelope(body: any): asserts body is { data: any; meta: any } {
  assert.deepEqual(Object.keys(body).sort(), ['data', 'meta']);
  assert.equal(body.meta.contractVersion, '2026-11-22.1');
  assert.equal(body.meta.correctionPolicy, 'APPEND_ONLY');
  assert.match(body.meta.requestId, /^[0-9a-f-]{36}$/);
  assert.match(body.meta.generatedAt, /^\d{4}-\d\d-\d\dT/);
  assert.ok(Array.isArray(body.meta.warnings));
}

function assertProvenance(row: any): void {
  const p = row.provenance;
  assert.ok(p, 'row carries provenance');
  for (const key of ['source', 'basis', 'currency', 'observedAt', 'capturedAt', 'lineage', 'confidence']) {
    assert.ok(key in p, `provenance carries ${key}`);
  }
  assert.equal(p.observedAt, p.observed_at);
  assert.equal(p.capturedAt, p.captured_at);
  assert.ok(Array.isArray(p.lineage) && p.lineage.length > 0);
  assert.ok(typeof row.source === 'string' && row.source.length > 0);
  assert.ok(typeof row.basis === 'string' && row.basis.length > 0);
  assert.ok(typeof row.currency === 'string' && row.currency.length > 0);
}

test('GET /api/catalog/search returns the { data, meta } envelope with provenance rows', async () => {
  const { status, body } = await getJson(app.baseUrl, '/api/catalog/search?q=charizard');
  assert.equal(status, 200);
  assertEnvelope(body);
  assert.ok(Array.isArray(body.data));
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0].id, 'A1');
  assert.equal(body.data[0].name, 'Charizard');
  assert.equal(body.data[0].game, 'Pokemon');
  assert.equal(body.data[0].set, 'Base Set');
  assert.equal(body.data[0].number, '4');
  assert.equal(body.data[0].identityConfidence, 'HIGH');
  assertProvenance(body.data[0]);
});

test('GET /api/catalog/search filters and honors limit', async () => {
  assert.equal((await getJson(app.baseUrl, '/api/catalog/search?q=pikachu')).body.data[0].id, 'A2');
  assert.equal((await getJson(app.baseUrl, '/api/catalog/search?q=Base')).body.data.length, 2);
  const limited = await getJson(app.baseUrl, '/api/catalog/search?q=Base&limit=1');
  assert.equal(limited.body.data.length, 1);
  const noMatch = await getJson(app.baseUrl, '/api/catalog/search?q=does-not-exist');
  assert.equal(noMatch.status, 200);
  assert.deepEqual(noMatch.body.data, []);
  assert.ok(noMatch.body.meta.warnings.some((w: string) => w.includes('No catalog items matched')));
});

test('GET /api/catalog/:id returns one row and meta provenance', async () => {
  const { status, body } = await getJson(app.baseUrl, '/api/catalog/A1');
  assert.equal(status, 200);
  assertEnvelope(body);
  assert.equal(body.data.id, 'A1');
  assertProvenance(body.data);
  assert.deepEqual(body.meta.provenance, body.data.provenance);
});

test('GET /api/catalog/:id/printings preserves POPULATION basis and UNKNOWN missing values', async () => {
  const { status, body } = await getJson(app.baseUrl, '/api/catalog/A1/printings');
  assert.equal(status, 200);
  assertEnvelope(body);
  assert.equal(body.data.length, 3);
  for (const row of body.data) assertProvenance(row);
  const top = body.data[0];
  assert.equal(top.basis, 'POPULATION');
  assert.equal(top.gradingPopulation, 120);
  const unknownPop = body.data[1];
  assert.equal(unknownPop.gradingPopulation, 'UNKNOWN');
  assert.equal(unknownPop.basis, 'UNKNOWN');
  assert.equal(unknownPop.language, 'UNKNOWN');
  assert.notEqual(unknownPop.gradingPopulation, 0);
});

test('unknown ids return a 404 error envelope on every id route', async () => {
  for (const path of [
    '/api/catalog/nope',
    '/api/catalog/nope/printings',
    '/api/pricing/nope',
    '/api/comps/nope',
    '/api/market/nope',
  ]) {
    const { status, body } = await getJson(app.baseUrl, path);
    assert.equal(status, 404, path);
    assert.equal(body.data, null, path);
    assert.equal(body.code, 'not_found', path);
    assert.match(body.error, /not found/i);
    assert.ok(body.meta.requestId && body.meta.contractVersion, path);
  }
});

test('empty catalog returns 200 with an empty array and an explicit warning', async () => {
  const { status, body } = await getJson(emptyApp.baseUrl, '/api/catalog/search?q=anything');
  assert.equal(status, 200);
  assertEnvelope(body);
  assert.deepEqual(body.data, []);
  assert.ok(body.meta.warnings.some((w: string) => w.includes('Catalog is empty')));
});

test('invalid query parameters return 400 error envelopes', async () => {
  for (const path of [
    '/api/catalog/search',
    '/api/catalog/search?q=A1&limit=0',
    '/api/pricing/A1?basis=FICTION',
  ]) {
    const { status, body } = await getJson(app.baseUrl, path);
    assert.equal(status, 400, path);
    assert.equal(body.data, null, path);
    assert.equal(body.code, 'validation_error', path);
    assert.ok(body.meta.contractVersion, path);
  }
});
