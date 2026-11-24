# Research and Database Population Plan — 2026-11-23

Status: active. Owner instruction: fan out subagents to audit the implementation plan and actually start populating research and database.

Authority: `/opt/slabswarm/docs/PRODUCT_GOAL.md`, especially the Active execution goal added 2026-11-23. The value is the join of catalog, first-party identity and sourced price evidence. No invented card, price, sale, research claim or canonical write.

Baseline: main `e447e1c`. Full suite 543/543. Live internal API `http://10.99.0.1:3010` with app-level auth disabled; public Caddy gate remains 302 to `/gate/login`. Docker containers `slabswarm` and `slabswarm-db`. Baseline counts: cards 292, evidence 443, observations 261, identity decisions 274, valuations 243, swarm research notes 1. Active report: 50 cards, insufficientEvidence false.

## Rulings before fan-out

1. No code changes in this plan. Workers may write only their named scratch report files and the live tables named in their task. Any code defect found becomes a finding for the controller, not an in-lane refactor.
2. Disjoint live write sets: audit lane is read-only; research lane writes `research_notes` only; database lane writes `cards`, `evidence_records`, `market_observations`, `identity_decisions` and `valuations` only. No worker may drop, truncate, delete or rewrite existing rows; inserts and idempotent upserts only.
3. No credentials in prompts or reports. No eBay, PSA or TCGAPI paid calls. No new listener, firewall rule, DNS record or public exposure.
4. Free public sources only, under existing allowlists/rate limits. Empty allowlist means zero network calls. Any gated or licensed source is a dataset gap, not a reason to invent data.
5. Basis stays explicit: SOLD / GUIDE / ASKING / OFFER / CLAIM / POPULATION / UNKNOWN. Missing values stay UNKNOWN, never zero. Every research claim cites evidence IDs.
6. Stale worktrees were inventoried. Only untracked artifacts remain (`node_modules`, lockfiles, old progress/report files); no committed in-flight lane work is inherited. Workers do not use those worktrees.

## Tasks

### A — Plan and implementation audit (read-only)

Read `docs/PRODUCT_GOAL.md`, the master plan, Free Data Foundation plan, Web Harvest plan, the progress ledger and the live API/DB. Produce a gap register with severity, evidence path/endpoint, and a recommended next plan task. Do not write to the repository or database. Report file: `/home/hermes/.hermes/cache/scratch/dp-population/audit.json`.

### B — Research population

Run bounded evidence-first research cycles through `POST /api/swarm/research/run` and fetch each run via `GET /api/swarm/runs/:id`. Persist each distinct run as a `research_notes` row with cited evidence IDs, role claims, decision and explicit missing data. Do not promote any proposal to a canonical fact. Report file: `/home/hermes/.hermes/cache/scratch/dp-population/research.json`.

### C — Database population

Use existing server endpoints and idempotent scripts to harvest/log more cards and price observations from allowlisted free sources, then verify counts through both Postgres `count(*)` and `/api/db/status`. Do not touch `research_notes`. Report file: `/home/hermes/.hermes/cache/scratch/dp-population/database.json`.

## Integration gate (controller)

After all three reports return: reconcile counts, check DB integrity and endpoint health, review audit findings, run the full suite once on main, deploy only if code changed, and append completion/decisions to the progress ledger. Do not call the goal complete if any task reports an unresolved Critical or Important finding.
