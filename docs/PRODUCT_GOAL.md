# Slabswarm Product Goal

Status: binding. Owner confirmed 2026-11-23.

## Active execution goal (owner instruction, 2026-11-23)

Keep the product working end to end, not merely buildable. In each operating cycle: harvest and log cards from allowlisted free sources; promote them to canonical identities; price them from SOLD / GUIDE / ASKING evidence without relabelling; run an evidence-first research cycle; record the run; and verify the result through the live API and Postgres. If any step fails, debug it methodically, add a failing test first, fix the cause, run the full suite, deploy, and re-run the cycle. A cycle is complete only when real card rows, real evidence rows, real price observations, a stored research run with cited evidence IDs and an evidence-backed active report are all readable from the canonical store. Never invent a card, a price, a sale or a research claim to make the pipeline look healthy. Gated sources remain gaps and are reported as such.

## Purpose

Build Slabswarm into our own first-party trading-card intelligence service. It will catalog trading cards, sports cards and comic books, attach historical prices, completed sales and active listings to the right identities, and use that joined evidence to produce price guidance and forecasts. The database and the methods are ours. External APIs are raw inputs, not the product.

The eventual commercial goal is to sell API access. That comes after the database is trustworthy for our own use.

## Mission (owner direction, 2026-11-23)

Give collectors, traders, hobbyists and retailers one current, provenance-backed view of what a sports card or TCG card is worth. MySlabs is a marketplace for sports cards and comics with active priced offers [83]. Nearmint covers TCG games including Yu-Gi-Oh!, Digimon, Magic: The Gathering and Riftbound [84]. 130point sells collection tracking against recent sales from 8+ marketplaces [85]. Together they confirm the shape of the market we serve: catalog breadth on one side, current prices on the other. We are not copying any of them. We are building the shared evidence layer that makes those numbers comparable and checkable.

## eBay listing protocol

- Browse API searches and retrieves active eBay items; Feed API supplies daily or weekly bulk listing files; Marketplace Insights API supplies sales history but is Limited Release [68].
- eBay's Buy APIs are intended for approved partners. The documented path is a developer account, minimum requirements, Sandbox integration, an Application Growth Check, then Production [68].
- Sandbox transactions are mocks and cannot supply real sold prices [80].
- The API License Agreement requires eBay's express prior written permission to derive average selling price or gross merchandise sold for any eBay category, and to develop pricing tools from Restricted APIs data [67].
- Our intended use falls inside that clause. No eBay feed is enabled until written permission and Buy API approval are documented. Active listings would be ASKING evidence; sold history would be SOLD evidence; neither may be relabelled.

## Product thesis

The value is the join, not any single source. A catalog without prices is a list. A price without a source is a guess. A forecast without a score is an opinion. We ship the whole chain or none of it.

```text
catalogs and products
  -> first-party identity resolution
  -> immutable price evidence (GUIDE / ASKING / SOLD, each with source and time)
  -> normalized observations
  -> deterministic valuation and forecast
  -> scoring against realized outcomes
  -> gated learning
```

## Users

- Now: us — research, price modelling and internal decisions.
- Later: paying API customers who need catalog, price and market-intelligence data with provenance.

## Scope

- Verticals: TCG, sports cards, comic books. One shared catalog with typed vertical facets, not three disconnected catalogs.
- Hierarchy: property → set/series/volume → card identity/issue → printing/variant → instance/slab → offer/observation.
- Evidence: free public catalogs first, manual notes and CSV from our own records, then licensed or paid feeds. eBay sold data stays gated until written permission and Buy API approval exist.
- Output: evidence-backed active report, price bands with drivers and invalidators, forecast scores, research notes and learning events.

## Hard rules

- Raw evidence immutable. Corrections append.
- Basis explicit: SOLD / ASKING / OFFER / GUIDE / CLAIM / POPULATION / UNKNOWN.
- Missing shipping, fees, FX, grade or condition stays UNKNOWN, never zero.
- Every fact carries source, observed_at, captured_at, lineage and confidence.
- Deterministic code computes valuations and scores. LLMs propose, explain, challenge. No model writes canonical facts.
- Simulations are hypotheses, never sales evidence.
- Every forecast is scored against real outcomes. Learning promotes only through benchmark non-regression.
- Keep Hermes tool IDs stable: get_collectible_valuation, scan_arbitrage_spreads, query_knowledge_graph, ingest_market_listing.
- No new public listener, firewall or DNS change without explicit approval.
- Use `sudo -n docker` for Docker. Keep keys server-side; never in chat, code, docs or client bundles.
- A gated source is a dataset gap. Do not fill it with invented numbers.

## Non-goals

- No MiroFish runtime, Neo4j, MongoDB, Kafka, Temporal, MinIO or Redis queue.
- No LLM-only price answers.
- No resale of data we lack rights to redistribute.
- No customer billing, keysets or quotas in this phase.
- No public exposure before the internal database is trustworthy.

## Milestones and definition of done

1. Canonical database: Postgres is the sole runtime source of truth. JSON graph and ledger are import/export artifacts. `/api/db/status` reports current migrations and non-zero catalog counts.
2. Free data foundation: priced candidates promoted; Scryfall, Pokémon TCG API, CardDex and Cardex adapters working under licence and rate limits; manual/CSV path usable.
3. Identity: the same card from two sources resolves to one canonical identity with an auditable, reversible decision. Absorbed IDs remain aliases.
4. Market evidence: GUIDE, ASKING and SOLD rows remain separate with source, currency and timestamp. No SOLD row without an observed sale.
5. Intelligence: active report returns real cards with evidence IDs, price bands, drivers and invalidators. Parquet lake exports and SQL Lab reads from it.
6. Learning: realized outcomes are captured from SOLD observations, forecasts scored at 7/30/90 days, and learning cycles recorded with promotion gates.
7. Hardening: tested backup and restore, audit logs for canonical writes, plain-language errors, full test suite green.
8. Commercial readiness, later: customer API keys identify a project for quota, not authorization alone; rate-limit headers and problem+json errors; licence review for every redistributed field.

## Decision rule

When sources disagree, preserve both readings with provenance and let deterministic identity rules decide, or send the case to a review queue. Never smooth a conflict into a single invented fact. If a requirement cannot be met from evidence we lawfully hold, state the gap plainly.

Sources:
[67] https://developer.ebay.com/develop/apis/api-license-agreement — eBay API License Agreement
[68] https://developer.ebay.com/develop/get-started/get-started-on-a-buying-application — eBay Get Started on a Buying Application
[80] https://developer.ebay.com/api-docs/static/gs_ebay-rest-getting-started-landing.html
[83] https://myslabs.com
[84] https://www.nearmint.ai
[85] https://130point.com
