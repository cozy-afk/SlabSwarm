# Seed catalog (real cards, sourced comps)

`seed-real-cards.json` seeds six real collectibles so the swarm and GraphRAG have
ground truth to operate on. Card identities are real. Each `initialSalePriceUsd` is one
publicly reported sold-price reading, not a verified transaction and not a forecast.
Replace them with your own comps before trusting any valuation output.

| Card | Seed price (PSA 10) | Source |
|---|---|---|
| Charizard 4/102, Base Set Unlimited | $38,600 (last sale 2026-11-05; pop 488) | https://www.tcgberg.com/cards/charizard-4-base-set-unlimited-holo |
| Blastoise 2/102 | $11,998.99 | https://shouldislabit.com/sets/base-set |
| Venusaur 15/102 | $4,200 | https://shouldislabit.com/sets/base-set |
| Mewtwo 10/102 | $5,700 | https://shouldislabit.com/sets/base-set |
| Gyarados 6/102 | $3,249 | https://shouldislabit.com/sets/base-set |
| Luffy OP05-119 Manga Rare | $15,158.27 | https://www.pricecharting.com/game/one-piece-awakening-of-the-new-era/monkeydluffy-alternate-art-manga-op05-119 |

The Base Set figures on shouldislabit are described as median eBay sold prices via
PriceCharting as of 2026-11-16. Prices move; these are a starting point only. No sports
cards are included because no equivalent sourced price was used for this seed.

## Apply

Auth is currently open (no operator passcode set). On the host:

```bash
cd /opt/slabswarm
curl -fsS -X POST http://10.99.0.1:3010/api/graph/import \
  -H 'Content-Type: application/json' \
  --data-binary @docs/seed-real-cards.json
curl -fsS http://10.99.0.1:3010/api/graph/state | head -c 500
```

## Live card discovery (TCG API)

`scripts/tcgapi_seed.py` pulls real card rows from https://tcgapi.dev and pushes them
into the graph. It is a one-way collector: it fetches card metadata and current TCGPlayer
market prices, maps them to ungraded (`Raw NM`) comps on `tcgplayer`, and skips titles
already in the graph. It cannot create graded prices or forecasts, and it does not
discover sales by itself.

The free tier allows 100 requests/day. The default query set uses four searches.
Set the key only in the host `.env`:

```bash
cd /opt/slabswarm
# add TCGAPI_KEY=*** to .env (gitignored)
TOKEN=$(curl -fsS -X POST http://10.99.0.1:3010/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"passcode":"<operator passcode>"}' | python3 -c 'import sys,json; print(json.load(sys.stdin)["token"])')
SLABGRAPH_TOKEN="$TOKEN" TCGAPI_KEY="$(grep '^TCGAPI_KEY=' .env | cut -d= -f2-)" \
  python3 scripts/tcgapi_seed.py
```

Override `SLABGRAPH_QUERIES`, `TCG_MIN_PRICE` and `TCG_MAX_PER_QUERY` via environment
variables to target other games or price bands. Never commit the key.

To undo any seeding: `POST /api/graph/reset`. That wipes all graph state, including
any later swarm runs, so only use it if you intend to start over.
