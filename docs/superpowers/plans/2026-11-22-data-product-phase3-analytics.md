# Phase 3 — Analytics and Discovery

**Spec:** `docs/superpowers/specs/2026-11-22-data-product-design.md`

**Depends on:** Phase 1 Postgres repositories and Phase 2 evidence/observation tables.

**Goal:** Parquet lake, DuckDB analysis, discovery sweeps, SQL Lab.

## Global Constraints

- Analytical outputs are derived and rebuildable.
- No derived fact becomes canonical without a benchmark gate.
- Basis-safe comps only.
- No invented prices.
- SQL Lab is read-only.

## Task 1: Parquet export service

- [ ] Export evidence, market observations, identities, events, forecasts, and scores to Parquet under `data/lake`.
- [ ] Partition by game/source/observed_date where fields exist.
- [ ] Add `POST /api/admin/export-parquet`.
- [ ] Add completeness tests.

## Task 2: DuckDB query service

- [ ] Add `@duckdb/node-api`.
- [ ] Create `server/analytics/duckdb.ts` with read-only query helper.
- [ ] Add allow-listed query templates.
- [ ] Add tests for query execution and rejection of writes.

## Task 3: Discovery sweep

- [ ] Implement active cards by observation count and recency.
- [ ] Momentum by 7/30/90 windows where history exists.
- [ ] Basis-safe comps and anomaly flags.
- [ ] Write findings as research observations/notes.
- [ ] Add `POST /api/intelligence/discovery-sweep` and `GET /api/intelligence/findings`.

## Task 4: SQL Lab

- [ ] Add `GET /api/sql/queries` built-in query list.
- [ ] Add `POST /api/sql/query` read-only.
- [ ] Add saved query repository.
- [ ] Add tests for write rejection and result shape.

## Task 5: Analytics benchmarks

- [ ] Query latency, comps correctness, export completeness, basis preservation.
- [ ] Document results.
