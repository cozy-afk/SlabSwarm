import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Express } from 'express';

// Final fix wave: (2) tenant-scoped media dedupe, (3) GraphRAG query guardrail
// + auth, (4) ingest validation + providerOverride allow-list.
//
// Uses a single isolated app with operator auth ENABLED so we can exercise
// requireAuth on the newly protected route. All provider keys are removed so
// every synthesis path deterministically falls back to deflection.
const envKeys = [
  'SLABGRAPH_DATA_DIR',
  'SLABGRAPH_TEST_MODE',
  'SLABGRAPH_ADMIN_PASSCODE',
  'GEMINI_API_KEY',
  'HERMES_API_URL',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'OLLAMA_BASE_URL',
];
const originals: Record<string, string | undefined> = {};
let tempDataDir: string;
let createApp: typeof import('../server.ts')['createApp'];
let storeMediaAsset: typeof import('../server/mediaStore.ts')['storeMediaAsset'];
let server: Server;
let baseUrl: string;
let authToken: string;

const PASSCODE = 'final-fix-wave-test-passcode';

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

before(async () => {
  for (const key of envKeys) originals[key] = process.env[key];
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slabswarm-final-fix-'));
  process.env.SLABGRAPH_DATA_DIR = tempDataDir;
  process.env.SLABGRAPH_TEST_MODE = '1';
  // Enable operator auth so requireAuth is active on protected routes.
  process.env.SLABGRAPH_ADMIN_PASSCODE = PASSCODE;
  for (const key of [
    'GEMINI_API_KEY', 'HERMES_API_URL', 'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY', 'OLLAMA_BASE_URL',
  ]) delete process.env[key];

  ({ createApp } = await import(`../server.ts?finalfix=${Date.now()}`));
  ({ storeMediaAsset } = await import(`../server/mediaStore.ts?finalfix=${Date.now()}`));
  const app: Express = await createApp();
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // Log in to obtain a bearer token for authenticated requests.
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ passcode: PASSCODE }),
  });
  assert.equal(login.status, 200, 'operator login should succeed');
  const loginBody = (await login.json()) as { token?: string };
  assert.ok(loginBody.token, 'login must return a session token');
  authToken = loginBody.token;
});

after(() => {
  if (server) server.close();
  for (const key of envKeys) {
    if (originals[key] === undefined) delete process.env[key];
    else process.env[key] = originals[key];
  }
  fs.rmSync(tempDataDir, { recursive: true, force: true });
});

function authHeaders(): Record<string, string> {
  return { 'content-type': 'application/json', authorization: `Bearer ${authToken}` };
}

// ---------------------------------------------------------------------------
// Fix 2: tenant-scoped media dedupe
// ---------------------------------------------------------------------------

test('media dedupe is tenant-scoped: identical bytes for two tenants create two records', () => {
  const bytes = Buffer.from('tenant-scoped-dedupe-payload');
  const checksum = sha256(bytes);
  const a = storeMediaAsset({
    kind: 'CARD_FRONT', bytes, mimeType: 'image/png', license: 'CC-BY-4.0',
    observedAt: '2026-11-22T00:00:00.000Z', tenantId: 'tenant-A',
    attribution: 'Owner A',
  });
  const b = storeMediaAsset({
    kind: 'CARD_BACK', bytes, mimeType: 'image/png', license: 'ALL_RIGHTS_RESERVED',
    observedAt: '2026-11-22T00:00:00.000Z', tenantId: 'tenant-B',
    attribution: 'Owner B',
  });

  assert.equal(a.checksum_sha256, checksum);
  assert.equal(b.checksum_sha256, checksum);
  assert.notEqual(b.id, a.id, 'tenant B must not receive tenant A\'s media record');
  assert.equal(b.attribution, 'Owner B', 'tenant B record keeps its own metadata');
  assert.equal(b.license, 'ALL_RIGHTS_RESERVED');
  assert.equal(a.attribution, 'Owner A', 'tenant A record is unchanged');
});

test('media dedupe within the same tenant still collapses to one record', () => {
  const bytes = Buffer.from('same-tenant-dedupe-payload');
  const a = storeMediaAsset({
    kind: 'CARD_FRONT', bytes, mimeType: 'image/png', license: 'CC-BY-4.0',
    observedAt: '2026-11-22T00:00:00.000Z', tenantId: 'tenant-C',
  });
  const b = storeMediaAsset({
    kind: 'CARD_BACK', bytes, mimeType: 'image/png', license: 'CC-BY-4.0',
    observedAt: '2026-11-23T00:00:00.000Z', tenantId: 'tenant-C',
  });
  assert.equal(b.id, a.id, 'same tenant + same checksum must dedupe');
});

test('POST /api/media/ingest: identical bytes for different tenants create separate records', async () => {
  const bytes = Buffer.from('api-tenant-scoped-dedupe-payload');
  const base = {
    kind: 'SCREENSHOT', bytesBase64: bytes.toString('base64'), mimeType: 'image/png',
    license: 'CC-BY-4.0', observedAt: '2026-11-22T00:00:00.000Z',
  };
  const aRes = await fetch(`${baseUrl}/api/media/ingest`, {
    method: 'POST', headers: authHeaders(),
    body: JSON.stringify({ ...base, tenantId: 'api-tenant-A' }),
  });
  const bRes = await fetch(`${baseUrl}/api/media/ingest`, {
    method: 'POST', headers: authHeaders(),
    body: JSON.stringify({ ...base, tenantId: 'api-tenant-B' }),
  });
  assert.equal(aRes.status, 201);
  assert.equal(bRes.status, 201);
  const a = (await aRes.json()) as { media: { id: string; checksum_sha256: string } };
  const b = (await bRes.json()) as { media: { id: string; checksum_sha256: string } };
  assert.equal(a.media.checksum_sha256, b.media.checksum_sha256);
  assert.notEqual(a.media.id, b.media.id, 'API must not leak a media record across tenants');
});

// ---------------------------------------------------------------------------
// Fix 3: GraphRAG query guardrail + auth + providerOverride allow-list
// ---------------------------------------------------------------------------

test('POST /api/graphrag/query requires operator authentication', async () => {
  const res = await fetch(`${baseUrl}/api/graphrag/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: 'What is the arbitrage spread?' }),
  });
  assert.equal(res.status, 401, 'unauthenticated GraphRAG query must be rejected');
});

test('POST /api/graphrag/query deflects when no provider / no supported evidence', async () => {
  const res = await fetch(`${baseUrl}/api/graphrag/query`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ question: 'What is the exact market value of my mystery card?' }),
  });
  assert.equal(res.status, 200, `authenticated query should succeed, got ${res.status}`);
  const body = (await res.json()) as {
    synthesis?: string;
    deflected?: boolean;
    confidenceLabel?: string;
    missingData?: string[];
    citations?: string[];
    providerUsed?: string;
  };
  assert.equal(body.deflected, true, 'no-provider / unsupported question must deflect');
  assert.match((body.synthesis ?? '').toLowerCase(), /insufficient evidence/);
  assert.ok(['UNKNOWN', 'LOW'].includes(body.confidenceLabel ?? ''),
    `confidence must be conservative, got ${body.confidenceLabel}`);
  assert.ok(Array.isArray(body.missingData) && body.missingData.length > 0,
    'deflection must enumerate missing data');
  assert.deepEqual(body.citations ?? [], []);
  assert.equal(body.providerUsed, 'Deterministic Guardrail',
    'no provider configured => deterministic guardrail label');
});

test('POST /api/graphrag/query rejects empty question and allow-lists providerOverride', async () => {
  const empty = await fetch(`${baseUrl}/api/graphrag/query`, {
    method: 'POST', headers: authHeaders(), body: JSON.stringify({ question: '   ' }),
  });
  assert.equal(empty.status, 400, 'empty question must be rejected');

  // An arbitrary providerOverride must be ignored (never forwarded), not crash
  // the route. With no keys configured it falls back to deterministic deflection.
  const bogus = await fetch(`${baseUrl}/api/graphrag/query`, {
    method: 'POST', headers: authHeaders(),
    body: JSON.stringify({ question: 'Any question?', providerOverride: 'evil-provider' }),
  });
  assert.equal(bogus.status, 200, 'bogus providerOverride must be ignored safely');
  const body = (await bogus.json()) as { providerUsed?: string; deflected?: boolean };
  assert.equal(body.providerUsed, 'Deterministic Guardrail', 'bogus override must not be used');
  assert.equal(body.deflected, true);
});

// ---------------------------------------------------------------------------
// Fix 4: ingest validation + question providerOverride allow-list
// ---------------------------------------------------------------------------

test('POST /api/research/source rejects non-string tags elements', async () => {
  for (const tags of [['ok', 1], ['ok', null], [true], [{ x: 1 }]]) {
    const res = await fetch(`${baseUrl}/api/research/source`, {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ type: 'USER_NOTE', title: 't', rawText: 'r', tags }),
    });
    assert.equal(res.status, 400, `tags ${JSON.stringify(tags)} must be rejected`);
  }
  // All-string tags are accepted.
  const ok = await fetch(`${baseUrl}/api/research/source`, {
    method: 'POST', headers: authHeaders(),
    body: JSON.stringify({ type: 'USER_NOTE', title: 't', rawText: 'r', tags: ['a', 'b'] }),
  });
  assert.equal(ok.status, 201);
});

test('POST /api/research/source validates checksum_sha256, source_url and raw_payload', async () => {
  const base = { type: 'USER_NOTE', title: 't', rawText: 'r' };

  // checksum_sha256 must be a lowercase 64-hex digest.
  for (const checksum_sha256 of ['ABCDEF', 'z'.repeat(64), 'a'.repeat(63), 123]) {
    const res = await fetch(`${baseUrl}/api/research/source`, {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ ...base, checksum_sha256 }),
    });
    assert.equal(res.status, 400, `bad checksum ${checksum_sha256} must be rejected`);
  }
  // A valid digest is accepted.
  const good = await fetch(`${baseUrl}/api/research/source`, {
    method: 'POST', headers: authHeaders(),
    body: JSON.stringify({ ...base, checksum_sha256: 'a'.repeat(64) }),
  });
  assert.equal(good.status, 201);

  // source_url must be a valid http(s) URL when provided.
  for (const source_url of ['not a url', 'ftp://example.com', 'example.com', 42, '']) {
    const res = await fetch(`${baseUrl}/api/research/source`, {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ ...base, source_url }),
    });
    assert.equal(res.status, 400, `bad source_url ${JSON.stringify(source_url)} must be rejected`);
  }
  const urlOk = await fetch(`${baseUrl}/api/research/source`, {
    method: 'POST', headers: authHeaders(),
    body: JSON.stringify({ ...base, source_url: 'https://example.com/listing' }),
  });
  assert.equal(urlOk.status, 201);

  // raw_payload must be a string or null.
  for (const raw_payload of [{ a: 1 }, [1, 2], 42, true]) {
    const res = await fetch(`${baseUrl}/api/research/source`, {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ ...base, raw_payload }),
    });
    assert.equal(res.status, 400, `bad raw_payload ${JSON.stringify(raw_payload)} must be rejected`);
  }
  for (const raw_payload of ['opaque text', null]) {
    const res = await fetch(`${baseUrl}/api/research/source`, {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ ...base, raw_payload }),
    });
    assert.equal(res.status, 201, `raw_payload ${JSON.stringify(raw_payload)} must be accepted`);
  }
});

test('POST /api/research/question allow-lists providerOverride', async () => {
  // A bogus override must be ignored and not break the deterministic fallback.
  const res = await fetch(`${baseUrl}/api/research/question`, {
    method: 'POST', headers: authHeaders(),
    body: JSON.stringify({ question: 'Any grounded question?', providerOverride: 'evil-provider' }),
  });
  assert.equal(res.status, 201, 'bogus providerOverride must be ignored safely');
  const body = (await res.json()) as { evidenceMode?: string };
  assert.equal(body.evidenceMode, 'deterministic_fallback');
});
