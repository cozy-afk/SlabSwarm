# UI Contract Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the shipped Market Intelligence and Price/Comps views work against the live API instead of showing contract and path errors.

**Architecture:** Three independent repairs: unify intelligence responses on the `{ data, meta }` envelope the UI already consumes; resolve the legacy snapshot path relative to the data directory so it works inside Docker; let the serving API resolve catalog ids that come from the ingest ledger rather than only the legacy graph snapshot. No listener, firewall, DNS or credential changes.

**Tech Stack:** TypeScript, Express, existing React UI, Node test runner (`tsx --test`).

**Spec:** `docs/superpowers/specs/2026-11-22-data-product-design.md` — approved. This plan repairs defects found in live UI verification, recorded at `docs/benchmarks/2026-11-22-industry-launch.md`.

## Global Constraints

- Every product endpoint returns `{ data, meta }` with `requestId`, `generatedAt`, `contractVersion`, `correctionPolicy` and `warnings` in `meta`.
- Basis explicit; missing values stay `UNKNOWN`; no invented prices or synthetic catalog facts.
- Catalog facts derived from evidence must carry provenance and lower identity confidence than a resolved graph asset.
- No secret values in responses, logs, docs or client code.
- No new public listener, firewall or DNS change. Use `sudo -n docker` for Docker.

## Review Focus

- UI still seeing `ok`/`findings` only: envelope must be present alongside any legacy fields. Test with a live HTTP assertion.
- Container path vs host path: legacy snapshot resolution must derive from `SLABGRAPH_DATA_DIR` or cwd, never a hardcoded `/opt/slabswarm/...`. Test both paths.
- `tcg:719440` returning 404 from pricing/comps/market while the report cites it: the serving resolver must fall back to ledger-derived catalog identity. Test that exact id.

---

### Task 1: Intelligence envelope and legacy path

**Files:** `server/analytics/routes.ts`, `server/ingest/adapters/legacy.ts`, `server/ingest/routes.ts`, `server/db/routes.ts`, corresponding tests under `tests/analytics/`, `tests/ingestion/`, `tests/db/`.

- [ ] **Step 1:** Write failing tests asserting `GET /api/intelligence/findings` and `POST /api/intelligence/discovery-sweep` return `{ data, meta }` with the five meta fields, while existing `ok`/`findings` fields remain for compatibility.
- [ ] **Step 2:** Replace `DEFAULT_LEGACY_DB` with a resolver based on `SLABGRAPH_DATA_DIR` or `./data`, and fix the other hardcoded `/opt/slabswarm/data` path in `server/db/routes.ts`. Test both a temp data dir and the default.
- [ ] **Step 3:** Implement, run lane tests plus `tsc --noEmit`, commit.

### Task 2: Ledger-backed catalog resolution

**Files:** `server/serving/catalog.ts`, `server/serving/routes.ts`, `server/serving/market.ts`, `tests/serving/`.

- [ ] **Step 1:** Write failing tests for `/api/pricing/tcg:719440`, `/api/comps/tcg:719440`, `/api/market/tcg:719440` against a fixture ledger containing that id. Assert 200, `{ data, meta }`, provenance and basis preserved.
- [ ] **Step 2:** Add a fallback catalog resolver that derives identity facets from evidence `parsedPayload` (`name`, `gameName`, `expansionName`) when the graph snapshot has no matching asset. Mark identity confidence `LOW` and provenance as ledger-derived. Never invent a price or a set.
- [ ] **Step 3:** Implement, run lane tests plus `tsc --noEmit`, commit.

### Task 3: UI target selection

**Files:** `src/components/product/MarketIntelligenceView.tsx`, `tests/ui/`.

- [ ] **Step 1:** Write a failing source-contract test: the view offers a selectable list of card ids sourced from the active report or catalog search, instead of requiring manual id entry; selection loads pricing, comps and market; errors stay plain text.
- [ ] **Step 2:** Implement the picker without new credentials or client-side data invention.
- [ ] **Step 3:** Run tests plus `tsc --noEmit`, commit.

### Task 4: Integration and live verification

- [ ] Merge all three lanes; run the full 51-file suite and typecheck.
- [ ] Rebuild the existing container, verify through internal HTTP that all UI-called endpoints return `{ data, meta }`, that harvest-legacy succeeds against `/app/data/slabgraph-db.json`, and that `tcg:719440` returns 200 from pricing/comps/market.
- [ ] Verify the public gate still redirects and record results in `docs/benchmarks/2026-11-22-ui-contract-repair.md`.
