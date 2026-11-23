# eBay marketplace access review — 2026-11-23

**Gate status: NOT APPROVED — NO EBAY FEED.** No adapter was built, no keyset was
used, and no eBay API call was made in this task. Production ingest stays blocked
until every owner prerequisite in §4 is supplied and documented.

Scope: this is an engineering compliance gate, not legal advice. Evidence is the
primary eBay developer documentation retrieved on 2026-11-23; the quoted text is
verbatim from those pages. eBay states the API License Agreement may be updated
and that developers "must ensure compliance with currently posted terms" [67], so
this review must be re-checked against the live pages before any approval is acted
on.

## 1. The blocking clause [67]

Under the heading **"Prohibited Use and Derivation of Information"**, the eBay API
License Agreement states [67]:

> You must have eBay’s express prior written permission to use or display eBay
> Content in any way that enables derivation of, including without limitation,
> any of the following:
>
> - Any site-wide statistics across eBay Sites or within any eBay Site;
> - Take-up rates for enhanced listings (for example, gallery, featured, category
>   featured, etc.);
> - Statistics relating to the performance (financial or otherwise) of any eBay
>   Service (for example, gross merchandise sales);
> - **Average selling price or gross merchandise sold for any eBay category.**

Two further passages in the same agreement remove any doubt for our use case [67]:

> “Restricted APIs” refers to any eBay APIs that provide information about
> market trends, pricing strategies, sales volumes, user behavior, or provide
> generated content (including content using artificial intelligence in response
> to your inputs). Access is specially granted to select Developers.

> Developer is permitted to use, modify, create derivative works of, publicly
> display and host, and distribute data outputs of the Restricted APIs Data
> during the Term to develop pricing tools, only upon receiving eBay’s express
> prior written consent.

**Plain statement:** our intended use — ingesting eBay sold-item history (the
Marketplace Insights sold data) to derive prices for trading-card price guidance —
is precisely "derivation of" the "Average selling price ... for any eBay category"
listed above, and is "develop pricing tools" from Restricted APIs data. Our use
falls squarely inside the clause. We do not have eBay's express prior written
permission. We therefore may not lawfully ingest eBay sold data for price
derivation at this time.

## 2. Sandbox is for plumbing, not for data

The primary getting-started guide describes the Sandbox as "a self-contained
virtual testing environment" and says: "Items listed and sold in the Sandbox
aren't real transactions, and all listing fees and item purchases are paid with
fictional money" [80]. Marketplace Insights is the Buy API that retrieves "the
sales history of items sold on eBay" and is flagged as a Limited Release [68].

**Sandbox transactions are mocks. Sandbox cannot supply real sold prices**, so it
cannot supply the price observations our product needs. Any Sandbox work is
limited to plumbing: OAuth/auth flow, request shape, error handling and
rate-limit behaviour, using injected fetch only. No such adapter was built here.

No Sandbox keyset was available: the vault `list` returned no saved logins and no
private `.env` exists in this worktree (only `.env.example`, which has no eBay
variables). Per the task constraint, no keyset was invented and no adapter that
would require one was created. A Sandbox keyset, if wanted later, is an owner
prerequisite below; keys must be stored server-side through the vault or the
private `.env`, never in chat, code, tests or docs.

## 3. Access path from the primary docs [68][80]

- eBay Developers Program membership is free: "eBay Developers Program
  membership is free, and you can use virtually any programming language to
  interface with eBay APIs" [80]. Joining requires a business email and
  acceptance of the API License Agreement [80].
- Keysets are environment-specific: "For your application to run in the Sandbox
  or Production environment, it needs to have the appropriate keyset for that
  environment" [80].
- Buy APIs are not open self-service: "The Buy APIs listed above are intended for
  certain approved eBay partners based on their application. Acceptance of
  applications is based on the proposed business model, as well as a formal
  agreement to abide by the policies and requirements stipulated by eBay" [68].
- Marketplace Insights — the sold-history API — is a Limited Release [68].
- The documented path is: (1) eBay Developer account; (2) meet Buy API minimum
  requirements and agreements; (3) integrate and test in Sandbox; (4) apply for
  an Application Growth Check to get access to Buy APIs in Production; (5) go
  live [68].
- The growth check is not optional for us: "The Application Growth Check is a
  mandatory step for using restricted Buy APIs in Production. This is done by
  the eBay team as a final step before granting Production access to the
  partner’s production keyset to access Buy APIs" [68].

## 4. Owner prerequisites before any production code is enabled

1. **Production keyset** — supplied by the owner and stored server-side through
   the vault or the private `.env`. Never pasted into chat, code, tests or docs.
2. **Written permission for price derivation** — eBay's express prior written
   permission covering the clause in §1, including the pricing-tools consent for
   Restricted APIs data. The permission must be documented, not assumed.
3. **Buy API approval** — approved-partner status and access to the Limited
   Release Marketplace Insights API [68].
4. **Call-volume estimate** — estimated hourly and daily call volume for the
   Application Growth Check [68].
5. **Sandbox keyset (optional)** — only if adapter plumbing is later authorised;
   also stored server-side. Currently unavailable; not invented here.

Constraints that remain in force: no production calls, no new listener, no
firewall or DNS changes, no credentials in the repository. A Sandbox adapter may
exist in code at some point, but it must stay disabled against Production until
items 1–4 are documented.

## 5. Decision

**Not approved, no eBay feed.** The licence clause in §1 covers our exact purpose,
and none of the four production prerequisites is in place. Sold-price data from
eBay stays out of the product until the owner supplies written permission, the
Production keyset, Buy API approval and the growth-check volumes.

Sources:
[67] https://developer.ebay.com/develop/apis/api-license-agreement — eBay API License Agreement
[68] https://developer.ebay.com/develop/get-started/get-started-on-a-buying-application — eBay Get Started on a Buying Application
[80] https://developer.ebay.com/api-docs/static/gs_ebay-rest-getting-started-landing.html
