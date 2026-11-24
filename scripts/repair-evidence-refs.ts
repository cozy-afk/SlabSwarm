/**
 * Idempotent repair for A-01: canonical observations whose `evidence_id` does
 * not resolve in `evidence_records`.
 *
 * Matching is exact and provenance-based only. A ledger evidence row is
 * located by an exact id/reference recorded on the orphan observation, then
 * the canonical Postgres evidence row is selected by the immutable triple
 * (sourceId, sourceRecordId, checksum). Nothing is guessed, no evidence row
 * is deleted or rewritten, and every unmatched observation stays in the
 * failure report.
 *
 * Dry-run by default. `--apply` performs only the evidence_id update.
 * This module does nothing when imported; the CLI runs only as main.
 */

import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDefaultExecutor } from '../server/db/client.ts';
import { createRepositories, type Repositories } from '../server/db/repositories/index.ts';
import { createSqlStore } from '../server/db/store.ts';
import { createDurableRepositories } from '../server/ingest/store.ts';

type Row = Record<string, unknown>;

export interface RepairFailure {
  observationId: string;
  evidenceId: string;
  reason: string;
}

export interface RepairChange {
  observationId: string;
  from: string;
  to: string;
  sourceId: string;
  sourceRecordId: string;
}

export interface RepairReport {
  generatedAt: string;
  mode: 'dry-run' | 'apply';
  scanned: number;
  alreadyResolved: number;
  repaired: number;
  wouldRepair: number;
  failures: RepairFailure[];
  repairs: RepairChange[];
  errors: string[];
}

export interface RepairOptions {
  repositories: Repositories;
  /** Immutable JSON ledger evidence rows (id, sourceId, sourceRecordId, checksum, ...). */
  ledgerEvidence: readonly Row[];
  apply?: boolean;
  now?: () => Date;
  /** Injected for in-memory verification; production uses the SQL executor. */
  updateEvidenceRef?: (observationId: string, evidenceId: string) => Promise<void>;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** Exact ledger references: its id, `sourceId:sourceRecordId` and `sourceId:externalId`. */
function ledgerRefsOf(row: Row): string[] {
  const keys = new Set<string>();
  const id = text(row.id);
  if (id) keys.add(id);
  const sourceId = text(row.sourceId);
  const sourceRecordId = text(row.sourceRecordId);
  if (sourceId && sourceRecordId) keys.add(`${sourceId}:${sourceRecordId}`);
  const payload = row.parsedPayload;
  const record = payload && typeof payload === 'object' ? (payload as Row).record : null;
  const externalId = record && typeof record === 'object' ? text((record as Row).externalId) : null;
  if (sourceId && externalId) keys.add(`${sourceId}:${externalId}`);
  return [...keys];
}

/** Only references actually recorded on the observation are considered. */
function observationRefsOf(row: Row): string[] {
  const refs = new Set<string>();
  const add = (value: unknown) => {
    const raw = text(value);
    if (!raw) return;
    refs.add(raw);
    if (raw.startsWith('evidence:')) refs.add(raw.slice('evidence:'.length));
  };
  add(row.evidenceId);
  add(row.sourceRecordId);
  add((row.lineage as Row | undefined)?.evidenceId);
  if (Array.isArray(row.lineage)) row.lineage.forEach(add);
  const components = row.priceComponents;
  if (components && typeof components === 'object') {
    const part = components as Row;
    add(part.evidenceId);
    if (Array.isArray(part.lineage)) part.lineage.forEach(add);
  }
  return [...refs];
}

async function updateCanonicalEvidenceRef(observationId: string, evidenceId: string): Promise<void> {
  // Parameterised, single-column update. No DELETE, TRUNCATE or payload write.
  await getDefaultExecutor().query(
    'UPDATE "market_observations" SET "evidence_id" = $1 WHERE "id" = $2',
    [evidenceId, observationId],
  );
}

export async function repairEvidenceRefs(options: RepairOptions): Promise<RepairReport> {
  const apply = options.apply === true;
  const report: RepairReport = {
    generatedAt: (options.now?.() ?? new Date()).toISOString(),
    mode: apply ? 'apply' : 'dry-run',
    scanned: 0,
    alreadyResolved: 0,
    repaired: 0,
    wouldRepair: 0,
    failures: [],
    repairs: [],
    errors: [],
  };
  const ledgerByRef = new Map<string, Row[]>();
  for (const row of options.ledgerEvidence) {
    for (const key of ledgerRefsOf(row)) {
      const bucket = ledgerByRef.get(key);
      if (bucket) bucket.push(row);
      else ledgerByRef.set(key, [row]);
    }
  }

  const observations = await options.repositories.marketObservations.list();
  report.scanned = observations.length;
  for (const observation of observations) {
    const row = observation as unknown as Row;
    const citedId = text(row.evidenceId) ?? '';
    if (citedId && await options.repositories.evidence.get(citedId)) {
      report.alreadyResolved += 1;
      continue;
    }
    const observationId = text(row.id) ?? (citedId || '(unknown)');
    const candidates = new Set<Row>();
    for (const ref of observationRefsOf(row)) {
      for (const ledgerRow of ledgerByRef.get(ref) ?? []) candidates.add(ledgerRow);
    }
    if (candidates.size === 0) {
      report.failures.push({
        observationId,
        evidenceId: citedId,
        reason: 'no ledger evidence record matches this cited id or its recorded lineage',
      });
      continue;
    }
    if (candidates.size > 1) {
      report.failures.push({
        observationId,
        evidenceId: citedId,
        reason: `ambiguous ledger provenance (${candidates.size} exact matches); refusing to guess`,
      });
      continue;
    }
    const ledgerRow = [...candidates][0]!;
    const sourceId = text(ledgerRow.sourceId);
    const sourceRecordId = text(ledgerRow.sourceRecordId);
    const checksum = text(ledgerRow.checksum);
    if (!sourceId || !sourceRecordId || !checksum) {
      report.failures.push({
        observationId,
        evidenceId: citedId,
        reason: 'ledger evidence lacks exact sourceId + sourceRecordId + checksum provenance',
      });
      continue;
    }
    let matches: Awaited<ReturnType<Repositories['evidence']['list']>>;
    try {
      matches = await options.repositories.evidence.list({ sourceId, sourceRecordId, checksum });
    } catch (error) {
      report.errors.push(`Evidence lookup for ${sourceId}:${sourceRecordId}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (matches.length !== 1) {
      report.failures.push({
        observationId,
        evidenceId: citedId,
        reason: `no unique canonical evidence row for source=${sourceId} sourceRecordId=${sourceRecordId} checksum=${checksum} (found ${matches.length})`,
      });
      continue;
    }
    const canonicalId = matches[0]!.id;
    if (apply) {
      try {
        await (options.updateEvidenceRef ?? updateCanonicalEvidenceRef)(observationId, canonicalId);
        report.repairs.push({ observationId, from: citedId, to: canonicalId, sourceId, sourceRecordId });
        report.repaired += 1;
      } catch (error) {
        report.errors.push(`Update ${observationId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      report.wouldRepair += 1;
    }
  }
  return report;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const reportIndex = args.indexOf('--report');
  const reportPath = reportIndex >= 0 && args[reportIndex + 1]
    ? resolve(args[reportIndex + 1]!)
    : resolve(process.cwd(), 'evidence-repair-report.json');
  const ledger = createDurableRepositories();
  const ledgerEvidence = await ledger.evidence.list();
  const repositories = createRepositories(createSqlStore(getDefaultExecutor()));
  const report = await repairEvidenceRefs({
    repositories,
    ledgerEvidence: ledgerEvidence as unknown as Row[],
    apply,
  });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  // Counts and ids only. No payload, credential or DSN is ever printed.
  console.log(JSON.stringify({
    mode: report.mode,
    scanned: report.scanned,
    alreadyResolved: report.alreadyResolved,
    repaired: report.repaired,
    wouldRepair: report.wouldRepair,
    failures: report.failures.length,
    errors: report.errors.length,
    reportPath,
  }));
  process.exitCode = report.failures.length > 0 || report.errors.length > 0 ? 2 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main().catch((error: unknown) => {
    console.error(`repair failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

export default repairEvidenceRefs;
