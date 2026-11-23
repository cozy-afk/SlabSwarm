# PSA Certificate Verification Review — 2026-11-23

Gated research review for Task 9 of the Free Data Foundation plan. No PSA API call was made, no adapter was written, no token was read or stored, and no production, listener, firewall or DNS change was made. Every external claim below is grounded in the primary PSA documentation [51][52]; the ledger citations match the plan's source list.

## Decision

**APPROVED FOR PLANNING (gated).** PSA certificate verification is a legitimate *evidence source about a graded instance* and may later enter our database as a provenance-bearing record — but it is **not** a price, sale, population or guide source, and it stays unimplemented until the token-rotation and End User Agreement gates below are cleared. No production call is made in this task either way.

One line: cert verification may be planned as grader-attested evidence about an instance, never as market evidence, and only after the exposed token is rotated and the PSA End User Agreement is reviewed.

## 1. Capability boundary

Verified from the primary docs [51][52]:

- **Single-item verification only.** The documentation states: "We currently offer access to data from Cert Verification for single item searches by cert number" [51]. The one in-scope method is `GET /cert/GetByCertNumber/{certNumber}` [52].
- **Authentication.** All requests are HTTPS to `https://api.psacard.com/publicapi/` [51]. The token is generated from PSA login credentials via OAuth 2 password grant and sent as an `Authorization: bearer <access token>` header [51]; the Swagger spec defines a `Bearer` apiKey security scheme in that header and instructs "`Bearer yourToken`" [52]. The API portal warns never to expose PSA credentials in client-side code [51].
- **200 does not mean data.** A successful HTTP call returns 200 even when nothing is found: `{ "IsValidRequest": true, "ServerMessage": "No data found" }` is a valid-format-but-empty result, distinct from a successful lookup (`"ServerMessage": "Request successful"`) and from a malformed request (`{ "IsValidRequest": false, "ServerMessage": "Invalid CertNo" }`) [51]. Other documented codes: 204 for empty request data (missing cert number), 4xx for a bad path, and 500 for invalid credentials or a server error [51]. Any adapter must therefore distinguish "no record" from "record returned" by parsing the body, not the status code, and must treat "No data found" as `UNKNOWN`, not as a negative fact about the card.
- **Swagger lists more paths than the docs offer.** The spec also advertises `GetByCertNumberForFileAppend`, `GetImagesByCertNumber`, order-progress and population paths [52], but the current documentation scopes available access to single-item Cert Verification [51]. Those extra methods are out of scope for this review and their availability/data quality is unverified; we do not assume them.

**Boundary statement:** this API returns a grader's own recorded description and grade for a slab identified by cert number. That is authoritative *identity/grade evidence about one instance* [51]. It contains no sold price, asking price, price guide, market value, or completed-sale data, and it is **not a price or sales source**. It must never be used to populate a price, GUIDE, SOLD or population observation. At most it can corroborate the identity and grade fields of a graded instance.

## 2. Exposed-token rotation rule

- A PSA bearer token was pasted into chat on 2026-11-23. It is exposed and must be treated as compromised. The owner must **regenerate it in the PSA portal**. Regeneration is required even though the acceptance gate is closed, because an exposed bearer token is a credential derived from the PSA login [51].
- The exposed value must not be used, repeated, logged or stored. **No token value may appear in chat, code, tests, docs, ledger files or logs.** This document records no token value.
- The owner declined to use the exposed token "for now" and rotate later; that request was correctly refused. A credential pasted in chat cannot be accepted or used by this assistant under the no-secrets-in-chat rule, regardless of rotation intent.
- **Replacement handling:** the new token goes into the vault or the private server `.env` only, and the application reads it server-side by environment-variable name. Never place it in client-side code, a committed file, a test fixture or a doc [51].
- This rule is a hard prerequisite: no adapter, no live call and no verification of response shape against the live API may happen until rotation is confirmed.

## 3. End User Agreement gate

- The PSA API documentation links an **"API End User Agreement"** that must be reviewed before any live calls [51]. Related terms published by the same provider are the Collectors User Agreement and PSA's Terms & Conditions / Privacy Policy; the exact API EULA is the one linked from the documentation page [51].
- The agreement is unresolved in this task. **Until that review is complete, this task produces no adapter.** The review must answer, at minimum:
  - May certificate responses be stored, cached or persisted in our own database, and for how long?
  - May PSA data and any cert images be displayed in our UI, and under what attribution?
  - Are local caching, bulk download and commercial or redistribution use restricted?
  - What rate limits, quotas or paid-tier conditions apply, and is non-display/algorithmic use permitted?
- These are the real gate questions. Community-writeups circulate figures such as a 100-calls/day free tier and claims about commercial-use terms, but those are **third-party and unverified**; they are not evidence and must not be treated as authoritative. Only the primary agreement and docs govern. No live call is made here to test any limit.

## 4. How cert verification may later enter as evidence

If and only if the gates are cleared, a future adapter may write an append-only, provenance-bearing record for a graded instance:

- **Basis:** grader-attested identity/grade (`CLAIM` from PSA as the authoritative grader for its own certs) — a fact about the *instance*, never a market observation.
- **Provenance:** record `source = PSA Public API / GetByCertNumber`, the cert number queried, `observed_at`, server-generated `captured_at`, `lineage` and `confidence`, consistent with the plan's global evidence rules.
- **Null semantics:** "No data found" → `UNKNOWN` (append an explicit no-record observation, not a zero and not a false assertion). Never overwrite or mutate an existing record; corrections append.
- **Scope guard:** no field from this API may flow into price, sold, asking, guide, population or sales tables. It can corroborate instance identity/grade only.
- **No new surface:** credentials stay server-side, no new public listener, no firewall or DNS change.

## Prerequisite checklist (all must be true before any adapter)

- [ ] Owner has regenerated the exposed token in the PSA portal; the old value is confirmed dead and never appears in chat/repo/logs.
- [ ] Replacement token is stored only in the vault or private server `.env`, read server-side by env-var name, never in code/tests/docs/client.
- [ ] PSA API End User Agreement has been read and the storage/caching, display, attribution, redistribution, commercial-use and rate-limit questions in §3 have a recorded answer.
- [ ] Rate limits/quotas confirmed from primary sources (not third-party claims).
- [ ] Any future adapter is scoped to cert verification only, writes immutable provenance-bearing evidence about instances, maps "No data found" to `UNKNOWN`, and is barred from price/sales/population fields.
- [ ] No production wiring, live call, new listener, firewall or DNS change is part of this task.

## Sources

[51] https://www.psacard.com/publicapi/documentation — PSA Public API docs (HTTPS base URL; bearer auth from PSA login credentials; OAuth 2 password grant; currently single-item Cert Verification by cert number; 200 may mean "No data found"; error codes; "Review the PSA API End User Agreement" link; warning against client-side credentials)

[52] https://api.psacard.com/publicapi/swagger.json — PSA Public API Swagger 2.0 spec (Bearer apiKey auth in `Authorization` header; `GET /cert/GetByCertNumber/{certNumber}`; additional advertised paths)

Portal / related terms (context only, not verified as the API EULA): https://www.psacard.com/publicapi ; https://app.collectors.com/collectorsuseragreement ; https://www.psacard.com/termsandconditions
