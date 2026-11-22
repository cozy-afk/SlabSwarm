/**
 * SQL Lab: read-only queries over in-memory projections of the analytics
 * store, plus a repository of saved read-only queries. No listener, no file
 * access, no writes to canonical data.
 */

import { getAnalyticsStore } from './store.ts';
import {
  adaptDuckDBResult,
  assertReadOnlySql,
  QueryEngineError,
  runReadOnlyQuery,
  ValidationError,
  type QueryExecutor,
  type QueryResult,
} from './duckdb.ts';
import { gameOf, sourceOf } from './fields.ts';
import { findBuiltInQuery, getBuiltInQueries } from './queries.ts';
import type { AnalyticsSnapshot, AnalyticsStore, SavedQuery, SavedQueryInput } from './types.ts';

export { ReadOnlyViolation, ValidationError, QueryEngineError } from './duckdb.ts';
export type { QueryResult } from './duckdb.ts';
export type { BuiltInQuery } from './queries.ts';

export interface SqlQueryInput {
  sql?: unknown;
  queryId?: unknown;
  savedId?: unknown;
  limit?: unknown;
}

export interface SqlLabResult extends QueryResult {
  source: 'template' | 'raw' | 'saved';
  queryId?: string;
}

interface TableDef {
  columns: Array<[string, string]>;
  rows: unknown[][];
}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;
const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

function cell(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value;
  if (typeof value === 'bigint') return Number(value);
  return JSON.stringify(value);
}

/** Project the store snapshot into flat, queryable SQL Lab tables. */
export function buildTables(snapshot: AnalyticsSnapshot): Record<string, TableDef> {
  const observations: TableDef = {
    columns: [
      ['id', 'VARCHAR'], ['evidence_id', 'VARCHAR'], ['target_identity_ref', 'VARCHAR'],
      ['basis', 'VARCHAR'], ['amount', 'DOUBLE'], ['currency', 'VARCHAR'],
      ['source', 'VARCHAR'], ['marketplace', 'VARCHAR'], ['observed_at', 'VARCHAR'],
      ['captured_at', 'VARCHAR'], ['status', 'VARCHAR'], ['confidence', 'DOUBLE'],
      ['game', 'VARCHAR'],
    ],
    rows: snapshot.observations.map((o) => [
      o.id, o.evidenceId ?? null, o.targetIdentityRef, o.basis, o.amount, o.currency,
      sourceOf(o), text(o.marketplace), o.observedAt, text((o as { capturedAt?: unknown }).capturedAt),
      o.status ?? 'UNKNOWN', num((o as { confidence?: unknown }).confidence), gameOf(o),
    ]),
  };
  const evidence: TableDef = {
    columns: [
      ['id', 'VARCHAR'], ['source_id', 'VARCHAR'], ['source_record_id', 'VARCHAR'],
      ['observed_at', 'VARCHAR'], ['captured_at', 'VARCHAR'], ['checksum', 'VARCHAR'],
      ['mime_type', 'VARCHAR'], ['parse_status', 'VARCHAR'], ['game', 'VARCHAR'],
    ],
    rows: snapshot.evidence.map((e) => [
      e.id, e.sourceId, e.sourceRecordId, e.observedAt, e.capturedAt, e.checksum,
      e.mimeType, e.parseStatus, gameOf(e),
    ]),
  };
  const identities: TableDef = {
    columns: [
      ['id', 'VARCHAR'], ['canonical_name', 'VARCHAR'], ['game', 'VARCHAR'],
      ['source', 'VARCHAR'], ['observed_at', 'VARCHAR'],
    ],
    rows: snapshot.identities.map((i) => [
      i.id, i.canonicalName, text(i.game), text(i.source), text(i.observedAt),
    ]),
  };
  const events: TableDef = {
    columns: [
      ['id', 'VARCHAR'], ['type', 'VARCHAR'], ['target_id', 'VARCHAR'],
      ['source', 'VARCHAR'], ['game', 'VARCHAR'], ['observed_at', 'VARCHAR'],
    ],
    rows: snapshot.events.map((e) => [
      e.id, e.type, text(e.targetId), text(e.source), text(e.game), e.observedAt,
    ]),
  };
  const forecasts: TableDef = {
    columns: [
      ['id', 'VARCHAR'], ['target_type', 'VARCHAR'], ['target_id', 'VARCHAR'],
      ['horizon_days', 'DOUBLE'], ['scenario', 'VARCHAR'], ['low', 'DOUBLE'],
      ['base', 'DOUBLE'], ['high', 'DOUBLE'], ['currency', 'VARCHAR'],
      ['confidence', 'VARCHAR'], ['status', 'VARCHAR'], ['created_at', 'VARCHAR'],
    ],
    rows: snapshot.forecasts.map((f) => [
      f.id, f.targetType, f.targetId, f.horizonDays, f.scenario,
      f.priceBands.low, f.priceBands.base, f.priceBands.high, f.priceBands.currency,
      f.confidence, f.status, f.createdAt,
    ]),
  };
  const scores: TableDef = {
    columns: [
      ['id', 'VARCHAR'], ['forecast_id', 'VARCHAR'], ['scored_at', 'VARCHAR'],
      ['error', 'DOUBLE'], ['outcome_at', 'VARCHAR'],
    ],
    rows: snapshot.scores.map((s) => [
      s.id, s.forecastId, s.scoredAt, num(s.error), text(s.outcomeAt),
    ]),
  };
  const findings: TableDef = {
    columns: [
      ['id', 'VARCHAR'], ['type', 'VARCHAR'], ['target_id', 'VARCHAR'],
      ['title', 'VARCHAR'], ['confidence', 'VARCHAR'], ['created_at', 'VARCHAR'],
      ['evidence_ids', 'VARCHAR'], ['metrics_json', 'VARCHAR'],
    ],
    rows: snapshot.findings.map((f) => [
      f.id, f.type, f.targetId, f.title, f.confidence, f.createdAt,
      f.evidenceIds.join(','), JSON.stringify(f.metrics),
    ]),
  };

  return { observations, evidence, identities, events, forecasts, scores, findings };
}

/** Create an isolated in-memory executor with the projected tables loaded. */
async function createLabExecutor(store: AnalyticsStore): Promise<QueryExecutor> {
  const duckdb = await import('@duckdb/node-api');
  const instance = await duckdb.DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  await connection.run('SET enable_external_access=false');
  const tables = buildTables(store.snapshot());
  for (const [name, table] of Object.entries(tables)) {
    const ddl = `CREATE TABLE ${name} (${table.columns.map(([col, type]) => `${col} ${type}`).join(', ')})`;
    await connection.run(ddl);
    if (table.rows.length === 0) continue;
    const placeholders = table.columns.map(() => '?').join(', ');
    const insert = `INSERT INTO ${name} (${table.columns.map(([col]) => col).join(', ')}) VALUES (${placeholders})`;
    for (const row of table.rows) {
      await connection.run(insert, row.map(cell) as never);
    }
  }
  return {
    async run(sql: string) {
      return adaptDuckDBResult(await connection.run(sql));
    },
  };
}

export function listSavedQueries(store: AnalyticsStore = getAnalyticsStore()): SavedQuery[] {
  return store.listSavedQueries();
}

/** Persist a read-only query; writes are rejected before storage. */
export function saveQuery(
  store: AnalyticsStore,
  input: SavedQueryInput,
): SavedQuery {
  if (input === null || typeof input !== 'object') {
    throw new ValidationError('Saved query input must be an object.');
  }
  if (typeof input.name !== 'string' || input.name.trim() === '') {
    throw new ValidationError('Saved query name is required.');
  }
  assertReadOnlySql(input.sql);
  return store.saveQuery({
    name: input.name.trim(),
    sql: input.sql.trim(),
    description: text(input.description ?? null),
  });
}

/** Execute a template id, saved query id, or raw read-only SQL. */
export async function runSqlQuery(
  store: AnalyticsStore,
  input: SqlQueryInput,
): Promise<SqlLabResult> {
  if (input === null || typeof input !== 'object') {
    throw new ValidationError('Query input must be an object.');
  }
  const limit = input.limit === undefined ? 200 : input.limit;
  if (
    typeof limit !== 'number' ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 1000
  ) {
    throw new ValidationError('limit must be an integer between 1 and 1000.');
  }

  let sql: string;
  let source: SqlLabResult['source'];
  let queryId: string | undefined;
  if (input.queryId !== undefined) {
    if (typeof input.queryId !== 'string') {
      throw new ValidationError('queryId must be a string.');
    }
    const template = findBuiltInQuery(input.queryId);
    if (!template) throw new ValidationError(`Unknown built-in query: ${input.queryId}`);
    sql = template.sql;
    source = 'template';
    queryId = template.id;
  } else if (input.savedId !== undefined) {
    if (typeof input.savedId !== 'string') {
      throw new ValidationError('savedId must be a string.');
    }
    const saved = store.getSavedQuery(input.savedId);
    if (!saved) throw new ValidationError(`Unknown saved query: ${input.savedId}`);
    assertReadOnlySql(saved.sql);
    sql = saved.sql;
    source = 'saved';
    queryId = saved.id;
  } else {
    if (typeof input.sql !== 'string') {
      throw new ValidationError('sql must be a string or supply queryId/savedId.');
    }
    sql = input.sql;
    source = 'raw';
  }

  // Validate before any native work so writes never touch DuckDB.
  assertReadOnlySql(sql);
  let executor: QueryExecutor;
  try {
    executor = await createLabExecutor(store);
  } catch (error) {
    throw new QueryEngineError(
      `SQL Lab engine unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const result = await runReadOnlyQuery(sql, { executor, maxRows: limit });
  return { ...result, source, ...(queryId ? { queryId } : {}) };
}

export { getBuiltInQueries } from './queries.ts';
