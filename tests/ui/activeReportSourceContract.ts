import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Source contract for the one-button insight view.
 *
 * Static assertions keep the browser bundle honest: it must render the real
 * ActiveReport response, keep the frozen contract shapes mirrored locally,
 * and never substitute invented numbers or placeholder copy.
 */
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const APP = 'src/App.tsx';
const VIEW = 'src/components/product/ActiveReportView.tsx';
const TYPES = 'src/types/dataProduct.ts';
const API = 'src/utils/dataProductApi.ts';

function read(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

test('active report: primary nav exposes the view and keeps existing views', () => {
  const app = read(APP);
  assert.match(app, /import \{ ActiveReportView \} from '\.\/components\/product\/ActiveReportView\.tsx'/);
  assert.ok(app.includes("'active-report'"), "nav must declare an 'active-report' entry");
  assert.match(
    app,
    /case 'active-report':\s*return <ActiveReportView \/>/,
    'route must render ActiveReportView'
  );
  for (const label of [
    'Sources',
    'Catalog',
    'Market Intelligence',
    'Research Swarm',
    'Forecast Lab',
    'Learning',
    'SQL Lab',
    'API / Hermes',
  ]) {
    assert.ok(app.includes(label), `existing nav entry ${label} must remain`);
  }
  // The entry must be real navigation, not a dead string in a comment/copy.
  assert.match(app, /id: 'active-report'/);
  assert.match(app, /label: 'Active Report'/);
});

test('active report: local UI types mirror the frozen shared contract', () => {
  const types = read(TYPES);
  for (const declaration of [
    "export const UNKNOWN = 'UNKNOWN'",
    'export type Basis =',
    'export type Freshness =',
    'export type Confidence =',
    'export interface EvidenceRef',
    'export interface PriceBand',
    'export interface ActiveCard',
    'export interface ActiveReportSummary',
    'export interface ActiveReport',
  ]) {
    assert.ok(types.includes(declaration), `types must declare ${declaration}`);
  }
  assert.ok(
    !/from\s+['"][^'"]*server/i.test(types),
    'browser-facing types must not import server code'
  );
  for (const basis of ['SOLD', 'ASKING', 'OFFER', 'GUIDE', 'CLAIM', 'POPULATION']) {
    assert.ok(types.includes(basis), `basis ${basis} must be explicit in the UI type`);
  }
});

test('active report: API module exposes the GET route and a typed fetcher', () => {
  const api = read(API);
  assert.ok(api.includes("activeReport: '/api/intelligence/active-report'"));
  assert.ok(api.includes("discoverySweep: '/api/intelligence/discovery-sweep'"));
  assert.match(api, /export function fetchActiveReport\(\): Promise<ApiEnvelope<ActiveReport>>/);
  assert.match(api, /fetchEnvelope<ActiveReport>\(ROUTES\.activeReport\)/);
});

test('active report: view renders every summary field and every card field with provenance', () => {
  const view = read(VIEW);
  for (const token of [
    'summary.totalEvidence',
    'summary.totalObservations',
    'summary.cardsObserved',
    'summary.insufficientEvidence',
    'summary.oldestObservationAt',
    'summary.newestObservationAt',
    'card.name',
    'card.set',
    'card.game',
    'card.basis',
    'card.currency',
    'card.observationCount',
    'card.lastObservedAt',
    'card.momentum7d',
    'card.momentum30d',
    'card.priceBand',
    'card.drivers',
    'card.invalidators',
    'card.evidence',
    'card.confidence',
    'card.freshness',
    'ref.source',
    'ref.observedAt',
  ]) {
    assert.ok(view.includes(token), `view must render ${token}`);
  }
  assert.match(view, /basis=\{card\.basis\}/, 'basis must be rendered explicitly');
  assert.match(view, /card\.currency/, 'currency must be rendered explicitly');
  assert.match(view, /observed_at=\{/, 'observed_at must be rendered from the response');
  assert.match(view, /source=\{/, 'source must be rendered from the response');
  assert.match(view, /<table/, 'cards must be rendered as a ranked table');
  assert.match(view, /rankCards\(/, 'table must be ranked deterministically');
});

test('active report: missing values are UNKNOWN verbatim, never zero or a guess', () => {
  const view = read(VIEW);
  assert.match(view, /const UNKNOWN_TEXT = 'UNKNOWN'/);
  assert.match(view, /typeof value !== 'number' \|\| !Number\.isFinite\(value\)/);
  assert.match(view, /band === UNKNOWN_TEXT/);
  assert.match(view, /evidence\.length === 0/);
  assert.ok(!/Math\.random|Date\.now\(\)/.test(view), 'no invented numbers or times');
});

test('active report: no placeholder strings in client sources', () => {
  // Split literals so this test file can name the banned tokens without itself
  // being flagged by a future repo-wide placeholder scan.
  const banned = [
    'TO' + 'DO',
    'Lo' + 'rem',
    'Coming' + ' soon',
    'T' + 'BD',
    'FI' + 'XME',
    'mo' + 'ck',
    'du' + 'mmy',
    'place' + 'holder',
  ];
  for (const file of [VIEW, TYPES, API, APP]) {
    const source = read(file).toLowerCase();
    for (const token of banned) {
      assert.ok(
        !source.includes(token.toLowerCase()),
        `${file} must not contain placeholder copy "${token}"`
      );
    }
  }
});

test('active report: Refresh sweeps first, then reloads, disables in flight, shows plain errors', () => {
  const view = read(VIEW);
  const sweep = view.indexOf('postEnvelope(ROUTES.discoverySweep');
  assert.ok(sweep >= 0, 'Refresh must POST the discovery sweep');
  const reload = view.indexOf('await loadReport()', sweep);
  assert.ok(reload > sweep, 'Refresh must reload the report after the sweep resolves');
  assert.match(view, /await fetchActiveReport\(\)/, 'reload must GET the real report');
  assert.match(view, /disabled=\{refreshing \|\| loading\}/);
  assert.match(view, /setRefreshError\(/);
  assert.match(view, /role="alert"[^>]*>\s*\{refreshError\}/, 'errors must appear as plain text');
});

test('active report: simulations are labelled hypotheses, not evidence', () => {
  const view = read(VIEW);
  assert.match(view, /hypothes[iy]/i, 'drivers/invalidators must be marked as hypotheses');
  assert.match(view, /never sales evidence/i);
});
