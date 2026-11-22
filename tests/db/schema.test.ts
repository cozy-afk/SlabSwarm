import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getTableColumns } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import * as schema from '../../server/db/schema.ts';
import { TABLE_REGISTRY } from '../../server/db/store.ts';

const CORE_COLLECTIONS = [
  'evidence_records', 'raw_payloads', 'ingest_runs', 'market_observations',
  'games', 'sets', 'cards', 'printings', 'instances', 'entities', 'events',
  'identity_decisions', 'aliases', 'crosswalks', 'factors', 'factor_scores',
  'forecasts', 'forecast_scores', 'simulation_runs', 'swarm_runs',
  'research_notes', 'learning_events', 'source_trust_profiles', 'rule_versions',
  'jobs',
];

test('Drizzle schema defines every core collection plus backfill and migration tables', () => {
  for (const name of CORE_COLLECTIONS) {
    assert.ok(TABLE_REGISTRY[name], `table ${name} must be registered`);
    assert.ok((Object.values(schema) as unknown[]).includes(TABLE_REGISTRY[name]), `schema must define ${name}`);
  }
  assert.ok(TABLE_REGISTRY['valuations']);
  assert.ok(TABLE_REGISTRY['__schema_migrations']);
  assert.ok(schema.schemaMigrations);
});

test('raw payloads and flexible facets use JSONB columns', () => {
  const evidenceCols = getTableColumns(schema.evidenceRecords);
  assert.equal(evidenceCols.parsedPayload.getSQLType(), 'jsonb');
  const cardCols = getTableColumns(schema.cards);
  assert.equal(cardCols.facets.getSQLType(), 'jsonb');
  assert.equal(cardCols.rawPayload.getSQLType(), 'jsonb');
  const observationCols = getTableColumns(schema.marketObservations);
  assert.equal(observationCols.priceComponents.getSQLType(), 'jsonb');
});

test('observation and evidence tables index source, target, time, basis and status', () => {
  const indexNames = (table: Parameters<typeof getTableConfig>[0]): string[] =>
    getTableConfig(table).indexes.map((index) => String(index.config.name ?? ''));
  const observationIndexes = indexNames(schema.marketObservations);
  for (const fragment of ['source_record_id', 'target_identity_id', 'observed_at', 'basis', 'status']) {
    assert.ok(
      observationIndexes.some((name) => name.includes(fragment)),
      `market_observations needs an index containing ${fragment}`,
    );
  }
  const evidenceIndexes = indexNames(schema.evidenceRecords);
  assert.ok(evidenceIndexes.some((name) => name.includes('source_record_id')));
  assert.ok(evidenceIndexes.some((name) => name.includes('observed_at')));
  const jobIndexes = indexNames(schema.jobs);
  assert.ok(jobIndexes.some((name) => name.includes('status')));
});
