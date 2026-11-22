import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PERSONAS,
  runSimulation,
  simulationToForecastProposal,
  type ScenarioSpec,
} from '../../server/simulation/engine.ts';

const SPEC: ScenarioSpec = {
  id: 'scenario-1',
  targetId: 'card-x',
  targetType: 'CARD',
  horizonDays: 30,
  seed: 42,
  baselinePrice: 100,
  currency: 'USD',
  demandShock: 0.4,
  supplyShock: -0.1,
  events: [
    { day: 7, type: 'REPRINT_RUMOUR', magnitude: -0.3, evidenceId: 'ev-rumour' },
    { day: 14, type: 'TOURNAMENT', magnitude: 0.25, evidenceId: 'ev-event' },
  ],
  personas: ['collector', 'flipper'],
  evidenceIds: ['ev-sold', 'ev-rumour', 'ev-event'],
  asOf: '2026-03-01T00:00:00.000Z',
};

test('simulation is deterministic for a fixed seed and fixed evidence', () => {
  const a = runSimulation(SPEC);
  const b = runSimulation(SPEC);
  assert.deepEqual(a, b);
  assert.equal(a.id, b.id);
  assert.deepEqual(a.pricePath, b.pricePath);
});

test('changing the seed changes the path but not the scenario identity', () => {
  const a = runSimulation(SPEC);
  const b = runSimulation({ ...SPEC, seed: 43 });
  assert.notDeepEqual(a.pricePath, b.pricePath);
  assert.equal(a.scenarioId, b.scenarioId);
});

test('simulation output is a hypothesis with ordered price bands and explicit pressures', () => {
  const sim = runSimulation(SPEC);
  assert.equal(sim.status, 'HYPOTHESIS');
  assert.equal(sim.priceBands.currency, 'USD');
  assert.ok(sim.priceBands.low <= sim.priceBands.base);
  assert.ok(sim.priceBands.base <= sim.priceBands.high);
  assert.ok(sim.priceBands.low > 0);
  assert.ok(['LOW', 'MEDIUM', 'HIGH'].includes(sim.demandPressure));
  assert.ok(['LOW', 'MEDIUM', 'HIGH'].includes(sim.supplyPressure));
  assert.ok(['LOW', 'MEDIUM', 'HIGH'].includes(sim.confidence));
  assert.deepEqual(sim.evidenceIds, [...SPEC.evidenceIds].sort());
  assert.equal(sim.pricePath.length, 31, 'day 0 through day 30 inclusive');
});

test('drivers and invalidators are explicit and every driver cites real evidence', () => {
  const sim = runSimulation(SPEC);
  assert.ok(sim.drivers.length >= 2);
  assert.ok(sim.invalidators.length >= 2);
  for (const driver of sim.drivers) {
    assert.ok(driver.text.length > 0);
    assert.ok(driver.evidenceIds.length > 0);
    assert.ok(driver.evidenceIds.every((id) => SPEC.evidenceIds.includes(id)));
  }
  const rumourDriver = sim.drivers.find((d) => d.evidenceIds.includes('ev-rumour'));
  assert.ok(rumourDriver, 'injected event must appear as a cited driver');
});

test('event injection alters the price path; unknown personas and bad horizons are rejected', () => {
  const baseline = runSimulation({ ...SPEC, events: [] });
  const injected = runSimulation(SPEC);
  assert.notDeepEqual(baseline.pricePath, injected.pricePath);
  assert.throws(() => runSimulation({ ...SPEC, personas: ['unknown-persona'] }), /UNKNOWN_PERSONA/);
  assert.throws(() => runSimulation({ ...SPEC, horizonDays: 14 as 30 }), /INVALID_HORIZON/);
  assert.throws(() => runSimulation({ ...SPEC, evidenceIds: [] }), /EVIDENCE_REQUIRED/);
  assert.equal(Object.keys(PERSONAS).length, 4);
});

test('a simulation can only become a HYPOTHESIS forecast, never sales evidence', () => {
  const proposal = simulationToForecastProposal(runSimulation(SPEC));
  assert.equal(proposal.status, 'HYPOTHESIS');
  assert.equal(proposal.horizonDays, 30);
  assert.deepEqual(proposal.priceBands, runSimulation(SPEC).priceBands);
  assert.equal((proposal as unknown as Record<string, unknown>).basis, undefined);
  assert.deepEqual(proposal.evidenceIds, [...SPEC.evidenceIds].sort());
});
