# Phase 5 — Productization and Hardening

**Spec:** `docs/superpowers/specs/2026-11-22-data-product-design.md`

**Depends on:** Phases 1–4.

**Goal:** Serve the product through API and UI, harden it, deploy it.

## Global Constraints

- No new public listeners without explicit owner approval.
- Keep shared gate and internal binds.
- Credentials server-side only.
- No model writes canonical facts directly.
- Tests/benchmarks before deploy.

## Task 1: Serving API

- [ ] Add `/api/catalog/search`, `/api/catalog/:id`, `/api/pricing/:id`, `/api/comps/:id`, `/api/market/:id`.
- [ ] Use `{ data, meta }` envelopes and provenance fields.
- [ ] Add OpenAPI 3.1 document.
- [ ] Add contract tests.

## Task 2: UI productization

- [ ] Replace primary nav with Sources, Catalog, Market Intelligence, Research Swarm, Forecast Lab, Learning, SQL Lab, API/Hermes.
- [ ] Remove generic swarm stub and onboarding/blueprint novelty screens from primary navigation.
- [ ] Build Sources, Findings, Forecast Report, SQL Lab views.
- [ ] Add UI tests or source-contract tests.

## Task 3: Operational hardening

- [ ] Add memory limits for all new containers.
- [ ] Add backup script for Postgres, Parquet lake, and encrypted LLM settings.
- [ ] Add restore drill.
- [ ] Add audit logs for canonical writes.
- [ ] Review broad internal listeners. No firewall changes without approval.

## Task 4: Deployment

- [ ] Rebuild Slabswarm image from merged branch.
- [ ] Verify health, DB status, public gate redirect, Hermes tools, ingestion run, discovery sweep, forecast run.
- [ ] Run full tests and benchmarks.
- [ ] Record deployment results.
