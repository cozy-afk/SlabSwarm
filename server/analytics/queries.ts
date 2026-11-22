// Allow-listed, read-only SQL Lab templates. Each template queries only the
// in-memory projections registered from the analytics store; no external file
// or network access is possible.

import { assertReadOnlySql } from './duckdb.ts';

export interface BuiltInQuery {
  id: string;
  title: string;
  description: string;
  sql: string;
}

export const BUILT_IN_QUERIES: readonly BuiltInQuery[] = [
  {
    id: 'active_cards_30d',
    title: 'Active cards (30 days)',
    description: 'Cards with the most market observations in the last 30 days.',
    sql: `SELECT target_identity_ref AS targetId,
                 COUNT(*) AS observations,
                 COUNT(DISTINCT source) AS sources,
                 MAX(observed_at) AS latestObservedAt
          FROM observations
          WHERE observed_at >= CAST(CURRENT_TIMESTAMP - INTERVAL '30' DAY AS VARCHAR)
          GROUP BY target_identity_ref
          ORDER BY observations DESC, targetId`,
  },
  {
    id: 'basis_mix',
    title: 'Basis mix',
    description: 'Observation counts grouped by explicit basis and currency.',
    sql: `SELECT basis, currency, COUNT(*) AS observations
          FROM observations
          GROUP BY basis, currency
          ORDER BY basis, currency`,
  },
  {
    id: 'finding_summary',
    title: 'Discovery finding summary',
    description: 'Counts of persisted discovery notes by type and confidence.',
    sql: `SELECT type, confidence, COUNT(*) AS findings
          FROM findings
          GROUP BY type, confidence
          ORDER BY type, confidence`,
  },
  {
    id: 'price_summary_by_basis',
    title: 'Price summary by basis',
    description: 'Price ranges computed within one basis and one currency only.',
    sql: `SELECT basis, currency, COUNT(*) AS observations,
                 MIN(amount) AS minAmount,
                 MAX(amount) AS maxAmount,
                 AVG(amount) AS avgAmount
          FROM observations
          GROUP BY basis, currency
          ORDER BY basis, currency`,
  },
  {
    id: 'recent_observations',
    title: 'Recent observations',
    description: 'The 50 newest observations with their provenance fields.',
    sql: `SELECT id, target_identity_ref AS targetId, basis, amount, currency,
                 source, observed_at AS observedAt, status
          FROM observations
          ORDER BY observed_at DESC
          LIMIT 50`,
  },
  {
    id: 'source_freshness',
    title: 'Source freshness',
    description: 'Newest observation per source with its age in days.',
    sql: `SELECT source,
                 COUNT(*) AS observations,
                 MAX(observed_at) AS latestObservedAt,
                 DATE_DIFF('day', CAST(MAX(observed_at) AS TIMESTAMP), CURRENT_TIMESTAMP) AS ageDays
          FROM observations
          GROUP BY source
          ORDER BY latestObservedAt`,
  },
];

for (const query of BUILT_IN_QUERIES) {
  assertReadOnlySql(query.sql);
}

export function getBuiltInQueries(): BuiltInQuery[] {
  return BUILT_IN_QUERIES.map((query) => ({ ...query }));
}

export function findBuiltInQuery(id: string): BuiltInQuery | null {
  const found = BUILT_IN_QUERIES.find((query) => query.id === id);
  return found ? { ...found } : null;
}
