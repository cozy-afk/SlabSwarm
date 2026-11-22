# Slabswarm Data Product API (contract)

The machine-readable contract is [`../openapi.json`](../openapi.json) (OpenAPI 3.1.0).
It is contract-first: the UI in `src/components/product/` is built against these
planned endpoints. Backend lanes implement persistence behind them.

## Response envelope

Every operation returns `{ data, meta }`:

```json
{
  "data": { "...": "endpoint-specific payload" },
  "meta": {
    "requestId": "req-...",
    "generatedAt": "2026-11-22T00:00:00.000Z",
    "contractVersion": "2026-11-22.1",
    "provenance": {
      "source": "ebay-listing-adapter",
      "observedAt": "2026-11-21T18:00:00.000Z",
      "capturedAt": "2026-11-21T18:04:11.000Z",
      "lineage": ["raw:...", "observation:..."],
      "confidence": "MEDIUM"
    },
    "basis": "SOLD"
  }
}
```

`provenance` and `basis` are required on all canonical record schemas. `NULL`
means **UNKNOWN**, never zero: missing shipping, fees, FX, grade or condition is
never silently treated as a real value.

## Basis vocabulary

`SOLD`, `ASKING`, `OFFER`, `GUIDE`, `CLAIM`, `POPULATION`, `UNKNOWN`. Basis is
explicit and is never inferred from an amount or defaulted by the server.

## API groups

| Group | Endpoints |
| --- | --- |
| Evidence & Ingest | `/api/evidence`, `/api/observations`, `/api/ingest/{source}` |
| Catalog | `/api/catalog/search`, `/api/catalog/{id}`, `/api/catalog/{id}/printings` |
| Market | `/api/pricing/{id}`, `/api/comps/{id}`, `/api/market/{id}` |
| Intelligence | `/api/intelligence/harvest-legacy`, `/api/intelligence/discovery-sweep`, `/api/intelligence/findings` |
| Swarm | `/api/swarm/research/run`, `/api/swarm/runs/{id}` |
| Forecast | `/api/forecasts`, `/api/forecasts/{id}`, `/api/forecasts/{id}/score`, `/api/forecasts/{id}/backtest` |
| Learning | `/api/learning/state`, `/api/learning/feedback`, `/api/learning/run-cycle` |
| SQL Lab | `/api/sql/query`, `/api/sql/saved` |
| Hermes (stable) | `/api/hermes/status`, `/api/hermes/tools` |

## Non-negotiables encoded in the contract

- Raw evidence is immutable; corrections append (`meta.correctionPolicy = APPEND_ONLY`).
- Simulations are hypotheses, never sales evidence (`Forecast.status = HYPOTHESIS` until scored).
- Deterministic code computes valuations and scores; models only propose, explain, challenge.
- Every forecast is scored at 7/30/90 days against real outcomes before learning.
- Learning promotion requires the benchmark gate (`LearningState.benchmarkGate`).
- Hermes tool IDs are stable: `get_collectible_valuation`, `scan_arbitrage_spreads`,
  `query_knowledge_graph`, `ingest_market_listing`.

## Tests

- `tests/ui/productizationSourceContract.test.ts` — source-contract location.
- `tests/benchmarks/productization.test.ts` — golden contract checks; the
  repository `npm test` glob picks up this file and registers the source
  contract through the shared module.
