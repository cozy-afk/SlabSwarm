// Identity resolution and canonical promotion for free-feed records.
// Five cases from the Free Data Foundation Task 4 brief. No network, no model,
// no live database: canonical repositories are backed by an in-memory store.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MarketBasis } from '../../server/contracts/dataProduct.ts';
import type { FreeFeedRecord } from '../../server/contracts/freeFeed.ts';
import {
  createRepositories,
  type Repositories,
} from '../../server/db/repositories/index.ts';
import { createMemoryStore } from '../../server/db/store.ts';
import type { ConfidenceBand } from '../../server/ingest/types.ts';
import {
  promoteToCanonical,
  resolveCandidate,
} from '../../server/identity/resolver.ts';

const OBSERVED_AT = '2026-11-22T10:00:00.000Z';
const CAPTURED_AT = '2026-11-23T09:00:00.000Z';

/**
 * The frozen FreeFeedRecord contract has no captured_at/lineage/confidence.
 * A canonical proposal must carry them explicitly; the internal injection
 * seam keeps this task's one-argument exports testable without a live DB.
 */
interface ProposalProvenance {
  capturedAt?: string;
  lineage?: string[];
  confidence?: ConfidenceBand;
  trustTier?: ConfidenceBand;
  repositories?: Repositories;
  now?: () => Date;
}

function fixture(): Repositories {
  return createRepositories(createMemoryStore());
}

function proposal(
  overrides: Partial<FreeFeedRecord> = {},
  repos?: Repositories,
): FreeFeedRecord {
  const sourceId = overrides.sourceId ?? 'scryfall';
  const externalId = overrides.externalId ?? 's-1';
  const base: FreeFeedRecord = {
    sourceId,
    externalId,
    vertical: 'TRADING_CARD_GAME',
    property: 'Pokemon',
    set: 'Base Set',
    name: 'Charizard',
    number: '4',
    finish: 'UNKNOWN',
    currency: 'USD',
    amount: 12.5,
    basis: 'GUIDE',
    observedAt: OBSERVED_AT,
    sourceUrl: `https://example.test/${sourceId}/${externalId}`,
    license: 'public catalog, attribution required',
    attribution: `${sourceId} public catalog`,
  };
  const extra: ProposalProvenance = {
    capturedAt: CAPTURED_AT,
    lineage: [`source:${sourceId}`, `record:${externalId}`],
    confidence: 'LOW',
    ...(repos ? { repositories: repos } : {}),
  };
  return { ...base, ...overrides, ...extra } as FreeFeedRecord;
}

function evidenceIdsOf(row: { candidates: unknown[] }): string[] {
  return row.candidates
    .map((item) => (item as { evidenceId?: unknown }).evidenceId)
    .filter((value): value is string => typeof value === 'string')
    .sort();
}

/** Canonical rows persist the ref under the `target_identity_id` column. */
function targetOf(row: { targetIdentityRef?: string; targetIdentityId?: string }): string {
  return row.targetIdentityRef ?? row.targetIdentityId ?? 'UNKNOWN';
}

test('two sources naming the same card produce one canonical identity', async () => {
  const repos = fixture();
  const a = proposal({ sourceId: 'scryfall', externalId: 's-1' }, repos);
  const b = proposal({ sourceId: 'pokemontcg', externalId: 'p-1' }, repos);

  const da = await resolveCandidate(a);
  const db = await resolveCandidate(b);
  assert.equal(da.identityKey, db.identityKey);
  assert.equal(da.canonicalId, db.canonicalId);
  assert.equal(da.rule, db.rule);
  assert.equal(da.merged, false);

  const ra = await promoteToCanonical(a);
  const rb = await promoteToCanonical(b);
  assert.equal(ra.accepted, true);
  assert.equal(rb.accepted, true);
  assert.deepEqual(ra.reasons, []);
  assert.deepEqual(rb.reasons, []);

  const cards = await repos.cards.list();
  assert.equal(cards.length, 1);
  const observations = await repos.marketObservations.list();
  assert.equal(observations.length, 2);
  assert.ok(observations.every((row) => targetOf(row) === da.canonicalId));
  assert.deepEqual(
    observations.map((row) => row.evidenceId).sort(),
    ['pokemontcg:p-1', 'scryfall:s-1'],
  );

  // Deterministic tie-break: an alias to a lower-trust external card must
  // never displace the first-party survivor.
  const legacy = await repos.cards.upsert({
    id: 'tcg:legacy-1',
    name: 'Charizard',
    identityKey: 'legacy-key',
    facets: { trustTier: 'LOW', observed_at: '2020-01-01T00:00:00.000Z' },
  });
  await repos.aliases.upsert({
    entityId: legacy.id,
    alias: 'carddex:cd-1',
    source: 'identity-resolver',
  });
  const contested = await resolveCandidate(
    proposal({ sourceId: 'carddex', externalId: 'cd-1' }, repos),
  );
  assert.equal(contested.canonicalId, da.canonicalId);
  assert.equal(contested.merged, true);
  assert.deepEqual([...contested.aliases].sort(), ['carddex:cd-1', 'tcg:legacy-1']);
});

test('a missing set or number stays UNKNOWN and does not merge', async () => {
  const repos = fixture();
  const known = proposal({ set: 'Base Set', number: '4' }, repos);
  const noNumber = proposal({
    sourceId: 'carddex', externalId: 'c-2', set: 'Base Set', number: 'UNKNOWN',
  }, repos);
  const noSet = proposal({
    sourceId: 'cardex', externalId: 'x-3', set: 'UNKNOWN', number: '4',
  }, repos);
  const neither = proposal({
    sourceId: 'scryfall', externalId: 's-4', set: 'UNKNOWN', number: 'UNKNOWN',
  }, repos);
  const neitherAgain = proposal({
    sourceId: 'pokemontcg', externalId: 'p-5', set: 'UNKNOWN', number: 'UNKNOWN',
  }, repos);
  const all = [known, noNumber, noSet, neither, neitherAgain];

  const decisions = [];
  for (const candidate of all) decisions.push(await resolveCandidate(candidate));
  const keys = new Set(decisions.map((decision) => decision.identityKey));
  const ids = new Set(decisions.map((decision) => decision.canonicalId));
  assert.equal(keys.size, all.length);
  assert.equal(ids.size, all.length);
  assert.ok(decisions.every((decision) => decision.merged === false));
  assert.equal(decisions[1]!.inputs.number, 'UNKNOWN');
  assert.equal(decisions[2]!.inputs.set, 'UNKNOWN');

  for (const candidate of all) {
    const report = await promoteToCanonical(candidate);
    assert.equal(report.accepted, true);
  }
  const cards = await repos.cards.list();
  assert.equal(cards.length, all.length);
  assert.deepEqual(
    cards.map((card) => card.cardNumber).sort(),
    ['4', '4', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN'],
  );
  assert.deepEqual(
    cards.map((card) => card.setId).sort(),
    ['Base Set', 'Base Set', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN'],
  );
  assert.equal((await repos.aliases.list()).length, 0);
  const decisionsWritten = await repos.identityDecisions.list();
  assert.equal(decisionsWritten.length, all.length);
  assert.ok(decisionsWritten.every((row) => row.status === 'ACCEPTED'));
});

test('GUIDE amount stays GUIDE/USD and is never relabelled SOLD', async () => {
  const repos = fixture();
  const guide = proposal({
    sourceId: 'pokemontcg',
    externalId: 'p-1',
    basis: 'GUIDE' as MarketBasis,
    currency: 'USD',
    amount: 123.45,
  }, repos);
  const report = await promoteToCanonical(guide);

  assert.equal(report.accepted, true);
  assert.equal(report.observation?.basis, 'GUIDE');
  assert.equal(report.observation?.currency, 'USD');
  const observations = await repos.marketObservations.list();
  assert.equal(observations.length, 1);
  assert.equal(observations[0]!.basis, 'GUIDE');
  assert.equal(observations[0]!.currency, 'USD');
  assert.equal(observations[0]!.amount, 123.45);
  assert.ok(!observations.some((row) => row.basis === 'SOLD'));
  const decision = (await repos.identityDecisions.list())[0]!;
  assert.equal(decision.scores.basis, 'GUIDE');
  assert.equal(decision.scores.currency, 'USD');
});

test('a candidate missing provenance is rejected without any canonical write', async () => {
  const repos = fixture();
  const incomplete = { ...proposal({}, repos) } as FreeFeedRecord & Record<string, unknown>;
  delete incomplete.capturedAt;
  delete incomplete.lineage;
  delete incomplete.confidence;

  const report = await promoteToCanonical(incomplete as FreeFeedRecord);
  assert.equal(report.accepted, false);
  assert.equal(report.card, null);
  assert.equal(report.observation, null);
  assert.ok(report.reasons.length >= 3, report.reasons.join(', '));
  const joined = report.reasons.join(' ');
  assert.match(joined, /captured/i);
  assert.match(joined, /lineage/i);
  assert.match(joined, /confidence/i);

  assert.equal((await repos.cards.list()).length, 0);
  assert.equal((await repos.marketObservations.list()).length, 0);
  assert.equal((await repos.identityDecisions.list()).length, 0);
  assert.equal((await repos.aliases.list()).length, 0);
});

test('a merge is reversible: the original identity survives and an identity_decisions row is recorded', async () => {
  const repos = fixture();
  const first = proposal({ sourceId: 'scryfall', externalId: 's-1' }, repos);
  const firstReport = await promoteToCanonical(first);
  assert.equal(firstReport.accepted, true);
  const before = (await repos.cards.list())[0]!;

  const second = proposal({ sourceId: 'pokemontcg', externalId: 'p-1' }, repos);
  const secondReport = await promoteToCanonical(second);
  assert.equal(secondReport.accepted, true);
  assert.equal(secondReport.decision?.merged, true);

  const cards = await repos.cards.list();
  assert.equal(cards.length, 1);
  assert.equal(cards[0]!.id, before.id);
  assert.equal(cards[0]!.identityKey, before.identityKey);
  assert.deepEqual(cards[0]!.facets, before.facets);

  const aliases = await repos.aliases.list();
  assert.equal(aliases.length, 1);
  assert.equal(aliases[0]!.entityId, before.id);
  assert.equal(aliases[0]!.alias, 'pokemontcg:p-1');

  const decisions = await repos.identityDecisions.list();
  const merge = decisions.find((row) => row.status === 'MERGED');
  assert.ok(merge, 'a MERGED identity_decisions row must exist');
  assert.deepEqual(evidenceIdsOf(merge!), ['pokemontcg:p-1', 'scryfall:s-1']);
  assert.equal(merge!.scores.rule, 'EXACT_MATCH');
  assert.ok(merge!.scores.inputs, 'input fields are recorded');
  assert.ok(merge!.scores.confidence, 'confidence is recorded');
  assert.ok(typeof merge!.createdAt === 'string' && merge!.createdAt.length > 0);
  const reversibleKeys = merge!.scores.originalIdentityKeys as string[];
  assert.ok(Array.isArray(reversibleKeys) && reversibleKeys.length === 2);

  // Nothing is rewritten: both observations still point at the survivor.
  const observations = await repos.marketObservations.list();
  assert.equal(observations.length, 2);
  assert.ok(observations.every((row) => targetOf(row) === before.id));

  // Replay is idempotent: no second observation or alias is created.
  const repeat = await promoteToCanonical(second);
  assert.equal(repeat.accepted, true);
  assert.equal((await repos.marketObservations.list()).length, 2);
  assert.equal((await repos.aliases.list()).length, 1);
  assert.equal(repeat.promotion?.duplicates, 1);
});
