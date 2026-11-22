/**
 * Deterministic migration runner. Each file is applied at most once and its
 * checksum is immutable; a changed checksum is rejected rather than rewriting
 * history. Applied migrations are recorded in the same transaction as the DDL.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { DbStore, Row } from './store.ts';
import { createDefaultStore } from './store.ts';

export interface MigrationFile {
  name: string;
  sql: string;
}

export interface MigrationReport {
  applied: string[];
  skipped: string[];
}

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));

export function loadMigrationFiles(dir: string = MIGRATIONS_DIR): MigrationFile[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: fs.readFileSync(path.join(dir, name), 'utf-8') }));
}

export const DEFAULT_MIGRATIONS: MigrationFile[] = loadMigrationFiles();

export function migrationChecksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

export async function runMigrations(
  store: DbStore,
  migrations: MigrationFile[] = DEFAULT_MIGRATIONS,
): Promise<MigrationReport> {
  // Internal table used only for migration bookkeeping. It is not a Drizzle
  // model, so the adapter maps it verbatim; create it before reading state.
  await store.exec(
    'CREATE TABLE IF NOT EXISTS "__schema_migrations" (' +
      '"name" text PRIMARY KEY, "checksum" text NOT NULL, ' +
      '"applied_at" timestamptz NOT NULL DEFAULT now())',
  );
  const appliedRows = await store.findAll('__schema_migrations');
  const appliedByName = new Map(
    appliedRows.map((row) => [String(row.name), row]),
  );
  const report: MigrationReport = { applied: [], skipped: [] };

  for (const migration of migrations) {
    const checksum = migrationChecksum(migration.sql);
    const recorded = appliedByName.get(migration.name);
    if (recorded) {
      if (String(recorded.checksum) !== checksum) {
        throw new MigrationError(`Migration ${migration.name} changed after it was applied.`);
      }
      report.skipped.push(migration.name);
      continue;
    }
    try {
      await store.transaction(async (tx) => {
        await tx.exec(migration.sql);
        await tx.insert('__schema_migrations', {
          name: migration.name,
          checksum,
          applied_at: new Date().toISOString(),
        } as Row);
      });
    } catch (error) {
      throw new MigrationError(
        `Migration ${migration.name} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    report.applied.push(migration.name);
    appliedByName.set(migration.name, { name: migration.name, checksum });
  }
  return report;
}

export async function migrateDefault(): Promise<MigrationReport> {
  const store = createDefaultStore();
  const report = await runMigrations(store);
  return report;
}

const invokedDirectly = (() => {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  void (async () => {
    await import('dotenv/config');
    const report = await migrateDefault();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  })().catch((error: unknown) => {
    process.stderr.write(`Migration failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
