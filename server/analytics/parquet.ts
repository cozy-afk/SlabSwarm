/**
 * Parquet lake exporter (Phase 3, Task 1).
 *
 * Projects the analytics store snapshot into six derived datasets and writes
 * them as Parquet under `data/lake`. Nothing here mutates canonical evidence:
 * the lake is a rebuildable analytical artifact. Missing facets are written as
 * the explicit sentinel `UNKNOWN` — never zero, never inferred. Partitioning
 * uses only fields that actually exist on a dataset (game / source /
 * observed_date); datasets without those fields are written flat.
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getAnalyticsStore } from './store.ts';
import { basisOf, gameOf, observedDateOf, sourceOf } from './fields.ts';
import type { AnalyticsSnapshot, AnalyticsStore } from './types.ts';
import { CONTRACT_VERSION } from '../contracts/dataProduct.ts';

export interface ExportOptions {
  lakeDir?: string;
  now?: Date;
}

export interface ExportedDataset {
  name: string;
  rows: number;
  path: string;
  partitionBy: string[];
}

export interface ParquetExportResult {
  lakeDir: string;
  generatedAt: string;
  contractVersion: string;
  datasets: ExportedDataset[];
}

interface TableSpec {
  name: string;
  columns: Array<[name: string, type: string]>;
  rows: unknown[][];
  partitionBy: string[];
}

type Loose = Record<string, unknown>;
const loose = (value: object): Loose => value as Loose;

function unknownToText(value: unknown): string {
  if (value === null || value === undefined) return 'UNKNOWN';
  if (typeof value === 'string') return value.trim() === '' ? 'UNKNOWN' : value;
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value);
}

/** Optional numeric facet: a number when known, explicit UNKNOWN when absent. */
function numberOrUnknown(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return 'UNKNOWN';
}

function cell(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  return JSON.stringify(value);
}

function lineageOf(record: object): string {
  const r = loose(record);
  for (const key of ['lineage', 'lineage_pointer', 'rawRef', 'sourceUri', 'source_uri']) {
    const value = r[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return 'UNKNOWN';
}

function confidenceOf(record: object): string {
  const r = loose(record);
  return numberOrUnknown(r.confidence);
}

function jsonArray(values: string[] | undefined): string {
  return JSON.stringify(Array.isArray(values) ? values : []);
}

const FACET_PARTITIONS = ['game', 'source', 'observed_date'] as const;

export function buildExportTables(snapshot: AnalyticsSnapshot): TableSpec[] {
  const evidence: TableSpec = {
    name: 'evidence',
    partitionBy: [...FACET_PARTITIONS],
    columns: [
      ['id', 'VARCHAR'], ['source_id', 'VARCHAR'], ['source_record_id', 'VARCHAR'],
      ['source_uri', 'VARCHAR'], ['source', 'VARCHAR'], ['game', 'VARCHAR'],
      ['captured_at', 'VARCHAR'], ['observed_at', 'VARCHAR'], ['observed_date', 'VARCHAR'],
      ['checksum', 'VARCHAR'], ['mime_type', 'VARCHAR'], ['license', 'VARCHAR'],
      ['raw_ref', 'VARCHAR'], ['parse_status', 'VARCHAR'], ['lineage', 'VARCHAR'],
      ['confidence', 'VARCHAR'],
    ],
    rows: snapshot.evidence.map((record) => {
      const r = loose(record);
      const game = gameOf(record);
      return [
        record.id, record.sourceId, record.sourceRecordId,
        unknownToText(record.sourceUri ?? r.source_uri), sourceOf(record), game,
        record.capturedAt, record.observedAt, observedDateOf(record),
        record.checksum, record.mimeType, unknownToText(record.license),
        record.rawRef, record.parseStatus, lineageOf(record), confidenceOf(record),
      ];
    }),
  };

  const observations: TableSpec = {
    name: 'observations',
    partitionBy: [...FACET_PARTITIONS],
    columns: [
      ['id', 'VARCHAR'], ['evidence_id', 'VARCHAR'], ['target_identity_ref', 'VARCHAR'],
      ['basis', 'VARCHAR'], ['amount', 'DOUBLE'], ['currency', 'VARCHAR'],
      ['marketplace', 'VARCHAR'], ['source', 'VARCHAR'], ['game', 'VARCHAR'],
      ['observed_at', 'VARCHAR'], ['observed_date', 'VARCHAR'], ['captured_at', 'VARCHAR'],
      ['status', 'VARCHAR'], ['lineage', 'VARCHAR'], ['confidence', 'VARCHAR'],
      ['price_components_json', 'VARCHAR'],
    ],
    rows: snapshot.observations.map((record) => {
      const r = loose(record);
      return [
        record.id, record.evidenceId, record.targetIdentityRef,
        basisOf(record), record.amount, unknownToText(record.currency),
        unknownToText(record.marketplace), sourceOf(record), gameOf(record),
        record.observedAt, observedDateOf(record),
        unknownToText(r.capturedAt ?? r.captured_at),
        unknownToText(record.status), lineageOf(record), confidenceOf(record),
        JSON.stringify(r.priceComponents ?? {}),
      ];
    }),
  };

  const identities: TableSpec = {
    name: 'identities',
    partitionBy: [...FACET_PARTITIONS],
    columns: [
      ['id', 'VARCHAR'], ['canonical_name', 'VARCHAR'], ['source', 'VARCHAR'],
      ['game', 'VARCHAR'], ['observed_at', 'VARCHAR'], ['observed_date', 'VARCHAR'],
      ['lineage', 'VARCHAR'], ['confidence', 'VARCHAR'],
    ],
    rows: snapshot.identities.map((record) => [
      record.id, record.canonicalName, sourceOf(record), gameOf(record),
      unknownToText(record.observedAt), observedDateOf(record),
      lineageOf(record), confidenceOf(record),
    ]),
  };

  const events: TableSpec = {
    name: 'events',
    partitionBy: [...FACET_PARTITIONS],
    columns: [
      ['id', 'VARCHAR'], ['type', 'VARCHAR'], ['target_id', 'VARCHAR'],
      ['source', 'VARCHAR'], ['game', 'VARCHAR'], ['observed_at', 'VARCHAR'],
      ['observed_date', 'VARCHAR'], ['lineage', 'VARCHAR'], ['confidence', 'VARCHAR'],
    ],
    rows: snapshot.events.map((record) => [
      record.id, record.type, unknownToText(record.targetId),
      sourceOf(record), gameOf(record), record.observedAt, observedDateOf(record),
      lineageOf(record), confidenceOf(record),
    ]),
  };

  const forecasts: TableSpec = {
    name: 'forecasts',
    partitionBy: [],
    columns: [
      ['id', 'VARCHAR'], ['target_type', 'VARCHAR'], ['target_id', 'VARCHAR'],
      ['horizon_days', 'DOUBLE'], ['scenario', 'VARCHAR'], ['low', 'DOUBLE'],
      ['base', 'DOUBLE'], ['high', 'DOUBLE'], ['currency', 'VARCHAR'],
      ['demand_pressure', 'VARCHAR'], ['supply_pressure', 'VARCHAR'],
      ['drivers_json', 'VARCHAR'], ['invalidators_json', 'VARCHAR'],
      ['evidence_ids_json', 'VARCHAR'], ['confidence', 'VARCHAR'],
      ['status', 'VARCHAR'], ['created_at', 'VARCHAR'], ['lineage', 'VARCHAR'],
    ],
    rows: snapshot.forecasts.map((record) => [
      record.id, record.targetType, record.targetId, record.horizonDays,
      record.scenario, record.priceBands.low, record.priceBands.base,
      record.priceBands.high, unknownToText(record.priceBands.currency),
      record.demandPressure, record.supplyPressure,
      jsonArray(record.drivers), jsonArray(record.invalidators),
      jsonArray(record.evidenceIds), record.confidence, record.status,
      record.createdAt, lineageOf(record),
    ]),
  };

  const scores: TableSpec = {
    name: 'scores',
    partitionBy: [],
    columns: [
      ['id', 'VARCHAR'], ['forecast_id', 'VARCHAR'], ['scored_at', 'VARCHAR'],
      ['error', 'VARCHAR'], ['outcome_at', 'VARCHAR'],
      ['lineage', 'VARCHAR'], ['confidence', 'VARCHAR'],
    ],
    rows: snapshot.scores.map((record) => [
      record.id, record.forecastId, record.scoredAt,
      numberOrUnknown(record.error), unknownToText(record.outcomeAt),
      lineageOf(record), confidenceOf(record),
    ]),
  };

  return [evidence, observations, identities, events, forecasts, scores];
}

/** Default lake root. Override with SLABSWARM_LAKE_DIR for tests/deployments. */
export function defaultLakeDir(): string {
  return process.env.SLABSWARM_LAKE_DIR
    ? path.resolve(process.env.SLABSWARM_LAKE_DIR)
    : path.resolve(process.cwd(), 'data', 'lake');
}

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Write one dataset and return its on-disk location. */
async function writeDataset(
  connection: { run(sql: string, values?: never[]): Promise<unknown> },
  lakeDir: string,
  spec: TableSpec,
): Promise<ExportedDataset> {
  const datasetDir = path.join(lakeDir, spec.name);
  await rm(datasetDir, { recursive: true, force: true });
  await mkdir(datasetDir, { recursive: true });

  const columns = spec.columns.map(([name, type]) => `${name} ${type}`).join(', ');
  await connection.run(`CREATE TEMP TABLE ${spec.name} (${columns})`);
  if (spec.rows.length > 0) {
    const placeholders = spec.columns.map(() => '?').join(', ');
    const insert = `INSERT INTO ${spec.name} VALUES (${placeholders})`;
    for (const row of spec.rows) {
      await connection.run(insert, row.map(cell) as never[]);
    }
  }

  const partition = spec.partitionBy.filter((field) =>
    spec.columns.some(([name]) => name === field),
  );
  const target = partition.length === 0
    ? path.join(datasetDir, `${spec.name}.parquet`)
    : datasetDir;
  const options = ['FORMAT PARQUET'];
  if (partition.length > 0) options.push(`PARTITION_BY (${partition.join(', ')})`);
  await connection.run(
    `COPY (SELECT * FROM ${spec.name}) TO ${sqlLiteral(target)} (${options.join(', ')})`,
  );
  await connection.run(`DROP TABLE ${spec.name}`);
  return { name: spec.name, rows: spec.rows.length, path: target, partitionBy: partition };
}

/**
 * Rebuild the entire Parquet lake from the current snapshot. Idempotent:
 * a second export replaces the derived files rather than appending to them.
 */
export async function exportAnalyticsParquet(
  store: AnalyticsStore = getAnalyticsStore(),
  options: ExportOptions = {},
): Promise<ParquetExportResult> {
  const lakeDir = options.lakeDir ? path.resolve(options.lakeDir) : defaultLakeDir();
  const generatedAt = (options.now ?? new Date()).toISOString();
  await mkdir(lakeDir, { recursive: true });
  const tables = buildExportTables(store.snapshot());

  const duckdb = await import('@duckdb/node-api');
  const instance = await duckdb.DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  const datasets: ExportedDataset[] = [];
  try {
    for (const spec of tables) {
      datasets.push(await writeDataset(connection, lakeDir, spec));
    }
  } finally {
    await instance.closeSync();
  }

  const manifest = { lakeDir, generatedAt, contractVersion: CONTRACT_VERSION, datasets };
  await writeFile(path.join(lakeDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
