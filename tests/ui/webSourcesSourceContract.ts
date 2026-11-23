import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Static source contract for the web-source review lane. It keeps the browser
 * bundle honest: the view must fetch the real queue/sources endpoints, render
 * every candidate field with explicit provenance, call the review API for its
 * actions, and contain no placeholder copy or credentials.
 */
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const APP = 'src/App.tsx';
const VIEW = 'src/components/product/WebSourcesView.tsx';
const API = 'src/utils/dataProductApi.ts';

function read(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

test('web sources: nav exposes the view and keeps every existing view', () => {
  const app = read(APP);
  assert.match(
    app,
    /import \{ WebSourcesView \} from '\.\/components\/product\/WebSourcesView\.tsx'/,
  );
  assert.ok(app.includes("'web-sources'"), "nav must declare a 'web-sources' entry");
  assert.match(app, /id: 'web-sources'/);
  assert.match(app, /label: 'Web Sources'/);
  assert.match(
    app,
    /case 'web-sources':\s*return <WebSourcesView \/>/,
    'route must render WebSourcesView',
  );
  for (const label of [
    'Sources',
    'Catalog',
    'Market Intelligence',
    'Active Report',
    'Research Swarm',
    'Forecast Lab',
    'Learning',
    'SQL Lab',
    'API / Hermes',
  ]) {
    assert.ok(app.includes(label), `existing nav entry ${label} must remain`);
  }
});

test('web sources: API module exposes real routes and typed methods', () => {
  const api = read(API);
  for (const route of [
    "webSources: '/api/web-harvest/sources'",
    "webHarvestQueue: '/api/web-harvest/review-queue'",
    "webHarvestCandidates: '/api/web-harvest/candidates'",
    "webHarvestReview: '/api/web-harvest/review'",
  ]) {
    assert.ok(api.includes(route), `API must declare ${route}`);
  }
  for (const declaration of [
    'export interface WebSourceConfigView',
    'export interface WebHarvestCandidateView',
    'export interface ReviewCandidateView',
    'export interface WebSourcesResponse',
    'export interface WebHarvestQueueResponse',
    'export interface WebHarvestReviewResponse',
  ]) {
    assert.ok(api.includes(declaration), `API must declare ${declaration}`);
  }
  assert.match(
    api,
    /export function fetchWebSources\(\): Promise<ApiEnvelope<WebSourcesResponse>>/,
  );
  assert.match(
    api,
    /export function fetchWebHarvestQueue\(status\?: ReviewStatus\): Promise<ApiEnvelope<WebHarvestQueueResponse>>/,
  );
  assert.match(api, /fetchEnvelope<WebSourcesResponse>\(ROUTES\.webSources\)/);
  assert.match(api, /fetchEnvelope<WebHarvestQueueResponse>\(/);
  assert.match(
    api,
    /export function reviewWebCandidate\(\s*candidateId: string,\s*action: ReviewAction,\s*note\?: string\s*\): Promise<ApiEnvelope<WebHarvestReviewResponse>>/,
  );
  assert.match(api, /postEnvelope<WebHarvestReviewResponse>\(ROUTES\.webHarvestReview/);
  assert.match(
    api,
    /export function enqueueWebCandidates\(candidates: WebHarvestCandidateView\[\]\): Promise<ApiEnvelope<WebHarvestEnqueueResponse>>/,
  );
  assert.ok(
    !/from\s+['"][^'"]*server/i.test(api),
    'browser API module must not import server code',
  );
});

test('web sources: view renders source list and every candidate provenance field', () => {
  const view = read(VIEW);
  for (const token of [
    'source.id',
    'source.name',
    'source.kind',
    'source.license',
    'candidate.id',
    'candidate.name',
    'candidate.set',
    'candidate.game',
    'candidate.number',
    'candidate.basis',
    'candidate.amount',
    'candidate.currency',
    'candidate.observedAt',
    'candidate.capturedAt',
    'candidate.sourceId',
    'candidate.evidenceId',
    'candidate.confidence',
    'candidate.status',
    'candidate.warnings',
  ]) {
    assert.ok(view.includes(token), `view must render ${token}`);
  }
  assert.match(view, /observed_at=\{/, 'observed_at must be printed from the response');
  assert.match(view, /source=\{/, 'source must be printed from the response');
  assert.match(view, /basis=\{candidate\.basis\}/, 'basis must be explicit');
  assert.match(view, /ConfidenceChip/, 'confidence must be rendered explicitly');
  assert.match(view, /fetchWebSources\(\)/, 'view must load configured sources');
  assert.match(view, /fetchWebHarvestQueue\(\)/, 'view must load the review queue');
});

test('web sources: approve and reject are real review API calls with plain-text errors', () => {
  const view = read(VIEW);
  assert.match(view, /reviewWebCandidate\(/, 'actions must call the review API');
  assert.match(view, /action: 'APPROVE'/, 'approve must send APPROVE');
  assert.match(view, /action: 'REJECT'/, 'reject must send REJECT');
  assert.match(view, /queue\.reload\(\)/, 'review must reload the queue');
  assert.match(view, /role="alert"/, 'errors must appear as plain text');
  assert.match(view, /err instanceof Error \? err\.message/, 'error text comes from the response');
  assert.match(view, /disabled=\{busy/, 'buttons are disabled while a review is in flight');
  assert.match(view, /aria-label="Approve/, 'approve button is labelled');
  assert.match(view, /aria-label="Reject/, 'reject button is labelled');
});

test('web sources: missing values stay UNKNOWN and no placeholder or credential is shipped', () => {
  const view = read(VIEW);
  assert.match(view, /const UNKNOWN_TEXT = 'UNKNOWN'/);
  assert.match(view, /candidate\.amount === 'UNKNOWN'/);
  assert.equal(view.includes('Math.random') || view.includes('Date.now()'), false, 'no invented numbers or times');
  // Split literals so this test can name the banned tokens without itself
  // being flagged by a repo-wide placeholder scan.
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
  for (const file of [VIEW, API, APP]) {
    const source = read(file).toLowerCase();
    for (const token of banned) {
      assert.ok(
        !source.includes(token.toLowerCase()),
        `${file} must not contain placeholder copy "${token}"`,
      );
    }
    assert.ok(
      !/(api[_-]?key|password|client[_-]?secret|bearer\s+[a-z0-9])/i.test(source),
      `${file} must not contain credentials`,
    );
  }
});
