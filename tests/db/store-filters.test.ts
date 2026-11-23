import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSqlStore } from '../../server/db/store.ts';

test('SQL store filters become WHERE clauses with bound parameters', async () => {
  const calls: { sql: string; params: readonly unknown[] }[] = [];
  const executor = {
    async query(sql: string, params: readonly unknown[] = []) {
      calls.push({ sql, params });
      return { rows: [] };
    },
  };
  const store = createSqlStore(executor as unknown as Parameters<typeof createSqlStore>[0]);
  await store.findAll('cards', { identityKey: 'tcg:719440', name: 'Example Card' });

  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /WHERE/);
  assert.match(calls[0].sql, /identity_key/);
  assert.deepEqual([...calls[0].params], ['tcg:719440', 'Example Card']);
});

test('SQL store serializes plain strings written to JSONB columns', async () => {
  const calls: { sql: string; params: readonly unknown[] }[] = [];
  const executor = {
    async query(sql: string, params: readonly unknown[] = []) {
      calls.push({ sql, params });
      return { rows: [{}] };
    },
  };
  const store = createSqlStore(executor as unknown as Parameters<typeof createSqlStore>[0]);
  await store.insert('cards', { name: 'X', identityKey: 'k', facets: 'plain text' });
  assert.ok([...calls[0].params].includes('"plain text"'));
});

test('SQL store serializes JSONB arrays as JSON text', async () => {
  const calls: { sql: string; params: readonly unknown[] }[] = [];
  const executor = {
    async query(sql: string, params: readonly unknown[] = []) {
      calls.push({ sql, params });
      return { rows: [{}] };
    },
  };
  const store = createSqlStore(executor as unknown as Parameters<typeof createSqlStore>[0]);
  await store.insert('research_notes', { question: 'q', subquestions: ['a', 'b'], evidenceIds: ['e1'] });
  assert.ok([...calls[0].params].includes('["a","b"]'));
  assert.ok([...calls[0].params].includes('["e1"]'));
});

test('SQL store ignores unknown filter names instead of emitting bad SQL', async () => {
  const calls: { sql: string; params: readonly unknown[] }[] = [];
  const executor = {
    async query(sql: string, params: readonly unknown[] = []) {
      calls.push({ sql, params });
      return { rows: [] };
    },
  };
  const store = createSqlStore(executor as unknown as Parameters<typeof createSqlStore>[0]);
  await store.findAll('cards', { notAColumn: 'x' });
  assert.doesNotMatch(calls[0].sql, /WHERE/);
  assert.deepEqual([...calls[0].params], []);
});
