import 'dotenv/config';
// Project the durable ingest ledger into the canonical Postgres tables.
// Run inside the Slabswarm container, where slabswarm-db is reachable.
// Prints counts only; never prints credentials or raw payloads.

import { createDefaultRepositories } from '../server/db/repositories/index.ts';
import { syncLedgerToPostgres } from '../server/db/sync.ts';
import { createDurableRepositories } from '../server/ingest/store.ts';

const ledger = createDurableRepositories();
const [evidence, observations] = await Promise.all([
  ledger.evidence.list(),
  ledger.marketObservations.list(),
]);

const report = await syncLedgerToPostgres(createDefaultRepositories(), {
  evidence: evidence as unknown as Record<string, unknown>[],
  observations: observations as unknown as Record<string, unknown>[],
});

console.log(JSON.stringify({
  evidence: report.evidence,
  cards: report.cards,
  observations: report.observations,
  errors: report.errors.length,
  errorSample: report.errors[0] ?? null,
}));
process.exitCode = report.errors.length > 0 ? 1 : 0;
