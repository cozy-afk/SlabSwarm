/**
 * Storage adapter shared by repositories and the migration runner.
 *
 * `createSqlStore` maps typed camelCase row objects onto the Drizzle-defined
 * Postgres tables. `createMemoryStore` is the in-memory equivalent used by
 * tests, so repository logic is exercised without a live database.
 */

import { randomUUID } from 'node:crypto';
import { getTableColumns } from 'drizzle-orm';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import * as schema from './schema.ts';
import type { DbExecutor, Row } from './client.ts';
import { getDefaultExecutor } from './client.ts';

export type { Row } from './client.ts';

export interface ListOptions {
  orderBy?: { column: string; direction?: 'ASC' | 'DESC' };
  limit?: number;
}

export interface DbStore {
  insert(table: string, row: Row): Promise<Row>;
  findById(table: string, id: string): Promise<Row | null>;
  findAll(table: string, filters?: Row, options?: ListOptions): Promise<Row[]>;
  upsert(table: string, row: Row, conflictKeys: string[]): Promise<Row>;
  count(table: string): Promise<number>;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: DbStore) => Promise<T>): Promise<T>;
}

export const TABLE_REGISTRY: Record<string, PgTable> = {};
for (const value of Object.values(schema)) {
  try {
    const config = getTableConfig(value as PgTable);
    if (typeof config.name === 'string' && config.columns.length > 0) {
      TABLE_REGISTRY[config.name] = value as PgTable;
    }
  } catch {
    // Non-table exports are ignored.
  }
}

interface TableMeta {
  byProperty: Map<string, string>;
  byDbName: Map<string, string>;
  jsonColumns: Set<string>;
}

const metaCache = new Map<string, TableMeta>();

function metaForOptional(table: string): TableMeta | null {
  try {
    return metaFor(table);
  } catch {
    // Internal tables such as __schema_migrations are not Drizzle models.
    return null;
  }
}

function metaFor(table: string): TableMeta {
  const cached = metaCache.get(table);
  if (cached) return cached;
  const definition = TABLE_REGISTRY[table];
  if (!definition) throw new Error(`Unknown table: ${table}`);
  const meta: TableMeta = { byProperty: new Map(), byDbName: new Map(), jsonColumns: new Set() };
  for (const [property, column] of Object.entries(getTableColumns(definition))) {
    const dbName = (column as { name: string }).name;
    meta.byProperty.set(property, dbName);
    meta.byDbName.set(dbName, property);
    if ((column as { dataType?: string }).dataType === 'json') meta.jsonColumns.add(dbName);
  }
  metaCache.set(table, meta);
  return meta;
}

function quote(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function toDb(table: string, row: Row): Row {
  const meta = metaForOptional(table);
  if (!meta) return { ...row };
  const out: Row = {};
  for (const [property, rawValue] of Object.entries(row)) {
    const dbName = meta.byProperty.get(property);
    if (!dbName) continue;
    let value = rawValue === undefined ? null : rawValue;
    // node-postgres passes strings to JSONB as raw text. A plain string that
    // is not already JSON must be quoted or Postgres rejects the parameter.
    if (meta.jsonColumns.has(dbName) && typeof value === 'string') {
      try {
        JSON.parse(value);
      } catch {
        value = JSON.stringify(value);
      }
    }
    out[dbName] = value;
  }
  return out;
}

function fromDb(table: string, row: Row): Row {
  const meta = metaForOptional(table);
  if (!meta) return { ...row };
  const out: Row = {};
  for (const [dbName, value] of Object.entries(row)) {
    out[meta.byDbName.get(dbName) ?? dbName] = value;
  }
  return out;
}

function sqlLiteral(table: string, column: string): string {
  return quote(metaFor(table).byProperty.get(column) ?? column);
}

export function createSqlStore(executor: DbExecutor): DbStore {
  async function insert(table: string, row: Row): Promise<Row> {
    const dbRow = toDb(table, row);
    const columns = Object.keys(dbRow);
    if (columns.length === 0) throw new Error(`Cannot insert an empty row into ${table}`);
    const placeholders = columns.map((_, i) => `$${i + 1}`);
    const values = columns.map((column) => dbRow[column]);
    const result = await executor.query(
      `INSERT INTO ${quote(table)} (${columns.map(quote).join(', ')}) ` +
        `VALUES (${placeholders.join(', ')}) RETURNING *`,
      values,
    );
    return fromDb(table, result.rows[0] ?? {});
  }

  async function findAll(table: string, filters: Row = {}, options: ListOptions = {}): Promise<Row[]> {
    const clauses: string[] = [];
    const values: unknown[] = [];
    for (const [property, value] of Object.entries(filters)) {
      if (!metaFor(table).byProperty.has(property)) continue;
      const column = sqlLiteral(table, property);
      if (value === undefined || value === null) {
        clauses.push(`${column} IS NULL`);
      } else {
        values.push(value);
        clauses.push(`${column} = $${values.length}`);
      }
    }
    let sql = `SELECT * FROM ${quote(table)}`;
    if (clauses.length > 0) sql += ` WHERE ${clauses.join(' AND ')}`;
    if (options.orderBy) {
      const direction = options.orderBy.direction === 'ASC' ? 'ASC' : 'DESC';
      sql += ` ORDER BY ${sqlLiteral(table, options.orderBy.column)} ${direction}`;
    }
    if (options.limit && Number.isFinite(options.limit)) {
      values.push(Math.max(0, Math.trunc(options.limit)));
      sql += ` LIMIT $${values.length}`;
    }
    const result = await executor.query(sql, values);
    return result.rows.map((row) => fromDb(table, row));
  }

  async function upsert(table: string, row: Row, conflictKeys: string[]): Promise<Row> {
    const dbRow = toDb(table, row);
    const columns = Object.keys(dbRow);
    const conflicts = conflictKeys.map((key) => metaFor(table).byProperty.get(key) ?? key);
    const values = columns.map((column) => dbRow[column]);
    const updates = columns.filter((column) => !conflicts.includes(column));
    let sql =
      `INSERT INTO ${quote(table)} (${columns.map(quote).join(', ')}) ` +
      `VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`;
    if (conflicts.length > 0) {
      sql += ` ON CONFLICT (${conflicts.map(quote).join(', ')}) `;
      sql +=
        updates.length > 0
          ? `DO UPDATE SET ${updates.map((column) => `${quote(column)} = EXCLUDED.${quote(column)}`).join(', ')}`
          : 'DO NOTHING';
    }
    sql += ' RETURNING *';
    const result = await executor.query(sql, values);
    if (result.rows[0]) return fromDb(table, result.rows[0]);
    const existing = await findAll(table, Object.fromEntries(conflictKeys.map((key) => [key, row[key]])));
    if (existing[0]) return existing[0];
    throw new Error(`Upsert failed for ${table}`);
  }

  const store: DbStore = {
    insert,
    findAll,
    upsert,
    async findById(table: string, id: string): Promise<Row | null> {
      const result = await executor.query(`SELECT * FROM ${quote(table)} WHERE "id" = $1 LIMIT 1`, [id]);
      return result.rows[0] ? fromDb(table, result.rows[0]) : null;
    },
    async count(table: string): Promise<number> {
      const result = await executor.query<{ count: number | string }>(
        `SELECT COUNT(*)::int AS count FROM ${quote(table)}`,
      );
      return Number(result.rows[0]?.count ?? 0);
    },
    async exec(sql: string): Promise<void> {
      await executor.query(sql);
    },
    async transaction<T>(fn: (tx: DbStore) => Promise<T>): Promise<T> {
      if (!executor.connect) {
        await store.exec('BEGIN');
        try {
          const result = await fn(store);
          await store.exec('COMMIT');
          return result;
        } catch (error) {
          await store.exec('ROLLBACK');
          throw error;
        }
      }
      const connection = await executor.connect();
      const tx = createSqlStore(connection);
      try {
        await tx.exec('BEGIN');
        const result = await fn(tx);
        await tx.exec('COMMIT');
        return result;
      } catch (error) {
        try {
          await tx.exec('ROLLBACK');
        } catch {
          // Preserve the original error if the connection is already broken.
        }
        throw error;
      } finally {
        connection.release();
      }
    },
  };
  return store;
}

/** In-memory store with the same contract as the SQL store. */
export class MemoryStore implements DbStore {
  readonly rows = new Map<string, Row[]>();
  readonly executedSql: string[] = [];

  private clone<T>(value: T): T {
    return structuredClone(value);
  }

  private bucket(table: string): Row[] {
    let rows = this.rows.get(table);
    if (!rows) {
      rows = [];
      this.rows.set(table, rows);
    }
    return rows;
  }

  private matches(row: Row, filters: Row): boolean {
    return Object.entries(filters).every(([key, expected]) => {
      const actual = row[key];
      if (expected === undefined || expected === null) return actual === undefined || actual === null;
      return JSON.stringify(actual) === JSON.stringify(expected);
    });
  }

  async insert(table: string, row: Row): Promise<Row> {
    const stored = this.clone({ id: row.id ?? randomUUID(), ...row });
    this.bucket(table).push(stored);
    return this.clone(stored);
  }

  async findById(table: string, id: string): Promise<Row | null> {
    const found = this.bucket(table).find((row) => row.id === id);
    return found ? this.clone(found) : null;
  }

  async findAll(table: string, filters: Row = {}, options: ListOptions = {}): Promise<Row[]> {
    let rows = this.bucket(table)
      .filter((row) => this.matches(row, filters))
      .map((row) => this.clone(row));
    if (options.orderBy) {
      const direction = options.orderBy.direction === 'ASC' ? 1 : -1;
      rows = rows.sort((a, b) => {
        const av = a[options.orderBy!.column];
        const bv = b[options.orderBy!.column];
        if (av === bv) return 0;
        if (av === undefined || av === null) return 1;
        if (bv === undefined || bv === null) return -1;
        return String(av) < String(bv) ? -direction : direction;
      });
    }
    return options.limit === undefined ? rows : rows.slice(0, Math.max(0, options.limit));
  }

  async upsert(table: string, row: Row, conflictKeys: string[]): Promise<Row> {
    const rows = this.bucket(table);
    const existing = rows.find((candidate) => this.matches(candidate, Object.fromEntries(conflictKeys.map((key) => [key, row[key]]))));
    if (existing) {
      Object.assign(existing, this.clone(row));
      return this.clone(existing);
    }
    return this.insert(table, row);
  }

  async count(table: string): Promise<number> {
    return this.bucket(table).length;
  }

  async exec(sql: string): Promise<void> {
    this.executedSql.push(sql);
    if (sql.includes('FORCE_FAILURE')) throw new Error('Forced migration failure');
  }

  async transaction<T>(fn: (tx: DbStore) => Promise<T>): Promise<T> {
    const snapshot = this.clone([...this.rows.entries()]);
    const sqlCount = this.executedSql.length;
    try {
      return await fn(this);
    } catch (error) {
      this.rows.clear();
      for (const [table, rows] of snapshot) this.rows.set(table, rows);
      this.executedSql.length = sqlCount;
      throw error;
    }
  }
}

export function createMemoryStore(): DbStore {
  return new MemoryStore();
}

export function createDefaultStore(): DbStore {
  return createSqlStore(getDefaultExecutor());
}
