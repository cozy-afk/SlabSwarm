# Postgres Catalog Sync — Verification Record

Date: 2026-11-22 (UTC). Triggered by the owner's report that Slabswarm "doesn't create a database with all the cards".

## Root cause

The rebuilt app wrote ingestion output to a durable JSON ledger (`data/ingest-store.json`) only. Postgres had the Drizzle schema and migrations but no rows. `/api/db/status` reported `CURRENT` migrations with every table at zero, which made the app look healthy while the canonical database was empty.

Debugging also found two latent SQL-store defects that blocked a correct sync:

1. `findAll` used `property in Map` instead of `Map.has()`, so every filter was silently dropped. `list({ identityKey: 'x' })` returned all rows.
2. Reused `createdAt`/`capturedAt` values from node-postgres came back as JS `Date` objects; stringifying them produced `Mon Nov 23 2026 ...`, which Postgres rejects as a timestamp.

## Changes

- `server/db/sync.ts` + `scripts/sync-postgres.ts`: idempotent create-if-absent projection of the JSON ledger into `evidence_records`, `cards` and `market_observations`. Card identity is derived only from evidence `parsedPayload` (`name`, `gameName`, `expansionName`) and marked LOW-confidence ledger provenance. No invented cards or prices.
- `server/db/repositories/dates.ts`: normalizes reused timestamps to ISO strings; applied in card, evidence and market-observation repositories.
- `server/db/store.ts`: `Map.has()` fix and explicit filter tests.
- `server/serving/catalog.ts`: deterministic catalog-evidence selection so catalog identity does not randomly pick a sale record over the catalog record.
- Regression tests at `tests/db/sync-ledger.test.ts` and `tests/db/store-filters.test.ts`.

## Verification

- Full 51-file suite: **353 tests, 353 pass, 0 fail**. Typecheck exit 0, compose config exit 0.
- Sync inside container: `{"evidence":147,"cards":39,"observations":51,"errors":0}` — twice, with identical counts (idempotent).
- Postgres actual `count(*)`: evidence_records 147, cards 39, market_observations 51.
- `/api/db/status` now reports `state: CURRENT`, evidence 147, cards 39.
- Report, catalog search and pricing endpoints all 200 with `{ data, meta }`; public gate still 302.
- One debug row created during diagnosis was removed; no other canonical data was deleted.

## Limit

39 cards is the whole catalog our exhausted TCGAPIs trial could fetch, not a full trading-card catalog. A complete catalog needs a paid TCGAPIs plan or credits and a decision on which games to cover. This is an input issue, not a code defect.
