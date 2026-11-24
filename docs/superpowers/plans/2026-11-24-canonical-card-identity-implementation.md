# Canonical Card Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild Slabswarm card identity around canonical UUIDs with source crosswalks and human-readable search, while keeping all card types and sources in one canonical database.

**Architecture:** Additive Postgres migration adds provenance and search support. A dry-run/apply migration script builds an old→new mapping, writes crosswalks, appends identity decisions and repoints every text column that can hold a card reference. Serving and report code then read canonical cards plus sets/games and emit UUIDs with human fields. Research, forecasts and the human-proof log are regenerated from the migrated data.

**Tech Stack:** TypeScript, Node `node:test`, `tsx`, Postgres via existing repository layer, Docker Compose for deploy.

**Spec:** `docs/superpowers/specs/2026-11-24-canonical-card-identity-design.md`

## Global Constraints

- One canonical database. No second catalog, no hidden source rows.
- `source_kind` values are exactly `FIRST_PARTY`, `RESEARCH_REFERENCE`, `OBSERVED_SOURCE`.
- TCGAPIs rows are `RESEARCH_REFERENCE`; they remain searchable and usable for research. First-party scope is an explicit filter.
- All canonical card ids are UUID-shaped. Source refs live only in crosswalks, aliases, provenance and raw payloads.
- Additive migrations only. Never edit an applied migration.
- No DELETE, TRUNCATE, raw-evidence rewrite or invented card/name/set/game/price.
- Append-only identity decisions: add successor rows; never UPDATE old rows.
- Basis stays explicit; missing values stay UNKNOWN, never zero.
- `observed_at` and `captured_at` remain separate.
- No credentials, paid APIs, firewall, DNS, listener or public-exposure changes in worker lanes.
- Workers do not run the full suite or deploy; controller does both after merge.

## Review Focus

- Source-ref leakage into canonical id fields must fail every proof check; tested in Task 2 proof assertions and Task 5.
- Search by human name must return one canonical card with name/set/game/number, not six raw source refs; tested in Task 3.
- First-party and research scopes must both be truthful; tested in Tasks 3 and 4.
- Append-only identity history must not be rewritten; tested in Task 2.
- Observation upsert after repoint must remain idempotent with no duplicate rows; tested in Task 2.

---

### Task 1: Additive provenance and search schema

**Files:**
- Create: `server/db/migrations/0004_canonical_identity.sql`
- Modify: `server/db/schema.ts`
- Test: `tests/db/canonical-identity-schema.test.ts`

**Interfaces:**
- Consumes: existing `cards`, `evidence_records`, `sets`, `games`, `crosswalks`, `aliases` tables.
- Produces: `cards.source_kind`, `evidence_records.source_kind`, CHECK constraint `canonical_source_kind`, indexes for lowercase name/number/set/game search.

- [ ] **Step 1: Write failing schema contract test**

  Assert `col_description` or column presence for `cards.source_kind` and `evidence_records.source_kind`, valid values, CHECK constraint behavior, and search indexes. Use the existing disposable DB test pattern.

- [ ] **Step 2: Run test to verify it fails**

  Run: `DOTENV_CONFIG_PATH=<empty-env> SLABGRAPH_TEST_MODE=1 npx tsx --test tests/db/canonical-identity-schema.test.ts`
  Expected: FAIL because columns and indexes do not exist.

- [ ] **Step 3: Add additive migration**

  Create `0004_canonical_identity.sql` adding `source_kind text NOT NULL DEFAULT 'OBSERVED_SOURCE'`, CHECK constraint for the three allowed values, `cards_name_lower_idx`, `cards_number_lower_idx`, `sets_name_lower_idx`, `sets_code_lower_idx`, `games_name_lower_idx`. Add comments documenting provenance meaning. Do not alter applied migrations.

- [ ] **Step 4: Run test to verify it passes**

  Run the same command. Expected: PASS.

- [ ] **Step 5: Commit**

  Message: `feat(db): add canonical identity provenance and search indexes`

---

### Task 2: Old→new mapping and canonical repoint script

**Files:**
- Create: `scripts/migrate-canonical-identity.ts`
- Create: `tests/db/canonical-identity-migration.test.ts`

**Interfaces:**
- Consumes: `source_kind` from Task 1.
- Produces: `CanonicalIdentityMapping` with `fromRef`, `toCardId`, `fromSystem`, `sourceRecordId`, `confidence`; CLI dry-run by default and `--apply` to write.

- [ ] **Step 1: Write failing migration tests**

  Create fixtures with a `card-<hash>` id and source refs in observation, valuation, identity decision and research note source JSON. Assert mapping creation, crosswalk rows, canonical UUID in all representative columns, append-only identity decision successor, idempotent rerun, exact-match failure list and dry-run makes zero writes.

- [ ] **Step 2: Run test to verify it fails**

  Run: `npx tsx --test tests/db/canonical-identity-migration.test.ts`
  Expected: FAIL because migration module is absent.

- [ ] **Step 3: Implement the migration script**

  Build mapping from `cards.identity_key`, evidence payloads and target refs. Mint UUIDs for all non-UUID `cards.id`. Write crosswalks with `from_system`, `from_id`, `to_system='slabswarm'`, `to_id=<UUID>`. Write aliases for human-readable alternate refs. Append new identity decisions with successor metadata; never UPDATE old ones. Repoint `cards.id`, `market_observations.target_identity_id`, `valuations.target_id`, `aliases.entity_id`, `printings.card_id`, `entities.canonical_ref`, `factor_scores.target_id`, `learning_events.target_id` and JSON research targets using the mapping. Dry-run reports counts and duplicates; apply writes idempotently.

- [ ] **Step 4: Run test to verify it passes**

  Run the same command. Expected: PASS, including no duplicate observation rows after a second apply.

- [ ] **Step 5: Commit**

  Message: `feat(identity): add canonical id mapping and repoint script`

---

### Task 3: Human-facing canonical search

**Files:**
- Modify: `server/db/repositories/card.ts`
- Modify: `server/serving/routes.ts`
- Test: `tests/serving/catalog-search-canonical.test.ts`

**Interfaces:**
- Consumes: canonical UUIDs and `source_kind` from Tasks 1–2.
- Produces: `searchCanonicalCards(query, scope)` returning `{ id, name, set, game, cardNumber, sourceKind, sourceRefs }[]`.

- [ ] **Step 1: Write failing search test**

  Assert `GET /api/catalog/search?q=Amalgamight&scope=research` returns `Amalgamight, Close Encounter` with UUID id, set `Nexus of Power`, game `Alpha Clash`, cardNumber `AC8-112 (C)`, and `sourceKind=RESEARCH_REFERENCE`. Assert `scope=first-party` excludes it. Assert no `tcg:*` id is returned as canonical id.

- [ ] **Step 2: Run test to verify it fails**

  Run: `npx tsx --test tests/serving/catalog-search-canonical.test.ts`
  Expected: FAIL because current search uses graph/ledger refs.

- [ ] **Step 3: Implement canonical search**

  Add repository search over cards joined to sets/games with lowercase matching, deterministic ranking, crosswalk sourceRefs and scope filter. Keep ledger fallback for rows with no canonical card, but mark fallback warnings and never return a source ref as canonical id.

- [ ] **Step 4: Run test to verify it passes**

  Run the same command. Expected: PASS.

- [ ] **Step 5: Commit**

  Message: `feat(search): return canonical cards by human-readable fields`

---

### Task 4: Active report canonical display and scope

**Files:**
- Modify: `server/contracts/activeReport.ts`
- Modify: `server/intelligence/active-report.ts`
- Modify: `server.ts`
- Test: `tests/intelligence/active-report-canonical.test.ts`

**Interfaces:**
- Consumes: canonical card lookup from Task 3.
- Produces: `ActiveCard` fields `id` UUID, `name`, `set`, `game`, `cardNumber`, `sourceKind`, `sourceRefs`; report accepts `scope=research|first-party`.

- [ ] **Step 1: Write failing report test**

  Assert report card id is UUID, display fields come from canonical card rows, source refs appear only in `sourceRefs`, research scope includes `RESEARCH_REFERENCE`, first-party scope excludes it, and incomplete canonical rows are excluded with an explicit warning.

- [ ] **Step 2: Run test to verify it fails**

  Run: `npx tsx --test tests/intelligence/active-report-canonical.test.ts`
  Expected: FAIL because report currently emits source refs and uses evidence payload display.

- [ ] **Step 3: Implement canonical report wiring**

  Add optional card lookup injection to `buildActiveReport`, wire it in `server.ts`, default display to canonical rows with evidence payload fallback flagged LOW, and add scope filter. Never promote fallback display to canonical confidence.

- [ ] **Step 4: Run test to verify it passes**

  Run the same command. Expected: PASS.

- [ ] **Step 5: Commit**

  Message: `feat(report): emit canonical card ids and human display fields`

---

### Task 5: Regenerated research, projections and human-proof log

**Files:**
- Create: `docs/proofs/2026-11-24-canonical-identity.md`
- Create: `scripts/verify-canonical-identity.ts`
- Test: `tests/integration/canonical-identity-proof.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4 deployed to a disposable DB and/or live controller-run environment.
- Produces: proof command runner and a real proof document with two-phase deploy output.

- [ ] **Step 1: Write failing proof test**

  Assert proof runner checks UUID regex on all canonical id fields, zero legacy prefixes, crosswalk count > 0, name search sample, report sample, evidence resolution, forecast/research counts > 0 with zero unresolved refs, source_kind counts, full suite count and deploy status placeholder.

- [ ] **Step 2: Run test to verify it fails**

  Run: `npx tsx --test tests/integration/canonical-identity-proof.test.ts`
  Expected: FAIL because proof runner is absent.

- [ ] **Step 3: Implement proof runner and proof template**

  Produce commands and recorded-output sections, not invented outputs. Include pre-deploy and post-deploy phases. Regeneration scripts must create fresh research and forecasts tied to canonical UUIDs and backfill `source.targetId` where exact provenance allows.

- [ ] **Step 4: Run test to verify it passes**

  Run the same command. Expected: PASS.

- [ ] **Step 5: Commit**

  Message: `docs(proof): add reproducible canonical identity proof`

---

## Controller integration after all tasks

1. Verify each task had a fresh reviewer with 0 Critical/Important findings.
2. Merge in task order into main.
3. Run full suite once on main. Expected: all tests pass.
4. Deploy with `sudo -n docker compose up -d --build`.
5. Run Task 2 migration dry-run, then apply against live DB.
6. Regenerate research, report, valuations and projections against canonical IDs.
7. Run proof runner and append real deploy output to the proof document.
8. Ledger the result. Do not mark complete if any proof check fails.
