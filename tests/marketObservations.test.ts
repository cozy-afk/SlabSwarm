import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Express } from 'express';
import type { MarketObservation } from '../src/types/graph.ts';

// ---------------------------------------------------------------------------
// Unit tests of the observation store module (no HTTP).
// ---------------------------------------------------------------------------

let tempDataDir: string;
const originalDataDir = process.env.SLABGRAPH_DATA_DIR;
const originalTestMode = process.env.SLABGRAPH_TEST_MODE;
const originalPasscode = process.env.SLABGRAPH_ADMIN_PASSCODE;

// Minimal valid input: a fully-specified, single-card SOLD observation in USD.
function validInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tenantId: 'tenant-1',
    targetIdentityRef: 'printing-1',
    sourceId: 'src-1',
    sourceFeedType: 'API_RESULT',
    nativeSourceRecordId: 'native-1',
    observed_at: '2026-11-22T00:00:00.000Z',
    basis: 'SOLD',
    currency: 'USD',
    amount: 100,
    fees: null,
    shipping_amount: 20,
    tax_amount: 0,
    quantity: 1,
    price_kind: 'ITEM',
    marketplace: 'ebay_sold',
    region: 'US',
    raw_evidence: { note: 'sold listing' },
    priceComponents: {
      listed_amount: 100,
      item_amount: 100,
      shipping_amount: 20,
      shipping_included: false,
      shipping_estimated: false,
      shipping_source: 'SELLER_LISTING',
      buyer_premium: 0,
      platform_fee: null,
      seller_fee: null,
      tax_amount: 0,
      fee_basis: 'LISTED_AMOUNT',
      lot_quantity: 1,
      lot_total_amount: null,
      per_card_allocation_method: 'SINGLE_CARD',
      currency: 'USD',
      fx_rate_to_base: null,
      fx_source: null,
      fx_as_of: null,
    },
    ...overrides,
  };
}

before(() => {
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slabswarm-observations-'));
  process.env.SLABGRAPH_DATA_DIR = tempDataDir;
  process.env.SLABGRAPH_TEST_MODE = '1';
  delete process.env.SLABGRAPH_ADMIN_PASSCODE;
});

after(() => {
  if (originalDataDir === undefined) delete process.env.SLABGRAPH_DATA_DIR;
  else process.env.SLABGRAPH_DATA_DIR = originalDataDir;
  if (originalTestMode === undefined) delete process.env.SLABGRAPH_TEST_MODE;
  else process.env.SLABGRAPH_TEST_MODE = originalTestMode;
  if (originalPasscode === undefined) delete process.env.SLABGRAPH_ADMIN_PASSCODE;
  else process.env.SLABGRAPH_ADMIN_PASSCODE = originalPasscode;
  fs.rmSync(tempDataDir, { recursive: true, force: true });
});

test('addMarketObservation creates, listMarketObservations lists, and getMarketObservation returns by id', async () => {
  const mod = await import('../server/marketObservations.ts');
  const created = mod.addMarketObservation(validInput());
  assert.ok(created.id, 'created observation must have an id');
  assert.equal(created.basis, 'SOLD');
  assert.equal(created.amount, 100);

  const listed = mod.listMarketObservations({});
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.id, created.id);

  const fetched = mod.getMarketObservation(created.id);
  assert.equal(fetched?.id, created.id);
});

test('addMarketObservation rejects a missing basis (no default to a factual basis)', async () => {
  const mod = await import('../server/marketObservations.ts');
  const input = validInput();
  delete input.basis;
  assert.throws(
    () => mod.addMarketObservation(input),
    /basis|required/i,
    'missing basis must be rejected, not defaulted',
  );
});

test('addMarketObservation rejects an invalid explicit basis', async () => {
  const mod = await import('../server/marketObservations.ts');
  assert.throws(
    () => mod.addMarketObservation(validInput({ basis: 'FACT' })),
    /basis/i,
  );
});

test('addMarketObservation rejects FX when a non-USD currency lacks source/as-of provenance', async () => {
  const mod = await import('../server/marketObservations.ts');
  const input = validInput({
    currency: 'EUR',
    priceComponents: {
      ...(validInput().priceComponents as Record<string, unknown>),
      currency: 'EUR',
      fx_rate_to_base: 1.1,
      fx_source: null,
      fx_as_of: null,
    },
  });
  assert.throws(
    () => mod.addMarketObservation(input),
    /fx|provenance|source|as.of/i,
    'FX without source and as-of must be rejected',
  );
});

test('addMarketObservation accepts FX when provenance is present', async () => {
  const mod = await import('../server/marketObservations.ts');
  const input = validInput({
    currency: 'EUR',
    priceComponents: {
      ...(validInput().priceComponents as Record<string, unknown>),
      currency: 'EUR',
      fx_rate_to_base: 1.1,
      fx_source: 'ECB',
      fx_as_of: '2026-11-22',
    },
  });
  const created = mod.addMarketObservation(input);
  assert.equal(created.currency, 'EUR');
});

test('addMarketObservation rejects negative amounts', async () => {
  const mod = await import('../server/marketObservations.ts');
  assert.throws(
    () => mod.addMarketObservation(validInput({ amount: -5 })),
    /amount|negative/i,
  );
});

test('addMarketObservation rejects negative fees/shipping/tax', async () => {
  const mod = await import('../server/marketObservations.ts');
  assert.throws(
    () => mod.addMarketObservation(validInput({ fees: -1 })),
    /fee|negative/i,
  );
  assert.throws(
    () => mod.addMarketObservation(validInput({ shipping_amount: -1 })),
    /shipping|negative/i,
  );
});

test('unknown shipping/fees/currency remain UNKNOWN (null), never zero', async () => {
  const mod = await import('../server/marketObservations.ts');
  const created = mod.addMarketObservation(
    validInput({
      shipping_amount: null,
      fees: null,
      tax_amount: null,
      priceComponents: {
        ...(validInput().priceComponents as Record<string, unknown>),
        shipping_amount: null,
        buyer_premium: null,
        seller_fee: null,
        platform_fee: null,
        tax_amount: null,
      },
    }),
  );
  assert.equal(created.shipping_amount, null, 'unknown shipping must persist as null');
  assert.equal(created.fees, null, 'unknown fees must persist as null');
  assert.equal(created.tax_amount, null, 'unknown tax must persist as null');
  assert.equal(created.priceComponents.shipping_amount, null);
  assert.equal(created.priceComponents.landed_cost_buyer, null, 'unknown components stay unknown');
});

test('normalizePrice derived values are written into priceComponents while raw values stay separate', async () => {
  const mod = await import('../server/marketObservations.ts');
  const created = mod.addMarketObservation(validInput());
  // Raw listed amount is preserved; derived outputs are populated by normalizePrice.
  assert.equal(created.priceComponents.listed_amount, 100);
  assert.equal(created.priceComponents.landed_cost_buyer, 120);
  assert.equal(created.amount, 100, 'raw top-level amount is unchanged');
});

test('listMarketObservations filters by basis, target, status, tenant and source', async () => {
  const mod = await import('../server/marketObservations.ts');
  const a = mod.addMarketObservation(validInput({ nativeSourceRecordId: 'filter-a' }));
  const b = mod.addMarketObservation(
    validInput({ nativeSourceRecordId: 'filter-b', basis: 'ASKING', targetIdentityRef: 'printing-2' }),
  );
  assert.ok(mod.listMarketObservations({ basis: 'ASKING' }).some((o: MarketObservation) => o.id === b.id));
  assert.ok(mod.listMarketObservations({ basis: 'ASKING' }).every((o: MarketObservation) => o.id !== a.id));
  assert.ok(mod.listMarketObservations({ targetIdentityRef: 'printing-2' }).some((o: MarketObservation) => o.id === b.id));
  assert.ok(mod.listMarketObservations({ status: 'ACTIVE' }).some((o: MarketObservation) => o.id === a.id));
  assert.ok(mod.listMarketObservations({ tenantId: 'tenant-1' }).length >= 2);
  assert.ok(mod.listMarketObservations({ sourceId: 'src-1' }).length >= 2);
});

// ---------------------------------------------------------------------------
// HTTP route tests — drive the real Express app on an ephemeral port.
// ---------------------------------------------------------------------------

let createApp: typeof import('../server.ts')['createApp'];
let server: Server;
let baseUrl: string;

before(async () => {
  ({ createApp } = await import('../server.ts'));
  const app: Express = await createApp();
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', reject);
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(() => {
  if (server) server.close();
});

test('POST /api/market/observations then GET list and GET /:id', async () => {
  const postRes = await fetch(`${baseUrl}/api/market/observations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(validInput({ nativeSourceRecordId: 'http-1' })),
  });
  assert.equal(postRes.status, 201);
  const created = (await postRes.json()) as { observation?: MarketObservation };
  assert.ok(created.observation?.id);

  const listRes = await fetch(`${baseUrl}/api/market/observations?basis=SOLD`);
  assert.equal(listRes.status, 200);
  const list = (await listRes.json()) as { observations?: MarketObservation[] };
  assert.ok(Array.isArray(list.observations));
  assert.ok(list.observations?.some((o) => o.id === created.observation?.id));

  const getRes = await fetch(`${baseUrl}/api/market/observations/${created.observation?.id}`);
  assert.equal(getRes.status, 200);
  const got = (await getRes.json()) as { observation?: MarketObservation };
  assert.equal(got.observation?.id, created.observation?.id);
});

test('POST /api/market/observations rejects missing basis with 400', async () => {
  const input = validInput();
  delete input.basis;
  const res = await fetch(`${baseUrl}/api/market/observations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  assert.equal(res.status, 400);
});

test('GET /api/market/observations/:id returns 404 for an unknown id', async () => {
  const res = await fetch(`${baseUrl}/api/market/observations/does-not-exist`);
  assert.equal(res.status, 404);
});
