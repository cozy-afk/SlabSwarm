/**
 * Phase 4 — INTELLIGENCE lane, Task 3: deterministic scenario simulation.
 *
 * A simulation is a bounded, seeded hypothesis. No simulation output is ever
 * a sale, a market observation, or a canonical fact. Fixed seed + fixed
 * evidence + fixed scenario produce byte-identical output.
 */

import { createHash } from 'node:crypto';
import type { Forecast, ForecastBand } from '../contracts/dataProduct.ts';

export type Pressure = 'LOW' | 'MEDIUM' | 'HIGH';
export type Confidence = 'LOW' | 'MEDIUM' | 'HIGH';
export type HorizonDays = 7 | 30 | 90;

export interface Persona {
  name: string;
  bias: number;
  volatility: number;
  description: string;
}

/** Registered personas. Behaviour is deterministic, not model-generated. */
export const PERSONAS: Readonly<Record<string, Persona>> = Object.freeze({
  collector: { name: 'collector', bias: 0.06, volatility: 0.4, description: 'Scarcity-driven long-term holder' },
  flipper: { name: 'flipper', bias: 0.02, volatility: 1.2, description: 'Short-horizon liquidity taker' },
  investor: { name: 'investor', bias: 0.03, volatility: 0.6, description: 'Fundamental value allocator' },
  observer: { name: 'observer', bias: 0, volatility: 0.2, description: 'Passive market witness' },
});

export interface ScenarioEvent {
  day: number;
  type: 'DEMAND_SHOCK' | 'SUPPLY_SHOCK' | 'REPRINT_RUMOUR' | 'TOURNAMENT';
  magnitude: number;
  evidenceId: string;
}

export interface ScenarioSpec {
  id: string;
  targetId: string;
  targetType?: 'CARD' | 'SET' | 'COLLECTION' | 'EVENT';
  horizonDays: HorizonDays;
  seed: number;
  baselinePrice: number;
  currency: string;
  demandShock?: number;
  supplyShock?: number;
  events?: ScenarioEvent[];
  personas?: string[];
  evidenceIds: string[];
  asOf?: string;
}

export interface Driver {
  text: string;
  evidenceIds: string[];
}

export interface SimulationRun {
  id: string;
  scenarioId: string;
  targetId: string;
  seed: number;
  status: 'HYPOTHESIS';
  priceBands: ForecastBand;
  demandPressure: Pressure;
  supplyPressure: Pressure;
  drivers: Driver[];
  invalidators: string[];
  confidence: Confidence;
  evidenceIds: string[];
  pricePath: Array<{ day: number; price: number }>;
  socialPressure: number;
  marketPressure: number;
  createdAt: string;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function round(value: number, places = 4): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function label(value: number): Pressure {
  if (value > 0.15) return 'HIGH';
  if (value < -0.15) return 'LOW';
  return 'MEDIUM';
}

function confidenceFor(count: number): Confidence {
  if (count >= 3) return 'HIGH';
  if (count === 2) return 'MEDIUM';
  return 'LOW';
}

/** Run a deterministic scenario: world model + market loop + social loop. */
export function runSimulation(spec: ScenarioSpec): SimulationRun {
  if (![7, 30, 90].includes(spec.horizonDays)) throw new Error('INVALID_HORIZON');
  if (!Array.isArray(spec.evidenceIds) || spec.evidenceIds.length === 0) {
    throw new Error('EVIDENCE_REQUIRED');
  }
  if (!Number.isFinite(spec.baselinePrice) || spec.baselinePrice <= 0) {
    throw new Error('INVALID_BASELINE');
  }
  const personas = spec.personas ?? ['observer'];
  for (const p of personas) {
    if (!PERSONAS[p]) throw new Error(`UNKNOWN_PERSONA: ${p}`);
  }
  const evidenceIds = [...new Set(spec.evidenceIds)].sort();
  const events = [...(spec.events ?? [])].sort((a, b) => a.day - b.day || a.type.localeCompare(b.type));
  for (const event of events) {
    if (!evidenceIds.includes(event.evidenceId)) throw new Error('EVENT_EVIDENCE_REQUIRED');
  }

  const seedMaterial = JSON.stringify([
    spec.seed, spec.id, spec.targetId, spec.horizonDays, round(spec.baselinePrice, 6),
    spec.currency, spec.demandShock ?? 0, spec.supplyShock ?? 0, events, personas, evidenceIds,
  ]);
  const seedHash = createHash('sha256').update(seedMaterial).digest();
  const rng = seededRandom(seedHash.readUInt32BE(0));
  const personaBias = personas.length
    ? personas.reduce((sum, p) => sum + PERSONAS[p].bias, 0) / personas.length
    : 0;
  const personaVolatility = personas.length
    ? personas.reduce((sum, p) => sum + PERSONAS[p].volatility, 0) / personas.length
    : 1;

  let price = spec.baselinePrice;
  let marketPressure = (spec.demandShock ?? 0) - (spec.supplyShock ?? 0);
  const initialMarketPressure = marketPressure;
  let socialPressure = 0;
  const pricePath: Array<{ day: number; price: number }> = [{ day: 0, price: round(price, 2) }];

  for (let day = 1; day <= spec.horizonDays; day++) {
    let eventPressure = 0;
    for (const event of events.filter((e) => e.day === day)) {
      eventPressure += event.magnitude;
      socialPressure += event.magnitude * 0.6;
    }
    marketPressure += eventPressure;
    // Social loop: mood decays, shocks amplify, personas set susceptibility.
    socialPressure = round(socialPressure * 0.85 + (rng() - 0.5) * 0.12, 6);
    const effective = marketPressure + socialPressure * 0.5 + personaBias;
    const drift = Math.max(-0.05, Math.min(0.05, effective * 0.004));
    const noise = (rng() - 0.5) * 0.006 * personaVolatility;
    price = Math.max(0.01, price * (1 + drift + noise));
    marketPressure = round(marketPressure * 0.99, 6);
    pricePath.push({ day, price: round(price, 2) });
  }

  const base = round(price, 2);
  const lows = pricePath.map((p) => p.price);
  const low = round(Math.min(...lows) * 0.95, 2);
  const high = round(Math.max(...lows) * 1.05, 2);
  const drivers: Driver[] = [
    {
      text: `Demand shock ${round(spec.demandShock ?? 0, 3)} from cited market evidence`,
      evidenceIds: [evidenceIds[0]],
    },
    {
      text: `Supply shock ${round(spec.supplyShock ?? 0, 3)} from cited market evidence`,
      evidenceIds: [evidenceIds[evidenceIds.length - 1]],
    },
    {
      text: `${evidenceIds.length} bounded evidence item(s) anchor the world model`,
      evidenceIds,
    },
    ...events.map((e) => ({
      text: `Day ${e.day} ${e.type} injection (magnitude ${round(e.magnitude, 3)})`,
      evidenceIds: [e.evidenceId],
    })),
  ];
  const invalidators = [
    'A confirmed SOLD observation outside the projected band invalidates this hypothesis',
    'A verified reprint announcement invalidates any scarcity-driven demand driver',
    'No new SOLD evidence inside the horizon reduces confidence to LOW',
  ];
  const idMaterial = JSON.stringify([
    spec.id, spec.seed, round(spec.baselinePrice, 6), evidenceIds, events, personas,
  ]);
  const confidence = confidenceFor(evidenceIds.length);
  return {
    id: `sim-${createHash('sha256').update(idMaterial).digest('hex').slice(0, 16)}`,
    scenarioId: spec.id,
    targetId: spec.targetId,
    seed: spec.seed,
    status: 'HYPOTHESIS',
    priceBands: { low, base, high, currency: spec.currency },
    demandPressure: label(initialMarketPressure),
    supplyPressure: label(spec.supplyShock ?? 0),
    drivers,
    invalidators,
    confidence,
    evidenceIds,
    pricePath,
    socialPressure: round(socialPressure, 6),
    marketPressure: round(marketPressure, 6),
    createdAt: spec.asOf ?? new Date().toISOString(),
  };
}

/** Convert a simulation into an unscored HYPOTHESIS forecast proposal. */
export function simulationToForecastProposal(sim: SimulationRun): Forecast {
  return {
    id: `proposal-${sim.id}`,
    targetType: 'CARD',
    targetId: sim.targetId,
    horizonDays: sim.pricePath.length - 1 === 90 ? 90 : sim.pricePath.length - 1 === 7 ? 7 : 30,
    scenario: sim.scenarioId,
    priceBands: sim.priceBands,
    demandPressure: sim.demandPressure,
    supplyPressure: sim.supplyPressure,
    drivers: sim.drivers.map((d) => d.text),
    invalidators: [...sim.invalidators],
    evidenceIds: [...sim.evidenceIds],
    confidence: sim.confidence,
    createdAt: sim.createdAt,
    status: 'HYPOTHESIS',
  };
}
