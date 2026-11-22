# Phase 2 — Ingestion Layer

**Spec:** `docs/superpowers/specs/2026-11-22-data-product-design.md`

**Depends on:** Phase 1 repository interfaces.

**Goal:** Immutable evidence ledger, ingest runs, and source adapters.

## Global Constraints

- Raw evidence immutable. Corrections append.
- Basis explicit and never inferred as SOLD by default.
- Missing values stay UNKNOWN.
- Source keys server-side. Never print secrets.
- Adapters emit evidence and candidate observations only.
- No model writes canonical facts directly.

## Task 1: Evidence and ingest-run APIs

- [ ] Add repositories and services for evidence records and ingest runs.
- [ ] Add `GET /api/evidence`, `GET /api/evidence/:id`, `GET /api/ingest/runs`, `GET /api/ingest/runs/:id`.
- [ ] Add tests for create/list/get and idempotency by source + native id + checksum.

## Task 2: Adapter registry and runner

- [ ] Create `server/ingest/types.ts`, `registry.ts`, `runner.ts`, `normalizer.ts`.
- [ ] Implement cursor/watermark handling and error capture.
- [ ] Add tests for backfill vs forward mode and duplicate handling.

## Task 3: Legacy graph adapter

- [ ] Convert existing 19 assets and 21 sales into evidence and candidate observations.
- [ ] Idempotent by stable source key.
- [ ] No legacy mutation.
- [ ] Add `POST /api/intelligence/harvest-legacy`.
- [ ] Add tests.

## Task 4: CSV and manual note adapters

- [ ] CSV import with column mapping and preview.
- [ ] Manual note ingestion with URL/date/source fields.
- [ ] Add `POST /api/ingest/csv` and `POST /api/ingest/manual`.
- [ ] Add tests for malformed rows and unknown values.

## Task 5: TCGAPIs adapter behind env flag

- [ ] Implement adapter using `TCGAPI_KEY` server-side.
- [ ] Add `TCGAPI_ENABLED` flag. Disabled by default.
- [ ] No calls when disabled.
- [ ] Add live verification script that checks key by status only, never by printing it.
- [ ] Add tests with mocked HTTP.

## Task 6: Ingestion benchmarks

- [ ] Add benchmark suite for duplicate rate, parse success, and run latency.
- [ ] Document results.
