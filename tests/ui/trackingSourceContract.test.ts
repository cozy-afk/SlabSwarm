// Task 17 UI contract: the tracking view must display explicit basis/source,
// preserve UNKNOWN, mark calculators as ESTIMATE with visible assumptions and
// never wire an external notification provider or billing path into alerts.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const VIEW_PATH = new URL('../../src/components/product/TrackingView.tsx', import.meta.url);
const PAYLOAD_PATH = new URL('../../src/utils/trackingPayload.ts', import.meta.url);
const APP_PATH = new URL('../../src/App.tsx', import.meta.url);
const viewSource = readFileSync(VIEW_PATH, 'utf-8');
const payloadSource = readFileSync(PAYLOAD_PATH, 'utf-8');
const appSource = readFileSync(APP_PATH, 'utf-8');

test('the tracking view names valuation basis, source and UNKNOWN in rendered text', () => {
  assert.match(viewSource, /SOLD_DERIVED/);
  assert.match(viewSource, /basis/i);
  assert.match(viewSource, /source/i);
  assert.match(viewSource, /UNKNOWN/);
  assert.match(viewSource, /warnings/);
  assert.match(viewSource, /acquiredAt/);
  assert.match(viewSource, /feeTreatment/);
});

test('fee and tax output is marked ESTIMATE and shows its assumptions', () => {
  assert.match(viewSource, /assumptions/);
  assert.match(viewSource, /ESTIMATE/);
  assert.match(viewSource, /ASSUMED_FEE_SCHEDULE/);
  assert.match(viewSource, /ASSUMED_TAX_RATE/);
  assert.match(viewSource, /basisLabel/);
});

test('alerts are local in-app state with no external delivery or billing path', () => {
  assert.match(viewSource, /acknowledge/i);
  assert.match(viewSource, /no external delivery/i);
  assert.doesNotMatch(viewSource, /dispatchAlertToChannel|Discord Webhook|Telegram Bot/);
  assert.doesNotMatch(viewSource, /billing|checkout|payment/i);
});

test('the shipped forms send explicit cost and proceeds currencies through shared payload builders', () => {
  assert.match(viewSource, /buildHoldingPayload/);
  assert.match(viewSource, /buildSalePayload/);
  assert.match(viewSource, /aria-label="Cost currency"/);
  assert.match(viewSource, /aria-label="Proceeds currency"/);
  assert.match(viewSource, /required/);
  assert.match(payloadSource, /costCurrency/);
  assert.match(payloadSource, /proceedsCurrency/);
  assert.match(payloadSource, /UNKNOWN/, 'a blank selection remains UNKNOWN, never an invented currency');
});

test('the view is reachable from the existing operator app navigation', () => {
  assert.match(appSource, /TrackingView/);
  assert.match(appSource, /'tracking'/);
  assert.match(appSource, /case 'tracking'/);
});
