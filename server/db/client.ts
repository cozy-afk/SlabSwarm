/**
 * Pooled PostgreSQL access. Credentials come from the environment and are
 * never logged. Importing this module does not open a connection; the pool is
 * created lazily on first use so tests and tooling can inject an executor.
 */

import pg from 'pg';

export type Row = Record<string, unknown>;

export interface QueryResult<T extends Row = Row> {
  rows: T[];
  rowCount: number | null;
}

export interface DbExecutor {
  query<T extends Row = Row>(sql: string, params?: readonly unknown[]): Promise<QueryResult<T>>;
  connect?(): Promise<DbConnection>;
}

export interface DbConnection extends DbExecutor {
  release(): void;
}

export interface PgExecutor extends DbExecutor {
  close(): Promise<void>;
}

/** Build a DSN from discrete env vars; never echo the password. */
export function resolveDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.DATABASE_URL?.trim();
  if (explicit) return explicit;
  const user = encodeURIComponent(env.POSTGRES_USER?.trim() || 'slabswarm');
  const password = encodeURIComponent(env.POSTGRES_PASSWORD ?? '');
  const host = encodeURIComponent(env.POSTGRES_HOST?.trim() || 'slabswarm-db');
  const port = env.POSTGRES_PORT?.trim() || '5432';
  const database = encodeURIComponent(env.POSTGRES_DB?.trim() || 'slabswarm');
  return `postgresql://${user}:${password}@${host}:${port}/${database}`;
}

export function createPgExecutor(connectionString: string = resolveDatabaseUrl()): PgExecutor {
  const pool = new pg.Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  return {
    async query<T extends Row = Row>(sql: string, params: readonly unknown[] = []): Promise<QueryResult<T>> {
      const result = await pool.query(sql, params as unknown[]);
      return { rows: result.rows as T[], rowCount: result.rowCount };
    },
    async connect(): Promise<DbConnection> {
      const client = await pool.connect();
      let released = false;
      return {
        async query<T extends Row = Row>(sql: string, params: readonly unknown[] = []): Promise<QueryResult<T>> {
          const result = await client.query(sql, params as unknown[]);
          return { rows: result.rows as T[], rowCount: result.rowCount };
        },
        async connect(): Promise<DbConnection> {
          throw new Error('A dedicated connection cannot open another transaction.');
        },
        release(): void {
          if (!released) {
            released = true;
            client.release();
          }
        },
      };
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
}

let defaultExecutor: DbExecutor | null = null;

export function getDefaultExecutor(): DbExecutor {
  defaultExecutor ??= createPgExecutor();
  return defaultExecutor;
}

export function setDefaultExecutor(executor: DbExecutor | null): void {
  defaultExecutor = executor;
}
