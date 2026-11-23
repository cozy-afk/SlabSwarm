# Metered B2B API — design decision and prerequisites

Status: **DESIGN ONLY — NOT APPROVED FOR IMPLEMENTATION, LAUNCH OR BILLING.**
Date: 2026-11-23
Plan origin: `docs/superpowers/plans/2026-11-23-free-data-foundation-plan.md` § Task 18; scope folded in from `docs/research/2026-11-23-commercial-scope-fold-in.md`.
Binding goal: `docs/PRODUCT_GOAL.md`. Conflicts resolve against that goal and the plan's evidence-first rules, not toward a commercial deadline.

## 1. Decision recorded here

**We are not launching a metered B2B API.** This document defines what one would have to be, and lists the gates that are currently closed. It adds no route, no listener, no billing provider, no API gateway, no npm dependency and no code. Nothing in this document is an implementation instruction until the owner decisions in §10 are made and the §9 prerequisites are met.

One line: **a meter on an unproven, partly unlicensed dataset only sells the gap faster.**

Blunt status of the four launch pillars:

| Pillar | Today | Verdict |
| --- | --- | --- |
| Data quality | 147 evidence rows, all `PENDING` parse and `UNKNOWN` trust; 58 priced candidates of which 51 `GUIDE` and 7 `SOLD`; 89 catalog-only | NOT READY |
| Provenance completeness | Provenance contract exists; served-subset completeness has never been audited to 100%; 0 aliases | NOT READY |
| Licensing (esp. redistribution) | Scryfall terms conflict with paywalling; eBay sold data gated; PSA EULA/token gated; CardDex attribution required | NOT READY |
| Commercial decisions (billing, price, quota, terms) | No provider, no price, no quota numbers, no terms | NOT DECIDED |

The default outcome if any of these is still open at a future go/no-go is **do not launch**. "Later" is not a decision.

## 2. What exists today (the basis; do not conflict with it)

Every convention below is read from the current tree. The metered surface, if ever built, must reuse these names, shapes and mount points.

| Concern | Existing artifact | Fact taken from it |
| --- | --- | --- |
| Success envelope | `server/serving/catalog.ts` (`envelope`, `makeMeta`, `ApiMeta`, `ApiEnvelope`) | `{ data, meta }`; `meta` = `requestId`, `generatedAt`, `contractVersion`, `correctionPolicy: 'APPEND_ONLY'`, optional `source`/`basis`/`currency`/`provenance`, `warnings` |
| Error envelope | `server/serving/catalog.ts` (`errorEnvelope`) | `{ data: null, error, code, meta }` — same five `meta` fields |
| Contract version | `server/contracts/dataProduct.ts` (`CONTRACT_VERSION`) | `2026-11-22.1`; documented in `docs/api/README.md` and `docs/openapi.json` |
| Basis vocabulary | `server/contracts/dataProduct.ts` (`MarketBasis`), `src/types/dataProduct.ts` (`BASIS_VALUES`) | `SOLD`, `ASKING`, `OFFER`, `GUIDE`, `CLAIM`, `POPULATION`, `UNKNOWN`; explicit, never inferred or defaulted |
| Missing values | `server/serving/catalog.ts` (`UNKNOWN`) | Missing shipping, fees, FX, grade, condition or population stays the literal string `UNKNOWN`, never zero or `null` |
| Read routes | `server/serving/routes.ts` (`createServingRouter`) | Six GETs: `/api/catalog/search`, `/api/catalog/:id`, `/api/catalog/:id/printings`, `/api/pricing/:id`, `/api/comps/:id`, `/api/market/:id`. Ordering matters: `/api/market/:id` mounts after `/api/market/observations` so it cannot shadow it (`server.ts:2232-2234`) |
| Mount, no listener | `server/serving/routes.ts` (`mountServingRoutes`), `server.ts:2234` | A mount function on an existing Express app; the only listener is `server.ts:2270` `app.listen(PORT, '0.0.0.0')` on the existing internal bind |
| Operator gate | `server/auth.ts` (`createOperatorAuthManager`, `requireAuth`, `issueSessionToken`, `verifySessionToken`, `verifyBridgeToken`) | Shared passcode session token (`Bearer`) or `HERMES_BRIDGE_TOKEN`; TTL 24 h; scrypt-hashed passcode and constant-time comparison |
| Gated surfaces today | `server.ts:255-272` and onward | `/api/db`, `/api/admin/export-parquet`, intelligence, `/api/web-harvest`, `/api/qa`, `/api/admin/web-harvest/lake-export`, research, market observations, media, graph, LLM, swarm, Hermes, alerts and portfolio routes use `requireAuth`. The six **serving reads are mounted without `requireAuth`**; their only protection is the existing reverse-proxy shared gate (`docs/api/hardening/README.md:47-57`, `docker-compose.yml:16-17` publishes `10.99.0.1:3010:3000`) |
| Error hygiene | `server/analytics/routes.ts:215-231` | Never echo raw exception text; it may contain connection strings or secrets |
| Feed licensing contract | `server/contracts/freeFeed.ts` (`FreeFeedRecord`, `FreeFeedConfig`) | Every feed record carries `license` and `attribution`; `license` missing means disabled; optional key is an env-var **name**, never a value. Configs in `server/ingest/freeFeeds.ts` (`FREE_FEEDS`) |
| Canonical fact shapes | `server/contracts/dataProduct.ts` (`EvidenceRecord`, `MarketObservation`, `CoverageSnapshot`), `server/contracts/freeFeed.ts` | Raw evidence immutable; observations carry `evidenceId`, `targetIdentityRef`, `basis`, `amount`, `currency`, `observedAt`, `status`; all reads are append-only from `RepositoryBundle` |
| Human release authority | `server/identity/qaAuthority.ts`, `server/identity/qaRoutes.ts`, `server/identity/qaQueue.ts` | Only a server-recorded human `APPROVE` with a committed canonical write releases a quarantine; authority is never read from a proposal or model-shaped object |
| Public listener policy | `docs/api/hardening/README.md:57-58` | "No new public listeners were introduced" — keep all existing binds and the shared gate as-is |

## 3. Proposed surface — reuse, do not invent

The metered surface is a **commercial wrapper around the existing read routes**, not a new endpoint family. No new path is created by this document, and no existing path, method or payload is changed.

**Candidate allow-list (proposal, subject to §9/§10):**

| Existing route | Source of truth | Meter note |
| --- | --- | --- |
| `GET /api/catalog/search` | `server/serving/routes.ts:119` | 1 unit per successful 2xx response, independent of `limit` for v1 (see D2) |
| `GET /api/catalog/:id` | `server/serving/routes.ts:152` | 1 unit |
| `GET /api/catalog/:id/printings` | `server/serving/routes.ts:170` | 1 unit |
| `GET /api/pricing/:id` | `server/serving/routes.ts:187` | 1 unit; basis is caller-selected with `UNKNOWN` default discipline |
| `GET /api/comps/:id` | `server/serving/routes.ts:221` | 1 unit; `SOLD`-eligible evidence only |
| `GET /api/market/:id` | `server/serving/routes.ts:252` | 1 unit; basis-separated counts, never summed |

**Explicitly out of scope for every customer key** (these stay on the existing operator gate in `server.ts`): all `/api/admin/*`, `/api/db/*`, ingest and free-feed routes, `/api/web-harvest/*`, `/api/qa/*`, `/api/research/*`, `/api/market/observations*`, media, graph read/write/reset, LLM provider and routing, swarm run, Hermes chat/tools, alerts and portfolio routes. A customer credential must never be able to reach a write path, an operator path, the SQL lab or the QA queue.

No key-management, billing, checkout, webhook or usage-query endpoints are specified here. If they are introduced later they must be operator-gated exactly like `/api/qa` and `/api/web-harvest` in `server.ts:265-270`, and must not rely on the `/api/*` catch-all at `server.ts:2237-2239` to define their semantics. Any new public path needs an explicit owner decision.

## 4. API key lifecycle (design only)

Separate credential namespace. Customer keys are **not** operator session tokens (`server/auth.ts` `issueSessionToken`) and **not** the bridge token (`HERMES_BRIDGE_TOKEN`). Accepting either across the boundary would turn a 24 h operator credential into a billable tenant credential.

States: `PROVISIONED → ACTIVE → SUSPENDED → REVOKED`, plus `EXPIRED` as a terminal transition from `ACTIVE`/`SUSPENDED`.

| Transition | Rule |
| --- | --- |
| Provision / issue | Human/operator action only. Generate a high-entropy secret; store only a salted scrypt hash plus a non-secret `keyId` and tenant binding (pattern from `server/auth.ts:12-25`). Return the plaintext secret once, out of band. Never in chat, code, tests, docs, logs, URLs or client bundles. |
| Activate | Explicit tenant + quota class + allowed source set (§9.3) recorded server-side. No key is active without a licensed data subset assigned. |
| Use | `Authorization: Bearer <customer-key>` or an `X-API-Key` header. Never a query parameter — query strings land in access logs. Compare in constant time (`safeEqualText` pattern at `server/auth.ts:29-33`). Resolve `keyId`, verify hash, check state, then check tenant's licensed subset. |
| Rotate | Issue a replacement with an overlap window; both secrets map to the same `keyId`/tenant until the old one is revoked. Overlap length is an owner decision (D5). Rotation never mutates prior usage records. |
| Suspend | Stops metering and serving without destroying history; reversible by an operator. Used for suspected abuse or an unresolved licence dispute. |
| Revoke / expire | Terminal for that secret. Existing usage records remain append-only and billable as recorded. A revoked secret must fail closed immediately, with no cached-authorization window. |
| Audit | Every lifecycle event appends an operator-audited record (actor, `keyId`, tenant, timestamp, reason). Never store the secret value. This follows the append-only audit proposal in `docs/api/hardening/README.md:37-45`. |

Secret storage rule: vault or a private server environment file only — the deployment's `.env`, which is not present in this worktree (only `.env.example` is). Read secrets by environment-variable **name** server-side (`server/contracts/freeFeed.ts:34-35` already uses this pattern). No `SLABGRAPH_SESSION_SECRET` reuse, no shared static API key, no client-shipped key.

## 5. Quotas (design only; numbers are not decided)

**Billable unit proposal:** exactly one billable unit = one **2xx** response from an allow-listed read route. `400`, `401`, `403`, `404`, `409`, `429` and `5xx` are not billable. A replay of an identical `meta.requestId` within the dedupe window is not double-counted (the `requestId` already comes from `server/serving/catalog.ts` `newContext`). No WebSocket, streaming or async job is metered in v1. Final definition is decision **D2** — it must be written down before anyone is charged.

Per-key controls (all PROPOSALS, to be set by D5):

| Control | Meaning | Guardrail from the code |
| --- | --- | --- |
| Burst rate | Requests per minute, token bucket per `keyId` | 429 before the handler runs, so no canonical read is performed |
| Monthly quota | Billable units per billing period, hard stop at 100% | Server-owned; never trusted from a request header |
| Concurrency | Max in-flight requests per `keyId` | Prevents one tenant from exhausting the single-host budget (`docs/api/hardening/README.md:16-32`) |
| Result-size cap | `limit`/page size bounded by the serving router | Reuse `defaultLimit=100`, `maxLimit=500` from `server/serving/routes.ts:93-94`; don't add a second, conflicting cap |
| Licensed subset | Which source-tagged rows a tenant may receive | Derived from §9.3 per-source rights, not from a tenant-supplied filter |

Enforcement is deterministic server code. No model, no LLM output and no client-supplied counter may decide quota or billing. Quota exhaustion returns the existing error envelope with `code: 'quota_exceeded'` plus `Retry-After`; it does not return a 200 with a truncated dataset.

## 6. Usage records (design only)

Usage records are an **append-only, server-owned** ledger. They are not canonical facts: they never enter the evidence, observation, card, forecast or learning tables defined in `server/contracts/dataProduct.ts` / `server/db/schema.ts`. Corrections append; records are never mutated or deleted to "fix" a bill.

Proposed immutable record fields:

| Field | Source / rule |
| --- | --- |
| `usageId` | Server-generated unique id |
| `keyId`, `tenantId` | Non-secret identifiers; never the secret itself |
| `requestId` | Copied from `meta.requestId` (`server/serving/catalog.ts:88-94`) so a bill line ties to a response |
| `route`, `method` | From the matched allow-listed route |
| `status`, `billableUnits` | HTTP status and 0/1 per §5 |
| `generatedAt`, `capturedAt` | UTC ISO strings; `capturedAt` is server-recorded, never client-supplied |
| `contractVersion` | `CONTRACT_VERSION` from `server/contracts/dataProduct.ts` |
| `period` | Billing period key, server-derived |
| `sourceSet` | Licensed source tags that were eligible for this response |
| `disputeState` | `NONE` / `OPEN` / `RESOLVED_BY_APPROVE`; resolution only through the human approval authority pattern in `server/identity/qaAuthority.ts` |
| `correctionPolicy` | `APPEND_ONLY`, consistent with `ApiMeta` |

Operational rules: never log the key value, `Authorization` header or request body; record only identifiers and counters. Daily aggregates are recomputable from the append-only records and must reconcile to what the server charged. Disputes append a correction record; they never rewrite history. Retention period and dispute SLA are decision **D9**.

## 7. Response contracts (design only)

No change to the success or error envelope in this task. `docs/api/README.md:7-31`, `docs/api/README.md` API groups, and `docs/openapi.json` remain authoritative.

- **Success:** unchanged `{ data, meta }`. Exactly the five base `meta` fields, plus the optional `source`/`basis`/`currency`/`provenance`/`warnings` that the existing handler already sets. No new required field is added.
- **Error:** unchanged `{ data: null, error, code, meta }`. Proposed new machine codes, to be registered in `docs/openapi.json` and `docs/api/README.md` before any implementation: `authentication_required`, `invalid_api_key`, `quota_exceeded`, `rate_limited`, `forbidden_route`. Existing `validation_error`, `not_found`, `internal_error` keep their names.
- **Headers (proposal, additive):** `X-Quota-Limit`, `X-Quota-Remaining`, `X-Quota-Reset`, `Retry-After`. Headers do not alter the JSON envelope; still gated on decision **D3**.
- **Do not add** quota or billing fields into `meta` until the contract version is deliberately bumped in `server/contracts/dataProduct.ts` and both `docs/api/README.md` and `docs/openapi.json` are updated. Silently changing a shared contract is not acceptable.
- **Semantics are never relaxed for a paying caller:** basis stays explicit; `GUIDE` is not relabelled `SOLD`; missing values stay `UNKNOWN`; raw evidence stays immutable; a simulation remains a hypothesis. A customer cannot buy a different truth from the one the UI sees.
- **Error hygiene:** follow `server/analytics/routes.ts:229-230` — raw exception text is never echoed.

## 8. Authentication boundaries

1. **One app, one bind.** Everything stays inside the existing Express app (`createApp` in `server.ts`) and the existing internal publish (`docker-compose.yml:16-17`). No new listener, no port, no firewall/DNS change, no gateway.
2. **Two distinct gates.** The operator gate (`server/auth.ts` `requireAuth`) keeps protecting operator routes. The customer-key check is a separate middleware applied only to the six allow-listed read routes (`server/serving/routes.ts`). The two credential namespaces never cross-validate.
3. **Serving reads are currently unauthenticated at the app level** (`server.ts:2234` has no `requireAuth`); their present protection is the external shared form gate documented at `docs/api/hardening/README.md:47-57`. A metered wrapper must add its own per-key check **before** those handlers and must not weaken or replace that shared gate.
4. **Fail closed.** Missing, malformed, revoked, suspended, expired or wrong-namespace credential → 401/403 in the existing error envelope, before any data read or usage write.
5. **Least privilege.** A key resolves to one tenant, one quota class and one licensed source set. It cannot widen its own scope via query parameters, escalate to another tenant's `keyId`, or reach any write/admin route.
6. **No secret in transit artifacts.** No keys in URLs, logs, error messages, `meta`, tests, fixtures or documentation. Rotate anything that leaks; see the PSA token rule in `docs/research/2026-11-23-psa-cert-review.md:22-28` for the precedent.

## 9. Prerequisite checklist — all blocking

### 9.1 Data quality — NOT READY

Measured, not assumed (`docs/benchmarks/2026-11-23-data-coverage.md`):

- 147 evidence rows; **all 147 `PENDING` parse status**; **all 147 `UNKNOWN` trust tier**. There is no proven parse/trust signal behind a paid response.
- 147 candidates, only 58 priced; 89 are catalog-only. Of the priced: 51 `GUIDE`, 7 `SOLD`, 0 of any other explicit basis. A "market data" product with 7 observed sales is not market data.
- 58 promoted observations; 0 priced candidates without an observation and 0 duplicate keys — the promotion bookkeeping is clean, but the underlying volume and basis mix are thin.
- Live population (`docs/benchmarks/2026-11-23-free-data-live.md`): Postgres cards 58→78, evidence 169→209, observations 72→99, identity decisions 0→40, **aliases 0**. CardDex contributed 20 catalog rows and 20 GUIDE/EUR price rows; Pokémon TCG API returned 500/502 and wrote nothing; Cardex failed TLS; Scryfall was deliberately excluded on licence grounds.
- The active report said `insufficientEvidence: false` but covered only 14 observed cards out of the served catalog. That is a pass of a low bar, not a quality guarantee.

Blocking gate: define and measure a served-dataset threshold (minimum priced coverage, minimum non-`UNKNOWN` basis share, minimum `SOLD` share for any marketed "sold comps" claim, parse/trust completeness) and publish the census in `docs/benchmarks/` before billing anyone. A key that can be charged for an empty or `UNKNOWN`-only response is a refund machine.

### 9.2 Provenance completeness — NOT READY

- The contract is in place: `server/contracts/dataProduct.ts` (`EvidenceRecord`, `MarketObservation`) and `server/contracts/freeFeed.ts` (`license`, `attribution`), with `source`, `observed_at`, `captured_at`, `lineage`, `confidence` required by the envelope contract (`docs/api/README.md:18-31`).
- The served subset has **never been audited to 100% provenance completeness**. `license` is optional on `EvidenceRecord` (`server/contracts/dataProduct.ts:21`); a feed with no `license` is disabled in `server/ingest/freeFeeds.ts`, but historical rows and any manually seeded rows need an explicit check, not an assumption.
- Identity decisions are only 40 rows with 0 aliases; identity confidence warnings are already emitted by `server/serving/routes.ts:106-116`. A paid identity lookup must carry an auditable decision, not a `LOW`-confidence guess.
- Low-confidence matches are quarantined and released only by human `APPROVE` (`server/identity/qaAuthority.ts`, `server/identity/qaRoutes.ts`). Any data still in quarantine is not saleable.
- Blocking gate: an automated, repeatable audit that fails the build if any row in the served subset lacks source, basis, currency, `observed_at`, `captured_at`, lineage, confidence, declared licence and attribution where required. UNKNOWN values are allowed as values; **missing provenance fields are not**.

### 9.3 Licensing gates — NOT READY

Redistribution through a paid API is a different right from internal display or research use. Each source needs its own written answer before its rows can be served to a paying tenant.

| Source | Gate | Status |
| --- | --- | --- |
| Scryfall | Terms checked during the live run: data "may not be paywalled" [81] (`docs/benchmarks/2026-11-23-free-data-live.md:5`). That conflicts with a metered product. | BLOCKED. Exclude Scryfall-derived data from any paid tier or obtain explicit permission; do not relabel it as another source. |
| CardDex | Attribution required and attached to source metadata (`docs/benchmarks/2026-11-23-free-data-live.md:9,47`); `license` and `attribution` are mandatory in `server/contracts/freeFeed.ts`. | GATED. Confirm redistribution in a metered API, attribution display obligations and price-guide (GUIDE) reuse rights. |
| Pokémon TCG API | Keyless feed configured with licence in `server/ingest/freeFeeds.ts`; live run produced no rows (500/502). | GATED. Re-run and confirm licence/redistribution before any served data is attributed to it. |
| Cardex | Keyless, 100/day cap noted in the plan; live probe failed TLS. | GATED. Re-probe and confirm terms; do not assume availability or rights. |
| eBay (sold data) | API License Agreement requires express prior written permission to derive "Average selling price or gross merchandise sold for any eBay category"; Buy APIs need approved-partner status (`docs/research/2026-11-23-ebay-access-review.md:14-48,93-117`). | BLOCKED. No adapter, no sold-price derivation, no paid response sourced from it. |
| PSA cert verification | Exposed bearer token must be rotated; API End User Agreement storage/cache/display/redistribution/commercial-use questions unanswered (`docs/research/2026-11-23-psa-cert-review.md:22-58`). Cert data is instance identity/grade evidence, **never** price/sales/population. | BLOCKED. |
| Grader population tables | Needs its own licence review (`docs/research/2026-11-23-commercial-scope-fold-in.md:11`). Missing population stays `UNKNOWN`. | BLOCKED. |

Blocking gate: a per-source rights matrix recorded in the repo, with sourceId → allowed uses (internal display / paid API / redistribution / attribution text / retention), signed off by the owner. Only rows whose source is marked "paid API + redistribution" may be served through a metered key. If the matrix cannot be produced, the product does not launch.

### 9.4 Operational prerequisites — NOT READY

- Append-only audit of canonical writes and key lifecycle events, per `docs/api/hardening/README.md:37-45`. There is no canonical-write audit trail today.
- Backup/restore drill scripts exist (`docs/api/hardening/README.md:26-34`) but must be exercised on a schedule after owner approval; off-host backups required.
- No new npm dependency: implement any future metering with the existing stack (`express`, `pg`/drizzle through `server/db/`, Node `crypto` as in `server/auth.ts`). Adding Stripe, a gateway SDK or a rate-limit service is a separate decision, not part of this design.
- Keep the existing single-host budget in mind (`docs/api/hardening/README.md:16-24`); a metering store and its indexes must fit, or the owner must approve capacity first.

## 10. Owner decisions required before launch

Every undecided item defaults to **DO NOT LAUNCH**. "Owner" means the person authorised to accept the commercial and legal risk; engineering cannot sign these off.

| ID | Decision needed | Why it blocks | Owner input |
| --- | --- | --- | --- |
| D1 | Billing provider and money flow (or explicitly no billing provider) | §1 says none chosen; selecting one may change the deployment and dependency set | OPEN |
| D2 | Meter unit and price (per request vs per result row vs per time window; free tier; overage) | Determines what a usage record charges and what a tenant may dispute | OPEN |
| D3 | Contract-version policy: may `meta` gain quota fields, or headers only? Who bumps `CONTRACT_VERSION`? | `docs/api/README.md` and `docs/openapi.json` are contract-first; silent changes break callers | OPEN |
| D4 | Per-source licensing sign-off, including the Scryfall paywall conflict and any paid redistribution rights | §9.3; without it there is no lawful sellable dataset | OPEN |
| D5 | Quota numbers, rotation overlap, suspension policy, concurrency and burst defaults | §5; without numbers there is no enforceable contract | OPEN |
| D6 | Customer terms, attribution display, acceptable-use and refund policy | CardDex attribution and dispute handling depend on it | OPEN |
| D7 | Who provisions/rotates/revokes keys and through which operator-only surface | §4/§8; key management cannot be a public route today | OPEN |
| D8 | Launch dataset subset and claims (e.g. "sold comps" only if `SOLD` coverage is real) | §9.1; marketing a `GUIDE`-only dataset as sold data is a false claim | OPEN |
| D9 | Usage-record retention, dispute SLA and audit-access rules | §6; billing records are retained data with legal implications | OPEN |
| D10 | Go/no-go on the §9.1 served-dataset quality thresholds | §9.1; engineering cannot invent a quality bar and call it met | OPEN |

## 11. Acceptance gates for a future implementation task

A later task may implement this only after D1–D10 are closed and §9 is green. Its verification must show all of the following:

1. No new listener, no public port, no firewall/DNS change, no change to the shared form gate; `server.ts` still has the single `app.listen` at the existing bind.
2. No billing provider, no API gateway and no new npm dependency unless separately approved.
3. Envelope shape unchanged from `server/serving/catalog.ts`; `docs/api/README.md` and `docs/openapi.json` updated in the same change if any code or contract field is added.
4. Customer keys cannot reach operator, ingest, QA, admin, write or Hermes routes; operator tokens cannot be used as customer keys. Tests must prove both directions.
5. Usage records are append-only, reconcile to responses by `meta.requestId`, contain no secret value, and never touch canonical fact tables.
6. Failed/rejected/over-quota requests are not billed; revoked keys fail closed immediately.
7. Provenance/licence audit from §9.2 runs in the suite and fails the build on a missing field in the served subset.
8. `npx tsc --noEmit` exit 0 and the full suite stays green; record exact counts in the progress ledger.

## 12. Path index (artifacts this design links to)

- `docs/api/README.md`, `docs/openapi.json` — response envelope, basis vocabulary, API groups, contract version.
- `docs/PRODUCT_GOAL.md` — binding goal.
- `docs/api/hardening/README.md` — no-new-listener policy, internal binds, audit-log and backup proposals.
- `docs/superpowers/plans/2026-11-23-free-data-foundation-plan.md` — Task 18 brief and source list.
- `docs/research/2026-11-23-commercial-scope-fold-in.md` — origin and gating decision for Task 18.
- `docs/research/2026-11-23-ebay-access-review.md`, `docs/research/2026-11-23-psa-cert-review.md` — licensing gates.
- `docs/benchmarks/2026-11-23-data-coverage.md`, `docs/benchmarks/2026-11-23-free-data-live.md` — measured data quality and provenance/licence findings.
- `server/serving/routes.ts`, `server/serving/catalog.ts` — mount pattern, six read routes, envelope helpers, `UNKNOWN`.
- `server/contracts/dataProduct.ts`, `server/contracts/freeFeed.ts`, `src/types/dataProduct.ts` — contract version, basis vocabulary, evidence/observation shapes, licence fields.
- `server/auth.ts`, `server.ts`, `docker-compose.yml` — operator gate, mount points, single listener, internal publish.
- `server/analytics/routes.ts`, `server/identity/qaAuthority.ts`, `server/identity/qaRoutes.ts`, `server/identity/qaQueue.ts` — error hygiene and human-release authority.
- `server/ingest/freeFeeds.ts`, `server/contracts/freeFeed.ts` — per-source licence and attribution metadata.

## 13. Explicitly not delivered by this task

No API key implementation, no key store, no quota middleware, no usage table, no billing integration, no gateway, no public listener, no new endpoint, no change to `docs/openapi.json` or `docs/api/README.md`, no new dependency, no change to `server.ts` or any other code file, no live third-party call and no secret value anywhere. This is a design document and a blocker list. Nothing here should be read as approval to sell data.
