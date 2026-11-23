# First-Party Catalog Backfill — Verification Record

Date: 2026-11-23 (UTC). Owner correction: TCGAPIs is a structural reference for the database and API, not the data source. Slabswarm is meant to be our own first-party trading-card API service.

## What was wrong

The 39 TCGAPIs-derived cards were an artifact of using a reference API as the catalog source. They were never the owner's catalog. The first-party import path (`scripts/backfill-json.ts`) existed but had never been run.

## Latent defects fixed to make the first-party import work

1. Repository upserts on `market_observations` targeted a four-column key with no unique constraint. Added migration `0003_observation_upsert_uq.sql`.
2. The SQL adapter passed plain strings and arrays straight to JSONB columns. Plain strings were parsed as raw JSON (error when not JSON); arrays became Postgres array literals. Both are now serialized explicitly in `toDb`.

## Backfill result

Command: `npx tsx scripts/backfill-json.ts /app/data/slabgraph-db.json`, run inside the container.

- Migrations: 0001, 0002, 0003 skipped as already applied.
- Source counts: 19 assets, 21 sales, 19 sets, 1 research source, 6 research notes.
- Imported: 19 cards, 19 sets, 22 evidence records, 21 market observations, 19 valuations, 6 research notes.
- Skipped 0, invalid 0, parity true. Source JSON byte-identical before and after.

## Database state after backfill

- cards 58 total: 19 first-party (`TCG-POK-*`, `TCG-ONE-*` etc.) and 39 external-reference (`tcg:*`) rows.
- evidence_records 169, market_observations 72, sets 19, valuations 19, research_notes 6.
- `/api/db/status` reports `CURRENT` with migrations 0001–0003 applied.

## Verification

- 355 tests across 51 files pass, 0 fail. Typecheck exit 0, compose config exit 0.
- Backfill re-run is safe: upserts use unique keys and the JSON source is read-only.

## Open question for the owner

The 19 first-party cards are the entire dataset in the existing snapshot. "All cards" for our own service requires a first-party catalog source the owner chooses — their own CSV/JSON export, manual entry, or another source they control. The 39 TCGAPIs rows remain as clearly prefixed external reference data; no decision has been made about removing them.
