import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getBuiltInQueries, runSqlQuery, saveQuery } from '../../server/analytics/sqlLab.ts';
import { ReadOnlyViolation, ValidationError } from '../../server/analytics/duckdb.ts';
import {
  daysAgo,
  makeEvidence,
  makeObservation,
  makeStore,
} from './fixtures.ts';

test('built-in query list is non-empty, stable and entirely read-only', () => {
  const queries = getBuiltInQueries();
  assert.ok(queries.length >= 4);
  assert.deepEqual(queries.map((q) => q.id), queries.map((q) => q.id).slice().sort());
  for (const query of queries) {
    assert.ok(query.id && query.title && query.description && query.sql);
    assert.match(query.sql, /^\s*(SELECT|WITH)\b/i);
  }
});

test('a built-in query runs over seeded observations and preserves basis', async () => {
  const store = makeStore({
    observations: [
      makeObservation({ id: 'o-1', basis: 'SOLD', amount: 100, observedAt: daysAgo(1) }),
      makeObservation({ id: 'o-2', basis: 'ASKING', amount: 300, observedAt: daysAgo(1) }),
      makeObservation({ id: 'o-3', basis: 'SOLD', amount: 110, observedAt: daysAgo(1) }),
    ],
  });
  const result = await runSqlQuery(store, { queryId: 'basis_mix' });
  assert.ok(result.rows.length >= 2);
  const sold = result.rows.find((row) => row.basis === 'SOLD');
  assert.equal(sold?.observations, 2);
  assert.equal(sold?.currency, 'USD');
  assert.equal(result.source, 'template');
});

test('raw SQL reads the projected tables and returns result-shape metadata', async () => {
  const store = makeStore({
    evidence: [makeEvidence({ id: 'e-1' })],
    observations: [makeObservation({ id: 'o-1' })],
  });
  const result = await runSqlQuery(store, {
    sql: `SELECT source, COUNT(*) AS observations FROM observations GROUP BY source`,
  });
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].source, 'ebay');
  assert.equal(result.rows[0].observations, 1);
  assert.ok(Array.isArray(result.columns));
  assert.ok(typeof result.durationMs === 'number');
  assert.equal(result.source, 'raw');
});

test('SQL Lab rejects write statements before execution', async () => {
  const store = makeStore();
  for (const sql of [
    'DROP TABLE observations',
    'DELETE FROM observations',
    'INSERT INTO observations VALUES (1)',
    'SELECT 1; DROP TABLE evidence',
    'SELECT read_csv(\'/etc/passwd\')',
  ]) {
    await assert.rejects(runSqlQuery(store, { sql }), ReadOnlyViolation, sql);
  }
});

test('SQL Lab rejects malformed input and unknown template ids', async () => {
  const store = makeStore();
  await assert.rejects(runSqlQuery(store, {}), ValidationError);
  await assert.rejects(runSqlQuery(store, { sql: 42 }), ValidationError);
  await assert.rejects(runSqlQuery(store, { queryId: 'does-not-exist' }), ValidationError);
});

test('SQL Lab enforces a row cap', async () => {
  const store = makeStore({
    observations: Array.from({ length: 12 }, (_, i) =>
      makeObservation({ id: `o-${i}`, observedAt: daysAgo(1) }),
    ),
  });
  const result = await runSqlQuery(store, {
    sql: `SELECT id FROM observations ORDER BY id`,
    limit: 4,
  });
  assert.equal(result.rows.length, 4);
  assert.equal(result.truncated, true);
});

test('saved query repository rejects writes and stores read-only SQL', () => {
  const store = makeStore();
  assert.throws(
    () => saveQuery(store, { name: 'bad', sql: 'DELETE FROM observations' }),
    ReadOnlyViolation,
  );
  const saved = saveQuery(store, {
    name: 'Basis mix',
    sql: 'SELECT basis, COUNT(*) AS n FROM observations GROUP BY basis',
    description: 'Read-only basis report',
  });
  assert.ok(saved.id);
  assert.equal(store.getSavedQuery(saved.id)?.name, 'Basis mix');
  assert.equal(store.listSavedQueries().length, 1);
  assert.equal(store.deleteSavedQuery(saved.id), true);
  assert.equal(store.listSavedQueries().length, 0);
});
