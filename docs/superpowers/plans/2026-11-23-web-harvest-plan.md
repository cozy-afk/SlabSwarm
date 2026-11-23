# Web Source Harvesting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Give Slabswarm a first-party web-ingestion path so its swarm can gather public catalog and market evidence, propose candidates, and let an operator approve them into the canonical catalog. TCGAPIs remains a schema reference only.

**Architecture:** An operator-configured allowlist of public sources feeds a web adapter. Fetches are deterministic, rate-limited, robots-aware and recorded as immutable raw evidence with source, license, timestamps and lineage. Two new swarm tools expose source discovery and bounded web harvest; roles may propose candidates but never write canonical facts. An operator queue reviews proposals before they enter `cards`/`market_observations`.

**Tech Stack:** TypeScript, Express, Node test runner, existing ingest/adapter and swarm role machinery, existing React UI.

**Spec:** `docs/superpowers/specs/2026-11-22-data-product-design.md` goal 1 ("public mentions, catalog metadata") and its rule that models propose while deterministic code writes canonical facts.

## Global Constraints

- Raw evidence immutable; corrections append.
- No source is fetched unless explicitly enabled in the operator allowlist. Empty allowlist means zero network calls.
- Respect robots.txt, declared license and a per-source rate limit. Never bypass a paywall or access control.
- No secrets in URLs, logs, client bundles or docs.
- Basis explicit; missing values UNKNOWN; no invented prices or catalog facts.
- Swarm agents propose only. Operator approval is required before a web candidate becomes canonical.
- No new public listener, firewall or DNS change. Use `sudo -n docker` for Docker.
- All tests use injected/mocked HTTP. No live scraping in tests.

## Review Focus

- A swarm role writing straight to `cards`: must be impossible; the only path is operator approval.
- An empty allowlist still making requests: must be zero calls.
- A web candidate being treated as SOLD evidence: basis must be preserved from source or UNKNOWN.

---

### Task 1: Web adapter and source registry

**Files:** `server/ingest/adapters/web.ts`, `server/ingest/sources.ts`, `tests/ingestion/web.test.ts`.

- [ ] **Step 1:** Freeze `server/contracts/webHarvest.ts` types (controller-owned): `WebSourceConfig`, `WebHarvestCandidate`, `WebHarvestResult`.
- [ ] **Step 2:** Failing tests: empty allowlist makes zero fetches; robots-disallowed source is skipped; JSON selector extraction produces candidates with provenance; HTML parse failure yields zero candidates and a safe error; rate limit is honoured; basis is preserved and never defaults to SOLD.
- [ ] **Step 3:** Implement `WebSourceAdapter` using injected fetch and the existing `IngestAdapter` interface. Emit raw evidence only; do not create observations.
- [ ] **Step 4:** Add `GET/POST /api/ingest/web-sources` for operator allowlist management (non-secret config only) and `POST /api/ingest/web-harvest`.
- [ ] **Step 5:** Run lane tests and typecheck, commit.

### Task 2: Swarm web tools and evidence-scout behaviour

**Files:** `server/swarm/webTools.ts`, `server/swarm/roles.ts` (scoped additions), `tests/swarm/webTools.test.ts`.

- [ ] **Step 1:** Failing tests: `search_web_sources` returns only enabled allowlist entries; `harvest_web_source` returns a bounded evidence packet and never a canonical write; a proposal without evidence IDs is rejected; the evidence-scout role emits structured citations for web-derived items.
- [ ] **Step 2:** Register the two tools in the closed allowlist and wire them to the adapter with injected fetch.
- [ ] **Step 3:** Run lane tests and typecheck, commit.

### Task 3: Operator review queue and UI

**Files:** `server/webharvest/routes.ts`, `server/webharvest/store.ts`, `src/components/product/WebSourcesView.tsx`, `tests/webharvest/**`, `tests/ui/**`.

- [ ] **Step 1:** Failing tests: candidates land in a review queue with provenance; approving one writes a LOW-confidence catalog card and evidence-backed observation; rejecting removes it from the queue; no approval means no canonical write; UI lists sources, candidates and approve/reject actions without placeholders.
- [ ] **Step 2:** Implement the queue and view. Every candidate displays source, basis, currency, observed_at and confidence.
- [ ] **Step 3:** Run lane tests and typecheck, commit.

### Task 4: Integration and verification

- [ ] Merge lanes, wire routers into `server.ts` (integrator-owned), run all 51+ test files and typecheck.
- [ ] Rebuild the existing container; verify the API with an empty allowlist makes zero external calls, and with a mocked local fixture source can harvest, propose and approve one card.
- [ ] Record results in `docs/benchmarks/2026-11-23-web-harvest.md`.
