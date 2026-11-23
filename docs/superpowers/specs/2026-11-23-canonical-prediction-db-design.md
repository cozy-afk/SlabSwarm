# Canonical Prediction Database — Design

Status: proposed for approval
Date: 2026-11-23
Binding goal: `docs/PRODUCT_GOAL.md`. This design serves that goal; conflicts resolve against the goal document.

## Intent

Slabswarm's own database must be trustworthy enough to predict card prices and market behaviour before any thought of selling access. Today the app has three competing stores: the legacy JSON graph, a JSON ingest ledger, and canonical Postgres tables. The same card can return different facts depending on the endpoint. That has to end before more data is added.

## Product thesis

The value is the join, not any single source. We combine catalogs and products from multiple places, resolve them to one first-party identity, then attach historical prices, completed sales and active listings as separately labelled evidence. Deterministic code turns that matched evidence into price guidance, forecasts and scores.

The chain is: catalog/checklist facts → identity resolution → immutable price evidence with basis and provenance → normalized observations → valuation and forecast → scoring against real outcomes → learning. A catalog without prices is a list. A price without a source is a guess. A forecast without a score is an opinion. We ship the whole chain or none of it.

This does not license us to invent market truth. SOLD data must come from an observed sale; GUIDE and ASKING stay distinct; simulations remain hypotheses. Where a source is gated — eBay sold data, for example — the honest answer is that the dataset has a gap, not that a model filled it.

## Goals

1. One source of truth: canonical Postgres is authoritative for catalog, evidence, observations, forecasts, scores and learning state.
2. JSON graph and JSON ledger become import/export artifacts, not runtime sources.
3. Every prediction input carries source, basis, currency, observed_at, captured_at, lineage and confidence.
4. Deterministic identity resolution so the same printing from two sources becomes one card, with an auditable decision.
5. Realized outcomes are captured from new SOLD observations; forecasts are scored at 7/30/90 days.
6. Learning changes weights only when benchmark non-regression passes.
7. Parquet lake and backups exist and are exercised, not just declared.
8. Existing Hermes tool IDs keep working and return the same facts as the UI.

## Non-goals

- No customer API keys, billing, quotas or public exposure in this phase.
- No new web sources beyond the web-harvest work already in flight.
- No model writes canonical facts. No LLM-only prices.
- No destructive rewrite of the legacy JSON snapshot.

## Anti-goals

- A bigger catalog built on split sources. That multiplies disagreement.
- Forecasts sold or shown as confident before they are scored against outcomes.
- Scraped data resold without a clear license and provenance.

## Constraints

- Raw evidence immutable; corrections append.
- Basis explicit: SOLD/ASKING/OFFER/GUIDE/CLAIM/POPULATION/UNKNOWN.
- Missing shipping, fees, FX, grade or condition stays UNKNOWN, never zero.
- Deterministic code computes valuations and scores; agents propose, explain, challenge.
- Every forecast is scored against real outcomes; learning promotes only through gates.
- Keep Hermes tool IDs stable: get_collectible_valuation, scan_arbitrage_spreads, query_knowledge_graph, ingest_market_listing.
- No new public listeners, firewall or DNS changes.
- Use `sudo -n docker` for Docker operations.

## Approaches considered

### A. Big-bang rewrite of all read paths

Replace graphEngine, the ledger and the analytics store in one pass. Cleanest end state, but it touches nearly every endpoint at once and would leave the app untestable mid-flight. Rejected.

### B. Canonical-first adapter replacement (recommended)

Keep existing interfaces. Replace what backs them: repositories point at Postgres, Hermes tools and product endpoints call those repositories, and the JSON graph/ledger are used only at import time. Migrate one read domain at a time — catalog first, then evidence/observations, then Hermes tools — with contract tests asserting identical results across the old and new paths before each cutover. Lower blast radius, keeps the app running, but leaves temporary adapters until the last cutover.

### C. Dual-write both stores forever

Write to Postgres and the JSON graph on every mutation. Least work up front, but it guarantees the two stores drift under failure and keeps the exact problem we are trying to remove. Rejected.

## Chosen design

Approach B, in five workstreams. The catalog taxonomy below is a prerequisite for workstream 1 and is grounded in the research at `docs/research/2026-11-23-catalog-taxonomy-research.md`.

### Catalog taxonomy

One shared catalog, three verticals: `TRADING_CARD_GAME`, `SPORTS_CARD`, `COMIC_BOOK`. Public systems consistently separate identity from printing: TCGGraph gives each set, collector number and language its own id, Scryfall separates `oracle_id` from printing id, and TCGplayer's SKU tuple adds language, printing and condition [6][8][11]. Comics need a further level — W3C identifies an issue by series and volume, issue number and variant description, while keeping volume distinct from start year [30][29].

```text
Catalog
  Vertical: TCG | SPORTS_CARD | COMIC_BOOK
    Property: Pokemon | Yu-Gi-Oh! | Magic | One Piece | NBA | Marvel
      Set / Series / Volume: Base Set 1999 | 2024 Topps Chrome | Amazing Spider-Man vol 2
        Card identity / Issue: Charizard 4/102 | LeBron #23 | ASM #300
          Printing / Variant: 1st-edition holo | refractor | alternate cover
            Instance / Copy: PSA 10 cert | CGC 9.8 Universal | owner copy
              Offer / Observation: seller, price, currency, basis, observed_at
```

Canonical schema additions:

- Add `vertical` and `propertyId` to `games` (renamed conceptually to properties); keep `sets`, `cards`, `printings`, `instances` as the shared spine.
- An `identifiers` table with scheme, normalized value, raw value and validity. ISBN identifies an edition and format, GTIN identifies a trade item, and vendor IDs stay scheme-scoped [47][48][41].
- A `grade_certificates` table with issuer, cert, raw label, normalized numeric grade, qualifier and label tier. Sports-card feeds already separate grader, grade and cert [19]; grader-specific population keys and CGC label tiers must stay raw [22][35].
- An `offers` table separate from catalog facts, carrying seller, price, ISO currency and condition. schema.org keeps Product and Offer distinct and requires explicit price currency [37][38][46].
- An `entity_links` table connecting card or issue identities to athlete, team, character, creator or publisher entities. Trading Card API models subjects and teams [20]; comics model creators and first appearances [32].
- Reversible identity decisions: normalization, blocking, two thresholds and a review queue are standard record-linkage practice [56][57]. Our existing deterministic resolver becomes the decision engine; merges are never destructive.
- Provenance on every catalog value: source, observed_at, captured_at, method, confidence and version. W3C PROV models versions as specializations of a stable entity [49][50].

Vertical-specific required facts live in validated `facets` profiles: TCG requires set code, card number, rarity and finish; sports requires sport, league, team-on-card, season and print run; comics requires publisher, series, volume, issue number as a string, variant description, and both cover date and on-sale date [1][19][27]. Condition and grade remain separate axes [44].

API surface stays one `/api/catalog` with a `vertical` filter and typed facets, not three separate catalogs. Errors use problem+json and rate limits return 429 with Retry-After [58][59][61]. Future customer keys identify a project for quota rather than acting as authorization alone [62].

### 1. Canonical read layer

- A `server/canonical/queries.ts` facade exposing catalog, pricing, comps, market, evidence and Hermes-tool reads over `createDefaultRepositories()`.
- Cut over `/api/catalog/*`, `/api/pricing/:id`, `/api/comps/:id`, `/api/market/:id` and `server/hermesBridge.ts` to that facade.
- Contract tests compare old and new responses for the same fixtures before each cutover.
- Mark the 39 `tcg:*` rows as `EXTERNAL_REFERENCE` in `facets.sourceClass`; exclude them from prediction inputs by default. The 19 first-party cards stay `FIRST_PARTY`.

### 2. Identity resolution

- Implement the spec's resolver over canonical `cards`, `identity_decisions`, `aliases` and `crosswalks` tables.
- Deterministic match on normalized name + set + card number + variant, then evidence-backed alias matches. No fuzzy LLM decision.
- Swarm may propose an alias or crosswalk; only the deterministic resolver commits a decision with a reason and evidence IDs.

### 3. Outcomes, scoring and learning

- A job in the Postgres `jobs` table watches new SOLD observations. When a target has a prior forecast whose 7/30/90 day horizon has elapsed, compute the realized value from SOLD observations only and write `forecast_scores` with band coverage, direction, MAE and Brier.
- Scoring is deterministic. No simulated value may become an outcome.
- `POST /api/learning/run-cycle` consumes scores, updates source trust, factor weights and calibration, and promotes only on non-regression. Record each cycle in `learning_events` and `rule_versions`.
- Forecast Lab displays coverage, MAE and Brier per horizon, not just bands.

### 4. Parquet lake

- Run `POST /api/admin/export-parquet` after each approved harvest and nightly. Export evidence, observations, identities, events, forecasts and scores under `/opt/slabswarm/data/lake`, partitioned where fields exist.
- SQL Lab queries the exported Parquet through the existing read-only DuckDB helper, with proof in the API response that the data came from the lake.

### 5. Backup and restore

- Scripts for Postgres `pg_dump`, the Parquet lake and encrypted LLM settings.
- A restore drill against a temporary database and directory. Record checksums and result.
- Schedule daily backup; retain a small, documented number of copies.

## Data owners

- `server/canonical/**` and `server.ts` router wiring: integrator.
- Identity resolver: `server/identity/**`.
- Outcomes/scoring/learning: `server/forecast/**` and `server/learning/**`.
- Parquet export and SQL Lab: `server/analytics/**`.
- Backup/restore: `scripts/backup-*`, `scripts/restore-*`.

## Verification

- Every cutover has contract tests comparing old and new outputs on fixed fixtures.
- Full suite, typecheck, compose validation before each rebuild.
- Live checks: one card returns identical facts through UI, Hermes tool and SQL Lab; one SOLD observation creates a score; one learning cycle changes state only if the benchmark gate passes; Parquet files exist and SQL Lab reads them; restore drill succeeds.

## Resolved builder questions

These were ambiguous in the first draft. The answers below are the builder's calls, made so the implementation plan has no hidden choices.

1. **Resolver algorithm.** Normalize NFC + lowercase + trim, uppercase set codes, strip leading zeros and `#` from card numbers, lowercase variants. Exact match key: normalized name + set + number + variant. Tie-break: highest trust tier (HIGH > MEDIUM > LOW > UNKNOWN), then earliest `observedAt`, then lexicographically smallest evidence ID. An alias or crosswalk requires either an explicit `aliasOf` field in source evidence or two independent sources agreeing on the normalized key. No fuzzy or model-based matching. Every `identity_decisions` row records the rule, input fields, candidate evidence IDs, confidence and timestamp.
2. **Surviving ID.** The first accepted first-party canonical card ID survives. Absorbed source IDs (`tcg:*`, `TCG-*`) become rows in `aliases` pointing to it. Observation `targetIdentityId` values are never rewritten. The canonical facade resolves both canonical IDs and aliases, so Hermes tool inputs keep working. UI shows the canonical ID and lists aliases.
3. **Write path.** Yes, canonical Postgres becomes the write target in this phase — ingest, promotion, web-harvest approval and `ingest_market_listing`. The JSON ledger and graph become import/export artifacts. `scripts/sync-postgres.ts` stays as a one-time migration utility, not a runtime bridge. Contract tests assert no new runtime writes reach the ledger after cutover.
4. **Hermes valuation inputs.** Valuations are recomputed deterministically from canonical `market_observations` (basis, grade, marketplace, currency, status). Backfilled `valuations` rows remain authoritative for POPULATION and grade-count metrics. Add a small `fee_schedules` table with configurable marketplace fee percentages; absent fee data stays UNKNOWN rather than assuming zero. Status mapping: VERIFIED → NORMALIZED, QUARANTINED → CONTESTED, with the original status preserved in evidence facets.
5. **Realized outcome.** For a forecast created at t0 with horizon H, the realized value is the median `amount` of SOLD, NORMALIZED observations for the same canonical card, grade, marketplace and currency whose `observedAt` falls within ±7 days of t0+H. No matching observations means the outcome is UNKNOWN and the forecast is not evaluable — not scored as wrong. `baselinePrice` is the midpoint of the forecast's price band at creation, stored in a new `forecasts.baseline_snapshot` JSONB column.
6. **Learning state.** Canonical tables are authoritative: `source_trust_profiles`, `factor_scores`, `rule_versions`, `learning_events`, plus a new `learning_state` singleton table for cycle count and calibration. `/api/learning/run-cycle` ignores caller-supplied benchmarks; the benchmark comes only from stored non-regressing backtests. No backtest means no promotion.
7. **Contract test comparison.** Compare fact fields exactly after alias resolution: ID, basis, currency, amount, observedAt, source, lineage, confidence, set, game, number, variant. Ignore `generatedAt`, `requestId`, warning wording/order and provenance source strings, but assert each exists with the right shape.
8. **`ingest_market_listing`.** Response shape stays identical. New canonical observation status is NORMALIZED for VERIFIED, CONTESTED for QUARANTINED; `outlierReason` is preserved in evidence facets and `priceComponents`. `updatedValuation` is recomputed by the deterministic valuation function over canonical observations.
9. **SQL Lab and the lake.** Findings become a seventh Parquet dataset so the built-in `findings-by-type` query keeps working. Lake proof is `meta.lakeManifest` with file paths, row counts and sha256 checksums, plus `engine: duckdb-readonly`.
10. **Scheduling.** An in-process scheduler inside the app container uses the Postgres `jobs` table with a lock row — no host cron or OS changes. Jobs: outcome creation when a SOLD observation is approved, nightly Parquet export, daily backup. All are idempotent by job status and lock. An "approved harvest" is a web-harvest candidate whose status is APPROVED.

## What is left to the builder

Implementation sequencing, file-level tasks and test cases go in the implementation plan after design approval.

Sources:
[1] https://docs.pokemontcg.io/api-reference/sets/set-object — Pokemon TCG API - set object
[6] https://tcggraph.com/llms-full.txt — TCGGraph complete reference
[8] https://scryfall.com/docs/api/cards — Scryfall Card Objects
[11] https://docs.tcgplayer.com/docs/getting-started — TCGplayer API getting started
[19] https://www.thecardapi.com/docs — The Card API docs
[20] https://tradingcardapi.com/docs/api/models — Trading Card API data models
[22] https://docs.gemrate.com/introduction — GemRate API docs
[27] https://comicvine.gamespot.com/api/documentation — ComicVine API docs
[29] https://anansi-project.github.io/docs/comicinfo/documentation — Anansi ComicInfo docs
[30] https://www.w3.org/wiki/WebSchemas/PeriodicalsComics — W3C Periodicals and Comics
[32] https://comicmeta.org/cbo — Comic Book Ontology
[35] https://www.qualitycomix.com/guide/how-read-cgc-label — Reading a CGC label
[37] https://schema.org/Product — schema.org Product
[38] https://schema.org/Offer — schema.org Offer
[41] https://schema.org/identifier — schema.org identifier
[44] https://schema.org/itemCondition — schema.org itemCondition
[46] https://schema.org/price — schema.org price
[47] https://www.isbn-international.org/content/what-isbn/10 — International ISBN Agency
[48] https://www2.gs1.org/standards/id-keys/gtin — GS1 GTIN
[49] https://www.w3.org/TR/prov-o — W3C PROV-O
[50] https://www.w3.org/TR/prov-primer — W3C PROV primer
[56] https://en.wikipedia.org/wiki/Record_linkage — Record linkage
[57] https://www.zingg.ai/deep-dives/the-what-and-why-of-entity-resolution — Entity resolution pipeline
[58] https://jsonapi.org/format/1.0 — JSON:API 1.0
[59] https://www.rfc-editor.org/rfc/rfc9457 — RFC 9457 problem details
[61] https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/429 — HTTP 429 MDN
[62] https://cloud.google.com/docs/authentication/api-keys — Google API keys
