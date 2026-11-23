/**
 * Deterministic discovery sweep over first-party evidence.
 *
 * The sweep only reads derived/projected data and writes DiscoveryFinding
 * notes through the injected store. It never invents prices: every numeric
 * metric traces back to market observations, and every finding names the
 * explicit basis and currency used. With no evidence it deflects with a single
 * EVIDENCE_GAP finding instead of asserting a discovery.
 */

import { createHash } from 'node:crypto';
import type { DiscoveryFinding, MarketObservation } from '../contracts/dataProduct.ts';
import { basisOf, currencyOf, evidenceIdsOf, sourceOf } from './fields.ts';
import type { AnalyticsStore } from './types.ts';

export interface DiscoveryOptions {
  now?: Date;
  activeWindowDays?: number;
  staleDays?: number;
  minActiveObservations?: number;
  anomalyRatio?: number;
  spreadRatio?: number;
}

export interface SweepResult {
  findings: DiscoveryFinding[];
  scanned: {
    evidenceCount: number;
    observationCount: number;
    identityCount: number;
    eventCount: number;
    windowDays: number;
    staleDays: number;
  };
}

const DAY_MS = 86_400_000;

function findingId(type: string, targetId: string, discriminator = ''): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([type, targetId, discriminator]))
    .digest('hex')
    .slice(0, 16);
  return `finding-${digest}`;
}

function ageDays(observedAt: string, now: Date): number | null {
  const time = Date.parse(observedAt);
  if (Number.isNaN(time)) return null;
  return (now.getTime() - time) / DAY_MS;
}

function inWindow(observedAt: string, days: number, now: Date): boolean {
  const age = ageDays(observedAt, now);
  return age !== null && age >= 0 && age <= days;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * Resolve the canonical target of an observation. Postgres rows expose
 * `targetIdentityId`; in-memory/ingest rows use `targetIdentityRef`.
 */
export function observationTargetRef(observation: MarketObservation): string {
  if (typeof observation.targetIdentityRef === 'string' && observation.targetIdentityRef.trim() !== '') {
    return observation.targetIdentityRef;
  }
  const raw = observation as unknown as Record<string, unknown>;
  if (typeof raw.targetIdentityId === 'string' && raw.targetIdentityId.trim() !== '') {
    return raw.targetIdentityId;
  }
  return 'unresolved';
}

export function runDiscoverySweep(
  store: AnalyticsStore,
  options: DiscoveryOptions = {},
): SweepResult {
  const now = options.now ?? new Date();
  const activeWindowDays = options.activeWindowDays ?? 30;
  const staleDays = options.staleDays ?? 30;
  const minActiveObservations = options.minActiveObservations ?? 3;
  const anomalyRatio = options.anomalyRatio ?? 2;
  const spreadRatio = options.spreadRatio ?? 1.5;
  const createdAt = now.toISOString();

  const snapshot = store.snapshot();
  const observations = snapshot.observations;
  const scanned: SweepResult['scanned'] = {
    evidenceCount: snapshot.evidence.length,
    observationCount: observations.length,
    identityCount: snapshot.identities.length,
    eventCount: snapshot.events.length,
    windowDays: activeWindowDays,
    staleDays,
  };

  const produced: DiscoveryFinding[] = [];
  const emit = (
    type: DiscoveryFinding['type'],
    targetId: string,
    title: string,
    summary: string,
    evidenceIds: string[],
    confidence: DiscoveryFinding['confidence'],
    metrics: DiscoveryFinding['metrics'],
    discriminator = '',
  ): void => {
    const finding: DiscoveryFinding = {
      id: findingId(type, targetId, discriminator),
      type,
      targetId,
      title,
      summary,
      evidenceIds,
      confidence,
      metrics: { ...metrics, source: 'discovery-sweep' },
      createdAt,
    };
    produced.push(finding);
    store.addFinding(finding);
  };

  if (observations.length === 0) {
    emit(
      'EVIDENCE_GAP',
      'GLOBAL',
      'No evidence available for discovery',
      'No evidence available: 0 market observations scanned, so no discovery claim can be asserted. Ingest evidence before drawing conclusions.',
      [],
      'LOW',
      {
        observationCount: 0,
        evidenceCount: scanned.evidenceCount,
        windowDays: activeWindowDays,
        observedAt: createdAt,
        source: 'discovery-sweep',
      },
    );
    return { findings: produced, scanned };
  }

  const byTarget = new Map<string, typeof observations>();
  for (const observation of observations) {
    const target = observationTargetRef(observation);
    const bucket = byTarget.get(target);
    if (bucket) bucket.push(observation);
    else byTarget.set(target, [observation]);
  }

  for (const [target, group] of byTarget) {
    const recent = group.filter((o) => inWindow(o.observedAt, activeWindowDays, now));
    const sources = new Set(recent.map(sourceOf));
    if (recent.length >= minActiveObservations) {
      const confidence: DiscoveryFinding['confidence'] =
        sources.size >= 2 ? 'HIGH' : 'LOW';
      const latest = recent
        .map((o) => o.observedAt)
        .sort((a, b) => b.localeCompare(a))[0];
      emit(
        'ACTIVE_CARD',
        target,
        `${target} is actively trading`,
        `${target} has ${recent.length} market observations from ${sources.size} distinct sources within ${activeWindowDays} days.`,
        evidenceIdsOf(recent),
        confidence,
        {
          count: recent.length,
          distinctSources: sources.size,
          sources: [...sources].sort().join(','),
          windowDays: activeWindowDays,
          latestObservedAt: latest,
          basis: [...new Set(recent.map(basisOf))].sort().join(','),
          currency: [...new Set(recent.map(currencyOf))].sort().join(','),
        },
      );
    }

    const count7 = group.filter((o) => inWindow(o.observedAt, 7, now)).length;
    const count30 = group.filter((o) => inWindow(o.observedAt, 30, now)).length;
    const count90 = group.filter((o) => inWindow(o.observedAt, 90, now)).length;
    // Momentum needs both a recent burst and older history to compare against.
    if (count7 >= 2 && count90 > count30 && count7 * 2 > count30) {
      emit(
        'MOMENTUM',
        target,
        `${target} momentum is rising`,
        `${target} has ${count7} observations in 7 days versus ${count30} in 30 days and ${count90} in 90 days.`,
        evidenceIdsOf(group.filter((o) => inWindow(o.observedAt, 7, now))),
        count7 >= 5 && count90 >= 10 ? 'HIGH' : 'MEDIUM',
        { count7, count30, count90, windowDays: 90 },
        `7/30/90`,
      );
    }

    // Basis-safe, currency-safe comps: never pool SOLD with ASKING, never
    // compare across currencies without an explicit FX conversion.
    const compGroups = new Map<string, typeof group>();
    for (const observation of group) {
      const key = `${basisOf(observation)}|${currencyOf(observation)}`;
      const bucket = compGroups.get(key);
      if (bucket) bucket.push(observation);
      else compGroups.set(key, [observation]);
    }
    for (const [key, compGroup] of compGroups) {
      if (compGroup.length < minActiveObservations) continue;
      const [basis, currency] = key.split('|');
      const amounts = compGroup.map((o) => o.amount);
      const mid = median(amounts);
      const min = Math.min(...amounts);
      const max = Math.max(...amounts);
      const comparator = {
        basis,
        currency,
        sampleSize: compGroup.length,
        median: round(mid),
      };

      for (const observation of compGroup) {
        if (
          mid > 0 &&
          (observation.amount >= mid * anomalyRatio ||
            observation.amount <= mid / anomalyRatio)
        ) {
          emit(
            'ANOMALY',
            target,
            `${basis} price anomaly for ${target}`,
            `${observation.amount} ${currency} is outside the ${basis} comp band (median ${round(mid)} ${currency}, ${compGroup.length} basis-matched observations).`,
            evidenceIdsOf([observation]),
            compGroup.length >= 5 ? 'MEDIUM' : 'LOW',
            {
              ...comparator,
              observedAmount: observation.amount,
              ratio: round(mid > 0 ? observation.amount / mid : 0),
              observedAt: observation.observedAt,
            },
            `${basis}|${currency}|${observation.id}`,
          );
        }
      }

      if (min > 0 && max / min >= spreadRatio) {
        emit(
          'SPREAD',
          target,
          `${basis} price spread for ${target}`,
          `${basis} observations span ${min}–${max} ${currency} (${round(((max - min) / min) * 100)}%), compared only within the same basis and currency.`,
          evidenceIdsOf(compGroup),
          'LOW',
          {
            ...comparator,
            min,
            max,
            spreadPct: round(((max - min) / min) * 100),
          },
          `${basis}|${currency}`,
        );
      }
    }
  }

  const bySource = new Map<string, string[]>();
  for (const observation of observations) {
    const source = sourceOf(observation);
    const bucket = bySource.get(source);
    if (bucket) bucket.push(observation.observedAt);
    else bySource.set(source, [observation.observedAt]);
  }
  for (const [source, timestamps] of bySource) {
    const latest = timestamps.slice().sort((a, b) => b.localeCompare(a))[0];
    const age = ageDays(latest, now);
    if (age !== null && age > staleDays) {
      emit(
        'SOURCE_FRESHNESS',
        source,
        `Source ${source} is stale`,
        `Source ${source} has no observation newer than ${latest} (${round(age, 1)} days old).`,
        evidenceIdsOf(observations.filter((o) => sourceOf(o) === source && o.observedAt === latest)),
        'LOW',
        { latestObservedAt: latest, ageDays: round(age, 1), staleDays },
      );
    }
  }

  produced.sort(
    (a, b) =>
      a.type.localeCompare(b.type) ||
      a.targetId.localeCompare(b.targetId) ||
      a.id.localeCompare(b.id),
  );
  return { findings: produced, scanned };
}
