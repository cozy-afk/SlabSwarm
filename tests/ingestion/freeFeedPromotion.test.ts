// End-to-end: a free-feed harvest writes immutable ledger evidence and then
// promotes provenance-complete records into canonical cards and observations.
// Injected fetch only — no live third-party call, no model, no invented price.

import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';

import {
  createRepositories,
  type Repositories,
} from '../../server/db/repositories/index.ts';
import { createMemoryStore } from '../../server/db/store.ts';
import { createInMemoryRepositories } from '../../server/ingest/store.ts';
import { createIngestRouter } from '../../server/ingest/routes.ts';
import type { IngestRepositories } from '../../server/ingest/types.ts';

const CAPTURED_AT = '2026-11-23T12:00:00.000Z';
const OBSERVED_AT = '2026-11-22T10:00:00.000Z';

/** Complete GUIDE-priced record: identity facets + a published market price. */
const COMPLETE_BODY = {
  data: [
    {
      id: 'base1-4',
      name: 'Charizard',
      game: 'pokemon',
      set: { id: 'base1', name: 'Base' },
      number: '4',
      observedAt: OBSERVED_AT,
      tcgplayer: {
        url: 'https://www.tcgplayer.com/product/4386',
        prices: { normal: { market: 412.5 } },
      },
    },
  ],
};

/** A ledger-eligible record whose identity provenance is missing (no name/id). */
const INCOMPLETE_BODY = {
  data: [
    {
      id: '',
      name: '',
      game: 'magic',
      set_name: 'Base',
      collector_number: '4',
      observedAt: OBSERVED_AT,
    },
  ],
};

let server: Server;
let baseUrl: string;
let ledger: IngestRepositories;
let canonical: Repositories;
let nextBody: unknown;
const calls: string[] = [];

before(async () => {
  ledger = createInMemoryRepositories({ durable: false });
  canonical = createRepositories(createMemoryStore());
  const app = express();
  app.use(express.json());
  app.use(createIngestRouter(ledger, {
    freeFeeds: {
      // Deterministic server clock and fully injected transport.
      now: () => new Date(CAPTURED_AT),
      fetchImpl: async (url: string) => {
        calls.push(url);
        return {
          ok: true,
          status: 200,
          json: async () => nextBody,
          text: async () => JSON.stringify(nextBody),
        };
      },
      // Canonical repositories are a server-side seam, never an HTTP input.
      repositories: canonical,
    },
  }));
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

function harvest(sourceId: string, body: Record<string, unknown> = {}) {
  return fetch(`${baseUrl}/api/ingest/free-feeds/${sourceId}/harvest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('a free-feed harvest promotes complete records, rejects provenance-incomplete ones, and is idempotent', async () => {
  // 1. Complete record -> ledger evidence + canonical card and observation.
  //    Forged provenance in the HTTP body must never reach a canonical fact.
  nextBody = COMPLETE_BODY;
  const firstRes = await harvest('pokemontcg', {
    capturedAt: '2001-01-01T00:00:00.000Z',
    lineage: ['FORGED_BODY_LINEAGE'],
    confidence: 'HIGH',
  });
  assert.equal(firstRes.status, 200);
  const first = await firstRes.json() as Record<string, any>;
  assert.equal(first.data.status, 'COMPLETED');
  assert.equal(first.data.counts.fetched, 1);
  assert.equal(first.data.counts.created, 1);
  assert.ok(first.data.canonical, 'harvest must return a canonical write report in data');
  assert.equal(
    first.data.canonical.accepted, true,
    `complete candidate must commit: ${JSON.stringify(first.data.canonical)}`,
  );
  assert.equal(first.data.canonical.attempted, 1);
  assert.equal(first.data.canonical.promoted, 1);
  assert.equal(first.data.canonical.rejected, 0);
  assert.equal(first.meta.canonicalPromotion.accepted, true, 'report must also appear in meta');

  const ledgerEvidence = (await ledger.evidence.list({ sourceId: 'pokemontcg' }))[0];
  assert.ok(ledgerEvidence, 'the accepted record must stay in the immutable ledger');
  assert.equal(ledgerEvidence.capturedAt, CAPTURED_AT, 'server clock, not the forged body value');
  const cards = await canonical.cards.list();
  assert.equal(cards.length, 1, 'one canonical card');
  const observations = await canonical.marketObservations.list();
  assert.equal(observations.length, 1, 'one canonical observation');
  const observation = observations[0]!;
  // The observation must cite a canonical evidence_records id, never the
  // ledger's `ev-*` id or the synthetic `source:externalId` identity key (A-01).
  const canonicalEvidence = await canonical.evidence.get(observation.evidenceId);
  assert.ok(
    canonicalEvidence,
    `promoted observation cites unresolvable evidence id ${observation.evidenceId}`,
  );
  assert.equal(canonicalEvidence.sourceRecordId, ledgerEvidence!.sourceRecordId);
  assert.equal(canonicalEvidence.checksum, ledgerEvidence!.checksum);
  assert.equal(observation.basis, 'GUIDE', 'a catalog price stays GUIDE, never SOLD');
  assert.equal(observation.amount, 412.5, 'the published price is copied, never invented');
  assert.equal(observation.currency, 'USD');
  assert.equal(
    observation.targetIdentityRef ?? (observation as any).targetIdentityId,
    cards[0]!.id,
  );
  const facets = cards[0]!.facets as Record<string, unknown>;
  assert.equal(facets.source, 'pokemontcg');
  assert.equal(facets.observed_at, OBSERVED_AT);
  assert.equal(facets.captured_at, CAPTURED_AT, 'canonical captured_at comes from the server');
  assert.equal(facets.confidence, 'UNKNOWN', 'caller-supplied confidence must be ignored');
  assert.equal(facets.basis, 'GUIDE');
  assert.equal(facets.currency, 'USD');
  const lineage = facets.lineage as string[];
  assert.ok(Array.isArray(lineage) && lineage.length > 0);
  assert.ok(lineage.includes(`run:${first.data.runId}`));
  assert.ok(lineage.includes(`evidence:${ledgerEvidence!.id}`));
  assert.ok(!JSON.stringify(facets).includes('FORGED_BODY_LINEAGE'));
  assert.ok(!JSON.stringify(first).includes('FORGED_BODY_LINEAGE'));

  // 2. Provenance-incomplete candidate -> stays in the ledger, is reported
  //    rejected, and writes no canonical row.
  nextBody = INCOMPLETE_BODY;
  const secondRes = await harvest('scryfall');
  assert.equal(secondRes.status, 200);
  const second = await secondRes.json() as Record<string, any>;
  assert.equal(second.data.counts.created, 1, 'the candidate is still written to the ledger');
  assert.equal(second.data.canonical.accepted, false, 'a partial write must not be reported as success');
  assert.equal(second.data.canonical.attempted, 1);
  assert.equal(second.data.canonical.promoted, 0);
  assert.equal(second.data.canonical.rejected, 1);
  assert.ok(
    second.data.canonical.reasons.some((reason: string) => /name|record id/i.test(reason)),
    JSON.stringify(second.data.canonical.reasons),
  );
  assert.equal(second.meta.canonicalPromotion.accepted, false, 'meta carries the failure too');
  assert.equal((await ledger.evidence.list({ sourceId: 'scryfall' })).length, 1);
  assert.equal((await canonical.cards.list()).length, 1, 'no extra canonical card');
  assert.equal((await canonical.marketObservations.list()).length, 1, 'no extra observation');

  // 3. Re-harvesting the same data is idempotent: ledger duplicates, no new
  //    canonical rows, no replayed promotion or identity decision.
  const cardsBefore = (await canonical.cards.list()).length;
  const observationsBefore = (await canonical.marketObservations.list()).length;
  const decisionsBefore = (await canonical.identityDecisions.list()).length;
  nextBody = COMPLETE_BODY;
  const thirdRes = await harvest('pokemontcg');
  assert.equal(thirdRes.status, 200);
  const third = await thirdRes.json() as Record<string, any>;
  assert.equal(third.data.counts.created, 0);
  assert.ok(third.data.counts.duplicates >= 1);
  assert.equal(third.data.canonical.attempted, 0, 'duplicates are not re-promoted');
  assert.equal(third.data.canonical.accepted, true);
  assert.equal((await canonical.cards.list()).length, cardsBefore);
  assert.equal((await canonical.marketObservations.list()).length, observationsBefore);
  assert.equal((await canonical.identityDecisions.list()).length, decisionsBefore);

  // Every call was served by the injected fetch against the configured host.
  assert.ok(calls.length >= 3);
  assert.ok(calls.every((url) =>
    url.startsWith('https://api.pokemontcg.io/') || url.startsWith('https://api.scryfall.com/')),
  );
});
