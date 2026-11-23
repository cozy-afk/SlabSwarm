# Free-feed endpoint and licence corrections, 2026-11-23

The first live harvest failed for all configured sources. The failures were real, not test noise: Scryfall 400/404, Pokémon TCG API 500, Cardex 404. This records what was checked and what changed.

## What was wrong

- The registry used `https://api.carddex.io` for CardDex. The documented base is `https://api.carddex.dev`, with cards under `/v1/cards` [64]. Keyless public reads are documented.
- The default paths were broad collection endpoints that returned errors. A bounded query works: Pokémon TCG API at `/v2/cards?q=name:Pikachu&pageSize=20` and CardDex at `/v1/cards?name=Pikachu&pageSize=20`. Both were confirmed with direct HTTPS requests on 2026-11-23.
- Scryfall requires an accurate `User-Agent` and an `Accept` header on every request [81]. The adapter sent only `Accept`. The adapter now sends both.
- Cardex's documented API is free and keyless with `/api/sets` and `/api/cards` endpoints [65], but the configured host did not answer a TLS handshake during this check. Its default path stays unchanged and no Cardex data was harvested.

## Commercial constraint

Scryfall's terms prohibit paywalling Scryfall data [81]. Our intended product sells API access. Therefore Scryfall catalog data must not enter the commercial dataset. The adapter fix is kept for correctness, and the source remains in the registry for operator visibility, but the live commercial harvest uses Pokémon TCG API and CardDex only. This is a harder gate than the earlier research note suggested.

CardDex requires attribution [64]. The harvest response already carries the attribution from the frozen source config; any commercial display must keep it.

## Change made

- Corrected the CardDex base URL and default paths for Pokémon TCG API and CardDex.
- Added a `User-Agent` header to the free-feed adapter.
- No new listener, credentials, firewall rule or DNS change.

## Verification

Endpoint probes and the full test suite were run before this document was written. The follow-up live harvest result is recorded separately in the progress ledger; this document does not claim that data was written.

Sources:
[64] https://carddex.dev/docs — CardDex API docs
[65] https://cardex-api.dev — Cardex API
[81] https://scryfall.com/docs/api
