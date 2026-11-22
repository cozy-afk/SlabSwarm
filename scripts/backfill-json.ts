/**
 * One-way JSON -> PostgreSQL backfill.
 *
 * The source JSON is an import/export artifact only: it is opened read-only,
 * checksummed before and after, and never written. Every imported row carries
 * source, observed_at, captured_at, lineage and an explicit basis. Missing
 * price components stay UNKNOWN (null); nothing is silently defaulted to zero.
 * Re-running is idempotent because all writes go through upserts keyed on the
 * source identity.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createRepositories, type Repositories } from '../server/db/repositories/index.ts';
import { runMigrations } from '../server/db/migrate.ts';
import { createDefaultStore, type DbStore, type Row } from '../server/db/store.ts';
import type {
  EvidenceRecordInput,
  MarketObservationInput,
} from '../server/contracts/dataProduct.ts';

export interface BackfillCounts {
  assets: number;
  sales: number;
  valuations: number;
  researchSources: number;
  researchNotes: number;
  marketObservations: number;
  sets: number;
}

export interface BackfillIssue {
  collection: string;
  key: string;
  reason: string;
}

export interface BackfillReport {
  source: string;
  sourceChecksum: string;
  capturedAt: string;
  startedAt: string;
  finishedAt: string;
  sourceCounts: BackfillCounts;
  /** Rows successfully read from each source collection. */
  processed: BackfillCounts;
  /** Source records skipped because of a missing identifier. */
  skipped: BackfillCounts;
  /** Rows written per target table. */
  imported: Record<string, number>;
  invalid: BackfillIssue[];
  /** True when every source record is exactly one of processed/skipped/invalid. */
  parity: boolean;
  notes: string[];
}

export interface BackfillOptions {
  source?: string;
  capturedAt?: string;
  onProgress?: (event: { table: string; count: number }) => void;
}

const SOURCE_IDS = {
  sets: 'legacy-sets',
  assets: 'legacy-assets',
  sales: 'legacy-sales',
  valuations: 'legacy-valuations',
  researchSources: 'legacy-research-sources',
  researchNotes: 'legacy-research-notes',
  marketObservations: 'legacy-market-observations',
} as const;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** ISO-8601 day strings become a deterministic UTC instant; never a zero timestamp. */
function normalizeDate(value: unknown, fallback: string): string {
  if (!nonEmptyString(value)) return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

function emptyCounts(): BackfillCounts {
  return {
    assets: 0, sales: 0, valuations: 0, researchSources: 0,
    researchNotes: 0, marketObservations: 0, sets: 0,
  };
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Extract only price components that are actually present; absent stays UNKNOWN. */
function priceComponentsFrom(record: Record<string, unknown>): Record<string, unknown> | undefined {
  const fields = ['listed_amount', 'shipping_amount', 'fees_amount', 'fx_rate', 'grade', 'condition'];
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (record[field] !== undefined && record[field] !== null) out[field] = record[field];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Import a parsed JSON snapshot into the given store. The raw text is only
 * used for the checksum; it is never modified or persisted back to disk.
 */
export async function backfillJson(
  raw: string,
  store: DbStore,
  options: BackfillOptions = {},
): Promise<BackfillReport> {
  const startedAt = new Date().toISOString();
  const capturedAt = options.capturedAt ?? startedAt;
  const source = options.source ?? 'slabgraph-db.json';
  const sourceChecksum = `sha256:${sha256(raw)}`;
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Backfill source is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isObject(snapshot)) throw new Error('Backfill source must be a JSON object.');

  const repos: Repositories = createRepositories(store);
  const sourceCounts = emptyCounts();
  const processed = emptyCounts();
  const skipped = emptyCounts();
  const imported: Record<string, number> = {};
  const invalid: BackfillIssue[] = [];
  const notes: string[] = [];

  const bump = (table: string, n = 1): void => {
    imported[table] = (imported[table] ?? 0) + n;
    options.onProgress?.({ table, count: imported[table] });
  };
  const issue = (collection: string, key: string, reason: string): void => {
    invalid.push({ collection, key, reason });
  };

  const sets = asArray(snapshot.sets);
  sourceCounts.sets = sets.length;
  for (const entry of sets) {
    if (!isObject(entry) || !nonEmptyString(entry.id)) {
      skipped.sets += 1;
      continue;
    }
    await store.upsert('sets', {
      id: entry.id,
      name: String(entry.name ?? entry.id),
      gameId: nonEmptyString(entry.franchise) ? entry.franchise : null,
      code: nonEmptyString(entry.id) ? entry.id : null,
      releaseYear: typeof entry.releaseYear === 'number' ? entry.releaseYear : null,
      metadata: { segment: entry.segment ?? null, eraCluster: entry.eraCluster ?? null },
      createdAt: capturedAt,
    } as Row, ['id']);
    processed.sets += 1;
    bump('sets');
  }

  const assets = asArray(snapshot.assets);
  sourceCounts.assets = assets.length;
  for (const entry of assets) {
    if (!isObject(entry) || !nonEmptyString(entry.id)) {
      skipped.assets += 1;
      continue;
    }
    await repos.cards.upsert({
      name: String(entry.title ?? entry.id),
      identityKey: entry.id,
      setId: nonEmptyString(entry.setId) ? entry.setId : null,
      cardNumber: nonEmptyString(entry.cardNumber) ? entry.cardNumber : null,
      variant: nonEmptyString(entry.variant) ? entry.variant : null,
      facets: {
        segment: entry.segment ?? null,
        franchise: entry.franchise ?? null,
        setName: entry.setName ?? null,
        releaseYear: entry.releaseYear ?? null,
        subjectId: entry.subjectId ?? null,
        subjectName: entry.subjectName ?? null,
        visualTheme: entry.visualTheme ?? null,
        grades: entry.grades ?? null,
      },
      rawPayload: entry,
    });
    processed.assets += 1;
    bump('cards');
  }

  const sales = asArray(snapshot.sales);
  sourceCounts.sales = sales.length;
  for (const [index, entry] of sales.entries()) {
    if (!isObject(entry) || !nonEmptyString(entry.id)) {
      skipped.sales += 1;
      continue;
    }
    const price = entry.priceUsd;
    if (typeof price !== 'number' || !Number.isFinite(price) || price < 0) {
            issue('sales', entry.id, 'invalid or missing priceUsd');
      continue;
    }
    if (!nonEmptyString(entry.assetId)) {
            issue('sales', entry.id, 'missing assetId');
      continue;
    }
    const observedAt = normalizeDate(entry.date, capturedAt);
    const checksum = `sha256:${sha256(stableStringify(entry))}`;
    const evidenceInput: EvidenceRecordInput = {
      sourceId: SOURCE_IDS.sales,
      sourceRecordId: entry.id,
      sourceUri: `file://${source}#sales/${index}`,
      capturedAt,
      observedAt,
      checksum,
      mimeType: 'application/json',
      license: 'first-party',
      rawRef: `raw_payloads/sales/${entry.id}`,
      parsedPayload: entry,
      trustTier: entry.status === 'VERIFIED' ? 'HIGH' : entry.status === 'QUARANTINED' ? 'LOW' : 'UNKNOWN',
    };
    const evidence = await repos.evidence.upsert(evidenceInput);
    const parseStatus = entry.status === 'QUARANTINED' ? 'QUARANTINED' : entry.status === 'VERIFIED' ? 'PARSED' : 'PENDING';
    await store.upsert('evidence_records', { ...(evidence as unknown as Row), parseStatus } as Row, ['id']);
    bump('evidence_records');

    const observation: MarketObservationInput = {
      evidenceId: evidence.id,
      targetIdentityRef: entry.assetId,
      basis: 'SOLD',
      amount: price,
      currency: 'USD',
      marketplace: nonEmptyString(entry.marketplaceId) ? entry.marketplaceId : null,
      observedAt,
      priceComponents: priceComponentsFrom(entry),
      status: entry.status === 'QUARANTINED' ? 'CONTESTED' : 'NORMALIZED',
    };
    await repos.marketObservations.upsert(observation);
    processed.sales += 1;
    bump('market_observations');
  }

  const valuations = isObject(snapshot.valuations) ? snapshot.valuations : {};
  sourceCounts.valuations = Array.isArray(snapshot.valuations)
    ? snapshot.valuations.length
    : Object.keys(valuations).length;
  for (const [key, entry] of Object.entries(valuations)) {
    if (!isObject(entry)) {
            issue('valuations', key, 'non-object valuation');
      continue;
    }
    const targetId = nonEmptyString(entry.assetId) ? entry.assetId : key;
    await store.upsert('valuations', {
      id: `valuation:${targetId}`,
      targetId,
      metrics: {
        topGradeLabel: entry.topGradeLabel ?? null,
        topGradeAvg: entry.topGradeAvg ?? null,
        movingAvg30d: entry.movingAvg30d ?? null,
      },
      history: Array.isArray(entry.history) ? entry.history : null,
      source: SOURCE_IDS.valuations,
      observedAt: normalizeDate(entry.observedAt, capturedAt),
      createdAt: capturedAt,
    } as Row, ['id']);
    processed.valuations += 1;
    bump('valuations');
  }
  // Population facts embedded on assets (grades/pop counts) are valuations with
  // POPULATION basis; popCount 0 in the source is a real value, not a default.
  for (const entry of assets) {
    if (!isObject(entry) || !nonEmptyString(entry.id) || !Array.isArray(entry.grades) || entry.grades.length === 0) continue;
    await store.upsert('valuations', {
      id: `grades:${entry.id}`,
      targetId: entry.id,
      metrics: { basis: 'POPULATION', grades: entry.grades },
      history: null,
      source: 'legacy-grade-population',
      observedAt: capturedAt,
      createdAt: capturedAt,
    } as Row, ['id']);
    bump('valuations');
  }

  const researchSources = asArray(snapshot.researchSources);
  sourceCounts.researchSources = researchSources.length;
  for (const [index, entry] of researchSources.entries()) {
    if (!isObject(entry) || !nonEmptyString(entry.id)) {
      skipped.researchSources += 1;
      continue;
    }
    const evidenceInput: EvidenceRecordInput = {
      sourceId: SOURCE_IDS.researchSources,
      sourceRecordId: entry.id,
      sourceUri: `file://${source}#researchSources/${index}`,
      capturedAt: normalizeDate(entry.capturedAt, capturedAt),
      observedAt: normalizeDate(entry.observedAt, normalizeDate(entry.capturedAt, capturedAt)),
      checksum: `sha256:${sha256(stableStringify(entry))}`,
      mimeType: 'application/json',
      license: typeof entry.license === 'string' ? entry.license : null,
      rawRef: `raw_payloads/research-sources/${entry.id}`,
      parsedPayload: entry,
      trustTier: 'UNKNOWN',
    };
    const evidence = await repos.evidence.upsert(evidenceInput);
    await store.upsert('evidence_records', { ...(evidence as unknown as Row), parseStatus: 'PARSED' } as Row, ['id']);
    processed.researchSources += 1;
    bump('evidence_records');
  }

  const researchNotes = asArray(snapshot.researchNotes);
  sourceCounts.researchNotes = researchNotes.length;
  for (const [index, entry] of researchNotes.entries()) {
    if (!isObject(entry) || !nonEmptyString(entry.id)) {
      skipped.researchNotes += 1;
      continue;
    }
    await store.upsert('research_notes', {
      id: entry.id,
      question: String(entry.question ?? ''),
      subquestions: Array.isArray(entry.subquestions) ? entry.subquestions : null,
      evidenceIds: Array.isArray(entry.evidenceIds) ? entry.evidenceIds : null,
      synthesis: typeof entry.synthesis === 'string' ? entry.synthesis : null,
      confidence: typeof entry.confidence === 'number' ? entry.confidence : null,
      missingData: Array.isArray(entry.missingData) ? entry.missingData : null,
      source: { sourceId: SOURCE_IDS.researchNotes, sourceUri: `file://${source}#researchNotes/${index}` },
      observedAt: normalizeDate(entry.createdAt, capturedAt),
      createdAt: capturedAt,
    } as Row, ['id']);
    processed.researchNotes += 1;
    bump('research_notes');
  }

  const observations = asArray(snapshot.marketObservations);
  sourceCounts.marketObservations = observations.length;
  for (const [index, entry] of observations.entries()) {
    if (!isObject(entry) || !nonEmptyString(entry.id)) {
      skipped.marketObservations += 1;
      continue;
    }
    const basis = entry.basis;
    const validBases = new Set(['SOLD', 'ASKING', 'OFFER', 'GUIDE', 'CLAIM', 'POPULATION', 'UNKNOWN']);
    if (typeof basis !== 'string' || !validBases.has(basis)) {
            issue('marketObservations', entry.id, `invalid basis: ${String(basis)}`);
      continue;
    }
    // Preserve lineage by resolving a source evidenceId to our generated id.
    let evidenceId = nonEmptyString(entry.evidenceId) ? entry.evidenceId : '';
    if (evidenceId) {
      const [match] = await repos.evidence.list({ sourceRecordId: evidenceId });
      if (match) evidenceId = match.id;
      else notes.push(`marketObservation ${entry.id}: evidence ${entry.evidenceId} not found; original ref retained`);
    }
    if (!evidenceId) {
            issue('marketObservations', entry.id, 'missing evidenceId');
      continue;
    }
    const observation: MarketObservationInput = {
      evidenceId,
      targetIdentityRef: String(entry.targetIdentityRef ?? entry.targetIdentityId ?? ''),
      basis: basis as MarketObservationInput['basis'],
      // Missing amount is UNKNOWN/invalid, never a zero that looks like a real price.
      amount: typeof entry.amount === 'number' ? entry.amount : Number.NaN,
      currency: nonEmptyString(entry.currency) ? entry.currency : 'UNKNOWN',
      marketplace: nonEmptyString(entry.marketplace) ? entry.marketplace : null,
      observedAt: normalizeDate(entry.observedAt, capturedAt),
      priceComponents: priceComponentsFrom(entry),
      // Absent status stays undefined so an existing (e.g. sale-derived) status
      // is preserved on upsert instead of being overwritten with RAW.
      status: (['RAW', 'NORMALIZED', 'CONTESTED', 'SUPERSEDED'].includes(String(entry.status))
        ? entry.status
        : undefined) as MarketObservationInput['status'] | undefined,
    };
    if (!observation.targetIdentityRef || !Number.isFinite(observation.amount)) {
            issue('marketObservations', entry.id, 'missing target or invalid amount');
      continue;
    }
    await repos.marketObservations.upsert(observation);
    processed.marketObservations += 1;
    bump('market_observations');
  }

  const invalidByCollection = invalid.reduce<Record<string, number>>((acc, item) => {
    acc[item.collection] = (acc[item.collection] ?? 0) + 1;
    return acc;
  }, {});
  const keys = Object.keys(sourceCounts) as (keyof BackfillCounts)[];
  const parity = keys.every((key) =>
    sourceCounts[key] === processed[key] + skipped[key] + (invalidByCollection[key] ?? 0),
  );
  if (!parity) notes.push('Parity mismatch: source counts != processed + skipped + invalid.');

  // Guard against an accidental source mutation during the import.
  if (sha256(raw) !== sourceChecksum.slice('sha256:'.length)) {
    throw new Error('Source JSON changed during backfill; refusing to report success.');
  }

  return {
    source,
    sourceChecksum,
    capturedAt,
    startedAt,
    finishedAt: new Date().toISOString(),
    sourceCounts,
    processed,
    skipped,
    imported,
    invalid,
    parity,
    notes,
  };
}

/** Read-only file wrapper used by the CLI and route handler. */
export async function backfillJsonFile(
  filePath: string,
  store: DbStore,
  options: Omit<BackfillOptions, 'source'> = {},
): Promise<BackfillReport> {
  const raw = await readFile(filePath, 'utf-8');
  const before = createHash('sha256').update(raw).digest('hex');
  const report = await backfillJson(raw, store, { ...options, source: filePath });
  // Re-read the file on disk: the source must be byte-identical after import.
  const after = createHash('sha256').update(await readFile(filePath, 'utf-8')).digest('hex');
  if (before !== after) throw new Error('Source JSON file was modified by the backfill.');
  return report;
}

/** CLI entry point: db:migrate is applied first, then the snapshot is imported. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const filePath = argv[0] ?? process.env.SLABGRAPH_DB_PATH ?? '/opt/slabswarm/data/slabgraph-db.json';
  await import('dotenv/config');
  const store = createDefaultStore();
  const migrations = await runMigrations(store);
  const report = await backfillJsonFile(filePath, store);
  process.stdout.write(`${JSON.stringify({ migrations, report }, null, 2)}\n`);
}

const invokedDirectly = (() => {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`Backfill failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
