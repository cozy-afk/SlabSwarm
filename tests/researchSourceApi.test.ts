import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Express } from 'express';

// Isolate persistence so the API test never touches real graph data.
const originalDataDir = process.env.SLABGRAPH_DATA_DIR;
const originalTestMode = process.env.SLABGRAPH_TEST_MODE;
let tempDataDir: string;
let createApp: typeof import('../server.ts')['createApp'];
let server: Server;
let baseUrl: string;

before(async () => {
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slabswarm-research-api-'));
  process.env.SLABGRAPH_DATA_DIR = tempDataDir;
  // Skip Vite dev middleware / static hosting: no watcher should hold the loop.
  process.env.SLABGRAPH_TEST_MODE = '1';

  // Dynamic import AFTER the overrides: graphEngine loads the temp store on import.
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
  if (originalDataDir === undefined) {
    delete process.env.SLABGRAPH_DATA_DIR;
  } else {
    process.env.SLABGRAPH_DATA_DIR = originalDataDir;
  }
  if (originalTestMode === undefined) {
    delete process.env.SLABGRAPH_TEST_MODE;
  } else {
    process.env.SLABGRAPH_TEST_MODE = originalTestMode;
  }
  fs.rmSync(tempDataDir, { recursive: true, force: true });
});

test('POST /api/research/source accepts a USER_NOTE and GET /api/research/state includes it', async () => {
  const payload = {
    type: 'USER_NOTE',
    title: 'Seller claim on slab label',
    rawText: 'Seller states this is a reverse holo 1st Edition printing.',
    tags: ['reverse-holo', '1st-edition'],
  };

  const postRes = await fetch(`${baseUrl}/api/research/source`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  assert.equal(postRes.status, 201, 'source ingest should return 201 Created');

  const body = (await postRes.json()) as {
    source?: {
      id?: string;
      type?: string;
      title?: string;
      rawText?: string;
      tags?: string[];
      basis?: string;
    };
    state?: { researchSources?: unknown[]; counts?: { researchSources?: number } };
  };
  assert.ok(body.source, 'response must include the created source record');
  assert.equal(body.source?.type, 'USER_NOTE');
  assert.equal(body.source?.title, payload.title);
  assert.equal(body.source?.rawText, payload.rawText);
  assert.deepEqual(body.source?.tags, payload.tags);
  assert.ok(body.source?.id, 'created source must have an id');
  assert.equal(body.source?.basis, 'UNKNOWN', 'missing basis must be the UNKNOWN sentinel');
  assert.ok(body.state?.researchSources, 'response must include a state summary');

  const stateRes = await fetch(`${baseUrl}/api/research/state`);
  assert.equal(stateRes.status, 200);
  const state = (await stateRes.json()) as {
    researchSources?: Array<{ id?: string; title?: string; type?: string }>;
    counts?: { researchSources?: number };
  };
  assert.ok(Array.isArray(state.researchSources), 'state must expose researchSources');
  assert.ok(
    state.researchSources?.some(
      (s) => s.id === body.source?.id && s.title === payload.title && s.type === 'USER_NOTE'
    ),
    'ingested source must be present in research state'
  );
  assert.equal(state.counts?.researchSources, 1, 'state summary count must reflect the ingest');
});
