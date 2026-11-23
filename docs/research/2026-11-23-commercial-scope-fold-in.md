# Folding the commercial-scope brief into Slabswarm

Source: owner-pasted scope, 2026-11-23. It is a proposal, not a verified description of our app or of vendor terms. Anything below marked UNVERIFIED needs primary-source confirmation before spend or wiring.

## What fits now

1. Catalog facets. The brief breaks a card down by category, sport/game, year, manufacturer, set, card number, parallel, print run and grade. Our catalog already has cards, sets and games but not a consistent set of searchable facets for parallel, serial run, grade or rookie flag. Add facets without changing the canonical identity key rules already built.

2. Deterministic FMV. Recency-weighted decay plus IQR outlier removal is compatible with our evidence-first design. Cross-grade imputation can be added as an explicit, deterministic estimate with its own basis and confidence. It must never overwrite a real SOLD observation, and it must never be presented as a sale.

3. Liquidity and supply. Active-vs-sold inventory ratio is computable from ASKING and SOLD evidence we already separate. Population snapshots and gem rates are useful but source-gated: PSA is cert verification only under the current public API, and population tables need their own licence review. Missing population data stays UNKNOWN.

4. Demand and catalyst factors. Price momentum, absorption ratio and pop velocity can be computed from our own data. Attention delta and catalyst score need external feeds; those stay UNKNOWN until a licensed source is approved. No model may write a canonical fact.

5. Entity resolution for noisy listings. The four-stage idea is useful: extract hard attributes, verify cert numbers where licensed, match against canonical catalog, quarantine uncertain matches. Our identity resolver already does deterministic canonical matching. Add title extraction and a low-confidence quarantine/QA queue; route uncertain cases to humans. LLM output may propose or explain, never write canonical facts.

6. Product surface. Watchlists, alerts, portfolio valuation and an internal QA dashboard are genuine gaps identified in our own audit. They wait on reliable canonical prices and provenance, not on more infrastructure.

## What does not fit the approved design

- ClickHouse, Redpanda, Temporal, Redis, Feast, pgvector, Typesense, Kubernetes and managed proxy scraping are not in the approved spec. Adding them now would multiply cost and failure modes on a 2-OCPU/12GB host. Defer until the current Postgres-first product is populated and verified.
- Managed scraping of PSA/BGS/SGC/CGC population tables needs a terms review. Do not buy proxies or scrape grader sites on the strength of a pasted proposal.
- eBay Marketplace Insights is limited-release and our intended price-derivation use falls inside the licence clause requiring express prior written permission. It stays gated regardless of feed availability.
- LightGBM/XGBoost training on billions of ticks is aspirational. We have a learning loop and deterministic scoring; grow the data first.
- "$1,600 - $3,650 / mo" is an unverified estimate from the brief, not a budget decision.

## Resulting plan additions

- Task 13: catalog facets and filterable search fields.
- Task 14: deterministic FMV with IQR outlier removal, confidence bands and labelled cross-grade imputation.
- Task 15: liquidity, pop and demand factor pack with UNKNOWN sentinels and licence gates.
- Task 16: low-confidence match quarantine plus internal QA queue.
- Task 17: watchlist, alert and portfolio surface, gated on reliable canonical prices.
- Task 18: metered B2B API design, gated on data quality and billing decision.

Each task keeps the existing rules: raw evidence immutable, basis explicit, missing values UNKNOWN, deterministic code writes facts, agents only propose, and no new public listener without an explicit decision.
