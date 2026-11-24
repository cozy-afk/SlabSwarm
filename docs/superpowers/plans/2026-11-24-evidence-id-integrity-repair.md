# Evidence ID Integrity Repair Plan — 2026-11-24

Status: active. Triggered by audit finding A-01 (Critical) from `deleg_5cdfca0b`.

Authority: `/opt/slabswarm/docs/PRODUCT_GOAL.md` Active execution goal and hard rules. Every fact must carry a resolvable source and immutable evidence. No invented fact may be used to make a metric look healthy.

## Verified defect

- `market_observations`: 240 of 261 rows have `evidence_id` absent from `evidence_records.id`.
- `GET /api/intelligence/active-report`: 92 of 96 cited evidence IDs are unresolvable.
- Root cause traced: the JSON ingest ledger stores evidence IDs as `ev-<uuid>` (example `ev-2beb9ebc-9547-46ea-b8ae-4baa1b5d07b1`, source `tcgapis`, sourceRecordId `tcg:price:530626:0:lowPrice`). Postgres sync stores the same evidence as a bare UUID (example `80d120a3-ba1b-4b39-b0e6-e48294508453`). Canonical promotion copies the ledger-side ID into `market_observations.evidence_id` instead of the Postgres row ID. Identity code at `server/identity/resolver.ts:175-176` and the promotion report at `server/ingest/promotion.ts:450-451` also use synthetic source-scoped IDs.
- A-01 is not closed until both new promotions and all existing rows resolve.

## Scope and rulings

1. Fix at the persistence boundary: map ledger evidence IDs to canonical Postgres evidence IDs before writing observations and report evidence refs.
2. Do not change identity keys or aliases as part of this repair unless a failing test proves it is required. This task is about referential integrity, not identity redesign.
3. Repair existing rows with an idempotent backfill keyed by source plus sourceRecordId, or another exact provenance match. Never guess. Rows that cannot be matched exactly must remain visible in a failure report.
4. Append-only evidence rules remain. No DELETE, TRUNCATE or rewrite of raw evidence payloads.
5. No deployment, firewall, DNS, credential or public-exposure changes in the lane. Controller owns deploy and DB repair execution if the repair is a script rather than code.
6. Test first. Add a failing test for observation-to-evidence resolution through the real application factory or production-shaped repository path. Watch it fail, then implement the minimal fix.

## Task R1 — evidence ID integrity

Deliverables:
- Failing-first regression test proving a promoted observation's `evidence_id` resolves in `evidence_records`.
- Failing-first test proving active report evidence refs resolve before emission, or that unresolved refs are explicitly rejected rather than presented as evidence-backed.
- Minimal code fix at the sync/promotion boundary.
- Idempotent repair script or migration for the 240 existing orphan rows, with exact-match accounting.
- Report file at `/home/hermes/.hermes/cache/scratch/dp-population/evidence-repair.json`.

Acceptance:
- All 261 observation evidence IDs resolve after repair.
- Active report cited evidence IDs all resolve, or unresolved IDs are excluded with an explicit warning.
- Lane tests and typecheck green. Controller runs the full suite once after merge.

## Later tasks, not in R1

- R2: JSON ingest ledger performance and Postgres sole-source migration (A-02).
- R3: catalog/identity join and human-readable report cards (A-03).
- R4: licence, trust and confidence metadata gaps (A-04).
- R5: lake manifest, forecast, scoring and learning gaps (A-05).
