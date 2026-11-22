# Intelligence lane benchmark baseline — 2026-11-22

Phase 4 (swarm v2, simulation, forecasts/scoring, backtesting, learning).
Companion suite: `tests/benchmarks/intelligence.test.ts`.

## Purpose

Deterministic, network-free golden tests over the full intelligence pipeline.
These are regression tripwires, not performance measurements. Golden values
below were produced by actually running this lane's code on a fixed fixture.

## Golden fixture

- Four evidence items sorted by ID: `ev-claim` (CLAIM/LOW, reprint rumour),
  `ev-event` (UNKNOWN/MEDIUM, tournament), `ev-sold-1` (SOLD/HIGH, 100 USD),
  `ev-sold-2` (SOLD/HIGH, 110 USD).
- Evidence packet digest (sha256 of ordered items):
  `9ba5290a7b5f9ac10dd3b69030fadcbc2737a0a8641aa0060501d274ea513e16`
- Scenario: `golden-scenario`, seed `7`, 30-day horizon, baseline 105 USD,
  demand shock +0.2, supply shock -0.05, day-7 reprint rumour, day-14
  tournament, personas `collector` + `flipper`.
- Simulation identity: `sim-2c59debf7a2830e3`.
- Simulation bands: low `99.75`, base `107.34`, high `112.98` USD;
  demand pressure HIGH, supply pressure MEDIUM, confidence HIGH; status
  HYPOTHESIS.

## Golden scores and gates

| Surface | Expected |
|---|---|
| Score of realized 112 against band 95/110/125, baseline 105 | covered `true`, direction `true`, MAE `2`, Brier `0.04`, horizon `30` |
| Backtest vs naive pre-event SOLD median | MAE `5.666666`, baseline MAE `8`, band coverage `1`, verdict `NON_REGRESSION` |
| Backtest leakage | `used = [ev-sold-1, ev-sold-2]`, `leaked = [ev-leak]` (captured after event) |
| Learning, blocked by regressing benchmark | `promoted=false`, `reason=BENCHMARK_REGRESSION`, state unchanged at version 1 |
| Learning, promoted by derived non-regressing backtest | `promoted=true`, `reason=BENCHMARK_NON_REGRESSION`, version 2, cycleCount 1 |
| Learned state after promotion | `sourceTrust={ev-sold-1:0.1, ev-sold-2:0.1}`, `factorWeights.band_coverage=1`, `calibration.HIGH={count:1, covered:1, meanBrier:0.04}` |

## Constraints encoded as tests

- Simulations stay `HYPOTHESIS`; conversion to a forecast never adds a basis
  or turns a simulation into sales evidence.
- Comps admit SOLD evidence only; basis is never inferred.
- Unbacked outcomes and feedback events are rejected
  (`OUTCOME_EVIDENCE_REQUIRED`, `FEEDBACK_EVIDENCE_REQUIRED`).
- Backtests consume only evidence observed **and** captured before each event;
  future information is reported as leaked, never used.
- Learning promotes only through a non-regression benchmark; a blocked cycle
  is a strict no-op and repeated cycles produce byte-identical state.
- All twelve tool IDs are stable and every tool requires in-packet evidence IDs.

## Reproduction

```bash
cd /opt/slabswarm/.superpowers/sdd/dp-intelligence
npx tsx --test tests/benchmarks/intelligence.test.ts
```

Historical result: 5 tests, 5 pass, 0 fail.
