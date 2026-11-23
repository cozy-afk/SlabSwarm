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

## What is left to the builder

Implementation sequencing, file-level tasks and test cases go in the implementation plan after design approval.
