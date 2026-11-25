# Slabswarm Implementation Status

Date: 2026-11-24
Repository: `/opt/slabswarm`
GitHub: `https://github.com/cozy-afk/SlabSwarm.git`
Deployed public URL: `https://slabswarm.144-21-43-141.sslip.io/`

This document records what is actually deployed, what exists in the repository, and what remains blocked. It is written from real command output, repository history and the project ledger. It does not claim that planned work is shipped if it is only on a branch.

## 1. Executive summary

Slabswarm is a working, self-hosted trading-card data product. The live app collects evidence, stores canonical observations in Postgres, produces evidence-cited research, generates price bands and serves a UI behind one shared external gate.

Current deployed code is functionally healthy. It is not yet on the final identity model. The live database still uses source refs such as `tcg:719412` as card identifiers, with no crosswalks or aliases populated. A full canonical-identity rebuild has been implemented on a separate branch but is blocked from merge by final review; it has not been deployed.

GitHub `main` is current with local `main` at commit `1f1cf5f`. The canonical identity branch is local-only at `d8e7051`.

Binding product goal: [docs/PRODUCT_GOAL.md](/opt/slabswarm/docs/PRODUCT_GOAL.md).

## 2. What is deployed and working

### Runtime

- Docker Compose stack under `/opt/slabswarm`.
- App container `slabswarm`, healthy, bound to `10.99.0.1:3010`.
- Postgres container `slabswarm-db`, healthy, internal `5432`.
- Caddy container provides the shared external form gate. Public root returns 302 to `/gate/login`; `/gate/login` returns 200.
- No new listener, firewall rule, DNS record or cloud security-list change was added for the app.

### Data in Postgres

Last verified counts:

| Table | Rows |
|---|---:|
| `cards` | 293 |
| `evidence_records` | 443 |
| `market_observations` | 261 |
| `identity_decisions` | 275 |
| `valuations` | 243 |
| `research_notes` | 15 |
| `forecasts` (DB table) | 0 |

The 27 live forecasts are in the in-memory forecast repository, not in Postgres. An app restart clears them until regenerated.

### Active report

`GET /api/intelligence/active-report` was healthy and returned:

- `totalEvidence`: 443
- `totalObservations`: 261
- `cardsObserved`: 50
- `insufficientEvidence`: false
- Evidence citations: 96 cited, 0 unresolved

The report still emits source-ref IDs. Example: `tcg:719412`, displayed as `Amalgamight, Close Encounter`, set `Nexus of Power`, game `Alpha Clash`, basis `GUIDE`.

### Verified endpoints

All returned 200:

- `/api/health`
- `/api/db/status`
- `/api/evidence`
- `/api/observations`
- `/api/forecasts`
- `/api/intelligence/active-report`
- `/api/tracking/summary`
- `/api/qa/match-queue`
- `/api/web-harvest/sources`

Health response time: 0.003s. No server errors in recent logs.

## 3. Capabilities added

### 3.1 Canonical data foundation

Implemented under the data-product foundation plan.

- Postgres schema and migrations.
- Typed repositories for cards, evidence, observations and identity decisions.
- Internal Postgres 17 service.
- JSON ledger/graph retained as an import/export artifact.
- `/api/db/status` reports migrations and table counts.
- Key commits: `9e2cb60`, `b720708`, `7225d9b`, `5b28158`, merged at `5d9e3b1`.

### 3.2 Ingestion and evidence

- Free feed adapters: Scryfall, Pokémon TCG API, CardDex and Cardex.
- Cardex daily request cap enforced across adapter fetches.
- Server-stamped `capturedAt`; callers cannot forge capture time.
- Free-feed harvest promotes accepted candidates into canonical cards and observations.
- Manual and CSV ingest paths.
- Web harvest with operator-controlled sources, robots/licence awareness and a review queue.
- TCGAPIs rows are treated as schema/API reference data only. They remain in the one database as source-attributed research rows, not as first-party verified data.
- eBay and PSA integrations remain gated; no live feed was enabled.

Key commits include `62ce523`, `8c0da13`, `5ef0fcb`, `787d227`, `d26e755`.

### 3.3 Identity and evidence integrity

- Deterministic identity resolver.
- Quarantine and QA queue for low-confidence matches.
- Human approval authority recorded before override release.
- Canonical evidence-ID repair fixed three separate write paths:
  - free-feed promotion (`7c5645a`)
  - sync and QA re-approval (`15b10d2`)
  - web-harvest approval (`58a61ef`)
- Duplicate-ledger ambiguity repaired by exact observation timestamp (`eec5222`).
- Result: 261/261 observations resolve to an evidence record; active report cites 96 evidence IDs, 0 missing.

Merged at `e0391d4` and `3c3d745`.

### 3.4 Analytics and intelligence

- Deterministic discovery sweep.
- Active trading report.
- Deterministic FMV with IQR outlier handling and confidence bands.
- Liquidity, population and demand factor pack.
- Forecast drafts, scoring and learning scaffolding.
- Parquet lake export and DuckDB SQL Lab.
- Evidence-first swarm runs with roles, proposals and a review gate.

Key commits include `f1126e8`, `7d26014`, `e87c727`, `cd684f8`, `4af4e57`, `704a181`.

### 3.5 Research and pricing cycle

- Research endpoint accepts the UI payload `{question, mode}` and builds evidence from canonical Postgres.
- Every research run is now persisted to `research_notes` with cited evidence IDs, role claims, decision and source metadata. The note ID is derived from the content-addressed run ID, so repeats are idempotent and do not change `created_at`.
- 4 post-repair research notes cite 6 resolvable evidence rows each, with 33 role claims each.
- All current proposals are `REJECT`; no model claim was promoted to a canonical fact.
- 27 forecasts were generated: 9 target cards × 7/30/90-day horizons, all `HYPOTHESIS`, with ordered price bands and zero unresolved evidence refs.
- Projected targets currently have GUIDE-only observations, so no scored forecast was invented.
- 28 SOLD observations exist elsewhere in the database but not on the projected targets.

### 3.6 UI and API contracts

- Eight product sections: catalog, market intelligence, valuation/arbitrage, research, learning, forecast lab, tracking and sources.
- Shared `{ data, meta }` envelope restored for UI routes.
- UI compatibility fields preserved for catalog views.
- Watchlist, alerts and portfolio surface behind the existing gate.
- Hermes bridge tool IDs kept stable.

Key commits include `abb6ae0`, `d6e0175`, `9da64c1`, `876dc43`, `eae4e5d`, `73cc36b`.

### 3.7 Security and credentials

- Public access remains protected by the Caddy shared form gate.
- App-level operator passcode removed because the login option was no longer usable. `/api/auth/status` reports `locked: false`, `source: open`.
- eBay sandbox credentials are stored locally in `/opt/slabswarm/.env` with mode `0600`; no value is in code, docs or chat. No eBay feed is enabled.
- HERMES_BRIDGE_TOKEN remains in `.env` but is inert while the app-level lock is disabled.

## 4. Repository and GitHub state

- Local `main`: `1f1cf5f`.
- GitHub `origin/main`: `1f1cf5f`.
- `git push origin main` completed successfully; 165 commits were pushed.
- Only `main` exists on GitHub. No `dp-*` branches were published.

## 5. Work in progress, not merged or deployed

### Canonical identity branch

Branch: `dp-canonical-identity`
Worktree: `/opt/slabswarm/.superpowers/sdd/dp-canonical-identity`
Head: `d8e7051`

Goal: make `cards.id` a stable UUID, move source IDs into crosswalks and aliases, make search and reports use human-readable name/set/game/number fields, and keep all card types in one canonical database with `source_kind` provenance.

Five tasks were implemented and reviewed:

1. Additive provenance and search schema (`0b06ec3`).
2. Atomic canonical UUID mapping and repoint script (`00dce12`).
3. Canonical human-facing search (`2139b0a`).
4. Canonical active-report display and scope (`da7d8ca`).
5. Proof runner and regeneration CLI (`5385444`).

A final fix wave added proof-output scoping, migration-before-traffic ordering and a disposable-Postgres rehearsal script (`0f1a055`, `d8e7051`).

Current blockers:

- Final re-review rejected the fix wave.
- The fix stored `UNKNOWN` as a fourth `source_kind`, violating the binding three-value constraint: `FIRST_PARTY`, `RESEARCH_REFERENCE`, `OBSERVED_SOURCE`.
- Full suite on the branch: 612 passed, 3 failed.
  - `tests/intelligence/active-report-evidence-integrity.test.ts:14`
  - `tests/intelligence/active-report-evidence-integrity.test.ts:60`
  - `tests/serving/canonicalSource.test.ts:110`
- The real-Postgres rehearsal script exists but was not executed.
- No branch merge or live migration was performed.

Nothing was lost. The branch is intact and the live app remains healthy.

## 6. Known limitations of the deployed app

1. Source refs such as `tcg:719412` are still used as canonical card IDs in the report.
2. `crosswalks` and `aliases` tables are empty.
3. Forecasts live in memory, not in the `forecasts` table.
4. Learning cycles, forecast scores and factor scores are empty.
5. TCGAPIs rows are not distinguished by `source_kind` in the deployed schema.
6. Research proposals are all rejected; the review gate has not accepted an insight as canonical.
7. eBay, PSA and paid APIs remain ungated for data access.
8. The 119 MB JSON ingest ledger still participates in runtime loading and once caused a multi-minute stall. Postgres is not yet the sole runtime source of truth.
9. Many observation targets still lack human-readable set/game/number identity.

## 7. Decisions and rulings

- TCGAPIs is a schema/API reference only. Its rows stay in the one canonical database as source-attributed research data, not as first-party verified product data.
- No invented card, price, sale, name, set, game or research claim is allowed.
- Basis is explicit: SOLD / GUIDE / ASKING / OFFER / CLAIM / POPULATION / UNKNOWN. Missing values stay UNKNOWN, never zero.
- Basis and currency are never pooled silently.
- Raw evidence is immutable; corrections append.
- No new listener, firewall rule, DNS record or public exposure without explicit approval.
- Docker operations use `sudo -n docker`.
- Credentials stay server-side with `0600` permissions and never appear in code, docs or chat.
- Canonical identity tasks execute sequentially in one worktree; the controller owns merges, live DB writes, full suite and deploy.

## 8. Verification commands

From `/opt/slabswarm`:

```bash
curl -s http://10.99.0.1:3010/api/health
curl -s http://10.99.0.1:3010/api/db/status
curl -s http://10.99.0.1:3010/api/intelligence/active-report
curl -s http://10.99.0.1:3010/api/forecasts

sudo -n docker exec slabswarm-db psql -U slabswarm -d slabswarm -Atc \
  "select 'cards',count(*) from cards union all \
   select 'evidence',count(*) from evidence_records union all \
   select 'observations',count(*) from market_observations union all \
   select 'valuations',count(*) from valuations union all \
   select 'research_notes',count(*) from research_notes"

curl -s -o /dev/null -w '%{http_code}\n' \
  https://slabswarm.144-21-43-141.sslip.io/
```

## 9. Documentation index

- Product goal: `docs/PRODUCT_GOAL.md`
- Canonical identity design: `docs/superpowers/specs/2026-11-24-canonical-card-identity-design.md`
- Canonical identity plan: `docs/superpowers/plans/2026-11-24-canonical-card-identity-implementation.md`
- Evidence ID repair plan: `docs/superpowers/plans/2026-11-24-evidence-id-integrity-repair.md`
- Free-data plan: `docs/superpowers/plans/2026-11-23-free-data-foundation-plan.md`
- Web harvest plan: `docs/superpowers/plans/2026-11-23-web-harvest-plan.md`
- Data-product master plan: `docs/superpowers/plans/2026-11-22-data-product-master-plan.md`
- Gap audit: `docs/audits/2026-11-23-capability-gap-audit.md`
- Benchmarks: `docs/benchmarks/`
- Research notes and reviews: `docs/research/`
- API reference: `docs/openapi.json`
- Deploy notes: `docs/slabswarm-deploy.md`
- eBay key entry: `docs/ebay-key-entry.md`

## 10. Bottom line

The deployed product works: catalog, evidence, observations, prices, research and reports are readable through the API and Postgres. GitHub is synced to the deployed source state.

The next hard problem is identity. The live app still uses source refs as card IDs. The fix exists on a branch but is blocked by a spec violation and three failing tests. Do not deploy or migrate from that branch until the three stored `source_kind` values are restored and the full suite is green.
