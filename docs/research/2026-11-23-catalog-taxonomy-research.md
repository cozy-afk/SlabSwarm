# Catalog Taxonomy Research — 2026-11-23

Scope: what public catalog systems actually model for trading cards, sports cards and comics, plus standards that affect a database we intend to own. Method: four parallel research lanes using web search and page extraction. Every external claim below carries a ledger citation; the ledger was populated from retrieved URLs, not from memory.

## 1. Identity is several levels, not one product ID

The strongest systems split identity from printing. TCGGraph states that a card record is a printing, with each set, collector number and language getting its own id, and that there is no id grouping every printing of a card [6]. Scryfall expresses the same split with `oracle_id` shared across reprints and a separate id for each printing [8]. TCGplayer's hierarchy is category → group → product → SKU, where SKU is the tuple language, printing and condition [11][12]. The Pokémon TCG API keeps embedded set data and one row per printing or finish [1][2].

Design consequence: our `cards` table cannot be the only identity level. We need property, set, card identity, printing, finish/variant, instance, and a marketplace SKU as separate concepts.

## 2. Prices are sourced observations, not card fields

TCGGraph keeps TCGplayer USD and Cardmarket EUR as separate records and does not convert one into the other [6]. Scryfall syncs prices from affiliates every 24 hours and uses TCGplayer market price rather than low, mid or high [10]. The Pokémon TCG API labels its nested price blocks explicitly in US dollars and euros [2]. PriceCharting and eBay's sold-item API are both gated — the first requires a paid subscription and a commercial licence to redistribute [24], the second is a limited-release API approved only for select developers [25]. TCGplayer is no longer granting new API access [11], and Cardmarket's official developer docs returned HTTP 403 during research [16].

Design consequence: keep `(source, currency, basis, condition, language, timestamp)` on every quote. Assume we cannot rely on the biggest marketplaces as primary feeds.

## 3. Sports cards add subjects, seasons and graded instances

The Card API's sold records expose player, team, season, league, sport, card number, `print_run` (the denominator of a serial fraction), grader, grade, cert and autograph grade [19]. Trading Card API models parallels with `parent_id` on the child card and flags such as `is_parallel`, `is_variation` and `is_insert` on sets [20][21]. GemRate keys population data under grader-specific labels such as `psa_10` and `beckett_9_5` [22]. schema.org treats item condition as a coarse enumeration distinct from a grading scale [44][45].

Design consequence: sports cards need subject entities, season, team-on-card, serial print run, and a grader-scoped certificate table. Condition and grade must not share a column.

## 4. Comics use volume, issue and variant as identity

W3C's periodicals guidance says a comic issue is uniquely identified by series name and volume, issue number, and variant description when present [30]. Volume is specific to US comics and may be a number or a start year, kept distinct from `startYear` [29][30]. ComicVine separates `cover_date` from `store_date` and defines `issue_number` within a volume [27]. CGC's population report organizes by publisher, title and issue number [34], and a CGC label carries a colour category, numeric grade and certification number [35]. A library study argues for keeping the published issue separate from the physical copy [33].

Design consequence: comics need publisher → series → volume → issue → variant → copy, with cover date and on-sale date kept separate. They do not fit a card-number-only key.

## 5. Standards worth adopting now

ISBN identifies a specific edition and format, not the work [47]. GTIN identifies a trade item across the supply chain [48][5]. schema.org's `identifier` covers arbitrary vendor schemes [41], while `sku` is merchant-specific [43]. Product and Offer are distinct: descriptive identity on the product, price and currency on the offer [37][38][46]. W3C PROV models entities, activities and agents with `wasDerivedFrom` and qualified usage — a good fit for evidence-backed catalog values [49][50]. Record-linkage practice calls for normalization, blocking before pairwise comparison, two thresholds with a review queue, and persistent IDs [56][57].

Design consequence: add an `identifiers` table with scheme, normalized value, raw value and validity; keep offers and catalog facts apart; make every catalog value provenance-bearing; keep merges reversible.

## 6. API conventions to copy early

JSON:API requires a top-level `data` or `errors` member and forbids both together [58]. RFC 9457 defines `application/problem+json` for machine-readable errors [59]. HTTP 429 with `Retry-After` is the standard response for rate limiting [61]. A standard API key associates a request with a project for quota and billing; it does not authenticate a principal [62]. Rate-limit headers are still an IETF draft, not a finished RFC, so treat them as advisory [60].

Design consequence: our `{data,meta}` envelope is close. Add problem+json errors, 429 with Retry-After, and treat future customer keys as project identifiers, not authorization by themselves.

## 7. Consumer catalogs as product shape, not feeds

The pasted list mixes three different things: collection trackers, physical storage, and price guides. Physical storage is irrelevant to the API. The useful signal is that mature products separate catalog/checklist data from price observations. Trading Card API's own provenance docs say every checklist, metadata field or image originated somewhere, and model that as Set Sources with `source_type` of `checklist`, `metadata` or `images` [71]. That maps directly onto our evidence and provenance design.

Trading Card Database and LastDodo are consumer catalogues. Trading Card API uses tradingcarddb.com as an example checklist source URL, not as an open feed [71]; LastDodo's public page is a browsable catalogue with no developer API found [73]. Beckett guides are print reference data with no API found; they would enter through manual/CSV ingestion if we can license them.

PriceCharting and SportsCardsPro are paid: APIs require a subscription token, CSV export is limited to top tiers, and historic prices and sales are not supported by the official API [72]. Third-party wrappers exist — ReefAPI exposes SportsCardsPro grades, population, monthly history and completed sales behind its own key and credit meter [74] — but terms and redistribution rights need checking before use.

Direction: keep our split between immutable catalog facts and sourced market observations. Add a `sources` concept to sets/checklists. Treat consumer catalogs as manual/CSV research inputs. Do not treat any of them as a free market feed.

## Access and licensing reality

Several useful sources are closed, gated or legally restricted: TCGplayer no longer grants new access [11], Cardmarket docs were unreachable [16], and eBay sold data is limited release [25]. PriceCharting redistribution needs a commercial licence [24]. Populate our own database from sources we can legally use, and record licence on every evidence row.

Sources:
[1] https://docs.pokemontcg.io/api-reference/sets/set-object — Pokemon TCG API - set object
[2] https://docs.pokemontcg.io/api-reference/cards/card-object — Pokemon TCG API - card object
[5] https://schema.org/gtin — schema.org gtin
[6] https://tcggraph.com/llms-full.txt — TCGGraph complete reference
[8] https://scryfall.com/docs/api/cards — Scryfall Card Objects
[10] https://scryfall.com/docs/faqs/where-do-scryfall-prices-come-from-7 — Scryfall price sources
[11] https://docs.tcgplayer.com/docs/getting-started — TCGplayer API getting started
[12] https://docs.tcgplayer.com/reference/catalog_getskusbyproductid — TCGplayer List Product SKUs
[16] https://developer.cardmarket.com/api — Cardmarket official API docs
[19] https://www.thecardapi.com/docs — The Card API docs
[20] https://tradingcardapi.com/docs/api/models — Trading Card API data models
[21] https://tradingcardapi.com/docs/data-coverage — Trading Card API data coverage
[22] https://docs.gemrate.com/introduction — GemRate API docs
[24] https://www.pricecharting.com/api-documentation — PriceCharting API docs
[25] https://developer.ebay.com/api-docs/buy/marketplace-insights/resources/item_sales/methods/search — eBay Marketplace Insights item sales
[27] https://comicvine.gamespot.com/api/documentation — ComicVine API docs
[29] https://anansi-project.github.io/docs/comicinfo/documentation — Anansi ComicInfo docs
[30] https://www.w3.org/wiki/WebSchemas/PeriodicalsComics — W3C Periodicals and Comics
[33] https://cdr.lib.unc.edu/downloads/1544bs811?locale=en — Comic Book Metadata and Database Design
[34] https://www.cgccomics.com/population-report — CGC Population Report
[35] https://www.qualitycomix.com/guide/how-read-cgc-label — Reading a CGC label
[37] https://schema.org/Product — schema.org Product
[38] https://schema.org/Offer — schema.org Offer
[41] https://schema.org/identifier — schema.org identifier
[43] https://schema.org/sku — schema.org sku
[44] https://schema.org/itemCondition — schema.org itemCondition
[45] https://schema.org/OfferItemCondition — schema.org OfferItemCondition
[46] https://schema.org/price — schema.org price
[47] https://www.isbn-international.org/content/what-isbn/10 — International ISBN Agency
[48] https://www2.gs1.org/standards/id-keys/gtin — GS1 GTIN
[49] https://www.w3.org/TR/prov-o — W3C PROV-O
[50] https://www.w3.org/TR/prov-primer — W3C PROV primer
[56] https://en.wikipedia.org/wiki/Record_linkage — Record linkage
[57] https://www.zingg.ai/deep-dives/the-what-and-why-of-entity-resolution — Entity resolution pipeline
[58] https://jsonapi.org/format/1.0 — JSON:API 1.0
[59] https://www.rfc-editor.org/rfc/rfc9457 — RFC 9457 problem details
[60] https://datatracker.ietf.org/doc/html/draft-ietf-httpapi-ratelimit-headers — RateLimit headers draft
[61] https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/429 — HTTP 429 MDN
[62] https://cloud.google.com/docs/authentication/api-keys — Google API keys
[71] https://tradingcardapi.com/docs/concepts/data-provenance — Trading Card API - Data Provenance and Set Sources
[72] https://www.sportscardspro.com/api-documentation — SportsCardsPro Prices API documentation
[73] https://www.lastdodo.com/en/catalog/20191-trading-cards — LastDodo trading cards catalogue
[74] https://reefapi.com/docs/sportscardspro.md — ReefAPI SportsCardsPro reference
