import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Express } from 'express';

// Isolate persistence and LLM configuration so tests never touch real graph
// data and never call out to a configured provider.
const originalDataDir = process.env.SLABGRAPH_DATA_DIR;
const originalTestMode = process.env.SLABGRAPH_TEST_MODE;
const originalKeys: Record<string, string | undefined> = {};
const llmEnvKeys = [
  'GEMINI_API_KEY',
  'HERMES_API_URL',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'OLLAMA_BASE_URL',
  // Keep the isolated app open regardless of host-level operator config.
  'SLABGRAPH_ADMIN_PASSCODE',
];
let tempDataDir: string;
let createApp: typeof import('../server.ts')['createApp'];
let server: Server;
let baseUrl: string;

before(async () => {
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slabswarm-research-question-'));
  process.env.SLABGRAPH_DATA_DIR = tempDataDir;
  process.env.SLABGRAPH_TEST_MODE = '1';
  // Force the deterministic fallback path: no provider is configured.
  for (const key of llmEnvKeys) {
    originalKeys[key] = process.env[key];
    delete process.env[key];
  }

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
  if (originalDataDir === undefined) delete process.env.SLABGRAPH_DATA_DIR;
  else process.env.SLABGRAPH_DATA_DIR = originalDataDir;
  if (originalTestMode === undefined) delete process.env.SLABGRAPH_TEST_MODE;
  else process.env.SLABGRAPH_TEST_MODE = originalTestMode;
  for (const key of llmEnvKeys) {
    if (originalKeys[key] === undefined) delete process.env[key];
    else process.env[key] = originalKeys[key];
  }
  fs.rmSync(tempDataDir, { recursive: true, force: true });
});

test('POST /api/swarm/ingest works with zero assets and an unresolved raw title', async () => {
  // No canonical assets exist in the isolated store. Ingestion must not reject
  // just because the catalog is empty; the unresolved raw title is preserved as
  // first-party research evidence with no fabricated resolution.
  const res = await fetch(`${baseUrl}/api/swarm/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      rawTitle: 'Mystery hologram card, no catalogue entry',
      sellerNotes: 'Seller claims a rare reverse holo printing.',
      marketplaceId: 'ebay_sold',
      priceUsd: 0,
    }),
  });

  assert.notEqual(res.status, 400, 'empty catalog must not block ingest');
  assert.equal(res.status, 200, `ingest should succeed, got ${res.status}`);

  const body = (await res.json()) as {
    run?: { verdict?: string; rawTitle?: string; resolvedAssetId?: string | null };
  };
  assert.ok(body.run, 'response must include a swarm run record');
  assert.equal(body.run?.rawTitle, 'Mystery hologram card, no catalogue entry');
  assert.equal(
    body.run?.verdict,
    'HELD_UNRESOLVED',
    'unresolved raw title with no catalog is held without inventing an asset'
  );

  const stateRes = await fetch(`${baseUrl}/api/research/state`);
  const state = (await stateRes.json()) as {
    researchSources?: Array<{ title?: string; rawText?: string; basis?: string }>;
  };
  assert.ok(
    state.researchSources?.some((s) => s.title === 'Mystery hologram card, no catalogue entry'),
    'unresolved raw title must be captured as a first-party research source'
  );
});

test('POST /api/research/question creates a note via deterministic fallback with insufficient evidence', async () => {
  const res = await fetch(`${baseUrl}/api/research/question`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: 'What is the fair value of the mystery hologram card?' }),
  });

  assert.equal(res.status, 201, `question endpoint should return 201, got ${res.status}`);
  const body = (await res.json()) as {
    note?: {
      id?: string;
      question?: string;
      subquestions?: string[];
      evidenceIds?: string[];
      synthesis?: string;
      confidence?: number;
      missingData?: string[];
    };
    evidenceMode?: string;
    confidenceLabel?: string;
  };
  const note = body.note;
  assert.ok(note, 'response must include the created ResearchNote');
  assert.ok(note?.id, 'note must have an id');
  assert.equal(note?.question, 'What is the fair value of the mystery hologram card?');
  assert.ok(Array.isArray(note?.subquestions) && note.subquestions.length > 0, 'note must decompose question into subquestions');
  assert.ok(Array.isArray(note?.evidenceIds), 'note must carry evidence ids');
  assert.ok(
    note.evidenceIds.some((id) => id.startsWith('src-')),
    'evidence ids must reference first-party research sources captured by ingest'
  );
  assert.equal(typeof note?.synthesis, 'string');
  assert.ok((note?.synthesis ?? '').length > 0, 'synthesis must be a non-empty string');
  assert.ok(typeof note?.confidence === 'number' && note.confidence <= 0.3, 'no-provider fallback must be LOW confidence');
  assert.equal(body.confidenceLabel, 'LOW', 'fallback confidence label must be LOW');
  assert.ok(Array.isArray(note?.missingData), 'note must enumerate missing data');
  assert.ok(note.missingData.length > 0, 'insufficient evidence must list what is missing');
  assert.equal(body.evidenceMode, 'deterministic_fallback');
});

test('POST /api/research/question persists the note in research state', async () => {
  const stateRes = await fetch(`${baseUrl}/api/research/state`);
  assert.equal(stateRes.status, 200);
  const state = (await stateRes.json()) as {
    researchNotes?: Array<{ question?: string }>;
    counts?: { researchNotes?: number };
  };
  assert.ok(Array.isArray(state.researchNotes), 'state must expose researchNotes');
  assert.ok(
    state.researchNotes?.some((n) => n.question === 'What is the fair value of the mystery hologram card?'),
    'created note must be present in research state'
  );
  assert.equal(state.counts?.researchNotes, 1, 'state count must reflect the created note');
});

test('POST /api/research/question rejects missing or non-string questions', async () => {
  for (const payload of [{}, { question: '   ' }, { question: 42 }]) {
    const res = await fetch(`${baseUrl}/api/research/question`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    assert.equal(res.status, 400, `invalid payload ${JSON.stringify(payload)} must be rejected`);
  }
});
