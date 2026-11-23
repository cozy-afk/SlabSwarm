# Free-data live population, 2026-11-23

## What ran

Two licensed, keyless feeds were harvested through the gated operator route on the running app: CardDex and Pokémon TCG API. Scryfall was deliberately excluded after its terms were checked: its data may not be paywalled [81], which conflicts with the intended commercial API. The first Cardex endpoint probe failed TLS, so no Cardex data was harvested. Pokémon TCG API returned 500/502 repeatedly during this session and produced no rows.

The first CardDex harvest fetched 20 catalog rows and wrote them to the ledger. Canonical promotion initially rejected all 20 because identity keys used NUL as a separator; Postgres rejects NUL in text. After fixing that and re-promoting the stored rows, all 20 promoted as catalog-only facts.

A second CardDex harvest with `include=prices` fetched 20 price-guide rows. Promotion initially failed because confidence bands were written as strings into a numeric Postgres column. After mapping bands to numeric scores, all 20 price rows promoted as GUIDE/EUR observations. No SOLD data was invented and no price was relabelled.

## Before and after (canonical Postgres)

| Table | Before | After |
|---|---:|---:|
| cards | 58 | 78 |
| evidence_records | 169 | 209 |
| market_observations | 72 | 99 |
| identity_decisions | 0 | 40 |
| aliases | 0 | 0 |

Ingest runs are recorded in the file-backed ledger, not in the `ingest_runs` Postgres table, so that table stayed at zero. The ledger-to-Postgres sync reported `{"evidence":187,"cards":39,"observations":58,"errors":0,"errorSample":null}`; the larger totals above include first-party backfill rows already present.

## Active report

After the discovery sweep, `GET /api/intelligence/active-report` returned 200 with:

- `summary.totalEvidence`: 187
- `summary.totalObservations`: 58
- `summary.cardsObserved`: 14
- `summary.insufficientEvidence`: false
- `meta.lakeManifest`: present

The report cites real canonical evidence. Missing values remain UNKNOWN. No model wrote a canonical fact.

## Verification

- Full test suite: 420/420 pass after the final fixes.
- Typecheck: `npx tsc --noEmit` exit 0.
- App health: 200 on `10.99.0.1:3010`.
- Public URL: 302 to the existing shared gate; no gate, firewall, DNS or listener change.
- Docker image rebuilt and app container recreated; database container untouched apart from migrations and sync.

## Unresolved

- Pokémon TCG API returned upstream 500/502 during the live run. No data from that source was written.
- Cardex host failed TLS in this environment; default path left unchanged.
- CardDex attribution is required and remains attached to the source metadata.
- The export hook status record is in-process only; the immediate approval response carries the outcome.

Sources:
[81] https://scryfall.com/docs/api
