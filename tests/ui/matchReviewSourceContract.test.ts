// Task 16: static source contract for the internal Match QA view. The browser
// must call only the operator-gated API, show every hard attribute and its
// provenance, and never present a model suggestion as an identity decision.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const APP = 'src/App.tsx';
const VIEW = 'src/components/product/MatchReviewView.tsx';
const API = 'src/utils/dataProductApi.ts';

function read(file: string): string {
  return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

test('match QA: nav exposes the internal review view without removing existing tabs', () => {
  const app = read(APP);
  assert.match(app, /import \{ MatchReviewView \} from '\.\/components\/product\/MatchReviewView\.tsx'/);
  assert.ok(app.includes("'match-qa'"));
  assert.match(app, /id: 'match-qa'/);
  assert.match(app, /label: 'Match QA'/);
  assert.match(app, /case 'match-qa':\s*return <MatchReviewView \/>/);
  for (const label of ['Sources', 'Web Sources', 'Catalog', 'Market Intelligence', 'API / Hermes']) {
    assert.ok(app.includes(label), `existing tab ${label} must remain`);
  }
});

test('match QA: API module declares the gated queue, review and correction routes', () => {
  const api = read(API);
  for (const route of [
    "matchQueue: '/api/qa/match-queue'",
    "matchReview: '/api/qa/match-review'",
    "matchCorrections: '/api/qa/match-corrections'",
  ]) {
    assert.ok(api.includes(route), `API must declare ${route}`);
  }
  for (const declaration of [
    'export interface MatchAttributeView',
    'export interface MatchAssessmentView',
    'export interface MatchCandidateView',
    'export interface MatchCorrectionView',
    'export interface MatchQueueResponse',
    'export interface MatchReviewResponse',
    'export interface MatchCorrectionsResponse',
  ]) {
    assert.ok(api.includes(declaration), `API must declare ${declaration}`);
  }
  assert.match(api, /export function fetchMatchQueue\(status\?: MatchStatus\): Promise<ApiEnvelope<MatchQueueResponse>>/);
  assert.match(api, /export function fetchMatchCorrections\(candidateId\?: string\): Promise<ApiEnvelope<MatchCorrectionsResponse>>/);
  assert.match(api, /export function reviewMatchCandidate\(\s*candidateId: string,\s*action: MatchAction,\s*reviewer: string,\s*note\?: string\s*\): Promise<ApiEnvelope<MatchReviewResponse>>/);
  assert.match(api, /postEnvelope<MatchReviewResponse>\(ROUTES\.matchReview/);
  assert.ok(!/from\s+['"][^'"]*server/i.test(api), 'browser API module must not import server code');
});

test('match QA: view renders attributes, confidence and append-only correction provenance', () => {
  const view = read(VIEW);
  for (const token of [
    'candidate.id', 'candidate.title', 'candidate.status', 'candidate.evidenceId',
    'candidate.assessment.score', 'candidate.assessment.floor',
    'candidate.assessment.reasons', 'candidate.assessment.conflicts',
    'attribute.name', 'attribute.value', 'attribute.confidence',
    'correction.id', 'correction.action', 'correction.reviewer',
    'correction.decidedAt', 'correction.provenance',
    'fetchMatchQueue()', 'fetchMatchCorrections()', 'reviewMatchCandidate(',
    "action: 'APPROVE'", "action: 'REJECT'", 'role="alert"', 'UNKNOWN',
  ]) {
    assert.ok(view.includes(token), `view must render ${token}`);
  }
  assert.match(view, /aria-label="Approve/, 'approve button must be labelled');
  assert.match(view, /aria-label="Reject/, 'reject button must be labelled');
  assert.match(view, /disabled=\{busy/, 'buttons disable while a review is in flight');
  assert.ok(!/Math\.random|Date\.now\(\)/.test(view), 'no invented ids or times in the view');
});
