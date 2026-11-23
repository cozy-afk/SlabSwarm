# Slabswarm Capability Gap Audit — 2026-11-23

Method: read the approved design spec, inventory registered API routes and UI views, inspect live Postgres counts, check for placeholder strings and compare each spec goal and success criterion against code and runtime state.

## What works today

- 9 primary UI views: Sources, Catalog, Market Intelligence, Active Report, Research Swarm, Forecast Lab, Learning, SQL Lab, API/Hermes.
- ~75 registered `/api` routes including evidence, ingest, catalog, pricing, comps, market, forecasts, learning, SQL Lab, alerts, portfolio, Hermes tools.
- Active report returns 9 evidence-backed cards from first-party ledger data; forecast drafts carry 7/30/90 horizons, drivers, invalidators and evidence IDs.
- Postgres canonical tables populated: 58 cards (19 first-party, 39 external reference), 169 evidence records, 72 observations, 19 sets, 19 valuations, 6 research notes. Migrations 0001–0003 CURRENT.
- Hermes tool IDs still work. Public gate still 302. 355 tests pass.

## Material gaps, ranked by what they cost us

### 1. Canonical data and runtime are still split (high impact, medium effort)

Hermes tools in `server/hermesBridge.ts` read `graphEngine.getState()` — the legacy JSON graph — not the canonical Postgres tables. The report and catalog read a JSON ledger and graph snapshot. So the same card can have different facts depending on which endpoint you ask. More data makes this worse, not better.

Fix: route Hermes tools, catalog, pricing, comps and market through the canonical repositories; treat the JSON graph as an import source only.

### 2. Forecasts cannot learn yet (high impact, medium effort)

`/api/forecasts/:id/score` and `/api/learning/run-cycle` exist, but there is no outcome-capture path. Live `/api/learning/state` shows `cycleCount: 0` and empty trust/factor/calibration state. A forecast is only worth having if it is scored against a real result.

Fix: capture realized outcomes from new SOLD observations at 7/30/90 days, score automatically, then let the learning gate promote weights only on non-regression.

### 3. Parquet lake is declared but empty (medium impact, low effort)

UI nav says "SQL Lab — Parquet & DuckDB". `data/lake` has no exported Parquet files. The analytics store is seeded in memory from the ledger at app start. `/api/admin/export-parquet` exists but has never been run.

Fix: run the export on a schedule or after each approved harvest, and have SQL Lab query the exported files.

### 4. Identity resolution is absent (medium impact, medium effort)

`identity_decisions` has zero rows. Cards are keyed by source identity strings. Without deterministic resolution and aliases, the same printing from two sources stays two cards.

Fix: implement the identity resolver that the spec calls for, with explicit decisions, aliases and crosswalks; swarm may propose, never decide.

### 5. Web harvesting is missing — in progress (high impact, high effort)

Confirmed by code: no web tool in the swarm allowlist, no web adapter. The spec's goal 1 includes public mentions. Three workers are currently building the adapter, swarm tools and an operator review queue. This gap is being closed.

### 6. Backup and restore drill absent (high impact, low effort)

Phase 5 hardening listed a backup script and restore drill as proposals. No scripts exist on disk. Postgres, Parquet lake and encrypted LLM settings have no tested recovery path.

### 7. Alerting and watchlists have APIs but no product surface (medium impact, low effort)

`/api/alerts/rules`, `/api/alerts/dispatch` and `/api/portfolio/holdings` exist. Legacy views exist but are not in the primary navigation. No user can act on an insight without leaving the product.

### 8. Images absent from the product views (low/medium impact, medium effort)

Spec goal 1 mentions images and the app has a media store, but no product view renders card images. Visual verification of identity is a real intelligence input for trading cards.

## Suggested order

1. Finish the web-harvest work already running.
2. Close gap 1 (one source of truth) — otherwise new data increases inconsistency.
3. Close gap 2 (outcomes → scoring → learning) — this is what turns a report into an intelligence system.
4. Close gaps 3, 6, 7 as small hardening/product wins.
5. Then identity resolution and images.

## Anti-goals

Do not add more data sources before gap 1. Do not let a model promote a candidate to canonical storage. Do not expose databases or admin endpoints publicly. No new public listeners without approval.
