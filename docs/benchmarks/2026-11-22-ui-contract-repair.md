# UI Contract Repair — Verification Record

Date: 2026-11-22 (UTC). Triggered by a user-provided UI report showing three live failures.

## Defects found and fixed

1. `POST /api/intelligence/discovery-sweep` and `GET /api/intelligence/findings` returned `ok`/`findings` only. The UI's `useEnvelope`/`postEnvelope` helpers failed with "Response did not use the { data, meta } envelope." Both now return `{ data, meta }` and keep the legacy fields for compatibility.
2. `POST /api/intelligence/harvest-legacy` returned 400 because `DEFAULT_LEGACY_DB` was the hardcoded host path `/opt/slabswarm/data/slabgraph-db.json`. It now resolves at call time from `SLABGRAPH_DATA_DIR` or `./data`; the other hardcoded copy in `server/db/routes.ts` was fixed too.
3. `/api/pricing/:id`, `/api/comps/:id` and `/api/market/:id` returned 404 for ids from the active report such as `tcg:719440`. The serving API now falls back to ledger-derived catalog identity, marking it `LOW` confidence with ledger provenance and literal `UNKNOWN` for absent facets.
4. The Market Intelligence view required manual id entry. It now offers a select of real cards from the active report, showing name, set, game and id, with manual entry kept as a fallback.

## Integration

- Three repair lanes merged into `main`: envelope `b96f328`, catalog `1ade48b`, picker `80b9a08`.
- One flaky test was corrected at `922e2f2`: an assertion searched the whole response body for `250`, which a random request UUID can legitimately contain. It now scopes that check to `body.data`.
- `main` at `922e2f2`. Full 51-file suite run twice: **348 tests, 348 pass, 0 fail** both times. `tsc --noEmit` exit 0. `docker compose config -q` exit 0.

## Live HTTP verification after rebuild

All responses below came from `10.99.0.1:3010` with the existing bridge-token bearer:

- `POST /api/intelligence/discovery-sweep` — 200, envelope present
- `GET /api/intelligence/findings` — 200, envelope present
- `POST /api/intelligence/harvest-legacy` — 200, envelope present
- `GET /api/pricing/tcg:719440` — 200, envelope present
- `GET /api/comps/tcg:719440` — 200, envelope present
- `GET /api/market/tcg:719440` — 200, envelope present
- `GET /api/intelligence/active-report` — 200, envelope present
- Public gate `https://slabswarm.144-21-43-141.sslip.io/` — 302, unchanged

Pricing for `tcg:719440` reports basis `SOLD` with `UNKNOWN` values. That is deliberate: the seeded ledger has GUIDE evidence only, so no sold price is asserted. No placeholder values were substituted.
