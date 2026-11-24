# Canonical Card Identity and Human-Facing Search Design

Status: draft for owner approval. Owner chose Option A on 2026-11-24: canonical card UUIDs with source crosswalks.

Spec owner: Forrest Mcgee. Date: 2026-11-24.

## Intent

People search by card name, set, number and game. Machines need stable identity. Slabswarm currently uses source refs such as `tcg:719412` as `market_observations.target_identity_id` and as the active report card `id`, while the real `cards.id` is a UUID. That makes source identity the product identity and makes search, joins and API output fragile. The goal is to make the UUID canonical, source refs addressable as aliases, and human names first-class searchable fields.

TCGAPIs remains a schema/API reference only. Its 39 reference cards must be marked reference-only and must not silently stand in for first-party product catalog data.

## Goals

1. Canonical identity is `cards.id`, a stable UUID assigned once and never reused.
2. Source identifiers (`tcg:*`, `pokemontcg:*`, seller IDs, future provider IDs) live in `crosswalks` and `aliases`, not in canonical identity columns.
3. Search works by card name, set name, set code, card number and game, with deterministic ranking and no fuzzy guesses presented as facts.
4. Active report, forecasts, valuations, research notes and observations reference canonical card UUIDs and display human-readable name/set/game/number alongside them.
5. Existing data is migrated additively and reversibly in the sense that old source refs remain available as aliases. No raw evidence is rewritten or deleted.
6. Human proof: every acceptance criterion is checkable by a plain SQL query or curl command recorded in a proof log, with before/after counts and a sample search result.

## Non-goals

- No re-ingest of all historical sources as a prerequisite.
- No paid API calls, eBay or PSA live calls, TCGAPI credit use, firewall, DNS, listener or public-exposure changes.
- No new search infrastructure such as Elasticsearch or OpenSearch.
- No renaming of canonical UUIDs after launch.
- No final B2B API design in this change.

## Anti-goals

- Filling missing names, sets or games with invented values.
- Treating a source ref as a card just because an observation cited it.
- Letting reference-only TCGAPIs rows dominate the product report.
- Hiding unresolved identity in a display-name layer while leaving the wrong keys underneath.

## Constraints

- Additive migrations only. Never edit an applied migration.
- Keep source observation time (`observed_at`) separate from ingest time (`captured_at`).
- Basis stays explicit: SOLD / GUIDE / ASKING / OFFER / CLAIM / POPULATION / UNKNOWN.
- Missing values stay UNKNOWN, never zero.
- Every fact still carries source, observed_at, captured_at, lineage and confidence.
- Identity match keys must derive from the declared identity fields, not a second hand-maintained list.
- Append-only evidence rules remain. Corrections append. Crosswalks and aliases are additive mappings; canonical writes are auditable.
- No destructive SQL: no DELETE, TRUNCATE or raw evidence rewrite.

## Approaches considered

### A. Canonical UUID with source crosswalks — chosen

`cards.id` becomes the only canonical target for observations and downstream products. Crosswalks map source systems to the UUID. Aliases hold human-readable and alternate identifiers. Search uses card columns plus set/game tables.

Pros: correct long-term identity, multiple sources resolve to one card, stable for a commercial API, human search works naturally.
Cons: largest data migration; must be done with failing tests and review gates.

### B. Source refs with a search index — rejected

Keep `tcg:*` as the product identity and build a name lookup over it.

Pros: quickest.
Cons: leaves the identity defect in place. Two sources for one card remain two cards. Unacceptable for a data product.

### C. Human-readable slugs as primary identity — rejected

Use slugs like `alpha-clash/nexus-of-power/ac8-112-c` as the card key.

Pros: readable URLs.
Cons: slugs can change when catalog data improves. A stable UUID plus slug aliases gives the same benefit without the fragility.

## Design

### Data shape

- `cards.id`: canonical UUID. Existing UUIDs are preserved. Any source-ref-valued `cards.id` must be replaced by a new UUID and the old value kept as an alias/crosswalk.
- `cards.name`, `cards.card_number`, `cards.variant`: human-facing fields on the canonical card.
- `cards.set_id`: points to `sets.id`; `sets.game_id` points to `games.id`.
- `crosswalks`: exact source identity rows, e.g. `from_system='tcgapis'`, `from_id='tcg:719412'`, `to_system='slabswarm'`, `to_id=<card UUID>`, with confidence and source evidence.
- `aliases`: alternate human-readable strings and source refs, e.g. `alias='AC8-112 (C)'`, `source='tcgapis'`.
- Add an explicit `reference_only` flag or facet on cards/evidence so TCGAPIs catalog rows are excluded from first-party report ranking unless the owner asks otherwise.
- Add searchable indexes on `cards.name`, `cards.card_number`, `sets.name`, `sets.code`, `games.name` and normalized facets. Use lowercase normalized columns or expression indexes; do not rely on substring scans over JSON.

### Identity resolution

- Match keys derive from one declared field list: game, set, name, card number, variant. Changing any of those fields changes the key.
- A source ref alone never creates a canonical card. It creates or updates a crosswalk to an existing card when exact provenance matches.
- If no canonical card exists and the source record carries a complete human identity (name + set + number + game), create one canonical card with a new UUID, then write the crosswalk.
- If identity is incomplete, quarantine it. Do not invent values.
- Identity decisions remain append-only and point at canonical UUIDs after migration.

### Downstream references

- `market_observations.target_identity_id` becomes the canonical card UUID.
- `valuations.target_id`, `forecasts.target_id`, `research_notes.source.targetId` and active report `cards[].id` follow the same canonical UUID.
- Display fields return `id` as UUID and `name`, `set`, `game`, `cardNumber` as human data.
- API responses may include `sourceRefs` from crosswalks; they are never the primary id.

### Migration sequence

1. Additive schema migration: games/sets normalization support, crosswalks/aliases indexes, search indexes, reference-only flag.
2. Backfill games and sets from card facets and evidence payloads where exact values exist.
3. Create crosswalks from source refs already present in `cards.identity_key`, evidence payloads and observation target refs.
4. Mint canonical UUIDs for source-ref-valued card IDs; repoint references.
5. Repoint observations, valuations, forecasts and research notes to canonical UUIDs.
6. Update serving and report code to join on canonical UUID and expose human fields.
7. Regenerate report, valuations, research and projections from migrated data.
8. Write human-proof log and run full suite once, then deploy.

## Human proof

A plain-language proof file must be produced at `docs/proofs/2026-11-24-canonical-identity.md`. It must contain commands and expected results for:

1. `select count(*) from crosswalks` before and after; source refs preserved.
2. No source-ref-shaped values remain in `cards.id`, `market_observations.target_identity_id`, `valuations.target_id` or report `cards[].id`.
3. `GET /api/catalog/search?q=Amalgamight` returns `Amalgamight, Close Encounter` with canonical UUID, set, game and number.
4. `GET /api/intelligence/active-report` returns the same UUID and human fields for the card.
5. Every report cited evidence ID resolves in `evidence_records`.
6. Forecast and research outputs reference canonical UUIDs or resolve source IDs through crosswalks, with zero unresolved references.
7. TCGAPIs reference rows are flagged and absent from first-party report ranking.
8. Full suite count and deploy result.

Proof must show real command output. No invented sample output is permitted.

## Builder check — folded decisions

Builder check on 2026-11-24 found that the first draft was not buildable as written. These decisions are now binding:

1. Canonical IDs: 235 `card-<hash>` ids are not canonical. Mint fresh UUIDs for all non-UUID card ids using a recorded old→new mapping table; preserve old values as crosswalks/aliases. Only UUID-shaped ids may appear in `cards.id`, observation targets, valuation targets and report card ids.
2. Source-ref shape: proof item 2 uses a UUID regex plus a zero-count assertion for every legacy prefix, including `tcg:`, `pokemontcg:`, `card-`, `TCG-`, `sale:` and any other observed scheme. A prefix-only check is not acceptable.
3. Quarantine: observations without complete human identity stay in a quarantine inventory with count, refs and reason. They are excluded from product outputs, so output references are zero-unresolved. The inventory is a stated gap, not an invented card.
4. `identity_key` becomes a dedupe hint only, recomputed from game/set/name/number/variant. A key change never rewrites a UUID. Collisions go to QA quarantine.
5. Games and sets are created from distinct exact text values in current data. `One Piece` and `One Piece Card Game` remain distinct unless the owner later rules otherwise. Missing values stay UNKNOWN.
6. `reference_only` is a boolean on `cards`, default false, set on the 39 TCGAPIs reference cards. Their observations are excluded from first-party ranking and report figures. Visibility in human search is the open owner question below.
7. Search becomes canonical-card-first with sets/games joins, deterministic dedupe against ledger identities and evidence-payload fallback. The proof searches the full name `Amalgamight, Close Encounter`.
8. Report display fields come from canonical cards plus sets/games lookups. If a canonical card lacks complete display fields, the observation is excluded with an explicit warning. Evidence payload fallback is flagged LOW, never presented as canonical.
9. Repoint scope includes every text column that can hold a card ref: observations, valuations, forecasts, research targets, identity decisions, aliases, printings, entities, factor scores and learning events. One old→new mapping table drives all repoints.
10. Proof 6 is non-vacuous: generate fresh forecasts and research after migration, assert counts > 0, backfill `source.targetId` on existing research rows where exact provenance allows, and query zero unresolved refs through the mapping.
11. Proof 8 is written in two phases. Pre-deploy output is appended first; real deploy output is appended after the controller deploy.
12. Identity decisions are append-only. Add new canonical decision rows referencing UUIDs and record the supersede; never UPDATE old rows.
13. Crosswalk vocabulary: `from_system` is the declared source id (`tcgapis`, `pokemontcg`, `scryfall`, `carddex`, `cardex`, `web:<id>`), `from_id` is the full source ref, `to_system='slabswarm'`, `to_id` is the canonical UUID. Exact provenance means source id plus source record id; ambiguous rows are listed, never guessed.
14. Observation repoint uses an idempotent remap matched on evidence id, basis, observed_at and old target ref. A dry-run duplicate count is recorded before apply; future upserts use the canonical UUID.

## Open owner question

Should TCGAPIs reference-only cards remain visible in human search, clearly flagged as reference-only, or be hidden from product search entirely? My recommendation: visible but flagged, because they are real catalog evidence and useful for research, while first-party ranking and reports exclude them.

## Builder check status

Builder check completed with `blocked_pending_owner_decisions`. Answers above close all settled items; one visibility question remains for the owner.
