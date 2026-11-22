# Phase 1 — Data Product Foundation

**Spec:** `docs/superpowers/specs/2026-11-22-data-product-design.md`

**Goal:** Replace JSON as canonical storage with PostgreSQL 17, typed schema/migrations, repositories, and a verified JSON backfill.

**Ownership:** one implementer at a time in an isolated worktree. No parallel writes to the same branch.

## Global Constraints

- Raw evidence immutable. Corrections append.
- Basis explicit. Missing values are UNKNOWN, never zero.
- Preserve JSON. No destructive rewrite.
- Do not expose Postgres. Bind to internal Docker network only.
- Keep Hermes tool IDs stable.
- Tests before code. Full suite and lint before commit.

## Task 1: Dependencies and Postgres service

- [ ] Add `pg`, `drizzle-orm`, `dotenv`, `@types/pg`, `drizzle-kit` to package.json with pinned versions.
- [ ] Add `db:generate`, `db:migrate`, `db:studio` scripts.
- [ ] Add `slabswarm-db` Postgres 17 service to docker-compose.yml with named volume, healthcheck, `unless-stopped`, 1 GB memory limit, internal network only.
- [ ] Add non-secret keys to `.env.example`: `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PORT`, `DATABASE_URL`.
- [ ] Write tests asserting compose parses and required keys exist in `.env.example`.

## Task 2: Schema and migrations

- [ ] Create `server/db/schema.ts` with Drizzle tables for all core collections from the spec.
- [ ] Use JSONB for raw payloads and flexible facets; use timestamps for observed_at/captured_at.
- [ ] Add indexes on source_record_id, target_identity_id, observed_at, basis, status.
- [ ] Add `server/db/migrate.ts`.
- [ ] Add migration test using a temporary schema or mocked client to verify migration runner records once.

## Task 3: Repository layer

- [ ] Create `server/db/client.ts` with pooled Postgres client.
- [ ] Create repositories: evidence, marketObservation, card, forecast, learning, jobs.
- [ ] Provide typed create/get/list/upsert operations.
- [ ] Add tests for repository behavior against a test schema or in-memory fake.

## Task 4: JSON backfill

- [ ] Create `scripts/backfill-json.ts`.
- [ ] Import assets, sales, valuations, research sources, research notes, and market observations from `slabgraph-db.json`.
- [ ] Produce a parity report with counts and skipped/invalid records.
- [ ] Never mutate source JSON.
- [ ] Add test with a fixture JSON file.

## Task 5: Health and compatibility endpoints

- [ ] Add `GET /api/db/status` reporting migration state and table counts.
- [ ] Add `POST /api/admin/backfill-json` behind operator auth.
- [ ] Keep all existing endpoints unchanged.
- [ ] Add route tests.

## Task 6: Benchmarks and verification

- [ ] Add `tests/benchmarks/foundation.test.ts` for backfill parity and repository query latency.
- [ ] Run full test suite, lint, and docker compose config.
- [ ] Document results in `docs/benchmarks/2026-11-22-foundation.md`.
