# Industry Insight Launch — Verification Record

Date: 2026-11-22 (UTC). Host: oci-a1, aarch64. All figures below came from live commands, not estimates.

## Built and deployed

- Repo `/opt/slabswarm`, main at `afa0318`.
- Five data-product lanes merged, then four insight lanes, then the promotion lane. Full conflict list and rulings are in `.superpowers/sdd/2026-11-22-data-product-master-plan/progress.md`.
- `slabswarm:local` rebuilt from main; `slabswarm-db` is `postgres:17` on the internal-only `slabswarm-internal` network. ARM64 manifest confirmed before pull.
- Bind unchanged: `10.99.0.1:3010 -> 3000`. Public route unchanged: `https://slabswarm.144-21-43-141.sslip.io/` → 302 to the shared gate.

## Tests and static checks

- All 51 test files run explicitly: `tsx --test $(find tests ...)` → **330 tests, 330 pass, 0 fail**.
- `npx tsc --noEmit` → exit 0.
- `docker compose config -q` → exit 0.
- Provider keys must be suppressed during local tests (`DOTENV_CONFIG_PATH` pointed at an empty env) or real keys cause LLM timeouts. This is a test-environment rule, not an app defect.

## Data

- TCGAPIs live seed with `TCGAPI_ENABLED=true`, `TCGAPI_HARVEST_CREDIT_BUDGET=60`, 2 games / 1 expansion / 10 cards per expansion → **62 evidence records, 24 credits spent, 0 errors**.
- Durable ledger at `data/ingest-store.json`: **98 evidence records, 98 candidates, 51 observations**.
- Promotion is idempotent: first run promoted 51, skipped 47; second run promoted 0, reported 51 duplicates.
- All 51 promoted observations are basis `GUIDE`, currency `USD`. There is no SOLD evidence in this seed. Price bands are guide references, not completed-sale evidence.

## HTTP verification (bearer: server-side HERMES_BRIDGE_TOKEN)

All returned 200: `/api/health`, `/api/db/status`, `/api/evidence`, `/api/ingest/runs`, `/api/intelligence/findings`, `/api/intelligence/active-report`, `/api/learning/state`, `/api/sql/queries`, `/api/catalog/search?q=pikachu`, `/api/hermes/tools`.

- Postgres migrations: `0001_init.sql` and `0002_indexes.sql` applied, `state: CURRENT`, `__schema_migrations: 2`.
- Discovery sweep: 41 findings, types `ACTIVE_CARD`, `SPREAD`, `ANOMALY`. Findings route reports count 41.
- Active report: **9 cards**, 98 evidence, 51 observations, `insufficientEvidence: false`. Each card carries basis, currency, observation count, last observed at, drivers, invalidators and cited evidence refs.
  - `Amalgamight, Close Encounter` — Alpha Clash / Nexus of Power — GUIDE USD — band 0.20 / 0.65 / 1.00.
  - `Amalgamight, Determined` — Alpha Clash / Nexus of Power — GUIDE USD — band 0.20 / 0.65 / 1.00.
  - `Amalgamight, Accruing` — Alpha Clash / Nexus of Power — GUIDE USD — band 0.30 / 1.68 / 3.00.
- `POST /api/intelligence/forecast-from-report`: 9 deterministic drafts, horizons `[7, 30, 90]`, 6 evidence IDs on the first draft.
- Hermes tool IDs unchanged: `get_collectible_valuation`, `ingest_market_listing`, `query_knowledge_graph`, `scan_arbitrage_spreads`.
- Built client bundle present at `/app/dist/assets/index-BEZciSY6.js`.

## Known limits

- No SOLD/ASKING evidence yet. A second bounded harvest targeting Pokemon (`TCGAPI_GAME_IDS=3`, `TCGAPI_INCLUDE_SALES=true`, budget 40) reached HTTP 403 `TRIAL_CREDITS_USED` after 14 credits. The harvest stopped safely, made no retries and added no fabricated prices. Adding completed-sale basis requires the account owner to buy credits or a monthly plan.
- Forecasts are deterministic drafts from guide comps and are not yet scored against realized outcomes — there is no future outcome data to score against.
- Operator passcode is a claimed hash, not present in `.env`; verification used the existing bridge token rather than guessing credentials.
- The OCI key pasted into chat in an earlier session should be rotated by its owner. It was not used here.
