// Bounded live TCGAPIs seed. Loads credentials from the process environment
// only; prints counts and credit spend, never the key or a response body.
//
//   TCGAPI_ENABLED=true TCGAPI_HARVEST_CREDIT_BUDGET=60 \
//     TCGAPI_KEY=... npx tsx scripts/seed-market.ts

import { createDurableRepositories } from '../server/ingest/store.ts';
import { promoteCandidates } from '../server/ingest/promotion.ts';
import { runTcgapisHarvest } from '../server/ingest/tcgapis-harvest.ts';

const repos = createDurableRepositories();
const result = await runTcgapisHarvest({ repos });
// Harvest and promotion share the same durable ledger so already-stored
// candidates are promoted without re-fetching or inventing values.
const promotion = await promoteCandidates(repos);

console.log(
  JSON.stringify({
    games: result.games,
    expansions: result.expansions,
    cards: result.cards,
    prices: result.prices,
    sales: result.sales,
    evidenceWritten: result.evidenceWritten,
    creditsSpent: result.creditsSpent,
    stoppedAtBudget: result.stoppedAtBudget,
    errors: result.errors.length,
    promotion: {
      candidatesSeen: promotion.candidatesSeen,
      promoted: promotion.promoted,
      skipped: promotion.skipped,
      duplicates: promotion.duplicates,
      errors: promotion.errors.length,
    },
  }),
);

process.exitCode = result.errors.length > 0 || promotion.errors.length > 0 ? 1 : 0;
