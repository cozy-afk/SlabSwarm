// Bounded live TCGAPIs seed. Loads credentials from the process environment
// only; prints counts and credit spend, never the key or a response body.
//
//   TCGAPI_ENABLED=true TCGAPI_HARVEST_CREDIT_BUDGET=60 \
//     TCGAPI_KEY=... npx tsx scripts/seed-market.ts

import { createDurableRepositories } from '../server/ingest/store.ts';
import { runTcgapisHarvest } from '../server/ingest/tcgapis-harvest.ts';

const result = await runTcgapisHarvest({ repos: createDurableRepositories() });

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
  }),
);

process.exitCode = result.errors.length > 0 ? 1 : 0;
