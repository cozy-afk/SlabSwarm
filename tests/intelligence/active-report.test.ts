// Deterministic tests for the "what is actively trading" report.
// All values are synthetic fixtures; no live API calls, no invented market facts.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import {
  buildActiveReport,
  setActiveReportRepositories,
} from '../../server/intelligence/active-report.ts';
import { createIntelligenceRouter } from '../../server/intelligence/routes.ts';
import { createInMemoryRepositories } from '../../server/ingest/store.ts';
import type { IngestRepositories } from '../../server/ingest/types.ts';
import type { MarketBasis } from '../../server/contracts/dataProduct.ts';
import { UNKNOWN } from '../../server/contracts/activeReport.ts';

const NOW = new Date('2026-11-22T00:00:00.000Z');
const DAY_MS = 86_400_000;
const OPTS = { now: NOW };

function isoDaysAgo(days: number): string {
  return new Date(NOW.getTime() - days * DAY_MS).toISOString();
}

interface SeedSpec {
  key: string;
  target?: string;
  basis?: MarketBasis;
  currency?: string;
  amount: number;
  daysAgo: number;
  source?: string;
}

async function seed(
  repositories: IngestRepositories,
  specs: SeedSpec[],
): Promise<Map<string, { evidenceId: string; observationId: string }>> {
  const out = new Map<string, { evidenceId: string; observationId: string }>();
  for (const spec of specs) {
    const source = spec.source ?? 'ebay';
    const observedAt = isoDaysAgo(spec.daysAgo);
    const evidence = await repositories.evidence.create({
      sourceId: source,
      sourceRecordId: `${spec.key}-native`,
      capturedAt: new Date(Date.parse(observedAt) + 60_000).toISOString(),
      observedAt,
      checksum: `sha256-${spec.key}`,
      mimeType: 'application/json',
      rawRef: `raw/${spec.key}.json`,
      parsedPayload: {
        game: 'TestGame',
        set: 'Base Set',
        name: spec.target ?? 'card-alpha',
      },
    });
    const observation = await repositories.marketObservations.create({
      evidenceId: evidence.id,
      targetIdentityRef: spec.target ?? 'card-alpha',
      basis: spec.basis ?? 'SOLD',
      amount: spec.amount,
      currency: spec.currency ?? 'USD',
      marketplace: source,
      observedAt,
      status: 'NORMALIZED',
    });
    out.set(spec.key, { evidenceId: evidence.id, observationId: observation.id });
  }
  return out;
}

test('empty store returns an explicit insufficient-evidence report with no invented numbers', async () => {
  const result = await buildActiveReport({ ...OPTS, repositories: createInMemoryRepositories() });

  assert.deepEqual(result.data.cards, []);
  assert.equal(result.data.summary.insufficientEvidence, true);
  assert.equal(result.data.summary.totalEvidence, 0);
  assert.equal(result.data.summary.totalObservations, 0);
  assert.equal(result.data.summary.cardsObserved, 0);
  assert.equal(result.data.summary.oldestObservationAt, UNKNOWN);
  assert.equal(result.data.summary.newestObservationAt, UNKNOWN);
  assert.equal(result.data.generatedAt, NOW.toISOString());
  assert.equal(result.meta.generatedAt, NOW.toISOString());
  assert.equal(result.meta.filters.activeWindowDays, 30);
  assert.equal(result.meta.filters.staleDays, 30);
  assert.equal(result.meta.filters.minActiveObservations, 3);
});

test('a single old observation yields UNKNOWN momentum and stale freshness', async () => {
  const repositories = createInMemoryRepositories();
  await seed(repositories, [
    { key: 'lonely', basis: 'SOLD', amount: 100, daysAgo: 45 },
  ]);

  const { data } = await buildActiveReport({ ...OPTS, repositories });
  assert.equal(data.cards.length, 1);
  const card = data.cards[0];
  assert.equal(card.observationCount, 1);
  assert.equal(card.momentum7d, UNKNOWN);
  assert.equal(card.momentum30d, UNKNOWN);
  assert.equal(card.freshness, 'stale');
  assert.equal(card.priceBand, UNKNOWN, 'one observation is not a comp set');
  assert.equal(card.lastObservedAt, isoDaysAgo(45));
});

test('a GUIDE price keeps its own basis and currency', async () => {
  const repositories = createInMemoryRepositories();
  await seed(repositories, [
    { key: 'g1', basis: 'GUIDE', currency: 'EUR', amount: 90, daysAgo: 1, source: 'tcgapis' },
    { key: 'g2', basis: 'GUIDE', currency: 'EUR', amount: 100, daysAgo: 2, source: 'tcgapis' },
    { key: 'g3', basis: 'GUIDE', currency: 'EUR', amount: 110, daysAgo: 3, source: 'tcgapis' },
  ]);

  const { data } = await buildActiveReport({ ...OPTS, repositories });
  const card = data.cards[0];
  assert.equal(card.basis, 'GUIDE');
  assert.equal(card.currency, 'EUR');
  assert.notEqual(card.priceBand, UNKNOWN);
  if (card.priceBand !== UNKNOWN) {
    assert.equal(card.priceBand.basis, 'GUIDE');
    assert.equal(card.priceBand.currency, 'EUR');
    assert.deepEqual([card.priceBand.low, card.priceBand.mid, card.priceBand.high], [90, 100, 110]);
  }
  assert.ok(card.evidence.every((ref) => ref.basis === 'GUIDE' && ref.currency === 'EUR'));
});

test('ten recent sold observations rank first with SOLD basis, citations and a timestamp', async () => {
  const repositories = createInMemoryRepositories();
  const specs: SeedSpec[] = [
    ...[1, 2, 3, 4].map((n) => ({ key: `s${n}`, basis: 'SOLD' as const, amount: 100 + n, daysAgo: n })),
    ...[8, 12, 20].map((n) => ({ key: `m${n}`, basis: 'SOLD' as const, amount: 98, daysAgo: n })),
    ...[40, 55, 70].map((n) => ({ key: `o${n}`, basis: 'SOLD' as const, amount: 95, daysAgo: n })),
    { key: 'ask', target: 'card-beta', basis: 'ASKING', amount: 500, daysAgo: 2, source: 'tcgplayer' },
  ];
  const ids = await seed(repositories, specs);

  const { data } = await buildActiveReport({ ...OPTS, repositories });
  assert.equal(data.cards[0].id, 'card-alpha');
  const card = data.cards[0];
  assert.equal(card.observationCount, 10);
  assert.equal(card.basis, 'SOLD');
  assert.equal(card.currency, 'USD');
  assert.ok(card.lastObservedAt !== UNKNOWN);
  assert.equal(card.lastObservedAt, isoDaysAgo(1));
  assert.deepEqual(
    card.evidence.map((ref) => ref.id).sort(),
    specs.filter((s) => (s.target ?? 'card-alpha') === 'card-alpha')
      .map((s) => ids.get(s.key)!.evidenceId).sort(),
  );
  assert.notEqual(card.momentum7d, UNKNOWN, 'history exists for this card');
  assert.notEqual(card.momentum30d, UNKNOWN, 'history exists for this card');
  assert.equal(card.freshness, 'fresh');
});

test('every displayed figure is backed by an evidence ref with source, observedAt and basis', async () => {
  const repositories = createInMemoryRepositories();
  await seed(repositories, [
    { key: 'a1', basis: 'SOLD', amount: 100, daysAgo: 1 },
    { key: 'a2', basis: 'SOLD', amount: 101, daysAgo: 2 },
    { key: 'a3', basis: 'SOLD', amount: 102, daysAgo: 3 },
    { key: 'b1', target: 'card-beta', basis: 'ASKING', amount: 200, daysAgo: 4, source: 'tcgplayer' },
    { key: 'b2', target: 'card-beta', basis: 'ASKING', amount: 220, daysAgo: 5, source: 'tcgplayer' },
    { key: 'b3', target: 'card-beta', basis: 'ASKING', amount: 240, daysAgo: 6, source: 'tcgplayer' },
  ]);

  const { data } = await buildActiveReport({ ...OPTS, repositories });
  assert.equal(data.cards.length, 2);
  for (const card of data.cards) {
    assert.ok(card.evidence.length >= 3, `card ${card.id} cites all of its observations`);
    for (const ref of card.evidence) {
      assert.equal(typeof ref.id, 'string');
      assert.ok(ref.id.length > 0);
      assert.equal(typeof ref.source, 'string');
      assert.ok(ref.source.length > 0);
      assert.notEqual(Number.isNaN(Date.parse(ref.observedAt)), true);
      assert.ok(['SOLD', 'ASKING', 'OFFER', 'GUIDE', 'CLAIM', 'POPULATION', UNKNOWN].includes(ref.basis));
      assert.equal(typeof ref.currency, 'string');
    }
  }
  const sold = data.cards.find((c) => c.id === 'card-alpha')!;
  const asking = data.cards.find((c) => c.id === 'card-beta')!;
  assert.equal(sold.basis, 'SOLD');
  assert.equal(asking.basis, 'ASKING');
  assert.equal(sold.evidence.some((ref) => ref.basis === 'ASKING'), false);
  assert.equal(asking.evidence.some((ref) => ref.basis === 'SOLD'), false);
});

test('GET /api/intelligence/active-report returns { data, meta } over the injected store', async () => {
  const repositories = createInMemoryRepositories();
  setActiveReportRepositories(repositories);
  await seed(repositories, [
    { key: 'r1', basis: 'SOLD', amount: 100, daysAgo: 1 },
    { key: 'r2', basis: 'SOLD', amount: 110, daysAgo: 2 },
    { key: 'r3', basis: 'SOLD', amount: 120, daysAgo: 3 },
  ]);

  const app = express();
  app.use(createIntelligenceRouter());
  const server: Server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const response = await fetch(`${baseUrl}/api/intelligence/active-report`);
    assert.equal(response.status, 200);
    const body = await response.json() as {
      data: { cards: Array<{ id: string; basis: string }>; summary: { totalObservations: number } };
      meta: { generatedAt: string };
    };
    assert.equal(body.data.summary.totalObservations, 3);
    assert.equal(body.data.cards.length, 1);
    assert.equal(body.data.cards[0].basis, 'SOLD');
    assert.equal(typeof body.meta.generatedAt, 'string');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    setActiveReportRepositories(createInMemoryRepositories());
  }
});
