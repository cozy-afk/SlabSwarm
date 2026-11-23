# Free Data Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the current raw, mostly PENDING evidence pile into a first-party catalog and market dataset usable for prediction and research, using free and keyless feeds first and keeping paid or restricted sources as explicitly gated follow-ups.

**Architecture:** Fix the write path before adding sources. Complete promotion of already-priced evidence into canonical observations, then add rate-limited, license-aware adapters for free public catalogs (Scryfall, Pokémon TCG API, CardDex, Cardex). Every adapter emits immutable evidence with source, basis, currency, timestamps and license. Deterministic promotion resolves identity and writes canonical facts. Parquet export and the existing active report turn the canonical data into research output. WebSocket feeds are a separate, gated spike because the free-tier claims are not yet verified from primary docs [66].

**Tech Stack:** TypeScript, Express, Node test runner (`tsx --test`), existing ingest adapters and repositories, Drizzle/Postgres, DuckDB/Parquet, React/Vite.

**Spec:** `docs/superpowers/specs/2026-11-23-canonical-prediction-db-design.md`; research: `docs/research/2026-11-23-catalog-taxonomy-research.md`.

## Research basis and current state

The pasted "zero rows" report is stale. Live check on 2026-11-23: ledger has 147 evidence, 147 candidates, 51 observations; all 147 evidence rows are `parseStatus=PENDING` and `trustTier=UNKNOWN`; basis mix is 89 UNKNOWN, 51 GUIDE, 7 SOLD. Postgres has 58 cards, 169 evidence rows, 72 market observations, 19 sets. TCGAPIs produced 107 of the 147 evidence rows; 40 came from the legacy-graph import.

Free catalog sources are real but differ in shape. Scryfall is public with bulk exports [8]. Pokémon TCG API is public and labels USD and EUR prices by source [1][2]. CardDex offers anonymous reads at 30 req/min and 5,000 req/day, a free key at 100 req/min, daily price history, and a `prices.updated` webhook; its docs say prices are market reference prices, not offers to buy, and require attribution [64]. Cardex advertises a keyless catalog of 196 sets and 20,987 cards at 100 requests/day [65]. Treat all advertised limits as observed documentation, not guarantees.

eBay is the largest marketplace but is a legal gate, not a feed we can simply add. Its API License Agreement requires eBay's express prior written permission to derive average selling price or gross merchandise sold for any eBay category [67]. The Buy APIs, including Marketplace Insights for sold history, are intended for approved partners and require an application review before production use [68]. Our product's core purpose — deriving prices from sold data — sits squarely inside that restriction. Task 8 handles the approval path; no eBay adapter may be wired before written permission exists.

## Global Constraints

- Raw evidence immutable. Corrections append.
- Basis explicit: SOLD/ASKING/OFFER/GUIDE/CLAIM/POPULATION/UNKNOWN.
- Missing shipping/fees/FX/grade/condition is UNKNOWN, not zero.
- Every fact carries source, observed_at, captured_at, lineage, confidence.
- Deterministic code computes valuations and scores. LLMs propose, explain, challenge.
- No model writes canonical facts directly.
- Simulations are hypotheses, never sales evidence.
- Keep Hermes tool IDs stable.
- No new public listeners, firewall or DNS changes.
- Use `sudo -n docker` for Docker operations.
- No live third-party calls in tests; inject fetch.
- Store API keys server-side only; never print or persist them in docs.

## Review Focus

- A PENDING record with a finite price stays unpromoted: Task 1 must promote every priced candidate and report the remainder as catalog-only.
- A GUIDE price is relabelled SOLD: Tasks 2 and 4 must preserve basis and currency from the source record.
- A free feed exceeds its published rate limit: Task 2 must enforce per-source delay and stop on 429 with a safe error.
- A feed's licence forbids redistribution: Task 2 must require a declared licence and attribution before any evidence is written.
- A canonical write happens without provenance: Task 4 must reject proposals missing source, observed_at, captured_at, lineage and confidence.

---

### Task 1: Data coverage and promotion completion

**Files:**
- Create: `scripts/data-coverage.ts`
- Create: `tests/ingestion/data-coverage.test.ts`
- Modify: `server/ingest/promotion.ts`
- Create: `docs/benchmarks/2026-11-23-data-coverage.md`

**Interfaces:**
- Consumes: `createDurableRepositories()` from `server/ingest/store.ts`; `promoteCandidates(repos, options)` from `server/ingest/promotion.ts`.
- Produces: `buildCoverageSnapshot(repos): Promise<CoverageSnapshot>` with counts by source, basis, parseStatus, trustTier, priced candidates, promoted observations and canonical table counts. `CoverageSnapshot` is declared in `server/contracts/dataProduct.ts` by this task.

- [ ] **Step 1: Write failing tests**

Create `tests/ingestion/data-coverage.test.ts`: a fixture ledger with one priced GUIDE candidate, one catalog candidate with no amount, and one SOLD candidate already promoted. Assert `pricedWithoutObservation === 0` after promotion, `catalogOnly >= 1`, and that basis/source counts are preserved.

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx --test tests/ingestion/data-coverage.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the coverage report**

`buildCoverageSnapshot` reads the durable ledger and canonical repositories; it never mutates either. Add a guard in `promoteCandidates` that a candidate with finite amount, explicit basis and PARSED-or-PENDING status cannot be left without an observation.

- [ ] **Step 4: Run to verify pass**

Run: `npx tsx --test tests/ingestion/data-coverage.test.ts && npx tsc --noEmit`
Expected: PASS, 4 tests, 0 failures; typecheck exit 0.

- [ ] **Step 5: Run the live report and record results**

Run `npx tsx scripts/data-coverage.ts > docs/benchmarks/2026-11-23-data-coverage.md`. Then run `promoteCandidates` once against the live ledger and rerun the report. Expected: pricedWithoutObservation 0, no duplicate observations.

- [ ] **Step 6: Commit**

```bash
git add scripts/data-coverage.ts tests/ingestion/data-coverage.test.ts server/ingest/promotion.ts server/contracts/dataProduct.ts docs/benchmarks/2026-11-23-data-coverage.md
git commit -m "feat: report data coverage and finish priced-candidate promotion"
```

### Task 2: Free catalog adapters

**Files:**
- Create: `server/contracts/freeFeed.ts` (controller-frozen before parallel work)
- Create: `server/ingest/adapters/freeCatalog.ts`
- Create: `server/ingest/freeFeeds.ts`
- Create: `tests/ingestion/freeFeeds.test.ts`

**Interfaces:**
- Consumes: `IngestAdapter` from `server/ingest/types.ts`; `EvidenceRecordInput` from `server/contracts/dataProduct.ts`.
- Produces: `FreeFeedRecord` with `sourceId`, `externalId`, `vertical`, `property`, `set`, `name`, `number`, `finish`, `currency`, `amount`, `basis`, `observedAt`, `sourceUrl`, `license`, `attribution`. Produces `createFreeFeedAdapter(config: FreeFeedConfig): IngestAdapter`.

- [ ] **Step 1: Write failing tests**

Cases: keyless Scryfall adapter maps `/cards` and bulk exports to catalog records with no invented price; Pokémon TCG API records preserve USD/EUR and source; CardDex adapter writes GUIDE prices with license and attribution; Cardex keyless adapter respects 100/day cap; a 429 stops the run with a safe error; no `TCGAPI_KEY` is read.

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx --test tests/ingestion/freeFeeds.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement adapter registry**

`server/ingest/freeFeeds.ts` exports `FREE_FEEDS` with four configs: `scryfall` (public, no key), `pokemontcg` (public, no key), `carddex` (anonymous reads, server-side key optional via `CARDEX_API_KEY`, attribution required), `cardex` (keyless). Each config has `sourceId`, `vertical`, `baseUrl`, `rateLimitMs`, `license`, `attributionRequired`. Missing `license` means disabled.

- [ ] **Step 4: Implement the adapter**

Map each feed's response into `FreeFeedRecord`, then into existing `EvidenceRecordInput` with `parsedPayload.recordKind` of `CATALOG_CARD` or `PRICE_GUIDE`. Never assign SOLD. Preserve raw response bytes as immutable evidence. Use injected fetch only.

- [ ] **Step 5: Run to verify pass**

Run: `npx tsx --test tests/ingestion/freeFeeds.test.ts && npx tsc --noEmit`
Expected: PASS, 7 tests, 0 failures.

- [ ] **Step 6: Commit**

```bash
git add server/contracts/freeFeed.ts server/ingest/adapters/freeCatalog.ts server/ingest/freeFeeds.ts tests/ingestion/freeFeeds.test.ts
git commit -m "feat: add free catalog feed adapters with license and rate limits"
```

### Task 3: Operator routes and view for free feeds

**Files:**
- Modify: `server/ingest/routes.ts`
- Modify: `src/components/product/SourcesView.tsx`
- Modify: `src/utils/dataProductApi.ts`
- Create: `tests/ui/freeFeedsSourceContract.ts`

**Interfaces:**
- Consumes: `FREE_FEEDS` and `createFreeFeedAdapter` from Task 2.
- Produces: `GET /api/ingest/free-feeds`, `POST /api/ingest/free-feeds/:sourceId/harvest`, both `{data,meta}`.

- [ ] **Step 1: Write failing source-contract test**

Assert the Sources view lists the four feeds with license and attribution, shows a harvest action per feed, and renders no placeholder strings.

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx --test tests/ui/freeFeedsSourceContract.ts`
Expected: FAIL.

- [ ] **Step 3: Implement routes and view**

Routes return public feed metadata only; no key values. A harvest action calls the adapter and returns counts. The view surfaces last harvest counts and errors as plain text.

- [ ] **Step 4: Run to verify pass**

Run: `npx tsx --test tests/ui/freeFeedsSourceContract.ts && npx tsc --noEmit && npm run build`
Expected: tests pass, typecheck and build exit 0.

- [ ] **Step 5: Commit**

```bash
git add server/ingest/routes.ts src/components/product/SourcesView.tsx src/utils/dataProductApi.ts tests/ui/freeFeedsSourceContract.ts
git commit -m "feat: expose free feed harvest in Sources view"
```

### Task 4: Canonical promotion with identity and provenance

**Files:**
- Modify: `server/ingest/promotion.ts`
- Create: `server/identity/resolver.ts`
- Create: `tests/identity/resolver.test.ts`

**Interfaces:**
- Consumes: `FreeFeedRecord`, `promoteCandidates`, canonical repositories from `server/db/repositories/index.ts`.
- Produces: `resolveCandidate(candidate: FreeFeedRecord): Promise<IdentityDecision>` and `promoteToCanonical(candidate: FreeFeedRecord): Promise<CanonicalWriteReport>`.

- [ ] **Step 1: Write failing tests**

Cases: two sources naming the same card produce one canonical identity; a missing set or number stays UNKNOWN and does not merge; GUIDE amount stays GUIDE/USD; a candidate missing provenance is rejected; a merge is reversible and records an `identity_decisions` row.

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx --test tests/identity/resolver.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement resolver and canonical write**

Follow the design's normalization and tie-break rules. The canonical write accepts only candidates with source, observed_at, captured_at, lineage, confidence, basis and currency. No model call, no simulation, no price invention.

- [ ] **Step 4: Run to verify pass**

Run: `npx tsx --test tests/identity/resolver.test.ts && npx tsc --noEmit`
Expected: PASS, 5 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add server/ingest/promotion.ts server/identity/resolver.ts tests/identity/resolver.test.ts
git commit -m "feat: resolve free-feed identity and write canonical facts"
```

### Task 5: Parquet lake and evidence-backed report

**Files:**
- Modify: `server/analytics/routes.ts`
- Modify: `server/intelligence/active-report.ts`
- Create: `tests/analytics/lake-report.test.ts`

**Interfaces:**
- Consumes: canonical repositories and `POST /api/admin/export-parquet`.
- Produces: an active report whose `meta.lakeManifest` lists exported file paths, row counts and checksums.

- [ ] **Step 1: Write failing tests**

Assert that after export, findings, evidence, observations and cards appear in the manifest; SQL Lab rejects writes; active report cites at least one canonical evidence id.

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx --test tests/analytics/lake-report.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement export trigger and manifest**

Export after an approved harvest and on `POST /api/admin/export-parquet`. Include the seven datasets from the design, including findings. Attach `meta.lakeManifest` to the report.

- [ ] **Step 4: Run to verify pass**

Run: `npx tsx --test tests/analytics/lake-report.test.ts && npx tsc --noEmit`
Expected: PASS, 4 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add server/analytics/routes.ts server/intelligence/active-report.ts tests/analytics/lake-report.test.ts
git commit -m "feat: export canonical data to Parquet and cite lake in report"
```

### Task 6: Real-time feed spike (gated, no production wiring)

**Files:**
- Create: `docs/research/2026-11-23-realtime-feed-spike.md`

- [ ] **Step 1:** Verify from primary docs whether PokeTrace's WebSocket and free tier exist, and whether commercial use is allowed. The fetched developer page only confirms base URL, OpenAPI, health check and `X-API-Key` auth [66]; the WebSocket claim came from a search snippet and is unverified.
- [ ] **Step 2:** Check CardDex's documented `prices.updated` webhook licence and attribution requirements [64].
- [ ] **Step 3:** Record findings, cost, licence and a recommendation. Do not wire any feed into production in this task.
- [ ] **Step 4:** Commit the document.

### Task 8: eBay marketplace access (gated, no production wiring)

**Files:**
- Create: `docs/research/2026-11-23-ebay-access-review.md`

**Interfaces:**
- Consumes: the eBay API License Agreement [67] and the Buy API application guide [68].
- Produces: a written decision on whether we may lawfully ingest eBay sold data for price derivation; a checklist of prerequisites if yes.

- [ ] **Step 1: Record the blocking clause**

Quote the licence clause requiring express prior written permission to derive average selling price or gross merchandise sold for any eBay category [67]. State plainly that our intended use falls inside it.

- [ ] **Step 2: Use the Sandbox for plumbing, not data**

With the owner's Sandbox keyset, build and test an injected-fetch adapter against Sandbox endpoints: auth, request shape, error handling and rate-limit behaviour. Sandbox transactions are mocks; they cannot supply real sold prices. Keys are stored server-side through the vault or the private `.env`, never in chat, code or docs.

- [ ] **Step 3: Record the access path**

Summarize from the primary guide: free developer account, keysets for Sandbox and Production, Buy APIs intended for approved partners, application growth check required for restricted APIs in production [68].

- [ ] **Step 4: Define the owner action**

List what the owner must supply before any production code is enabled: Production keyset, written permission for price derivation, Buy API approval, and estimated hourly/daily call volume for the growth check.

- [ ] **Step 5: Commit the review document**

Expected outcome: either "approved, adapter may be enabled" or "not approved, no eBay feed". The Sandbox adapter may exist in code but stays disabled against production until approval is documented.

### Task 7: Integration and verification

- [ ] Merge all lanes; run all test files explicitly and `npx tsc --noEmit`.
- [ ] Wire new routers into `server.ts` (integrator-owned); update stale 12-tool assertions to 14 from the web-harvest merge.
- [ ] Rebuild the existing container; run the coverage script, one keyless Cardex harvest, promotion and Parquet export.
- [ ] Verify `/api/intelligence/active-report`, `/api/catalog/search`, `/api/db/status` and the public gate.
- [ ] Record results in `docs/benchmarks/2026-11-23-free-data-foundation.md`.

Sources:
[1] https://docs.pokemontcg.io/api-reference/sets/set-object — Pokemon TCG API - set object
[2] https://docs.pokemontcg.io/api-reference/cards/card-object — Pokemon TCG API - card object
[8] https://scryfall.com/docs/api/cards — Scryfall Card Objects
[64] https://carddex.dev/docs — CardDex API docs
[65] https://cardex-api.dev — Cardex API
[66] https://poketrace.com/developers — PokeTrace developer overview
[67] https://developer.ebay.com/develop/apis/api-license-agreement — eBay API License Agreement
[68] https://developer.ebay.com/develop/get-started/get-started-on-a-buying-application — eBay Get Started on a Buying Application
