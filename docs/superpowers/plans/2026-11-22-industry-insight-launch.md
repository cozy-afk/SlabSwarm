# Industry Insight Launch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the rebuilt Slabswarm pipeline into a working product that harvests real trading-card market data and returns a source-cited report on what is actively trading.

**Architecture:** A credit-bounded TCGAPIs harvest writes immutable evidence through the Phase 2 ingestion adapter. Phase 3 discovery turns that evidence into findings. A new report endpoint composes findings, comps, momentum and anomalies into one `{ data, meta }` response. A single UI view renders that response and offers one refresh action. Phase 4 forecasting scores the report's claims against later observations. Nothing here changes listeners, firewall rules or DNS.

**Tech Stack:** TypeScript, Express, Node test runner (`tsx --test`), Drizzle repositories, DuckDB read-only queries, existing React/Vite UI, TCGAPIs v2 REST (`x-api-key`, server-side only).

**Spec:** `docs/superpowers/specs/2026-11-22-data-product-design.md` — already approved for implementation. This plan covers the spec's unmet success criteria: real "what is actively trading" report, provenance on every observation, forecast scoring, and UI insight rather than placeholders. No new design approval is needed.

## Global Constraints

- Raw evidence immutable. Corrections append.
- Basis explicit: SOLD/ASKING/OFFER/GUIDE/CLAIM/POPULATION/UNKNOWN.
- Missing shipping/fees/FX/grade/condition is UNKNOWN, not zero.
- Every fact carries source, observed_at, captured_at, lineage, confidence.
- TCGAPIs price-guide values carry basis `GUIDE`; sales-history values carry basis `SOLD`. Never relabel one as the other.
- Preserve `source`, `currency` and source timestamp per record. No currency conversion. No summed quotes across sources.
- Deterministic code computes valuations and scores. LLMs propose, explain, challenge.
- No model writes canonical facts directly.
- `TCGAPI_KEY` and `TCGAPI_ENABLED` stay server-side. Never print a key, never put it in a repo, doc, URL or browser bundle.
- Credit spend is bounded by `TCGAPI_HARVEST_CREDIT_BUDGET` (default 60). The harvest stops at the cap and reports spend.
- No live API calls in tests. Mock HTTP with injected fetch.
- No new public listeners, firewall, DNS or database exposure changes.
- Use `sudo -n docker` for all Docker operations.
- Keep Hermes tool IDs stable.

## Review Focus

- A price-guide record labelled SOLD, or a missing currency silently converted: the report must show basis `GUIDE`, preserve original currency and never cross-source sum. Pinned in Task 1's source-fidelity test.
- The harvest overruns free credits or calls the API while disabled: the budget gate must stop before the cap and make zero calls when `TCGAPI_ENABLED` is unset. Pinned in Task 1's budget and disabled-flag tests.
- A rerun duplicates evidence or rewrites a prior record: source + native id + checksum idempotency must hold and the original evidence must remain byte-identical. Pinned in Task 1's idempotency test.
- Empty or stale data rendered as confident insight: the report must return `UNKNOWN` values, show freshness, and label low-evidence cards rather than inventing momentum. Pinned in Task 2's empty-store and staleness tests.
- The UI shows a placeholder or an un-cited number: every displayed figure must carry basis, source and observed_at from the response. Pinned in Task 3's source-contract test.

---

### Task 1: Credit-bounded live harvest into the evidence ledger

**Files:**
- Create: `server/ingest/tcgapis-harvest.ts`
- Create: `scripts/seed-market.ts`
- Create: `tests/ingestion/tcgapis-harvest.test.ts`
- Modify: `.env.example` (non-secret keys `TCGAPI_ENABLED`, `TCGAPI_HARVEST_CREDIT_BUDGET` only)

**Interfaces:**
- Consumes: Phase 2 `EvidenceRepository` and adapter registry from `server/ingest/`; shared types in `server/contracts/dataProduct.ts`.
- Produces: `runTcgapisHarvest(deps: HarvestDeps): Promise<HarvestResult>` where `HarvestResult` has `games`, `expansions`, `cards`, `prices`, `evidenceWritten`, `creditsSpent`, `stoppedAtBudget`, `errors: string[]` — never a key.

- [ ] **Step 1: Write the failing tests first**

Create `tests/ingestion/tcgapis-harvest.test.ts` with cases:
- disabled flag makes zero HTTP calls and returns `creditsSpent: 0`;
- given a budget of 5 and 20 candidate products, the runner stops before exceeding 5 and sets `stoppedAtBudget: true`;
- a `GUIDE` price record keeps `source: 'tcgapis'`, its original `currency`, its source timestamp, and basis `GUIDE`, never `SOLD`;
- two runs over the same payloads write one evidence row per source + native id + checksum, and the first row is byte-identical afterwards;
- an injected HTTP 403 with `TRIAL_CREDITS_USED` ends the run with a safe error string and no retry.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd /opt/slabswarm/.superpowers/sdd/dp-integration && npx tsx --test tests/ingestion/tcgapis-harvest.test.ts`
Expected: FAIL with `Cannot find module .../server/ingest/tcgapis-harvest.ts`.

- [ ] **Step 3: Implement the harvest**

Use the v2 chain: `GET /api/v2/games` (public) → `GET /api/v2/expansions/:categoryId` → `GET /api/v2/cards/:groupId` → `GET /api/v2/prices/:productId`. Header is `x-api-key` from `process.env.TCGAPI_KEY`; injected fetch only. `GET /api/v2/sales-history/:productId` runs only while budget remains and marks basis `SOLD`. Catalog calls cost 1 credit, prices and sales 2. Count credits before each call and stop when the next call would exceed the cap. Emit raw payloads and candidate observations through the Phase 2 adapter; never call a repository directly from the harvest script.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /opt/slabswarm/.superpowers/sdd/dp-integration && npx tsx --test tests/ingestion/tcgapis-harvest.test.ts`
Expected: PASS, 5 tests, 0 failures.

- [ ] **Step 5: Add the CLI seed script**

`scripts/seed-market.ts` calls `runTcgapisHarvest` with process env, prints counts and spend only, and exits non-zero on error. It must never print the key or a response body containing credentials.

- [ ] **Step 6: Commit**

```bash
git add server/ingest/tcgapis-harvest.ts scripts/seed-market.ts tests/ingestion/tcgapis-harvest.test.ts .env.example
git commit -m "feat: credit-bounded TCGAPIs seed into evidence ledger"
```

### Task 2: "What is actively trading" report endpoint

**Files:**
- Create: `server/intelligence/active-report.ts`
- Create: `server/intelligence/routes.ts` (mount function only; integrator wires it)
- Create: `tests/intelligence/active-report.test.ts`

**Interfaces:**
- Consumes: Phase 3 `DiscoveryFinding`, DuckDB read-only query helper, Phase 1 observation repositories.
- Produces: `GET /api/intelligence/active-report` returning `{ data: ActiveReport, meta }`. `ActiveReport` has `generatedAt`, `cards: ActiveCard[]`, `summary`; `ActiveCard` has `name`, `set`, `game`, `basis`, `currency`, `observationCount`, `lastObservedAt`, `momentum7d`/`momentum30d` (number or `UNKNOWN`), `priceBand` or `UNKNOWN`, `drivers`, `invalidators`, `evidenceIds`, `confidence`, `freshness`.

- [ ] **Step 1: Write failing tests**

Cases: empty store returns `cards: []`, `summary` with explicit `insufficientEvidence: true` and no invented numbers; a card with one observation and no history returns momentum `UNKNOWN` and `freshness: 'stale'` when older than 30 days; a `GUIDE` price appears with basis `GUIDE` and its own currency; a card with ten observations and recent sales appears with basis `SOLD`, an evidence id list and non-null `lastObservedAt`; every card in the response has `source` and `observed_at` on its evidence references.

- [ ] **Step 2: Run to verify failure**

Run: `cd /opt/slabswarm/.superpowers/sdd/dp-integration && npx tsx --test tests/intelligence/active-report.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

Compose Phase 3 findings with observation counts, recency and basis-safe comps. Deterministic code only. Do not call an LLM. Return `UNKNOWN` for every value that lacks evidence. Put `generatedAt` and the query/filter inputs in `meta`.

- [ ] **Step 4: Run to verify pass**

Run: `cd /opt/slabswarm/.superpowers/sdd/dp-integration && npx tsx --test tests/intelligence/active-report.test.ts`
Expected: PASS, 5 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add server/intelligence/active-report.ts server/intelligence/routes.ts tests/intelligence/active-report.test.ts
git commit -m "feat: active trading report endpoint with provenance"
```

### Task 3: One-button insight view

**Files:**
- Create: `src/components/product/ActiveReportView.tsx`
- Create: `tests/ui/activeReportSourceContract.ts`
- Modify: `src/App.tsx` (route/nav entry only), `src/utils/dataProductApi.ts` (typed method only)

**Interfaces:**
- Consumes: `GET /api/intelligence/active-report` and `POST /api/intelligence/discovery-sweep`.
- Produces: a view reachable from Market Intelligence that renders real report data and a Refresh action.

- [ ] **Step 1: Write a failing source-contract test**

Assert: the nav contains a Market Intelligence entry; `ActiveReportView` renders basis, currency, observed_at, evidence count and confidence for each card; no literal placeholder strings such as `TODO`, `Lorem` or `Coming soon`; no number is rendered without a basis label; the Refresh action calls the discovery-sweep endpoint then reloads the report.

- [ ] **Step 2: Run to verify failure**

Run: `cd /opt/slabswarm/.superpowers/sdd/dp-integration && npx tsx --test tests/ui/activeReportSourceContract.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the view**

Render summary first, then a ranked table of active cards. Show `UNKNOWN` verbatim where the API returns it. Show freshness as a plain label. Refresh runs the sweep and reloads; it disables while in flight and surfaces errors. No credentials in the client.

- [ ] **Step 4: Run tests and typecheck**

Run: `cd /opt/slabswarm/.superpowers/sdd/dp-integration && npx tsx --test tests/ui/activeReportSourceContract.ts && npx tsc --noEmit`
Expected: PASS, 0 failures, typecheck exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/components/product/ActiveReportView.tsx tests/ui/activeReportSourceContract.ts src/App.tsx src/utils/dataProductApi.ts
git commit -m "feat: active trading report UI view"
```

### Task 4: Forecast the report and score it

**Files:**
- Create: `server/intelligence/report-forecast.ts`
- Create: `tests/intelligence/report-forecast.test.ts`

**Interfaces:**
- Consumes: Phase 4 forecast/backtest/learning services and the Task 2 `ActiveReport`.
- Produces: `forecastFromReport(report: ActiveReport): ForecastDraft[]` with price bands, drivers, invalidators, evidence ids and confidence; scoring delegated to Phase 4 at 7/30/90 days.

- [ ] **Step 1: Write failing tests**

Cases: one draft per card with at least three observations; no draft for `UNKNOWN` price data; bands are deterministic for the same report; each draft cites at least one evidence id; a scored draft records 7/30/90 outcomes and does not mutate the source report.

- [ ] **Step 2: Run to verify failure**

Run: `cd /opt/slabswarm/.superpowers/sdd/dp-integration && npx tsx --test tests/intelligence/report-forecast.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

Deterministic band derivation from basis-safe comps. LLMs are not called. Simulations, if used, are marked hypotheses and never written as evidence.

- [ ] **Step 4: Run to verify pass**

Run: `cd /opt/slabswarm/.superpowers/sdd/dp-integration && npx tsx --test tests/intelligence/report-forecast.test.ts`
Expected: PASS, 5 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add server/intelligence/report-forecast.ts tests/intelligence/report-forecast.test.ts
git commit -m "feat: score forecasts from active trading report"
```

### Task 5: Integration, live seed and deployment verification

**Files:**
- Modify: `server.ts` and `package.json` (integrator-owned)
- Create: `docs/benchmarks/2026-11-22-industry-launch.md`

**Interfaces:**
- Consumes: all four tasks above plus the five merged Phase 1-5 lanes.
- Produces: a running Slabswarm container whose public gate URL serves the report with real data.

- [ ] **Step 1: Merge and validate**

Merge all five lane branches into `dp-integration`. Run `npm install`, `npm test`, `npm run lint`, `sudo -n docker compose -f /opt/slabswarm/docker-compose.yml --project-directory /opt/slabswarm config -q`.
Expected: full suite 0 failures, lint exit 0, compose config exit 0.

- [ ] **Step 2: Rebuild the existing container**

`sudo -n docker compose -f /opt/slabswarm/docker-compose.yml --project-directory /opt/slabswarm up -d --build slabswarm`
Expected: container healthy on `10.99.0.1:3010`. No new port, no firewall or DNS change.

- [ ] **Step 3: Run migrations and the bounded live seed**

Run `npm run db:migrate`, then `npx tsx scripts/seed-market.ts` with `TCGAPI_ENABLED=true` and `TCGAPI_HARVEST_CREDIT_BUDGET=60` supplied from the existing `.env` context.
Expected: non-zero evidence written, credits spent at or under 60, key never appears in output. If the account has no credits, record the 403 and use the legacy adapter for the report instead of inventing data.

- [ ] **Step 4: Exercise the product end to end**

`curl` the internal health, db status, active-report, discovery-sweep and forecast endpoints with the existing operator auth. Verify through `https://slabswarm.144-21-43-141.sslip.io/` that the gate redirects and the UI renders the report.

- [ ] **Step 5: Verify Hermes tools and record results**

Confirm `get_collectible_valuation`, `scan_arbitrage_spreads`, `query_knowledge_graph`, `ingest_market_listing` still respond. Write counts, credit spend, timings, curl statuses and any 403 into `docs/benchmarks/2026-11-22-industry-launch.md`. Commit the document.

```bash
git add docs/benchmarks/2026-11-22-industry-launch.md server.ts package.json
git commit -m "docs: record industry launch verification"
```
