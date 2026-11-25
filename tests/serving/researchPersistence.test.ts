import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import express from 'express';

import { createDataProductContractRouter } from '../../server/serving/contractRoutes.ts';

const TARGET = 'card-persistence-test';

let server: Server;
let baseUrl: string;
let notes: Map<string, Record<string, unknown>>;

before(async () => {
  notes = new Map();
  const marketObservations = {
    async list() {
      return [
        {
          id: 'obs-1',
          evidenceId: 'ev-1',
          targetIdentityRef: TARGET,
          basis: 'GUIDE',
          amount: 5,
          currency: 'USD',
          observedAt: '2026-11-24T00:00:00.000Z',
          status: 'NORMALIZED',
        },
        {
          id: 'obs-2',
          evidenceId: 'ev-2',
          targetIdentityRef: TARGET,
          basis: 'GUIDE',
          amount: 7,
          currency: 'USD',
          observedAt: '2026-11-24T00:00:00.000Z',
          status: 'NORMALIZED',
        },
      ];
    },
  };
  const researchNotes = {
    async upsert(row: Record<string, unknown>) {
      const id = String(row.id);
      notes.set(id, row);
      return row;
    },
  };
  const app = express();
  app.use(express.json());
  app.use(createDataProductContractRouter({ marketObservations, researchNotes } as never));
  server = await new Promise<Server>((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1');
    instance.once('listening', () => resolve(instance));
    instance.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function postRun(question: string) {
  const response = await fetch(`${baseUrl}/api/swarm/research/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ targetId: TARGET, question, mode: 'EVIDENCE_FIRST' }),
  });
  return { status: response.status, body: await response.json() };
}

test('a research run is persisted as a durable research note', async () => {
  const { status, body } = await postRun('What does the canonical evidence say?');
  assert.equal(status, 201);
  assert.ok(body.data?.id, 'run must return an id');
  assert.equal(notes.size, 1, 'run must be written to the research notes repository');

  const note = [...notes.values()][0]!;
  assert.equal(note.id, `research-note-${body.data.id}`);
  assert.deepEqual(note.evidenceIds, body.data.evidenceIds);
  assert.equal((note.source as Record<string, unknown>).runId, body.data.id);
  assert.match(String(note.synthesis), /proposals/);
});

test('repeating the same content-addressed run does not create duplicate notes', async () => {
  const first = await postRun('What does the canonical evidence say?');
  const second = await postRun('What does the canonical evidence say?');
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal(first.body.data.id, second.body.data.id);
  assert.equal(notes.size, 1);
});
