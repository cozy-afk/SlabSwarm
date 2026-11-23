// Task 16: the internal QA queue is exposed only through the existing
// operator-gated Express app. No listener, firewall or DNS change is made.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import express, { type Express } from 'express';

import { createRepositories } from '../../server/db/repositories/index.ts';
import { createMemoryStore } from '../../server/db/store.ts';
import { createMatchReviewQueue } from '../../server/identity/qaQueue.ts';
import {
  createMatchReviewRouter,
  mountMatchReviewRouter,
} from '../../server/identity/qaRoutes.ts';

const NOW = '2026-11-23T00:00:00.000Z';
const OBSERVED = '2026-11-22T10:00:00.000Z';
const CAPTURED = '2026-11-23T09:00:00.000Z';

function proposal(overrides: Record<string, unknown> = {}) {
  return {
    sourceId: 'marketplace',
    externalId: `listing-${overrides.externalId ?? '1'}`,
    vertical: 'SPORTS_CARD',
    property: 'Pokemon',
    set: 'Base Set',
    name: 'Charizard',
    number: '4',
    finish: 'UNKNOWN',
    currency: 'USD',
    amount: 1200,
    basis: 'ASKING',
    observedAt: OBSERVED,
    sourceUrl: 'https://example.test/listing/1',
    license: 'listing terms',
    attribution: 'marketplace listing',
    capturedAt: CAPTURED,
    lineage: ['source:marketplace', 'record:listing-1'],
    confidence: 'LOW',
    title: 'Charizard #4 PSA 10 cert #87654321',
    expectedAttributes: {
      gradingCompany: 'PSA', numericGrade: '10',
      certNumber: '12345678', cardNumber: '4',
    },
    confidenceFloor: 0.75,
    ...overrides,
  };
}

let server: Server;
let baseUrl: string;
let repos: ReturnType<typeof createRepositories>;

function post(route: string, body: unknown): Promise<{ status: number; body: any }> {
  return fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, body: await res.json() }));
}

function get(route: string): Promise<{ status: number; body: any }> {
  return fetch(`${baseUrl}${route}`).then(async (res) => ({ status: res.status, body: await res.json() }));
}

before(async () => {
  repos = createRepositories(createMemoryStore());
  const qa = createMatchReviewQueue({ repositories: repos, now: () => new Date(NOW), floor: 0.75 });
  const app = express();
  app.use(express.json());
  mountMatchReviewRouter(app, { store: qa });
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

function assertEnvelope(body: any): void {
  assert.ok(body && typeof body === 'object');
  for (const field of ['requestId', 'generatedAt', 'contractVersion', 'correctionPolicy', 'warnings']) {
    assert.ok(field in body.meta, `meta.${field} is required`);
  }
  assert.equal(body.meta.correctionPolicy, 'APPEND_ONLY');
  assert.ok(body.meta.warnings.some((warning: string) => /no model/i.test(warning)));
}

test('GET /api/qa/match-queue starts empty and returns the five-field envelope', async () => {
  const { status, body } = await get('/api/qa/match-queue');
  assert.equal(status, 200);
  assertEnvelope(body);
  assert.deepEqual(body.data.candidates, []);
  assert.deepEqual(body.data.counts, { PENDING: 0, APPROVED: 0, REJECTED: 0 });
});

test('POST /api/qa/match-queue quarantines a low-confidence proposal without canonical writes', async () => {
  const { status, body } = await post('/api/qa/match-queue', proposal());
  assert.equal(status, 200);
  assertEnvelope(body);
  assert.equal(body.data.candidate.status, 'PENDING');
  assert.equal(body.data.candidate.assessment.decision, 'QUARANTINE');
  assert.deepEqual(await repos.cards.list(), []);
  assert.deepEqual(await repos.marketObservations.list(), []);
});

test('queue filtering, corrections and review errors use plain error envelopes', async () => {
  const pending = await get('/api/qa/match-queue?status=PENDING');
  assert.equal(pending.body.data.counts.PENDING, 1);
  const id = pending.body.data.candidates[0].id as string;

  const rejected = await post('/api/qa/match-review', {
    candidateId: id, action: 'REJECT', reviewer: 'operator-1', note: 'cert mismatch',
  });
  assert.equal(rejected.status, 200);
  assertEnvelope(rejected.body);
  assert.equal(rejected.body.data.candidate.status, 'REJECTED');
  assert.equal(rejected.body.data.correction.reviewer, 'operator-1');
  assert.equal(rejected.body.data.correction.provenance.evidenceId, 'marketplace:listing-1');

  const corrections = await get(`/api/qa/match-corrections?candidateId=${encodeURIComponent(id)}`);
  assert.equal(corrections.status, 200);
  assert.equal(corrections.body.data.corrections.length, 1);
  assert.equal(corrections.body.data.corrections[0].note, 'cert mismatch');

  const badAction = await post('/api/qa/match-review', {
    candidateId: id, action: 'DELETE', reviewer: 'operator-1',
  });
  assert.equal(badAction.status, 400);
  assertEnvelope(badAction.body);
  assert.equal(badAction.body.code, 'validation_error');
  assert.equal(badAction.body.data, null);
  const unknown = await post('/api/qa/match-review', {
    candidateId: 'missing', action: 'APPROVE', reviewer: 'operator-1',
  });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.code, 'not_found');
});

test('POST /api/qa/match-review APPROVE publishes one provenance-carrying correction', async () => {
  await post('/api/qa/match-queue', proposal({ externalId: 'approve-1', title: 'Charizard #4 PSA 10 cert #87654321' }));
  const queue = await get('/api/qa/match-queue?status=PENDING');
  assert.equal(queue.body.data.counts.PENDING, 1);
  const target = (queue.body.data.candidates[0] as { id: string }).id;

  const approved = await post('/api/qa/match-review', {
    candidateId: target, action: 'APPROVE', reviewer: 'operator-2', note: 'issuer verified',
  });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.data.candidate.status, 'APPROVED');
  assert.equal(approved.body.data.correction.action, 'APPROVE');
  assert.equal(approved.body.data.correction.provenance.basis, 'ASKING');
  assert.equal(approved.body.data.canonical.accepted, true);
  assert.equal((await repos.marketObservations.list()).length, 1);
});

test('the QA router factory mounts on an existing app without opening a listener', () => {
  const qa = createMatchReviewQueue({ repositories: repos, now: () => new Date(NOW) });
  const router = createMatchReviewRouter({ store: qa });
  assert.equal(typeof router, 'function');
  assert.equal(qa.constructor.name, 'Object');
});

// --- mounted-app gate: reuse the operator auth already protecting admin APIs ---

const PASSCODE = 'task16-operator-passcode';
const originalDataDir = process.env.SLABGRAPH_DATA_DIR;
const originalTestMode = process.env.SLABGRAPH_TEST_MODE;
const originalPasscode = process.env.SLABGRAPH_ADMIN_PASSCODE;
let root: string;
let mountedApp: Express;
let mountedServer: Server;
let mountedUrl: string;
let authHeaders: Record<string, string>;

async function mountedPost(route: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${mountedUrl}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'slabswarm-task16-qa-'));
  process.env.SLABGRAPH_DATA_DIR = path.join(root, 'data');
  process.env.SLABGRAPH_TEST_MODE = '1';
  process.env.SLABGRAPH_ADMIN_PASSCODE = PASSCODE;
  const { createApp } = await import(`../../server.ts?task16qa=${Date.now()}`);
  const mountedRepos = createRepositories(createMemoryStore());
  mountedApp = await createApp({
    matchQaRepositories: mountedRepos,
    matchQaFloor: 0.75,
  });
  mountedServer = mountedApp.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    mountedServer.once('listening', () => resolve());
    mountedServer.once('error', reject);
  });
  mountedUrl = `http://127.0.0.1:${(mountedServer.address() as AddressInfo).port}`;
  const login = await mountedPost('/api/auth/login', { passcode: PASSCODE });
  assert.equal(login.status, 200);
  authHeaders = { authorization: `Bearer ${login.body.token}` };
});

after(async () => {
  if (mountedServer) await new Promise<void>((resolve) => mountedServer.close(() => resolve()));
  if (root) await rm(root, { recursive: true, force: true });
  for (const [key, value] of [
    ['SLABGRAPH_DATA_DIR', originalDataDir],
    ['SLABGRAPH_TEST_MODE', originalTestMode],
    ['SLABGRAPH_ADMIN_PASSCODE', originalPasscode],
  ] as Array<[string, string | undefined]>) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('the mounted QA review surface sits behind the existing operator gate', async () => {
  const anonymous = await mountedPost('/api/qa/match-queue', proposal({ externalId: 'gate-1' }));
  assert.equal(anonymous.status, 401, 'no public enqueue path was added');
  assert.match(anonymous.body.error, /Operator authentication required/);

  const authorized = await mountedPost('/api/qa/match-queue', proposal({ externalId: 'gate-1' }), authHeaders);
  assert.equal(authorized.status, 200);
  assert.equal(authorized.body.data.candidate.assessment.decision, 'QUARANTINE');
});
