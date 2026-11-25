import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import express from 'express';

import { createDataProductContractRouter } from '../../server/serving/contractRoutes.ts';

let server: Server;
let baseUrl: string;
let rows: Map<string, Record<string, unknown>>;

const input = {
  targetType: 'CARD',
  targetId: 'tcg:719412',
  targetName: 'Amalgamight, Close Encounter',
  horizonDays: 30,
  scenario: 'report-derived',
  priceBands: { low: 0.2, base: 0.65, high: 1, currency: 'USD' },
  demandPressure: 'MEDIUM',
  supplyPressure: 'MEDIUM',
  baselinePrice: null,
  drivers: ['GUIDE price spread'],
  invalidators: ['New comps outside band'],
  evidenceIds: ['ev-1'],
  confidence: 'MEDIUM',
};

before(async () => {
  rows = new Map();
  const forecasts = {
    async create(row: Record<string, unknown>) {
      const record = { ...row, id: 'fc-test-000001', status: 'HYPOTHESIS', createdAt: '2026-11-24T00:00:00.000Z' };
      rows.set(record.id, record);
      return record;
    },
    async list() {
      return [...rows.values()];
    },
    async get(id: string) {
      return rows.get(id) ?? null;
    },
  };
  const app = express();
  app.use(express.json());
  app.use(createDataProductContractRouter({ forecasts } as never));
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

test('POST /api/forecasts writes through to the durable repository', async () => {
  const response = await fetch(`${baseUrl}/api/forecasts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = await response.json();
  assert.equal(response.status, 201);
  assert.equal(rows.size, 1);
  assert.equal(body.data?.targetName, 'Amalgamight, Close Encounter');
});

test('GET /api/forecasts reads the durable repository, not an in-memory singleton', async () => {
  const response = await fetch(`${baseUrl}/api/forecasts`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.data?.length, 1);
  assert.equal(body.data?.[0]?.targetName, 'Amalgamight, Close Encounter');
});
