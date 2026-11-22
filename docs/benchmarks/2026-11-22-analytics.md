# Analytics Benchmarks — 2026-11-22

Phase 3 (Analytics and Discovery) of the Slabswarm data-product rebuild.
Numbers below are real output from this worktree, not estimates.

## Environment

- Branch: `dp-analytics`
- Worktree: `/opt/slabswarm/.superpowers/sdd/dp-analytics`
- Runtime: Node `v26.12.1`, `aarch64` Linux
- DuckDB: `@duckdb/node-api` `2.0.1-r.1` (native binding, in-memory)
- Command: `npx tsx --test tests/benchmarks/analytics.test.ts`
- No live containers, network calls or public listeners were used. The route
  tests bind an ephemeral loopback socket only and close it in teardown.

## Measured results

All inputs are deterministic fixtures: 240 market observations across SOLD and
ASKING bases and USD/EUR currencies, plus 12 evidence records, one identity,
one event, one forecast and one score. Timings are wall-clock milliseconds.

| Metric | Value |
| --- | ---: |
| Built-in query (`basis_mix`) latency, cold in-memory load | 616.82 ms |
| Raw grouped aggregation latency, cold in-memory load | 596.63 ms |
| Discovery sweep over 240 observations | 17.08 ms |
| Parquet export of all six datasets | 674.26 ms |
| Observations exported / re-read from Parquet | 240 |
| Distinct bases preserved in Parquet | 2 (SOLD, ASKING) |
| Distinct currencies preserved in Parquet | 2 (USD, EUR) |
| Basis/currency groups returned by SQL Lab | 4 |
| Basis-matched anomaly findings | 9 |
| Total findings from sweep | 13 |

Raw benchmark output:

```text
[bench] query_latency_ms built_in=616.82 raw=596.63 rows=4
[bench] basis_preservation groups=4 observations=240
[bench] comps_correctness anomalies=9 findings=13 sweep_ms=17.08
[bench] export_completeness datasets=6 rows=240 bases=2 currencies=2 export_ms=674.26
[bench] analytics {"queryBuiltInMs":616.82,"queryRawMs":596.63,"basisGroups":4,"sweepMs":17.08,"exportMs":674.26,"exportedRows":240}
```

Suite result: **4 tests, 4 pass, 0 fail** (duration 3051 ms).

## What each benchmark gates

- **Query latency** — both the allow-listed template path and raw read-only SQL
  execute against DuckDB and complete under 5 s with 240 observations. Each
  call loads a fresh isolated in-memory database, so the number includes the
  full projection/setup cost; steady-state queries are faster.
- **Basis preservation** — SQL Lab counts sum to the full observation count
  and every `basis|currency` pair is unique. SOLD is never pooled with ASKING,
  and no FX conversion is inferred.
- **Comps correctness** — anomaly findings name exactly one explicit basis and
  one currency, and their summaries state the same basis. A cross-basis
  comparison would fail this case.
- **Export completeness** — all six derived datasets (evidence, observations,
  identities, events, forecasts, scores) are written, row counts match the
  snapshot exactly, and basis/currency survive the Parquet round trip. Missing
  facets export as the literal `UNKNOWN`, never zero.

## Constraints verified

Analytical outputs are derived and rebuildable; no derived fact is promoted to
canonical by these jobs. The Parquet lake is wiped and rebuilt per export, and
discovery findings are research notes only. Missing values remain `UNKNOWN`.
SQL Lab accepts exactly one read-only `SELECT`/`WITH` statement and rejects
writes, DDL, stacked statements and external file-read functions before the
native binding sees them.

## Re-run

```bash
cd /opt/slabswarm/.superpowers/sdd/dp-analytics
npx tsx --test tests/benchmarks/analytics.test.ts
npx tsx --test tests/analytics/*.test.ts
npx tsc --noEmit
```
