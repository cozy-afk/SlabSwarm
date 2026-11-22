/**
 * Thin, hardened wrapper around @duckdb/node-api.
 *
 * The native binding is loaded lazily: if it is unavailable the module still
 * imports cleanly, reports `fallback` from getEngineStatus(), and every query
 * fails with a typed QueryEngineError instead of crashing the process. All
 * user-supplied SQL is screened by assertReadOnlySql before it reaches DuckDB.
 */

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class ReadOnlyViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReadOnlyViolation';
  }
}

export class QueryEngineError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'QueryEngineError';
  }
}

export interface QueryRowsResult {
  columnNames(): string[];
  getRowsJson(): Promise<unknown[][]>;
  /** Optional DuckDB type ids, used to restore numbers from JSON numeric strings. */
  columnTypeIds?(): number[];
  closeSync?(): void;
}

export interface QueryExecutor {
  run(sql: string): Promise<QueryRowsResult>;
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  durationMs: number;
  truncated: boolean;
  engine: 'duckdb' | 'fallback';
  warning?: string;
}

export interface QueryOptions {
  executor?: QueryExecutor;
  maxRows?: number;
}

export interface EngineStatus {
  engine: 'duckdb' | 'fallback';
  error?: string;
}

const FORBIDDEN_KEYWORDS = [
  'insert', 'update', 'delete', 'drop', 'create', 'alter', 'truncate',
  'copy', 'attach', 'detach', 'pragma', 'set', 'reset', 'export', 'import',
  'vacuum', 'analyze', 'call', 'install', 'load', 'begin', 'commit',
  'rollback', 'grant', 'revoke', 'merge', 'replace', 'overwrite',
];
const FORBIDDEN_FUNCTIONS =
  /\b(read_csv\w*|read_text\w*|read_file\w*|read_json\w*|read_ndjson\w*|sqlite_scan|postgres_scan|httpfs|glob)\s*\(/i;

/** Remove comments and quoted literals so keyword checks inspect only code. */
function stripLiterals(sql: string): string {
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (quote) {
      if (ch === quote && next === quote) {
        out += '  ';
        i += 1;
      } else if (ch === quote) {
        out += ' ';
        quote = null;
      } else {
        out += ch === '\n' ? '\n' : ' ';
      }
      continue;
    }
    if (ch === '-' && next === '-') {
      while (i < sql.length && sql[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      i -= 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      out += '  ';
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) {
        out += sql[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      out += ' ';
      continue;
    }
    out += ch;
  }
  return out;
}

/** Validate that a single, read-only SQL statement is being submitted. */
export function assertReadOnlySql(sql: unknown): void {
  if (typeof sql !== 'string' || sql.trim() === '') {
    throw new ValidationError('sql must be a non-empty string.');
  }
  const code = stripLiterals(sql);
  const statements = code
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (statements.length !== 1) {
    throw new ReadOnlyViolation('Exactly one read-only SQL statement is allowed.');
  }
  const statement = statements[0];
  if (!/^(SELECT|WITH)\b/i.test(statement)) {
    throw new ReadOnlyViolation('Only SELECT and WITH (read-only) statements are allowed.');
  }
  for (const keyword of FORBIDDEN_KEYWORDS) {
    if (new RegExp(`\\b${keyword}\\b`, 'i').test(code)) {
      throw new ReadOnlyViolation(`SQL contains a forbidden write/DDL keyword: ${keyword.toUpperCase()}.`);
    }
  }
  if (FORBIDDEN_FUNCTIONS.test(code)) {
    throw new ReadOnlyViolation('SQL contains a forbidden external file-read function.');
  }
}

/** DuckDB serializes integer/decimal columns as JSON strings to keep precision. */
const NUMERIC_TYPE_IDS = new Set([
  2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 16, 19, 32, 35,
]);

function normalizeCell(value: unknown, typeId?: number): unknown {
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && typeId !== undefined && NUMERIC_TYPE_IDS.has(typeId)) {
    const converted = Number(value);
    if (value.trim() !== '' && Number.isFinite(converted) && Math.abs(converted) <= Number.MAX_SAFE_INTEGER) {
      return converted;
    }
  }
  return value;
}

/** Adapt a native materialized result into the stable QueryRowsResult shape. */
export function adaptDuckDBResult(result: {
  columnNames(): string[];
  getRowsJson(): Promise<unknown[][]>;
  columnTypeId?(index: number): number;
  closeSync?(): void;
}): QueryRowsResult {
  const columns = result.columnNames();
  return {
    columnNames: () => columns,
    getRowsJson: () => result.getRowsJson(),
    ...(result.columnTypeId
      ? { columnTypeIds: () => columns.map((_, index) => result.columnTypeId!(index)) }
      : {}),
    ...(result.closeSync ? { closeSync: () => result.closeSync!() } : {}),
  };
}

let engineStatus: EngineStatus = { engine: 'duckdb' };
let defaultExecutor: Promise<QueryExecutor> | null = null;

export function getEngineStatus(): EngineStatus {
  return { ...engineStatus };
}

export function setDefaultExecutor(executor: QueryExecutor): void {
  defaultExecutor = Promise.resolve(executor);
  engineStatus = { engine: 'duckdb' };
}

/** Lazily create the native executor; never import the binding at module load. */
export async function getDefaultExecutor(): Promise<QueryExecutor> {
  if (!defaultExecutor) {
    defaultExecutor = (async () => {
      try {
        const duckdb = await import('@duckdb/node-api');
        const instance = await duckdb.DuckDBInstance.create(':memory:');
        const connection = await instance.connect();
        engineStatus = { engine: 'duckdb' };
        return {
          async run(sql: string) {
            return adaptDuckDBResult(await connection.run(sql));
          },
        };
      } catch (error) {
        engineStatus = {
          engine: 'fallback',
          error: error instanceof Error ? error.message : String(error),
        };
        throw new QueryEngineError(
          `DuckDB native binding unavailable; setDefaultExecutor() is required for queries: ${engineStatus.error}`,
        );
      }
    })().catch((error) => {
      defaultExecutor = null;
      throw error;
    });
  }
  return defaultExecutor;
}

/** Execute screened SQL and map it to the stable analytics result shape. */
export async function runReadOnlyQuery(
  sql: string,
  options: QueryOptions = {},
): Promise<QueryResult> {
  const started = performance.now();
  assertReadOnlySql(sql);
  const executor = options.executor ?? (await getDefaultExecutor());
  let columns: string[];
  let rows: Record<string, unknown>[];
  let typeIds: number[] | undefined;
  try {
    const result = await executor.run(sql);
    columns = result.columnNames();
    typeIds = result.columnTypeIds?.();
    const raw = await result.getRowsJson();
    rows = raw.map((row) =>
      Object.fromEntries(
        columns.map((column, index) => [
          column,
          normalizeCell(row[index], typeIds?.[index]),
        ]),
      ),
    );
    result.closeSync?.();
  } catch (error) {
    if (error instanceof QueryEngineError) throw error;
    throw new QueryEngineError(
      `DuckDB query failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const maxRows = options.maxRows ?? 1000;
  const truncated = rows.length > maxRows;
  const kept = truncated ? rows.slice(0, maxRows) : rows;
  const status = getEngineStatus();
  return {
    columns,
    rows: kept,
    rowCount: kept.length,
    durationMs: Math.round((performance.now() - started) * 1000) / 1000,
    truncated,
    engine: status.engine,
    ...(status.error ? { warning: status.error } : {}),
  };
}
