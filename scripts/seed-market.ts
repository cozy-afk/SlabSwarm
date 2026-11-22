import 'dotenv/config';
// Bounded live TCGAPIs seed. Loads credentials from the process environment
// only; prints counts and credit spend, never the key or a response body.
//
//   TCGAPI_ENABLED=true TCGAPI_HARVEST_CREDIT_BUDGET=60 \
//     TCGAPI_KEY=... npx tsx scripts/seed-market.ts

import { createDurableRepositories } from '../server/ingest/store.ts';
import { runTcgapisHarvest } from '../server/ingest/tcgapis-harvest.ts';

function positiveInt(name: string, fallback: number): number {
  const raw = Number(process.env[name] ?? fallback);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

const result = await runTcgapisHarvest({
  repos: createDurableRepositories(),
  maxGames: positiveInt('TCGAPI_MAX_GAMES', 2),
  maxExpansions: positiveInt('TCGAPI_MAX_EXPANSIONS', 1),
  maxCardsPerExpansion: positiveInt('TCGAPI_MAX_CARDS', 10),
  includeSalesHistory:
    String(process.env.TCGAPI_INCLUDE_SALES ?? 'false').toLowerCase() === 'true',
});

const key = process.env.TCGAPI_KEY ?? '';
const redact = (value: string) => key ? value.split(key).join('[REDACTED]') : value;
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
    errorSample: result.errors.length ? redact(result.errors[0]) : null,
  }),
);

process.exitCode = result.errors.length > 0 ? 1 : 0;
