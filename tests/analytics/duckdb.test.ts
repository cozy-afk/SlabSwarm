import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertReadOnlySql,
  getEngineStatus,
  QueryEngineError,
  ReadOnlyViolation,
  runReadOnlyQuery,
} from '../../server/analytics/duckdb.ts';

test('read-only guard accepts SELECT and WITH statements', () => {
  assert.doesNotThrow(() => assertReadOnlySql('SELECT 1 AS n'));
  assert.doesNotThrow(() => assertReadOnlySql('WITH x AS (SELECT 1) SELECT * FROM x'));
});

test('read-only guard rejects writes, DDL, pragmas and stacked statements', () => {
  for (const sql of [
    'DROP TABLE observations',
    'DELETE FROM observations',
    'UPDATE observations SET amount = 0',
    'INSERT INTO observations VALUES (1)',
    'CREATE TABLE t (n INT)',
    'COPY observations TO \'/tmp/x.csv\'',
    `PRAGMA enable_external_access=true`,
    `SET enable_external_access=true`,
    'SELECT 1; DROP TABLE observations',
    '/* comment */ DROP TABLE observations',
    'SELECT read_csv(\'/etc/passwd\')',
    'SELECT read_text(\'/etc/passwd\')',
  ]) {
    assert.throws(() => assertReadOnlySql(sql), ReadOnlyViolation, sql);
  }
});

test('string literals do not trigger the keyword guard', () => {
  assert.doesNotThrow(() => assertReadOnlySql(`SELECT 'DROP TABLE' AS literal`));
});

test('real DuckDB executes a read-only query and returns named rows', async () => {
  assert.equal(getEngineStatus().engine, 'duckdb');
  const result = await runReadOnlyQuery(
    `SELECT 42 AS n, 'SOLD' AS basis, NULL AS missing`,
  );
  assert.deepEqual(result.columns, ['n', 'basis', 'missing']);
  assert.deepEqual(result.rows, [{ n: 42, basis: 'SOLD', missing: null }]);
  assert.equal(result.rowCount, 1);
  assert.equal(result.truncated, false);
  assert.equal(result.engine, 'duckdb');
});

test('row cap truncates deterministically', async () => {
  const result = await runReadOnlyQuery(
    `SELECT i FROM range(10) t(i) ORDER BY i`,
    { maxRows: 3 },
  );
  assert.equal(result.rows.length, 3);
  assert.equal(result.truncated, true);
  assert.equal(result.rowCount, 3);
});

test('engine failure surfaces as a typed, graceful error with the same result contract', async () => {
  await assert.rejects(
    runReadOnlyQuery('SELECT 1', {
      executor: {
        async run() {
          throw new Error('native binding unavailable');
        },
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof QueryEngineError);
      assert.match((error as Error).message, /native binding unavailable/);
      return true;
    },
  );
});
