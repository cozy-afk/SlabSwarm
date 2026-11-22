# Slabswarm Data Product Design

Status: approved for implementation

## Intent

Slabswarm becomes a first-party trading-card data product: collect card data, normalize it into evidence and observations, resolve identity, build a knowledge graph, run our own agentic swarm, simulate scenarios, forecast price/demand/supply, score forecasts against outcomes, and learn patterns from measured results.

MiroFish is inspiration only. No MiroFish code or runtime dependency is used.

## Goals

1. Ingest historical and forward data: sales, listings, prices, events, public mentions, catalog metadata, images, manual notes, CSV.
2. Store raw evidence immutably with source, timestamps, checksum, license, and lineage.
3. Normalize to first-party entities and market observations with explicit basis and price components.
4. Resolve card identity deterministically before swarm adjudication.
5. Provide catalog/search/pricing/comps/market/research/forecast/learning APIs.
6. Run bounded, evidence-first swarm roles that propose but never write canonical facts.
7. Simulate scenarios with personas and world models; output price bands, drivers, invalidators, confidence.
8. Score forecasts at 7/30/90 days and learn source trust, factor weights, calibration, and rules.
9. Productize UI around Sources, Catalog, Intelligence, Research, Forecast Lab, Learning, and SQL Lab.

## Non-goals

- No MiroFish runtime.
- No Neo4j, MongoDB, Kafka, Temporal, MinIO, Redis queue.
- No ClickHouse now.
- No public admin/database exposure.
- No LLM-only price answers.
- No model writes directly to canonical storage.

## Non-negotiable rules

- Raw evidence immutable. Corrections append.
- Simulations are hypotheses, never sales evidence.
- Basis is explicit: SOLD/ASKING/OFFER/GUIDE/CLAIM/POPULATION/UNKNOWN.
- Missing shipping/fees/FX/grade/condition stays UNKNOWN, not zero.
- Every fact carries source, observed_at, captured_at, lineage, confidence.
- Deterministic code computes valuations and scores; LLMs propose, explain, challenge.
- Every forecast is scored against real outcomes.
- Learning promotes only through benchmark gates.
- Keep Hermes tool IDs stable: get_collectible_valuation, scan_arbitrage_spreads, query_knowledge_graph, ingest_market_listing.

## Stack

- Node 18+/TypeScript/Express app stays.
- PostgreSQL 17 dedicated container: canonical source of truth.
- Parquet lake under `/opt/slabswarm/data/lake`: durable analytical dataset.
- DuckDB via `@duckdb/node-api` on ARM64: analysis/backtests/SQL Lab.
- JSON file becomes import/export/backup artifact only.
- Drizzle ORM for typed schema and migrations.
- Postgres-backed job table. No Redis.

## Architecture

```text
adapters -> evidence_records/raw_payloads (Postgres)
         -> parser/normalizer -> candidate observations
         -> identity resolver -> canonical entities + market_observations
         -> Parquet export -> DuckDB analysis
         -> findings/forecasts -> Postgres
         -> outcomes -> forecast_scores -> learning_events/rule_versions
```

## Core collections

`evidence_records`, `raw_payloads`, `ingest_runs`, `market_observations`, `games`, `sets`, `cards`, `printings`, `instances`, `entities`, `events`, `identity_decisions`, `aliases`, `crosswalks`, `factors`, `factor_scores`, `forecasts`, `forecast_scores`, `simulation_runs`, `swarm_runs`, `research_notes`, `learning_events`, `source_trust_profiles`, `rule_versions`, `jobs`.

## API groups

- Evidence/ingest: `/api/evidence`, `/api/ingest/*`, `/api/observations`
- Catalog: `/api/catalog/search`, `/api/catalog/:id`, `/api/catalog/:id/printings`
- Market: `/api/pricing/:id`, `/api/comps/:id`, `/api/market/:id`
- Intelligence: `/api/intelligence/harvest-legacy`, `/api/intelligence/discovery-sweep`, `/api/intelligence/findings`
- Swarm: `/api/swarm/research/run`, `/api/swarm/runs/:id`
- Forecast: `/api/forecasts`, `/api/forecasts/:id`, `/api/forecasts/:id/score`, `/api/forecasts/:id/backtest`
- Learning: `/api/learning/state`, `/api/learning/feedback`, `/api/learning/run-cycle`
- SQL Lab: `/api/sql/query`, `/api/sql/saved`

## Success criteria

- One button returns real "what is actively trading" report from evidence.
- Every observation has source, basis, currency, timestamp, lineage.
- Forecast returns price bands, drivers, invalidators, evidence, confidence.
- Forecasts are scored against real outcomes.
- Swarm traces show role claims and evidence.
- Existing Hermes tools still work.
- Tests and benchmarks pass before each deploy.
- UI produces insight, not placeholders.
