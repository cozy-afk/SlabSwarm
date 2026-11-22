# Phase 4 — Swarm, Simulation, Forecasting, Learning

**Spec:** `docs/superpowers/specs/2026-11-22-data-product-design.md`

**Depends on:** Phases 1–3.

**Goal:** Own agentic swarm, scenario simulation, forecast API, backtesting, and learning loop.

## Global Constraints

- Simulations are hypotheses, never evidence.
- Agents use registered tools and bounded evidence packets.
- No model writes canonical facts directly.
- Forecasts use price bands, drivers, invalidators, evidence IDs, confidence.
- Learning promotes only through benchmark non-regression.

## Task 1: Swarm v2 tool registry

- [ ] Create `server/swarm/tools.ts` with registered tools: query_graph, get_market_observations, get_comps, get_event_history, get_factor_scores, search_sources, run_deterministic_baseline, run_simulation, backtest_forecast, propose_alias, propose_factor, propose_forecast.
- [ ] Create bounded evidence packet builder.
- [ ] Add structured role outputs and run records.
- [ ] Add tests for tool allowlist and evidence ID requirements.

## Task 2: Swarm roles

- [ ] Implement ingest triage, identity detective, evidence scout, market modeler, social signal analyst, skeptic, judge, report agent.
- [ ] Each role outputs structured JSON with citations.
- [ ] Judge/skeptic can reject proposals.
- [ ] Add `POST /api/swarm/research/run` and `GET /api/swarm/runs/:id`.

## Task 3: Simulation engine

- [ ] ScenarioSpec, persona registry, world model, social loop, market loop, event injection.
- [ ] Output price bands, demand/supply pressure, drivers, invalidators, confidence.
- [ ] Add `POST /api/simulations/run`.
- [ ] Add determinism tests with fixed seed and fixed evidence.

## Task 4: Forecast API and scoring

- [ ] Create forecasts and forecast_scores repositories.
- [ ] Add `POST /api/forecasts`, `GET /api/forecasts/:id`, `POST /api/forecasts/:id/score`.
- [ ] Score at 7/30/90 days: band coverage, direction, MAE, Brier.
- [ ] Add tests.

## Task 5: Backtesting

- [ ] Replay past events using only pre-event evidence.
- [ ] Compare predicted price path to realized outcomes.
- [ ] Add `POST /api/forecasts/:id/backtest`.
- [ ] Add benchmarks.

## Task 6: Learning loop

- [ ] Update source trust, factor weights, persona parameters, confidence calibration from scores.
- [ ] Add `GET /api/learning/state`, `POST /api/learning/feedback`, `POST /api/learning/run-cycle`.
- [ ] Promotion requires benchmark non-regression.
- [ ] Add tests and benchmarks.
