# Canonical Prediction Database — Design

Status: proposed for approval
Date: 2026-11-23

## Intent

Slabswarm's own database must be trustworthy enough to predict card prices and market behaviour before any thought of selling access. Today the app has three competing stores: the legacy JSON graph, a JSON ingest ledger, and canonical Postgres tables. The same card can return different facts depending on the endpoint. That has to end before more data is added.

## Goals

1. One source of truth: canonical Postgres is authoritative for catalog, evidence, observations, forecasts, scores and learning state.
2. JSON graph and JSON ledger become import/export artifacts, not runtime sources.
3. Every prediction input carries source, basis, currency, observed_at, captured_at, lineage and confidence.
4. Deterministic identity resolution so the same printing from two sources becomes one card, with an auditable decision.
5. Realized outcomes are captured from new SOLD observations; forecasts are scored at 7/30/90 days.
6. Learning changes weights only when benchmark non-regression passes.
7. Parquet lake and backups exist and are exercised, not just declared.
8. Existing Hermes tool IDs keep working and return the same facts as the UI.

## Non-goals

- No customer API keys, billing, quotas or public exposure in this phase.
- No new web sources beyond the web-harvest work already in flight.
- No model writes canonical facts. No LLM-only prices.
- No destructive rewrite of the legacy JSON snapshot.

## Anti-goals

- A bigger catalog built on split sources. That multiplies disagreement.
- Forecasts sold or shown as confident before they are scored against outcomes.
- Scraped data resold without a clear license and provenance.

## Constraints

- Raw evidence immutable; corrections append.
- Basis explicit: SOLD/ASKING/OFFER/GUIDE/CLAIM/POPULATION/UNKNOWN.
- Missing shipping, fees, FX, grade or condition stays UNKNOWN, never zero.
- Deterministic code computes valuations and scores; agents propose, explain, challenge.
- Every forecast is scored against real outcomes; learning promotes only through gates.
- Keep Hermes tool IDs stable: get_collectible_valuation, scan_arbitrage_spreads, query_knowledge_graph, ingest_market_listing.
- No new public listeners, firewall or DNS changes.
- Use `sudo -n docker` for Docker operations.

## Approaches considered

### A. Big-bang rewrite of all read paths

Replace graphEngine, the ledger and the analytics store in one pass. Cleanest end state, but it touches nearly every endpoint at once and would leave the app untestable mid-flight. Rejected.

### B. Canonical-first adapter replacement (recommended)

Keep existing interfaces. Replace what backs them: repositories point at Postgres, Hermes tools and product endpoints call those repositories, and the JSON graph/ledger are used only at import time. Migrate one read domain at a time — catalog first, then evidence/observations, then Hermes tools — with contract tests asserting identical results across the old and new paths before each cutover. Lower blast radius, keeps the app running, but leaves temporary adapters until the last cutover.

### C. Dual-write both stores forever

Write to Postgres and the JSON graph on every mutation. Least work up front, but it guarantees the two stores drift under failure and keeps the exact problem we are trying to remove. Rejected.

## Chosen design

Approach B, in five workstreams.

### 1. Canonical read layer

- A `server/canonical/queries.ts` facade exposing catalog, pricing, comps, market, evidence and Hermes-tool reads over `createDefaultRepositories()`.
- Cut over `/api/catalog/*`, `/api/pricing/:id`, `/api/comps/:id`, `/api/market/:id` and `server/hermesBridge.ts` to that facade.
- Contract tests compare old and new responses for the same fixtures before each cutover.
- Mark the 39 `tcg:*` rows as `EXTERNAL_REFERENCE` in `facets.sourceClass`; exclude them from prediction inputs by default. The 19 first-party cards stay `FIRST_PARTY`.

### 2. Identity resolution

- Implement the spec's resolver over canonical `cards`, `identity_decisions`, `aliases` and `crosswalks` tables.
- Deterministic match on normalized name + set + card number + variant, then evidence-backed alias matches. No fuzzy LLM decision.
- Swarm may propose an alias or crosswalk; only the deterministic resolver commits a decision with a reason and evidence IDs.

### 3. Outcomes, scoring and learning

- A job in the Postgres `jobs` table watches new SOLD observations. When a target has a prior forecast whose 7/30/90 day horizon has elapsed, compute the realized value from SOLD observations only and write `forecast_scores` with band coverage, direction, MAE and Brier.
- Scoring is deterministic. No simulated value may become an outcome.
- `POST /api/learning/run-cycle` consumes scores, updates source trust, factor weights and calibration, and promotes only on non-regression. Record each cycle in `learning_events` and `rule_versions`.
- Forecast Lab displays coverage, MAE and Brier per horizon, not just bands.

### 4. Parquet lake

- Run `POST /api/admin/export-parquet` after each approved harvest and nightly. Export evidence, observations, identities, events, forecasts and scores under `/opt/slabswarm/data/lake`, partitioned where fields exist.
- SQL Lab queries the exported Parquet through the existing read-only DuckDB helper, with proof in the API response that the data came from the lake.

### 5. Backup and restore

- Scripts for Postgres `pg_dump`, the Parquet lake and encrypted LLM settings.
- A restore drill against a temporary database and directory. Record checksums and result.
- Schedule daily backup; retain a small, documented number of copies.

## Data owners

- `server/canonical/**` and `server.ts` router wiring: integrator.
- Identity resolver: `server/identity/**`.
- Outcomes/scoring/learning: `server/forecast/**` and `server/learning/**`.
- Parquet export and SQL Lab: `server/analytics/**`.
- Backup/restore: `scripts/backup-*`, `scripts/restore-*`.

## Verification

- Every cutover has contract tests comparing old and new outputs on fixed fixtures.
- Full suite, typecheck, compose validation before each rebuild.
- Live checks: one card returns identical facts through UI, Hermes tool and SQL Lab; one SOLD observation creates a score; one learning cycle changes state only if the benchmark gate passes; Parquet files exist and SQL Lab reads them; restore drill succeeds.

## Resolved builder questions

These were ambiguous in the first draft. The answers below are the builder's calls, made so the implementation plan has no hidden choices.

1. **Resolver algorithm.** Normalize NFC + lowercase + trim, uppercase set codes, strip leading zeros and `#` from card numbers, lowercase variants. Exact match key: normalized name + set + number + variant. Tie-break: highest trust tier (HIGH > MEDIUM > LOW > UNKNOWN), then earliest `observedAt`, then lexicographically smallest evidence ID. An alias or crosswalk requires either an explicit `aliasOf` field in source evidence or two independent sources agreeing on the normalized key. No fuzzy or model-based matching. Every `identity_decisions` row records the rule, input fields, candidate evidence IDs, confidence and timestamp.
2. **Surviving ID.** The first accepted first-party canonical card ID survives. Absorbed source IDs (`tcg:*`, `TCG-*`) become rows in `aliases` pointing to it. Observation `targetIdentityId` values are never rewritten. The canonical facade resolves both canonical IDs and aliases, so Hermes tool inputs keep working. UI shows the canonical ID and lists aliases.
3. **Write path.** Yes, canonical Postgres becomes the write target in this phase — ingest, promotion, web-harvest approval and `ingest_market_listing`. The JSON ledger and graph become import/export artifacts. `scripts/sync-postgres.ts` stays as a one-time migration utility, not a runtime bridge. Contract tests assert no new runtime writes reach the ledger after cutover.
4. **Hermes valuation inputs.** Valuations are recomputed deterministically from canonical `market_observations` (basis, grade, marketplace, currency, status). Backfilled `valuations` rows remain authoritative for POPULATION and grade-count metrics. Add a small `fee_schedules` table with configurable marketplace fee percentages; absent fee data stays UNKNOWN rather than assuming zero. Status mapping: VERIFIED → NORMALIZED, QUARANTINED → CONTESTED, with the original status preserved in evidence facets.
5. **Realized outcome.** For a forecast created at t0 with horizon H, the realized value is the median `amount` of SOLD, NORMALIZED observations for the same canonical card, grade, marketplace and currency whose `observedAt` falls within ±7 days of t0+H. No matching observations means the outcome is UNKNOWN and the forecast is not evaluable — not scored as wrong. `baselinePrice` is the midpoint of the forecast's price band at creation, stored in a new `forecasts.baseline_snapshot` JSONB column.
6. **Learning state.** Canonical tables are authoritative: `source_trust_profiles`, `factor_scores`, `rule_versions`, `learning_events`, plus a new `learning_state` singleton table for cycle count and calibration. `/api/learning/run-cycle` ignores caller-supplied benchmarks; the benchmark comes only from stored non-regressing backtests. No backtest means no promotion.
7. **Contract test comparison.** Compare fact fields exactly after alias resolution: ID, basis, currency, amount, observedAt, source, lineage, confidence, set, game, number, variant. Ignore `generatedAt`, `requestId`, warning wording/order and provenance source strings, but assert each exists with the right shape.
8. **`ingest_market_listing`.** Response shape stays identical. New canonical observation status is NORMALIZED for VERIFIED, CONTESTED for QUARANTINED; `outlierReason` is preserved in evidence facets and `priceComponents`. `updatedValuation` is recomputed by the deterministic valuation function over canonical observations.
9. **SQL Lab and the lake.** Findings become a seventh Parquet dataset so the built-in `findings-by-type` query keeps working. Lake proof is `meta.lakeManifest` with file paths, row counts and sha256 checksums, plus `engine: duckdb-readonly`.
10. **Scheduling.** An in-process scheduler inside the app container uses the Postgres `jobs` table with a lock row — no host cron or OS changes. Jobs: outcome creation when a SOLD observation is approved, nightly Parquet export, daily backup. All are idempotent by job status and lock. An "approved harvest" is a web-harvest candidate whose status is APPROVED.

## What is left to the builder

Implementation sequencing, file-level tasks and test cases go in the implementation plan after design approval.
