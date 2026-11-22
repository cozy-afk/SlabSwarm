import 'dotenv/config';
// Bounded live TCGAPIs seed. Loads credentials from the process environment
// only; prints counts and credit spend, never the key or a response body.
//
//   TCGAPI_ENABLED=true TCGAPI_HARVEST_CREDIT_BUDGET=60 npx tsx scripts/seed-market.ts

import { createDurableRepositories } from '../server/ingest/store.ts';
import { promoteCandidates } from '../server/ingest/promotion.ts';
import { runTcgapisHarvest } from '../server/ingest/tcgapis-harvest.ts';

function positiveInt(name: string, fallback: number): number {
  const raw = Number(process.env[name] ?? fallback);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

// Harvest and promotion share one durable ledger so stored candidates are
// promoted without re-fetching or inventing values.
const repos = createDurableRepositories();
const result = await runTcgapisHarvest({
  repos,
  maxGames: positiveInt('TCGAPI_MAX_GAMES', 2),
  maxExpansions: positiveInt('TCGAPI_MAX_EXPANSIONS', 1),
  maxCardsPerExpansion: positiveInt('TCGAPI_MAX_CARDS', 10),
  gameIds: (process.env.TCGAPI_GAME_IDS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
  includeSalesHistory:
    String(process.env.TCGAPI_INCLUDE_SALES ?? 'false').toLowerCase() === 'true',
});
const promotion = await promoteCandidates(repos);

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
