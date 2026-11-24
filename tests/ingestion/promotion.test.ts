// Deterministic promotion tests: evidence-backed candidates -> canonical
// market observations. No live API calls and no model participation.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { createInMemoryRepositories } from '../../server/ingest/store.ts';
import type { IngestCandidate, IngestRepositories } from '../../server/ingest/types.ts';
import type { MarketObservation } from '../../server/contracts/dataProduct.ts';
import { promoteCandidates } from '../../server/ingest/promotion.ts';
import { createIngestRouter } from '../../server/ingest/routes.ts';
import { buildActiveReport } from '../../server/intelligence/active-report.ts';

const OBSERVED_AT = '2026-11-20T10:00:00.000Z';
const CAPTURED_AT = '2026-11-22T18:00:00.000Z';
const NOW = new Date('2026-11-22T19:00:00.000Z');

type StoredObservation = MarketObservation & {
  sourceId?: string;
  capturedAt?: string;
  confidence?: string;
  lineage?: string[];
};

function candidate(overrides: Partial<IngestCandidate> = {}): IngestCandidate {
  const evidenceId = overrides.evidenceId ?? 'ev-guide-1';
  const amount = overrides.amount === undefined ? 42.5 : overrides.amount;
  return {
    evidenceId,
    targetIdentityRef: 'tcg:719440',
    basis: 'GUIDE',
    amount,
    currency: 'USD',
    marketplace: null,
    observedAt: OBSERVED_AT,
    sourceId: 'tcgapis',
    capturedAt: CAPTURED_AT,
    lineage: [evidenceId],
    confidence: 'MEDIUM',
    priceComponents: {
      listed_amount: amount,
      currency: 'USD',
      shipping_amount: null,
      fees: null,
      fx_rate_to_base: null,
    },
    status: 'RAW',
    parseStatus: 'PARSED',
    warnings: [],
    ...overrides,
  };
}

async function store(repos: IngestRepositories, rows: IngestCandidate[]): Promise<void> {
  for (const row of rows) await repos.candidates.create(row);
}

test('a GUIDE candidate keeps basis, currency, timestamps, lineage, confidence and price components', async () => {
  const repos = createInMemoryRepositories();
  const input = candidate();
  await store(repos, [input]);

  const result = await promoteCandidates(repos, { now: NOW });
  assert.deepEqual(
    {
      candidatesSeen: result.candidatesSeen,
      promoted: result.promoted,
      skipped: result.skipped,
      duplicates: result.duplicates,
    },
    { candidatesSeen: 1, promoted: 1, skipped: 0, duplicates: 0 },
  );
  assert.deepEqual(result.errors, []);

  const rows = await repos.marketObservations.list();
  assert.equal(rows.length, 1);
  const row = rows[0] as StoredObservation;
  assert.equal(row.evidenceId, 'ev-guide-1');
  assert.equal(row.targetIdentityRef, 'tcg:719440');
  assert.equal(row.basis, 'GUIDE', 'a GUIDE price must never be relabelled SOLD');
  assert.equal(row.amount, 42.5);
  assert.equal(row.currency, 'USD', 'no currency conversion');
  assert.equal(row.observedAt, OBSERVED_AT);
  assert.equal(row.capturedAt, CAPTURED_AT);
  assert.equal(row.sourceId, 'tcgapis');
  assert.equal(row.confidence, 'MEDIUM');
  assert.deepEqual(row.priceComponents, input.priceComponents);
  assert.deepEqual(row.lineage?.slice(0, input.lineage.length), input.lineage);
  assert.equal(row.lineage?.length, input.lineage.length + 1, 'lineage is appended, never overwritten');
  assert.equal(row.status, 'NORMALIZED');
});

test('null, non-finite, UNKNOWN-basis and failed-parse candidates are skipped', async () => {
  const repos = createInMemoryRepositories();
  await store(repos, [
    candidate({ evidenceId: 'ev-null', amount: null, targetIdentityRef: 'tcg:null' }),
    candidate({ evidenceId: 'ev-nan', amount: Number.NaN, targetIdentityRef: 'tcg:nan' }),
    candidate({ evidenceId: 'ev-inf', amount: Number.POSITIVE_INFINITY, targetIdentityRef: 'tcg:inf' }),
    candidate({ evidenceId: 'ev-unknown-basis', basis: 'UNKNOWN', targetIdentityRef: 'tcg:unknown' }),
    candidate({ evidenceId: 'ev-failed', parseStatus: 'FAILED', targetIdentityRef: 'tcg:failed' }),
    candidate({ evidenceId: 'ev-bad-basis', basis: 'BOGUS' as 'GUIDE', targetIdentityRef: 'tcg:bogus' }),
  ]);

  const result = await promoteCandidates(repos, { now: NOW });
  assert.equal(result.candidatesSeen, 6);
  assert.equal(result.promoted, 0);
  assert.equal(result.skipped, 6);
  assert.equal(result.duplicates, 0);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(await repos.marketObservations.list(), []);
});

test('reruns and same-key candidates never duplicate observations', async () => {
  const repos = createInMemoryRepositories();
  await store(repos, [candidate()]);

  const first = await promoteCandidates(repos, { now: NOW });
  assert.equal(first.promoted, 1);
  const second = await promoteCandidates(repos, { now: NOW });
  assert.equal(second.promoted, 0);
  assert.equal(second.duplicates, 1);
  assert.equal((await repos.marketObservations.list()).length, 1);

  // Same evidence + ref + basis, different amount: still one observation.
  await store(repos, [candidate({ amount: 99 })]);
  const third = await promoteCandidates(repos, { now: NOW });
  assert.equal(third.promoted, 0);
  assert.equal(third.duplicates, 2, 'both same-key candidates are reported as duplicates');
  const rows = await repos.marketObservations.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amount, 42.5, 'the first observation is authoritative');
});

test('missing provenance degrades status to RAW without inventing values', async () => {
  const repos = createInMemoryRepositories();
  await store(repos, [candidate({ evidenceId: 'ev-no-capture', capturedAt: '' })]);

  const result = await promoteCandidates(repos, { now: NOW });
  assert.equal(result.promoted, 1);
  const row = (await repos.marketObservations.list())[0] as StoredObservation;
  assert.equal(row.status, 'RAW');
  assert.equal(row.capturedAt, '', 'missing provenance stays missing, never backfilled');
});

test('error messages never expose a TCGAPI key', async () => {
  const repos = createInMemoryRepositories();
  await store(repos, [candidate({ evidenceId: 'ev-secret' })]);
  const secret = 'tcgapi-test-secret-DoNotLeak';
  const previous = process.env.TCGAPI_KEY;
  process.env.TCGAPI_KEY = secret;
  try {
    const failing: IngestRepositories = {
      ...repos,
      marketObservations: {
        create: async () => {
          throw new Error(`write failed for ${process.env.TCGAPI_KEY}`);
        },
        get: (id) => repos.marketObservations.get(id),
        list: (filters) => repos.marketObservations.list(filters),
      },
    };
    const result = await promoteCandidates(failing, { now: NOW });
    assert.equal(result.errors.length, 1);
    assert.ok(!result.errors.some((message) => message.includes(secret)));
    assert.ok(!JSON.stringify(result).includes(secret));
  } finally {
    if (previous === undefined) delete process.env.TCGAPI_KEY;
    else process.env.TCGAPI_KEY = previous;
  }
});

test('POST /api/ingest/promote returns counts and writes observations', async () => {
  const repos = createInMemoryRepositories();
  await store(repos, [candidate()]);
  const app = express();
  app.use(express.json());
  app.use(createIngestRouter(repos));
  const server: Server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', reject);
  });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const response = await fetch(`${baseUrl}/api/ingest/promote`, { method: 'POST' });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(
      {
        candidatesSeen: body.candidatesSeen,
        promoted: body.promoted,
        skipped: body.skipped,
        duplicates: body.duplicates,
      },
      { candidatesSeen: 1, promoted: 1, skipped: 0, duplicates: 0 },
    );
    assert.deepEqual(body.errors, []);
    assert.equal((await repos.marketObservations.list()).length, 1);
  } finally {
    server.close();
  }
});

test('promoted observations feed a basis-safe active report', async () => {
  const repos = createInMemoryRepositories();
  // A report ref is only cited when it resolves in the evidence ledger; seed
  // the three immutable evidence rows that back these candidates.
  const amounts = [10, 20, 30];
  const priced = [];
  for (const amount of amounts) {
    const evidence = await repos.evidence.create({
      sourceId: 'tcgapis',
      sourceRecordId: `tcg:price:card-a:${amount}`,
      capturedAt: CAPTURED_AT,
      observedAt: OBSERVED_AT,
      checksum: `sha256-card-a-${amount}`,
      mimeType: 'application/json',
      rawRef: `ingest://tcgapis/tcg:price:card-a:${amount}`,
      parsedPayload: { name: 'Card A' },
    });
    priced.push(candidate({ evidenceId: evidence.id, amount, targetIdentityRef: 'tcg:card-a' }));
  }
  await store(repos, priced);
  const result = await promoteCandidates(repos, { now: NOW });
  assert.equal(result.promoted, 3);

  const { data } = await buildActiveReport({ repositories: repos, now: NOW });
  assert.equal(data.cards.length, 1);
  const card = data.cards[0];
  assert.equal(card.id, 'tcg:card-a', 'targetIdentityRef must resolve unchanged');
  assert.equal(card.basis, 'GUIDE');
  assert.equal(card.currency, 'USD');
  assert.equal(card.observationCount, 3);
  assert.ok(card.priceBand !== 'UNKNOWN');
  assert.deepEqual(card.priceBand, { low: 10, mid: 20, high: 30, currency: 'USD', basis: 'GUIDE' });
  assert.ok(card.drivers.length > 0);
  assert.deepEqual(card.evidence.map((ref) => ref.basis), ['GUIDE', 'GUIDE', 'GUIDE']);
  assert.equal(data.summary.insufficientEvidence, false);
});
