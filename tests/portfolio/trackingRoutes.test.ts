// Task 17 API surface: real HTTP handlers over an ephemeral loopback port.
// The injected ledger is in memory; no network, listener or canonical write
// outside the test process, and no external notification provider is used.

import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import express, { type Express } from 'express';

import { createInMemoryRepositories } from '../../server/ingest/store.ts';
import { createTrackingStore } from '../../server/portfolio/trackingStore.ts';
import { createTrackingRouter, mountTrackingRouter } from '../../server/portfolio/trackingRoutes.ts';
import type { TrackingStore } from '../../server/portfolio/trackingStore.ts';
import { buildHoldingPayload, buildSalePayload } from '../../src/utils/trackingPayload.ts';

const NOW = new Date('2026-11-23T00:00:00.000Z');
const OBSERVED = '2026-11-21T00:00:00.000Z';
const originalPasscode = process.env.SLABGRAPH_ADMIN_PASSCODE;

let server: Server;
let baseUrl: string;
let store: TrackingStore;
let repos: ReturnType<typeof createInMemoryRepositories>;

async function request(
  route: string,
  options: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${route}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.headers ?? {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  return { status: response.status, body: await response.json() };
}

function assertEnvelope(body: any): void {
  assert.ok(body && typeof body === 'object');
  assert.ok('data' in body && 'meta' in body);
  for (const field of ['requestId', 'generatedAt', 'contractVersion', 'correctionPolicy', 'warnings']) {
    assert.ok(field in body.meta, `meta.${field} is required`);
  }
  assert.equal(body.meta.correctionPolicy, 'APPEND_ONLY');
  assert.ok(typeof body.meta.basis === 'string');
  assert.ok(typeof body.meta.source === 'string');
  assert.ok(typeof body.meta.currency === 'string');
  assert.ok(body.meta.warnings.some((warning: string) => /no external delivery/i.test(warning)));
}

before(async () => {
  store = createTrackingStore({ now: () => NOW });
  repos = createInMemoryRepositories();
  for (const target of ['A1', 'A2']) {
    for (const [index, amount] of [100, 110, 105].entries()) {
      const evidence = await repos.evidence.create({
        sourceId: 'ebay_sold',
        sourceRecordId: `tracking-evidence-${target}-${index}`,
        capturedAt: NOW.toISOString(),
        observedAt: OBSERVED,
        checksum: `tracking-checksum-${target}-${index}`,
        mimeType: 'application/json',
        rawRef: `urn:tracking:${target}:${index}`,
        trustTier: 'HIGH',
      });
      await repos.marketObservations.create({
        evidenceId: evidence.id,
        targetIdentityRef: target,
        basis: 'SOLD',
        amount,
        currency: 'USD',
        marketplace: 'ebay_sold',
        observedAt: OBSERVED,
        status: 'NORMALIZED',
        ...(target === 'A1' ? { priceComponents: { grade: 'PSA 10' } } : {}),
      });
    }
  }
  for (const [index, amount] of [200, 210, 205].entries()) {
    const evidence = await repos.evidence.create({
      sourceId: 'ebay_sold',
      sourceRecordId: `tracking-a3-evidence-${index}`,
      capturedAt: NOW.toISOString(),
      observedAt: OBSERVED,
      checksum: `tracking-a3-checksum-${index}`,
      mimeType: 'application/json',
      rawRef: `urn:tracking:A3:${index}`,
      trustTier: 'HIGH',
    });
    await repos.marketObservations.create({
      evidenceId: evidence.id,
      targetIdentityRef: 'A3',
      basis: 'SOLD',
      amount,
      currency: 'USD',
      marketplace: 'ebay_sold',
      observedAt: OBSERVED,
      status: 'NORMALIZED',
      priceComponents: { grade: 'PSA 10' },
    });
  }
  for (const [grade, amounts] of [
    ['PSA 9', [90, 95, 100]],
    ['PSA 10', [190, 200, 210]],
  ] as const) {
    for (const [index, amount] of amounts.entries()) {
      const suffix = `${grade.replace(/\s/g, '')}-${index}`;
      const evidence = await repos.evidence.create({
        sourceId: 'ebay_sold',
        sourceRecordId: `tracking-a4-evidence-${suffix}`,
        capturedAt: NOW.toISOString(),
        observedAt: OBSERVED,
        checksum: `tracking-a4-checksum-${suffix}`,
        mimeType: 'application/json',
        rawRef: `urn:tracking:A4:${suffix}`,
        trustTier: 'HIGH',
      });
      await repos.marketObservations.create({
        evidenceId: evidence.id,
        targetIdentityRef: 'A4',
        basis: 'SOLD',
        amount,
        currency: 'USD',
        marketplace: 'ebay_sold',
        observedAt: OBSERVED,
        status: 'NORMALIZED',
        priceComponents: { grade },
      });
    }
  }
  const app: Express = express();
  app.use(express.json());
  mountTrackingRouter(app, {
    store,
    ledger: { evidence: repos.evidence, marketObservations: repos.marketObservations },
    now: () => NOW,
    engine: {
      getState: () => ({
        assets: [{
          id: 'A1', title: 'Charizard Base Set', franchise: 'Pokemon',
          setName: 'Base Set', cardNumber: '4', variant: 'Holo', segment: 'TCG',
          grades: [], prices: [], relationships: [], communities: [],
        }],
      }) as never,
    },
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  if (server) server.close();
});

test('GET /api/tracking/summary starts with UNKNOWN totals and a five-field envelope', async () => {
  const { status, body } = await request('/api/tracking/summary');
  assert.equal(status, 200);
  assertEnvelope(body);
  assert.deepEqual(body.data.watchlist, []);
  assert.deepEqual(body.data.holdings, []);
  assert.deepEqual(body.data.realized, []);
  assert.deepEqual(body.data.alerts, []);
  assert.equal(body.data.totals.unrealizedGain, 'UNKNOWN');
  assert.equal(body.meta.basis, 'SOLD_DERIVED');
  assert.equal(body.meta.currency, 'UNKNOWN');
});

test('watchlist CRUD uses the injected ledger FMV with explicit basis and source', async () => {
  const created = await request('/api/tracking/watchlist', {
    method: 'POST',
    body: { targetId: 'A1', note: 'grail' },
  });
  assert.equal(created.status, 201);
  assertEnvelope(created.body);
  assert.equal(created.body.data.grade, 'UNKNOWN');

  const listed = await request('/api/tracking/watchlist');
  assert.equal(listed.status, 200);
  const item = listed.body.data.items.find((row: any) => row.targetId === 'A1');
  assert.ok(item, 'watchlist item is listed');
  assert.equal(item.valuation.value, 105);
  assert.equal(item.valuation.basis, 'SOLD_DERIVED');
  assert.equal(item.valuation.source, 'ebay_sold');
  assert.equal(item.basis, 'SOLD_DERIVED');
  assert.equal(item.source, 'ebay_sold');
  assert.equal(item.identity.name, 'Charizard Base Set');
  assert.equal(item.identity.facets.set, 'Base Set');

  const removed = await request(`/api/tracking/watchlist/${item.id}`, { method: 'DELETE' });
  assert.equal(removed.status, 200);
  assert.deepEqual((await request('/api/tracking/watchlist')).body.data.items, []);
});

test('GET /api/tracking/valuation/:id returns UNKNOWN instead of inventing a price', async () => {
  const { status, body } = await request('/api/tracking/valuation/no-such-target');
  assert.equal(status, 200);
  assertEnvelope(body);
  assert.equal(body.data.value, 'UNKNOWN');
  assert.equal(body.data.currency, 'UNKNOWN');
  assert.equal(body.data.basis, 'SOLD_DERIVED');
  assert.equal(body.data.source, 'UNKNOWN');
  assert.equal(body.data.sampleSize, 0);
  assert.ok(body.meta.warnings.some((warning: string) => /UNKNOWN/i.test(warning)));
});

test('holdings and sales produce basis-named unrealized and realized rows', async () => {
  const added = await request('/api/tracking/holdings', {
    method: 'POST',
    body: {
      assetId: 'A1', grade: 'PSA 10', quantity: 2, unitCost: 80,
      costCurrency: 'USD', costBasis: 'PURCHASE_INVOICE', costSource: 'operator-entry',
    },
  });
  assert.equal(added.status, 201);
  assertEnvelope(added.body);
  assert.equal(added.body.data.acquiredAt, 'UNKNOWN');
  assert.equal(added.body.data.fees, 'UNKNOWN');
  assert.equal(added.body.data.shipping, 'UNKNOWN');

  const sold = await request('/api/tracking/sales', {
    method: 'POST',
    body: {
      holdingId: added.body.data.id, quantity: 2, unitProceeds: 150,
      proceedsCurrency: 'USD', proceedsBasis: 'SALE_CONTRACT', proceedsSource: 'operator-entry',
    },
  });
  assert.equal(sold.status, 201);
  assertEnvelope(sold.body);
  assert.equal(sold.body.data.soldAt, 'UNKNOWN');

  const summary = await request('/api/tracking/summary');
  assert.equal(summary.status, 200);
  const unrealized = summary.body.data.unrealized[0];
  assert.equal(unrealized.unrealized, 50);
  assert.equal(unrealized.basis, 'SOLD_DERIVED_FMV_MINUS_PURCHASE_INVOICE');
  assert.equal(unrealized.acquiredAt, 'UNKNOWN');
  assert.equal(unrealized.fees, 'UNKNOWN');
  assert.equal(unrealized.shipping, 'UNKNOWN');

  const realized = summary.body.data.realized[0];
  assert.equal(realized.gain, 140);
  assert.equal(realized.basis, 'SALE_CONTRACT_MINUS_PURCHASE_INVOICE');
  assert.equal(realized.soldAt, 'UNKNOWN');
  assert.equal(realized.feeTreatment, 'UNKNOWN_NOT_SUBTRACTED');
});

test('fee and tax endpoints return ESTIMATE artifacts with visible assumptions and no ledger write', async () => {
  const evidenceBefore = await repos.evidence.list();
  const observationsBefore = await repos.marketObservations.list();

  const fee = await request('/api/tracking/fees/estimate', {
    method: 'POST',
    body: {
      price: 200, currency: 'USD', marketplaceFeeRate: 0.1, processingFeeRate: 0.03,
      shippingReserve: 12, basisLabel: 'OPERATOR_FEE_TABLE_2026',
      assumptions: ['Marketplace fee 10%.', 'Buyer pays shipping.'],
    },
  });
  assert.equal(fee.status, 200);
  assertEnvelope(fee.body);
  assert.equal(fee.body.data.kind, 'ESTIMATE');
  assert.equal(fee.body.data.estimate, 38);
  assert.deepEqual(fee.body.data.assumptions, ['Marketplace fee 10%.', 'Buyer pays shipping.']);
  assert.equal(fee.body.meta.basis, 'ASSUMED_FEE_SCHEDULE');

  const tax = await request('/api/tracking/tax/estimate', {
    method: 'POST',
    body: {
      gain: 100, currency: 'USD', rate: 0.2, basisLabel: 'OPERATOR_TAX_RATE_2026',
      assumptions: ['Flat 20% estimate.'],
    },
  });
  assert.equal(tax.status, 200);
  assertEnvelope(tax.body);
  assert.equal(tax.body.data.kind, 'ESTIMATE');
  assert.equal(tax.body.data.estimate, 20);
  assert.equal(tax.body.meta.basis, 'ASSUMED_TAX_RATE');

  assert.deepEqual(await repos.evidence.list(), evidenceBefore, 'no canonical evidence was written');
  assert.deepEqual(await repos.marketObservations.list(), observationsBefore);
});

test('alert rules are stored, evaluated into in-app state and acknowledged locally', async () => {
  const rule = await request('/api/tracking/alerts/rules', {
    method: 'POST',
    body: { targetId: 'A1', metric: 'FMV_BELOW', threshold: 110, note: 'watch the floor' },
  });
  assert.equal(rule.status, 201);
  assertEnvelope(rule.body);
  assert.equal(rule.body.data.basis, 'SOLD_DERIVED');
  assert.equal(rule.body.data.channel, undefined, 'no external notification channel is configured');

  const evaluated = await request('/api/tracking/alerts/evaluate', { method: 'POST' });
  assert.equal(evaluated.status, 200);
  assertEnvelope(evaluated.body);
  const state = evaluated.body.data.states.find((row: any) => row.ruleId === rule.body.data.id);
  assert.ok(state);
  assert.equal(state.status, 'TRIGGERED');
  assert.equal(state.basis, 'SOLD_DERIVED');
  assert.equal(state.source, 'ebay_sold');

  const acknowledged = await request(`/api/tracking/alerts/${encodeURIComponent(state.id)}/ack`, {
    method: 'POST',
  });
  assert.equal(acknowledged.status, 200);
  assert.equal(acknowledged.body.data.acknowledged, true);

  const repeated = await request('/api/tracking/alerts/evaluate', { method: 'POST' });
  assert.equal(
    repeated.body.data.states.find((row: any) => row.id === state.id).acknowledged,
    true,
    'acknowledgement survives an identical refresh',
  );

  const deleted = await request(`/api/tracking/alerts/rules/${rule.body.data.id}`, { method: 'DELETE' });
  assert.equal(deleted.status, 200);
  assert.equal((await request('/api/tracking/alerts/rules')).body.data.rules.length, 0);
});

test('invalid input returns validation_error envelopes, never a partial write', async () => {
  const before = (await request('/api/tracking/holdings')).body.data.holdings.length;
  const missingBasis = await request('/api/tracking/holdings', {
    method: 'POST',
    body: { assetId: 'A1', unitCost: 100, costSource: 'operator-entry' },
  });
  assert.equal(missingBasis.status, 400);
  assertEnvelope(missingBasis.body);
  assert.equal(missingBasis.body.code, 'validation_error');

  const badMetric = await request('/api/tracking/alerts/rules', {
    method: 'POST',
    body: { targetId: 'A1', metric: 'FREE_MONEY', threshold: 1 },
  });
  assert.equal(badMetric.status, 400);
  assert.equal(badMetric.body.code, 'validation_error');

  const badSale = await request('/api/tracking/sales', {
    method: 'POST',
    body: { holdingId: 'no-holding', quantity: 1, unitProceeds: 10, proceedsBasis: 'SALE', proceedsSource: 'x' },
  });
  assert.equal(badSale.status, 400);
  assert.equal((await request('/api/tracking/holdings')).body.data.holdings.length, before);
});

// The mounted-app gate check is deliberately separate from the bare router
// tests above: it drives the real createApp() wiring with a real passcode.

test('a graded holding uses grade-filtered FMV and stays UNKNOWN without graded comps', async () => {
  const graded = await request('/api/tracking/holdings', {
    method: 'POST',
    body: {
      assetId: 'A2', grade: 'PSA 10', quantity: 1, unitCost: 80,
      costCurrency: 'USD', costBasis: 'PURCHASE_INVOICE', costSource: 'operator-entry',
    },
  });
  assert.equal(graded.status, 201);
  const ungraded = await request('/api/tracking/holdings', {
    method: 'POST',
    body: {
      assetId: 'A2', quantity: 1, unitCost: 80,
      costCurrency: 'USD', costBasis: 'PURCHASE_INVOICE', costSource: 'operator-entry',
    },
  });
  assert.equal(ungraded.status, 201);

  const summary = await request('/api/tracking/summary');
  const gradedRow = summary.body.data.unrealized.find((row: any) => row.holdingId === graded.body.data.id);
  const ungradedRow = summary.body.data.unrealized.find((row: any) => row.holdingId === ungraded.body.data.id);
  assert.equal(ungradedRow.valuation.value, 105);
  assert.equal(gradedRow.valuation.value, 'UNKNOWN', 'no PSA 10 comps means no graded price');
  assert.equal(gradedRow.unrealized, 'UNKNOWN');
  assert.ok(gradedRow.warnings.some((warning: string) => /grade/i.test(warning)));

  const withComps = await request('/api/tracking/holdings', {
    method: 'POST',
    body: {
      assetId: 'A3', grade: 'PSA 10', quantity: 1, unitCost: 180,
      costCurrency: 'USD', costBasis: 'PURCHASE_INVOICE', costSource: 'operator-entry',
    },
  });
  assert.equal(withComps.status, 201);
  const priced = (await request('/api/tracking/summary')).body.data.unrealized
    .find((row: any) => row.holdingId === withComps.body.data.id);
  assert.equal(priced.valuation.value, 205, 'only explicitly graded SOLD comps price a graded holding');
  assert.equal(priced.unrealized, 25);
});

test('two graded alert rules on one target evaluate their own grade, not the last snapshot', async () => {
  const psa9 = await request('/api/tracking/alerts/rules', {
    method: 'POST',
    body: { targetId: 'A4', grade: 'PSA 9', metric: 'FMV_BELOW', threshold: 120 },
  });
  const psa10 = await request('/api/tracking/alerts/rules', {
    method: 'POST',
    body: { targetId: 'A4', grade: 'PSA 10', metric: 'FMV_BELOW', threshold: 120 },
  });
  assert.equal(psa9.status, 201);
  assert.equal(psa10.status, 201);

  const evaluated = await request('/api/tracking/alerts/evaluate', { method: 'POST' });
  assert.equal(evaluated.status, 200);
  const ninth = evaluated.body.data.states.find((state: any) => state.ruleId === psa9.body.data.id);
  const tenth = evaluated.body.data.states.find((state: any) => state.ruleId === psa10.body.data.id);
  assert.equal(ninth.value, 95, 'PSA 9 rule uses the PSA 9 FMV');
  assert.equal(ninth.status, 'TRIGGERED');
  assert.equal(ninth.grade, 'PSA 9');
  assert.equal(tenth.value, 200, 'PSA 10 rule uses the PSA 10 FMV');
  assert.equal(tenth.status, 'NOT_TRIGGERED');
  assert.equal(tenth.grade, 'PSA 10');
});

test('the shipped UI payload shape with explicit currencies produces valued holding and sale', async () => {
  const holdingPayload = buildHoldingPayload({
    assetId: 'A1',
    unitCost: '80',
    costCurrency: 'USD',
    costBasis: 'PURCHASE_INVOICE',
    costSource: 'operator-entry',
  });
  assert.equal(holdingPayload.costCurrency, 'USD', 'the form payload always names a currency');
  const added = await request('/api/tracking/holdings', { method: 'POST', body: holdingPayload });
  assert.equal(added.status, 201);
  assert.equal(added.body.data.costCurrency, 'USD');

  const salePayload = buildSalePayload({
    holdingId: added.body.data.id,
    unitProceeds: '150',
    proceedsCurrency: 'USD',
    proceedsBasis: 'SALE_CONTRACT',
    proceedsSource: 'operator-entry',
  });
  assert.equal(salePayload.proceedsCurrency, 'USD');
  const sold = await request('/api/tracking/sales', { method: 'POST', body: salePayload });
  assert.equal(sold.status, 201);
  assert.equal(sold.body.data.proceedsCurrency, 'USD');

  const summary = await request('/api/tracking/summary');
  const unrealized = summary.body.data.unrealized.find((row: any) => row.holdingId === added.body.data.id);
  const realized = summary.body.data.realized.find((row: any) => row.saleId === sold.body.data.id);
  assert.equal(unrealized.valuation.value, 105);
  assert.equal(unrealized.unrealized, 25, 'one unit priced against explicit USD cost');
  assert.equal(realized.gain, 70, 'one unit sold with explicit USD proceeds');
});

test('a UI payload without a known currency stays UNKNOWN instead of inventing one', async () => {
  const payload = buildHoldingPayload({
    assetId: 'A1',
    unitCost: '80',
    costCurrency: '',
    costBasis: 'PURCHASE_INVOICE',
    costSource: 'operator-entry',
  });
  assert.equal(payload.costCurrency, 'UNKNOWN');
  const added = await request('/api/tracking/holdings', { method: 'POST', body: payload });
  assert.equal(added.status, 201);
  assert.equal(added.body.data.costCurrency, 'UNKNOWN');

  const summary = await request('/api/tracking/summary');
  const row = summary.body.data.unrealized.find((entry: any) => entry.holdingId === added.body.data.id);
  assert.equal(row.unrealized, 'UNKNOWN');
  assert.ok(row.warnings.some((warning: string) => /UNKNOWN|FX conversion/i.test(warning)));
});

test('the mounted tracking routes sit behind the existing operator gate', async () => {
  const passcode = 'task17-operator-passcode';
  process.env.SLABGRAPH_ADMIN_PASSCODE = passcode;
  const moduleUrl = `../../server.ts?task17gate=${Date.now()}`;
  try {
    const { createApp } = await import(moduleUrl as string);
    const app: Express = await createApp({ trackingStore: createTrackingStore({ now: () => NOW }) });
    const bound = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      bound.once('listening', () => resolve());
      bound.once('error', reject);
    });
    const gateUrl = `http://127.0.0.1:${(bound.address() as AddressInfo).port}`;
    try {
      const anonymous = await fetch(`${gateUrl}/api/tracking/summary`);
      assert.equal(anonymous.status, 401, 'no public tracking route was added');
      assert.match((await anonymous.json()).error, /Operator authentication required/);

      const login = await fetch(`${gateUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ passcode }),
      });
      assert.equal(login.status, 200);
      const token = (await login.json()).token;
      const authorized = await fetch(`${gateUrl}/api/tracking/summary`, {
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(authorized.status, 200, 'the same route works with an operator session');
    } finally {
      await new Promise<void>((resolve) => bound.close(() => resolve()));
    }
  } finally {
    if (originalPasscode === undefined) delete process.env.SLABGRAPH_ADMIN_PASSCODE;
    else process.env.SLABGRAPH_ADMIN_PASSCODE = originalPasscode;
  }
});
