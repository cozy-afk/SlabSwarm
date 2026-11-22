# Slabswarm Data Product Master Plan

**Spec:** `docs/superpowers/specs/2026-11-22-data-product-design.md`

This master plan sequences the rebuild. Each phase has its own executable plan.

## Phase 1 — Foundation

Plan: `docs/superpowers/plans/2026-11-22-data-product-phase1-foundation.md`

Goal: PostgreSQL, migrations, repositories, JSON backfill, parity tests.

## Phase 2 — Ingestion

Plan: `docs/superpowers/plans/2026-11-22-data-product-phase2-ingestion.md`

Goal: evidence ledger, ingest runs, adapters for legacy graph, CSV, manual notes, TCGAPIs.

## Phase 3 — Analytics

Plan: `docs/superpowers/plans/2026-11-22-data-product-phase3-analytics.md`

Goal: Parquet export, DuckDB query service, discovery sweeps, SQL Lab.

## Phase 4 — Intelligence

Plan: `docs/superpowers/plans/2026-11-22-data-product-phase4-intelligence.md`

Goal: swarm v2, simulation, forecasts, scoring, backtests, learning loop.

## Phase 5 — Productization

Plan: `docs/superpowers/plans/2026-11-22-data-product-phase5-productization.md`

Goal: serving API, UI views, hardening, deployment.

## Global Constraints

- Raw evidence immutable. Corrections append.
- Simulations are hypotheses, never sales evidence.
- Basis explicit: SOLD/ASKING/OFFER/GUIDE/CLAIM/POPULATION/UNKNOWN.
- Missing shipping/fees/FX/grade/condition is UNKNOWN, not zero.
- Every fact carries source, observed_at, captured_at, lineage, confidence.
- Deterministic code computes valuations and scores. LLMs propose, explain, challenge.
- No model writes canonical facts directly.
- Every forecast is scored against real outcomes.
- Learning promotes only through benchmark gates.
- Keep Hermes tool IDs stable.
- No new public listeners without explicit owner approval.
- Use `sudo -n docker` for all Docker operations.
- Do not expose databases or admin endpoints publicly.
