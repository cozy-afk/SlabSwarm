import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import type { ResearchSourceNode } from '../src/types/graph.ts';
import {
  createEmptyDatabase,
  loadPersistedDatabase,
  savePersistedDatabase,
} from '../server/storage.ts';

// Isolate persistence under a temp dir so the test never touches real data.
const originalDataDir = process.env.SLABGRAPH_DATA_DIR;
let tempDataDir: string;

before(() => {
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slabswarm-research-storage-'));
  process.env.SLABGRAPH_DATA_DIR = tempDataDir;
});

after(() => {
  if (originalDataDir === undefined) {
    delete process.env.SLABGRAPH_DATA_DIR;
  } else {
    process.env.SLABGRAPH_DATA_DIR = originalDataDir;
  }
  fs.rmSync(tempDataDir, { recursive: true, force: true });
});

const NEW_COLLECTIONS = [
  'researchSources',
  'researchObservations',
  'researchNotes',
  'researchProjections',
  'mediaAssets',
  'marketObservations',
  'identityDecisions',
] as const;

test('createEmptyDatabase returns empty arrays for every new collection', () => {
  const db = createEmptyDatabase() as unknown as Record<string, unknown>;

  assert.equal(db.schemaVersion, 2);
  for (const collection of NEW_COLLECTIONS) {
    assert.deepEqual(db[collection], [], `${collection} must default to an empty array`);
  }
});

test('loadPersistedDatabase preserves a written research source', () => {
  const source: ResearchSourceNode = {
    id: 'src-persist-1',
    type: 'USER_NOTE',
    title: 'Persisted claim',
    rawText: 'Seller claims a reverse holo 1st Edition print.',
    tags: ['reverse-holo'],
    basis: 'CLAIM',
    capturedAt: '2026-11-22T00:00:00.000Z',
  };

  const db = createEmptyDatabase();
  db.researchSources.push(source);
  savePersistedDatabase(db);

  const loaded = loadPersistedDatabase();
  assert.deepEqual(loaded.researchSources, [source]);
  assert.equal(loaded.researchSources[0].basis, 'CLAIM');
});
