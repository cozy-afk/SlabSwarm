// Failing-first tests for canonical catalog facets and deterministic,
// typo-tolerant filterable search. All cards are injected in memory; no
// external search service, no Postgres and no listener are involved.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMemoryStore } from '../../server/db/store.ts';
import { createRepositories } from '../../server/db/repositories/index.ts';
import * as catalog from '../../server/db/repositories/card.ts';

// Namespace access keeps the RED phase a runtime failure (feature missing)
// rather than an ESM import-time error.
const extract = (card: unknown): any => (catalog as any).extractCatalogFacets(card);
const search = (cards: unknown[], options: unknown = {}): any[] =>
  (catalog as any).searchCatalogCards(cards, options);

function makeCard(
  id: string,
  name: string,
  facets: Record<string, unknown> | null = {},
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    name,
    identityKey: `key:${id}`,
    setId: null,
    cardNumber: '1',
    variant: null,
    facets,
    rawPayload: null,
    createdAt: '2026-11-20T00:00:00.000Z',
    ...overrides,
  };
}

const FACET_KEYS = ['set', 'parallel', 'serialRun', 'grade', 'rookie', 'category'] as const;

test('extractCatalogFacets reads all six searchable facets from JSONB', () => {
  const view = extract(makeCard('c1', 'Charizard', {
    set: 'Base Set',
    parallel: '1st Edition Holo',
    serialRun: '23/99',
    grade: 'PSA 10',
    rookie: 'YES',
    category: 'Pokemon',
  }));
  assert.equal(view.id, 'c1');
  assert.equal(view.name, 'Charizard');
  assert.equal(view.set, 'Base Set');
  assert.equal(view.parallel, '1st Edition Holo');
  assert.equal(view.serialRun, '23/99');
  assert.equal(view.grade, 'PSA 10');
  assert.equal(view.rookie, 'YES');
  assert.equal(view.category, 'Pokemon');
});

test('absent facets stay UNKNOWN and are never zero, false or invented', () => {
  for (const facets of [null, {}, 'not-an-object', { set: '', grade: '   ' }]) {
    const view = extract(makeCard('c2', 'Sparse', facets as Record<string, unknown> | null));
    for (const key of FACET_KEYS) assert.equal(view[key], 'UNKNOWN', `${key} for ${String(facets)}`);
    assert.notEqual(view.serialRun, 0);
    assert.notEqual(view.rookie, false);
  }
});

test('extractCatalogFacets accepts documented alternate facet spellings', () => {
  const view = extract(makeCard('c3', 'Alternate', {
    expansionName: 'Base',
    print_run: 99,
    gradeLabel: 'BGS 9.5',
    isRookie: true,
    vertical: 'TRADING_CARD_GAME',
  }));
  assert.equal(view.set, 'Base');
  assert.equal(view.serialRun, '99');
  assert.equal(view.grade, 'BGS 9.5');
  assert.equal(view.rookie, 'YES');
  assert.equal(view.category, 'TRADING_CARD_GAME');
});

test('extractCatalogFacets maps rookie true, false and absent to YES, NO and UNKNOWN', () => {
  assert.equal(extract(makeCard('r1', 'R', { rookie: true })).rookie, 'YES');
  assert.equal(extract(makeCard('r2', 'R', { isRookie: false })).rookie, 'NO');
  assert.equal(extract(makeCard('r3', 'R', {})).rookie, 'UNKNOWN');
  assert.equal(extract(makeCard('r4', 'R', { rookie: 'maybe' })).rookie, 'UNKNOWN');
});

test('extraction does not mutate the canonical identity key or the raw facets payload', () => {
  const card = makeCard('c4', 'Immutable', { set: 'Base', grade: 'PSA 10' });
  const identityKey = card.identityKey;
  const facets = structuredClone(card.facets);
  extract(card);
  assert.equal(card.identityKey, identityKey);
  assert.deepEqual(card.facets, facets);
});

test('all six facets are filterable with exact values', () => {
  const card = makeCard('a', 'X', {
    set: 'Base',
    parallel: 'Holo',
    serialRun: '1/25',
    grade: 'PSA 10',
    rookie: true,
    category: 'Pokemon',
  });
  const values = {
    set: 'Base',
    parallel: 'Holo',
    serialRun: '1/25',
    grade: 'PSA 10',
    rookie: 'YES',
    category: 'Pokemon',
  };
  for (const key of FACET_KEYS) {
    assert.deepEqual(search([card], { [key]: values[key] }).map((row) => row.id), ['a'], key);
  }
  // A typo in a facet filter is not silently broadened into a fuzzy match.
  assert.deepEqual(search([card], { set: 'Bsae' }), []);
});

test('a zero or negative print run stays UNKNOWN instead of becoming a value', () => {
  assert.equal(extract(makeCard('z1', 'Z', { print_run: 0 })).serialRun, 'UNKNOWN');
  assert.equal(extract(makeCard('z2', 'Z', { serialRun: -3 })).serialRun, 'UNKNOWN');
});

test('searchCatalogCards filters by one facet case-insensitively', () => {
  const cards = [
    makeCard('a', 'Alpha', { set: 'Base Set' }),
    makeCard('b', 'Beta', { set: 'Jungle' }),
    makeCard('c', 'Gamma', {}),
  ];
  assert.deepEqual(search(cards, { set: 'base set' }).map((row) => row.id), ['a']);
});

test('searchCatalogCards ANDs multiple facet filters', () => {
  const cards = [
    makeCard('a', 'Alpha', { set: 'Base Set', grade: 'PSA 10', rookie: true }),
    makeCard('b', 'Beta', { set: 'Base Set', grade: 'PSA 9', rookie: true }),
    makeCard('c', 'Gamma', { set: 'Jungle', grade: 'PSA 10', rookie: true }),
  ];
  assert.deepEqual(
    search(cards, { set: 'Base Set', grade: 'PSA 10', rookie: 'YES' }).map((row) => row.id),
    ['a'],
  );
});

test('searchCatalogCards can filter explicitly for UNKNOWN facets', () => {
  const cards = [
    makeCard('a', 'Alpha', { set: 'Base Set' }),
    makeCard('b', 'Beta', {}),
  ];
  assert.deepEqual(search(cards, { set: 'UNKNOWN' }).map((row) => row.id), ['b']);
});

test('searchCatalogCards finds a name with a single-character typo', () => {
  const cards = [
    makeCard('a', 'Charizard', { set: 'Base Set' }),
    makeCard('b', 'Pikachu', { set: 'Jungle' }),
  ];
  assert.deepEqual(search(cards, { q: 'Charzard' }).map((row) => row.id), ['a']);
});

test('searchCatalogCards finds transposed and missing-character typos in names and facets', () => {
  const cards = [
    makeCard('a', 'Charizard', { set: 'Base' }),
    makeCard('b', 'Blastoise', { set: 'Jungle' }),
  ];
  assert.deepEqual(search(cards, { q: 'Chrazard' }).map((row) => row.id), ['a']);
  assert.deepEqual(search(cards, { q: 'Bas' }).map((row) => row.id), ['a']);
  assert.deepEqual(search(cards, { q: 'Jungl' }).map((row) => row.id), ['b']);
});

test('searchCatalogCards searches facet text, not only names', () => {
  const cards = [
    makeCard('a', 'Card A', { set: 'Jungle', parallel: '1st Edition', grade: 'PSA 10' }),
    makeCard('b', 'Card B', { set: 'Base', category: 'Sports' }),
  ];
  assert.deepEqual(search(cards, { q: '1st Editon' }).map((row) => row.id), ['a']);
  assert.deepEqual(search(cards, { q: 'sports' }).map((row) => row.id), ['b']);
});

test('typo matches rank by distance then id and honor the limit deterministically', () => {
  const cards = [
    makeCard('b', 'Charizard', {}),
    makeCard('a', 'Charizard', {}),
    makeCard('c', 'Charizard Holo', {}),
  ];
  assert.deepEqual(search(cards, { q: 'Charzard' }).map((row) => row.id), ['a', 'b', 'c']);
  assert.deepEqual(search(cards, { q: 'Charzard', limit: 1 }).map((row) => row.id), ['a']);
  assert.deepEqual(search(cards, { q: 'Charzard' }), search(cards, { q: 'Charzard' }));
});

test('searchCatalogCards never fabricates matches for unrelated or UNKNOWN queries', () => {
  const cards = [makeCard('a', 'Charizard', {}), makeCard('b', 'Pikachu', {})];
  assert.deepEqual(search(cards, { q: 'zzzznotfound' }), []);
  assert.deepEqual(search(cards, { q: 'UNKNOWN' }), []);
  assert.deepEqual(search(cards, { q: '   ' }), []);
});

test('card repository search reads injected cards and applies facet filters', async () => {
  const repos = createRepositories(createMemoryStore());
  await repos.cards.create({
    name: 'Charizard',
    identityKey: 'base-1-4',
    setId: 'base',
    facets: { set: 'Base Set', grade: 'PSA 10' },
  });
  await repos.cards.create({
    name: 'Pikachu',
    identityKey: 'jungle-1-25',
    setId: 'jungle',
    facets: { set: 'Jungle', grade: 'PSA 9' },
  });
  const results = await (repos.cards as any).search({ grade: 'PSA 10' });
  assert.equal(results.length, 1);
  assert.equal(results[0].name, 'Charizard');
  assert.equal(results[0].identityKey, undefined, 'facet search returns the facet view, not a mutated card');
  assert.deepEqual((await repos.cards.list()).map((row) => row.identityKey).sort(), ['base-1-4', 'jungle-1-25']);
});
