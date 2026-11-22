# Foundation benchmarks — 2026-11-22

**Lane:** `dp-foundation` (Phase 1 — Data Product Foundation)
**Worktree:** `/opt/slabswarm/.superpowers/sdd/dp-foundation`
**Spec:** `docs/superpowers/specs/2026-11-22-data-product-design.md`
**Plan:** `docs/superpowers/plans/2026-11-22-data-product-phase1-foundation.md`

## Status

DONE — all six Phase 1 tasks implemented and verified in the lane worktree.
No files in `server.ts`, `src/**`, or the other lanes' `server/{ingest,analytics,swarm,simulation,forecast}/` directories were modified.

## Verification commands and real output

### Lane tests

```
$ npx tsx --test tests/db/*.test.ts
# 35 tests, 35 pass, 0 fail (duration_ms ~5244)
```

Pass breakdown by file: `backfill` 5, `config` 5, `migrate` 5, `repositories` 10,
`routes` 6, `schema` 3. No skips, cancellations or todos.

### Benchmarks

```
$ npx tsx --test tests/benchmarks/foundation.test.ts
# fixture_backfill_ms=17.97 bytes=2674 invalid=2
# real_backfill_ms=10.46 bytes=51856 assets=19 sales=21 researchNotes=6 invalid=0 imported={"sets":19,"cards":19,"evidence_records":22,"market_observations":21,"valuations":19,"research_notes":6}
# repo_list_seed_ms=26.61 p50_ms=4.802 p95_ms=5.954 samples=200
ℹ tests 3
ℹ pass 3
ℹ fail 0
```

Budgets asserted in code: fixture backfill < 2000 ms, real backfill < 10 000 ms,
in-memory repository `list()` p95 < 100 ms over 1000 rows / 200 samples. All passed.

### Typecheck

```
$ npx tsc --noEmit
(no output)
exit 0
```

### Compose validation

```
$ printf 'POSTGRES_PASSWORD=validation-placeholder\n' > .env
$ sudo -n docker compose -f docker-compose.yml config -q
(no output)
exit 0
$ rm -f .env
```

A temporary, gitignored `.env` with a **non-secret placeholder** is required because
`POSTGRES_PASSWORD` is interpolated with `${POSTGRES_PASSWORD:?...}`; it was removed
immediately after validation. No real credential value was read, printed or written.

### Additional smoke checks

- `npx drizzle-kit generate --config <scratch config pointing at server/db/schema.ts>` →
  detected **27 tables** and produced a migration in a scratch directory (nothing written
  into the checked-in `server/db/migrations/`).
- `DATABASE_URL=postgresql://probe:***@127.0.0.1:1/probe npm run db:migrate` →
  CLI entry point fires and reports `Migration failed: connect ECONNREFUSED 127.0.0.1:1`
  (expected: no database running in the lane).

## What was built

1. **Dependencies/scripts** — `pg`, `drizzle-orm`, `dotenv`, `@types/pg`, `drizzle-kit`
   pinned exactly; `db:generate`, `db:migrate`, `db:studio`, `db:backfill` scripts.
   `server/db/drizzle.config.ts` makes the Drizzle scripts functional.
2. **Postgres 17 service** — `slabswarm-db` on internal-only `slabswarm-internal` network,
   named volume, `pg_isready` healthcheck, `unless-stopped`, 1 GB memory limit, no host ports.
3. **Schema/migrations** — Drizzle schema for all 25 core collections plus `valuations`
   and `__schema_migrations`; two checked-in SQL migrations and an idempotent, checksummed
   runner that records each migration in the same transaction as the DDL.
4. **Repositories** — pooled lazy client (`server/db/client.ts`), camelCase↔snake_case store
   adapter with SQL and in-memory implementations, typed evidence/marketObservation/card/
   forecast/learning/jobs repositories with validation (explicit basis; missing values stay
   UNKNOWN; evidence raw fields immutable on upsert).
5. **JSON backfill** — `scripts/backfill-json.ts` imports sets, assets→cards, sales→
   evidence+market observations, valuations (including asset grade populations), research
   sources→evidence, research notes, and native market observations. The source is read
   only, checksummed before/after on disk, never mutated. Parity report carries source,
   processed, skipped, invalid-with-reasons, per-table imported counts and a boolean parity.
   Re-running is idempotent via upserts.
6. **Routes** — `server/db/routes.ts` exports `createDbRouter(options)` and
   `mountDbRoutes(app, options)`. `GET /api/db/status` (200 current / 503 pending) reports
   migration state and per-table counts; `POST /api/admin/backfill-json` fails closed with
   403 unless an operator-auth middleware is injected, then returns the parity report
   (200 parity, 206 mismatch).

## Integrator interface details

- In `server.ts` (integrator-owned), wire:
  `import { mountDbRoutes } from './server/db/routes.ts';`
  `mountDbRoutes(app, { requireAuth: auth.requireAuth });`
  Do **not** import the CLI `main()` from `scripts/backfill-json.ts`.
- `GET /api/db/status` is open by design as a health endpoint; wrap it with your auth
  middleware if counts must be private. `POST /api/admin/backfill-json` never opens without
  an injected `requireAuth` (opt-out `allowUnauthenticatedBackfill: true` exists only for
  local tooling — do not enable in production).
- No `listen()` call, new port, or new public listener is introduced by this lane.
- Before backfill, run `npm run db:migrate` (or `mountDbRoutes` will report pending state).
  Optionally set `SLABGRAPH_DB_PATH` to override the default
  `/opt/slabswarm/data/slabgraph-db.json`.
- `RepositoryBundle` in `server/contracts/dataProduct.ts` was consumed verbatim, not edited.

## Concerns

- The real snapshot contains one `QUARANTINED` sale with `priceUsd: 0`. It is imported as a
  real source value with `status: CONTESTED` and basis `SOLD`; a literal zero in the source
  is preserved, never invented as a default for missing shipping/fees/FX/grade/condition.
- The fixture's `marketObservations[0]` duplicates `sales[0]` (same evidence, target, basis
  and observed time), so it dedupes onto the same row: 2 distinct observation rows for
  3 observation writes. `imported.market_observations` counts writes, not distinct rows.
- No live Postgres integration test was run in the lane (no database container started);
  repository and migration behavior is verified against the in-memory store that shares
  the `DbStore` contract. Full-suite/DB integration runs at integration.
- `POSTGRES_PASSWORD` must be provided in the server's private `.env` at deploy time;
  `.env.example` contains only non-secret keys and a `***` placeholder in the DSN.
