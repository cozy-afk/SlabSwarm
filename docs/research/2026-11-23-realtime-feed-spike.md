# Real-time Feed Spike — 2026-11-23 (gated, no production wiring)

Task 6 of the Free Data Foundation plan. Scope: verify, against primary docs, the two real-time-capable candidates named in the plan — PokeTrace's WebSocket [66] and CardDex's `prices.updated` webhook [64] — and record cost, licence, attribution and a recommendation. **No feed was wired, no key was created, no listener was opened, and no firewall/DNS change was made.** All findings are from vendor-owned pages fetched on 2026-11-23; the plan's citations were treated as leads, not proof.

## Bottom line

| Candidate | Real-time? | Free? | Commercial use allowed? | Status |
| --- | --- | --- | --- | --- |
| PokeTrace WebSocket (`wss://api.poketrace.com/v2/ws`) | Yes, verified | **No** — Scale/Business plans only, from $98/mo | Only on paid plans, and only for derived analytical pricing data | VERIFIED, cost/licence-gated |
| CardDex `prices.updated` webhook | **No** — one notification per day after a sync | Key is free ($0 beta), but see conflict below | Attribution required; data licence not stated | Partly UNVERIFIED |

No **free real-time feed** is available from either vendor. Recommendation: do not wire either feed (details below).

## Step 1 — PokeTrace: WebSocket, free tier, commercial use

**The brief's premise is refuted by the primary page.** The brief said the WebSocket claim came only from a search snippet and was unverified. The developer overview itself lists `WS /v2/ws` under "Example Request" and "RESTful API Endpoints", and has a numbered feature "WebSocket — Real-time price updates streamed to your app. Subscribe to cards and get instant notifications when prices change." [66] The changelog also records WebSocket at `/v2/ws` and improvements to `price.card-updated` delivery [77]. **The WebSocket exists — VERIFIED.**

**But it is not free.** The pricing page's plan comparison marks WebSocket as available only on Scale and Business [75]; the developer guide says "For WebSocket real-time updates (Scale and Business plans), connect to `wss://api.poketrace.com/v2/ws` with your API key" [76]. Scale is $98/mo (100,000 requests/day, 60/10s burst) and Business is $399.99/mo (1,000,000/day) [75]. The WebSocket allows 3 connections/user, 30 messages/min and 1 KB messages, with `connected` and `price.card-updated` events; events are per-market record, so both ids must be mapped via `markets[market].cardId`. (From the LLM-integration reference surfaced in search; not re-fetched as a primary page, so treat those operational limits as secondary.)

**The free tier exists but is deliberately small and non-commercial.** Free is $0 with 100 requests/day and a 1 request/2 s burst, US prices only (eBay + TCGPlayer), raw conditions only, and price history up to 7 days; no credit card required [66][75][76]. It has no WebSocket and no EU/graded data [75][77].

**Commercial use is a narrow, paid-only permission.** The pricing FAQ states "Free access is for personal, non-commercial use" and that paid plans "permit commercial use only of PokeTrace's analytical pricing data, including aggregated prices, sales statistics, trends and price history" [75]. The site footer adds the same scope limit [66]. Cheapest plan carrying commercial use is Pro at $19.99/mo — but Pro still has no WebSocket [75]. This is a licence to use derived analytics, not a redistribution grant for the underlying eBay/TCGPlayer/Cardmarket data. This spike does not resolve upstream marketplace rights, which the parent plan already treats as a separate legal gate.

## Step 2 — CardDex: `prices.updated` webhook, licence, attribution

**The webhook is documented, but it is not a real-time feed.** CardDex documents one event, `prices.updated`, "sent once a day after the daily Cardmarket price sync finishes (the daily job starts at 07:00 UTC)" [64]. No event is sent if that day's sync fails. Crucially, the event "says that today's prices are recorded; it does not list which cards changed, so fetch the prices you need when it arrives" [64]. So this is a daily *refresh signal*, not a price stream. Subscribing requires a bearer API key (`POST /v1/webhooks/subscribe`), a public HTTPS URL of up to 2,048 characters, at most 5 active webhooks per key, and HMAC verification of `X-CardDex-Signature: sha256=…` with a `whsec_` secret shown once [64]. Deliveries must be acknowledged with 2xx within 5 s; there is one retry a second later on timeout/network/5xx/429, and the signature has no timestamp, so consumers must dedupe on `recorded_at` [64]. A public HTTPS listener is explicitly out of scope for this task.

**Cost.** The docs list no-key public reads at 30 req/min and 5,000 req/day, and a free key at 100 req/min and 10,000 req/day; the webhook section does not state a plan gate for subscribing [64]. The pricing page describes a "Free beta plan — $0, no credit card required" and "no-key access" [78]. The docs also list Pro (500/min, 100,000/day) and Business (1,000/min, 1,000,000/day) keys pointing at that same pricing page [64].

**UNVERIFIED conflict in primary sources.** The pricing page asks "Are paid plans available?" and answers "Not yet. The launch version keeps pricing honest and only publishes what you can actually use today." [78] That contradicts the docs page, which names Pro and Business plans and links to that pricing page [64]. An older indexed version of the docs described "Paid plans and webhooks — Not part of the public beta launch". I did not resolve which state is current. Consequently: **webhook availability on the free key is UNVERIFIED**, and no subscription was attempted (out of scope).

**Attribution — VERIFIED.** The docs state: "Prices are market reference prices, not offers to buy. When you show CardDex data, credit CardDex (carddex.dev) and name the price source (Cardmarket or TCGplayer)." [64] Historical prices are not converted between currencies, with Cardmarket/EUR and TCGplayer/USD kept separate [64].

**Licence — UNVERIFIED.** Neither the docs nor the pricing page states a licence for the *data*. The `carddex` PyPI package is MIT-licensed, but that covers the SDK client library, not the price data [79]. There is no documented redistribution right. Treat any downstream storage/republication of CardDex prices as **UNVERIFIED** until the vendor confirms it in writing.

## Cost, licence and attribution summary

| Item | PokeTrace | CardDex |
| --- | --- | --- |
| Free REST cost | $0, 100 req/day, US raw only [75] | $0 no-key (30/min, 5,000/day) or free key (100/min, 10,000/day) [64][78] |
| Real-time cost | Scale $98/mo minimum; Business $399.99/mo [75] | N/A — no real-time product; webhook is daily [64] |
| Commercial licence | Paid plans only, and only for aggregated prices, sales statistics, trends, price history [75] | Not stated — UNVERIFIED [64][79] |
| Attribution | Not specified in primary docs beyond trademark notice; no explicit attribution clause found — UNVERIFIED | Credit CardDex (carddex.dev) and name Cardmarket or TCGplayer [64] |
| Free real-time option | None — verified paid-only [75][76] | None — daily notification only [64] |

## Recommendation (gated, no wiring)

**Do not wire any feed in this task, and do not plan on a free real-time feed.**

1. **PokeTrace WebSocket — no.** It is verified to exist but is gated behind a paid plan starting at $98/mo, and the commercial permission is narrow (derived analytics only, not raw-data redistribution) [75][76]. Wiring it is a product-and-legal spend decision, not a data-foundation task. Revisit only with an explicit budget owner and a legal read on the licence scope and upstream marketplace rights.
2. **CardDex `prices.updated` — no.** It is a once-daily "prices were recorded" signal that carries no changed-card data, requires a public HTTPS listener (explicitly excluded here), and its free-tier availability conflicts across CardDex's own primary pages; the data licence is unstated [64][78][79]. If a daily freshness signal is ever useful, prefer the existing REST endpoints inside the documented rate limits, and only reconsider a webhook after the licence and plan conflict are resolved in writing.
3. **Default path unchanged:** continue with keyless/licensed REST adapters (Scryfall, Pokémon TCG API, CardDex, Cardex) that write immutable, provenance-bearing observations. Record licence and attribution on every row. This spike adds no runtime component, socket, subscription, credential, listener or network rule.

## Sources

[64] https://carddex.dev/docs — CardDex API docs
[66] https://poketrace.com/developers — PokeTrace developer overview
[75] https://poketrace.com/pricing
[76] https://poketrace.com/blog/pokemon-card-api-developer-guide
[77] https://poketrace.com/docs/changelog
[78] https://carddex.dev/pricing
[79] https://pypi.org/project/carddex
