import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { MemoryStore, createMemoryStore } from '../../server/db/store.ts';
import {
  DEFAULT_MIGRATIONS,
  MigrationError,
  migrationChecksum,
  runMigrations,
} from '../../server/db/migrate.ts';

const first = { name: '0001_init.sql', sql: 'CREATE TABLE a (id text);' };
const second = { name: '0002_more.sql', sql: 'CREATE TABLE b (id text);' };

test('migration runner applies pending files once and records each checksum', async () => {
  const store = createMemoryStore();
  const report = await runMigrations(store, [first, second]);
  assert.deepEqual(report.applied, [first.name, second.name]);
  assert.deepEqual(report.skipped, []);
  const records = await store.findAll('__schema_migrations');
  assert.equal(records.length, 2);
  assert.equal(records[0].checksum, migrationChecksum(first.sql));

  const again = await runMigrations(store, [first, second]);
  assert.deepEqual(again.applied, []);
  assert.deepEqual(again.skipped, [first.name, second.name]);
  assert.equal((await store.findAll('__schema_migrations')).length, 2);
});

test('migration runner applies only files added after the last run', async () => {
  const store = createMemoryStore();
  await runMigrations(store, [first]);
  const report = await runMigrations(store, [first, second]);
  assert.deepEqual(report.applied, [second.name]);
  assert.deepEqual(report.skipped, [first.name]);
});

test('migration runner refuses a changed checksum for an applied migration', async () => {
  const store = createMemoryStore();
  await runMigrations(store, [first]);
  await assert.rejects(
    runMigrations(store, [{ ...first, sql: 'CREATE TABLE a (id int);' }]),
    MigrationError,
  );
  assert.equal((await store.findAll('__schema_migrations')).length, 1);
});

test('a failed migration is rolled back and not recorded', async () => {
  const store = new MemoryStore();
  const broken = { name: '0002_broken.sql', sql: 'FORCE_FAILURE;' };
  await assert.rejects(runMigrations(store, [first, broken]), MigrationError);
  const records = await store.findAll('__schema_migrations');
  assert.deepEqual(records.map((r) => r.name), [first.name]);
  assert.ok(!store.executedSql.includes(broken.sql), 'failed DDL must not be committed');
});

test('checked-in migrations create the core tables and are discoverable by default', async () => {
  assert.ok(DEFAULT_MIGRATIONS.length >= 1, 'at least one migration file must be checked in');
  for (const migration of DEFAULT_MIGRATIONS) {
    const file = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '../../server/db/migrations',
      migration.name,
    );
    assert.equal(fs.readFileSync(file, 'utf-8'), migration.sql);
  }
  const allSql = DEFAULT_MIGRATIONS.map((m) => m.sql).join('\n');
  for (const table of ['evidence_records', 'market_observations', 'cards', 'forecasts', 'jobs', 'research_notes']) {
    assert.match(allSql, new RegExp(`CREATE TABLE( IF NOT EXISTS)? ${table}\\b`));
  }
  const store = new MemoryStore();
  const report = await runMigrations(store);
  assert.equal(report.applied.length, DEFAULT_MIGRATIONS.length);
  assert.ok(store.executedSql.some((sql) => sql.includes('CREATE INDEX')));
});
