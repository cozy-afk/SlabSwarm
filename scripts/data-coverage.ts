// Read-only data coverage census for the durable ingest ledger.
//
//   npx tsx scripts/data-coverage.ts > docs/benchmarks/2026-11-23-data-coverage.md
//   npx tsx scripts/data-coverage.ts --promote   # promote once, then report
//
// The snapshot never mutates evidence, candidates or observations. Promotion is
// opt-in via --promote and writes only canonical market observations. All
// counts come from the ledger; nothing is inferred, rounded or invented.

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CoverageSnapshot } from '../server/contracts/dataProduct.ts';
import { isPricedCandidate, promoteCandidates, promotionKey } from '../server/ingest/promotion.ts';
import { createDurableRepositories } from '../server/ingest/store.ts';
import type { IngestCandidate, IngestRepositories } from '../server/ingest/types.ts';

function countBy<T>(rows: T[], keyOf: (row: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const key = keyOf(row) || 'UNKNOWN';
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Count the ledger without writing to it. Priced candidates have a finite
 * amount and an explicit basis; catalog rows with no amount stay catalog-only
 * (UNKNOWN is not zero). Parse status and trust tier describe raw evidence and
 * are reported verbatim, never reclassified by promotion.
 */
export async function buildCoverageSnapshot(repos: IngestRepositories): Promise<CoverageSnapshot> {
  const [evidence, candidates, observations, runs] = await Promise.all([
    repos.evidence.list(),
    repos.candidates.list(),
    repos.marketObservations.list(),
    repos.runs.list(),
  ]);

  const observationKeys = new Set(
    observations
      .filter((row) =>
        typeof row.evidenceId === 'string'
        && typeof row.targetIdentityRef === 'string'
        && typeof row.basis === 'string')
      .map((row) => promotionKey(row)),
  );
  const priced = candidates.filter((row) => isPricedCandidate(row as IngestCandidate));

  return {
    tables: {
      evidence: evidence.length,
      candidates: candidates.length,
      observations: observations.length,
      runs: runs.length,
    },
    bySource: countBy(candidates, (row) => String(row.sourceId ?? 'UNKNOWN')),
    byBasis: countBy(candidates, (row) => String(row.basis ?? 'UNKNOWN')),
    byParseStatus: countBy(evidence, (row) => String(row.parseStatus ?? 'UNKNOWN')),
    byTrustTier: countBy(evidence, (row) => String(row.trustTier ?? 'UNKNOWN')),
    pricedCandidates: priced.length,
    catalogOnly: candidates.length - priced.length,
    promotedObservations: observations.length,
    pricedWithoutObservation: priced.filter((row) => !observationKeys.has(promotionKey(row))).length,
    duplicateObservationKeys: observations.length - observationKeys.size,
  };
}

function table(title: string, columns: [string, string], rows: Array<[string, number]>): string {
  const lines = [
    `## ${title}`,
    '',
    `| ${columns[0]} | ${columns[1]} |`,
    '| --- | ---: |',
    ...rows.map(([key, value]) => `| ${key} | ${value} |`),
    '',
  ];
  return lines.join('\n');
}

export function renderCoverageMarkdown(snapshot: CoverageSnapshot): string {
  return [
    '# Data coverage — 2026-11-23',
    '',
    'Read-only census of the durable ingest ledger. No evidence, candidate or',
    'observation is mutated by this report. UNKNOWN stays UNKNOWN; a missing',
    'amount is catalog-only, never zero. Raw parse status is reported as stored,',
    'independent of promotion.',
    '',
    table('Ledger totals', ['Table', 'Rows'], [
      ['Evidence', snapshot.tables.evidence],
      ['Candidates', snapshot.tables.candidates],
      ['Market observations', snapshot.tables.observations],
      ['Ingest runs', snapshot.tables.runs],
    ]),
    table('Coverage', ['Metric', 'Count'], [
      ['Priced candidates', snapshot.pricedCandidates],
      ['Catalog-only candidates', snapshot.catalogOnly],
      ['Promoted observations', snapshot.promotedObservations],
      ['Priced candidates without observation', snapshot.pricedWithoutObservation],
      ['Duplicate observation keys', snapshot.duplicateObservationKeys],
    ]),
    table('Candidates by source', ['Source', 'Candidates'],
      Object.entries(snapshot.bySource)),
    table('Candidates by basis', ['Basis', 'Candidates'],
      Object.entries(snapshot.byBasis)),
    table('Evidence by raw parse status', ['Parse status', 'Rows'],
      Object.entries(snapshot.byParseStatus)),
    table('Evidence by trust tier', ['Trust tier', 'Rows'],
      Object.entries(snapshot.byTrustTier)),
    '## Machine-readable snapshot',
    '',
    '```json',
    JSON.stringify(snapshot, null, 2),
    '```',
    '',
  ].join('\n');
}

const invokedDirectly = process.argv[1]
  ? import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  : false;

if (invokedDirectly) {
  const repos = createDurableRepositories();
  if (process.argv.includes('--promote')) {
    const promotion = await promoteCandidates(repos);
    process.stderr.write(`${JSON.stringify({
      candidatesSeen: promotion.candidatesSeen,
      promoted: promotion.promoted,
      skipped: promotion.skipped,
      duplicates: promotion.duplicates,
      errors: promotion.errors,
      unpromotedPriced: promotion.unpromotedPriced.length,
    })}\n`);
    if (promotion.errors.length > 0 || promotion.unpromotedPriced.length > 0) {
      process.exitCode = 1;
    }
  }
  process.stdout.write(renderCoverageMarkdown(await buildCoverageSnapshot(repos)));
}

export default buildCoverageSnapshot;
