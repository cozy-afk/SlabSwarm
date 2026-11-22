# Observation Promotion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Promote deterministic, evidence-backed ingest candidates into canonical market observations so the active-report endpoint returns real industry insight instead of an empty report.

**Architecture:** A promotion service reads candidates from the durable ingest ledger, admits only those with a finite amount and an explicit non-UNKNOWN basis, preserves source/currency/timestamps/lineage/confidence verbatim, and writes idempotent observations through the ingest repository. It is called by the seed CLI after harvest and exposed as an operator route for reruns. No LLM, no simulation, no price invention.

**Tech Stack:** TypeScript, Node test runner (`tsx --test`), existing `IngestRepositories` and `MarketObservation` contracts.

**Spec:** `docs/superpowers/specs/2026-11-22-data-product-design.md` — approved. This plan implements its identity/observation and provenance requirements that the first two plans left unwired.

## Global Constraints

- Raw evidence immutable. Corrections append.
- Basis explicit: SOLD/ASKING/OFFER/GUIDE/CLAIM/POPULATION/UNKNOWN.
- A candidate with null/non-finite amount, basis UNKNOWN or parseStatus FAILED is never promoted.
- Missing shipping/fees/FX/grade/condition stays UNKNOWN, never zero.
- Preserve source, observed_at, captured_at, lineage, confidence and currency verbatim.
- No currency conversion and no cross-source aggregation.
- Deterministic code only. No model writes canonical facts.
- Keep Hermes tool IDs stable. No new public listeners, firewall or DNS changes.
- Use `sudo -n docker` for Docker.

## Review Focus

- A GUIDE price being relabelled SOLD, or a USD value converted: promotion must preserve basis and currency. Test with a GUIDE/USD candidate.
- A null amount becoming zero, or a failed-parse candidate being promoted: both must be skipped. Test explicitly.
- Rerunning promotion duplicating observations: idempotency on evidenceId + targetIdentityRef + basis must hold. Test twice.
- Identity names missing from the report: promotion must keep targetIdentityRef so the report can resolve catalog names. Test the ref is unchanged.

---

### Task 1: Deterministic candidate promotion

**Files:**
- Create: `server/ingest/promotion.ts`
- Create: `tests/ingestion/promotion.test.ts`
- Modify: `scripts/seed-market.ts`
- Modify: `server/ingest/routes.ts`

**Interfaces:**
- Consumes: `IngestRepositories` from `server/ingest/store.ts`; `IngestCandidate` and `MarketObservation` from `server/contracts/dataProduct.ts`.
- Produces: `promoteCandidates(repos: IngestRepositories, options?: { now?: Date }): Promise<PromotionResult>` with fields `candidatesSeen`, `promoted`, `skipped`, `duplicates`, `errors: string[]` and no secret values.

- [ ] **Step 1: Write failing tests**

Cases: GUIDE candidate with finite amount is promoted with basis GUIDE, currency USD, original observedAt/capturedAt, lineage and confidence intact; null amount is skipped; basis UNKNOWN is skipped; parseStatus FAILED is skipped; calling twice promotes once and reports duplicates; targetIdentityRef is unchanged; no errors contain the TCGAPI key.

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx --test tests/ingestion/promotion.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement promotion**

Use the existing `repos.observations` repository. Idempotency key is evidenceId + targetIdentityRef + basis. Set status NORMALIZED only when all provenance fields are present; otherwise RAW. Append to lineage, never overwrite. Do not create evidence — candidates already reference it.

- [ ] **Step 4: Add the operator route and seed integration**

Mount `POST /api/ingest/promote` in `server/ingest/routes.ts`, returning the promotion result. Call `promoteCandidates` from `scripts/seed-market.ts` after harvest and include `promotion` counts in the printed JSON (counts only, no key or payload).

- [ ] **Step 5: Verify**

Run: `npx tsx --test tests/ingestion/promotion.test.ts && npx tsc --noEmit && npm test`
Expected: promotion tests pass, typecheck exit 0, full suite 0 failures.

- [ ] **Step 6: Commit**

```bash
git add server/ingest/promotion.ts server/ingest/routes.ts scripts/seed-market.ts tests/ingestion/promotion.test.ts
git commit -m "feat: promote priced candidates into canonical observations"
```

### Task 2: Live verification and insight report

**Files:**
- Create: `docs/benchmarks/2026-11-22-observation-promotion.md`

- [ ] **Step 1:** Rebuild only the app image (`sudo -n docker compose up -d --build slabswarm`), restart it, then run the seed CLI so harvest and promotion share the persisted ledger.
- [ ] **Step 2:** With the existing bridge-token auth, verify `/api/evidence` > 0, `/api/ingest/runs` shows COMPLETED, `/api/intelligence/active-report` returns at least one card with basis, currency, evidence refs and non-empty drivers, and `/api/intelligence/forecast-from-report` returns deterministic drafts with 7/30/90 horizons.
- [ ] **Step 3:** Verify the public gate URL still redirects and the UI route renders without placeholders.
- [ ] **Step 4:** Record counts, credit spend, curl statuses and any 403 in the benchmark document and commit it.
