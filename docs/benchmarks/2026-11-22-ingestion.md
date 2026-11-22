# Ingestion benchmarks — 2026-11-22

**Phase:** 2 (Ingestion) · **Suite:** `tests/benchmarks/ingestion.test.ts`
**Run command:** `npx tsx --test tests/benchmarks/ingestion.test.ts`

All benchmarks are deterministic, in-process and network-free. No live TCGAPIs
call, no real key, no database, and no LLM is involved. Timings are from a
single run on the dev container and are indicative, not SLOs.

## Results

| Benchmark | Metric | Result |
| --- | --- | --- |
| Duplicate rate | first run created / second run duplicates / rate | 30 / 30 / **1.000** |
| Parse success | valid / total rows / success rate | 97 / 100 / **0.970** |
| Run latency | 100 items / created / candidates / total / per item | 100 / 100 / 100 / **21.87 ms** / **0.219 ms/item** |

Raw JSON emitted by the suite:

```json
{"benchmark":"ingestion-duplicate-rate","createdFirstRun":30,"duplicatesSecondRun":30,"duplicateRate":1,"elapsedMs":33.93}
{"benchmark":"ingestion-parse-success","totalRows":100,"validRows":97,"invalidRows":3,"parseSuccessRate":0.97,"parserErrors":3}
{"benchmark":"ingestion-run-latency","items":100,"created":100,"candidates":100,"elapsedMs":21.87,"msPerItem":0.219}
```

## What each benchmark guards

- **Duplicate rate** — the same CSV ingested twice must produce zero new
  evidence on the second run. This exercises idempotency by source + native id
  + checksum, and catches a common regression where a per-run `capturedAt`
  leaks into the checksummed payload (the legacy adapter had to be fixed for
  exactly this).
- **Parse success** — 97 well-formed rows and 3 structurally malformed rows.
  The suite asserts the malformed rows are reported as errors and never become
  evidence, and that a row with a missing price/basis/currency keeps
  `null` / `UNKNOWN` rather than `0` / `SOLD`.
- **Run latency** — 100 items through fetch → immutable evidence → candidate
  observations → run record. The current budget assertion is < 5000 ms so the
  suite measures gross regressions without being flaky on slow CI.

## Gate recommendation

Promote ingestion changes only when all three benchmarks pass and the
duplicate rate stays exactly `1.000`. A falling parse-success rate or a latency
regression above the budget should block promotion per the global
"learning promotes only through benchmark gates" constraint.
