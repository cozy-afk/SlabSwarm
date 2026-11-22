// In-memory analytics store with append-only findings and saved queries.
// The controller may replace the process-wide instance with a Postgres-backed
// provider implementing AnalyticsStore; all lane services take the store as an
// explicit dependency, so nothing here opens a listener or writes canonical
// facts.

import { randomUUID } from 'node:crypto';
import type {
  DiscoveryFinding,
} from '../contracts/dataProduct.ts';
import {
  emptySnapshot,
  type AnalyticsSnapshot,
  type AnalyticsStore,
  type FindingFilters,
  type SavedQuery,
  type SavedQueryInput,
} from './types.ts';

export type {
  AnalyticsSnapshot,
  AnalyticsStore,
  FindingFilters,
  SavedQuery,
  SavedQueryInput,
} from './types.ts';

const clone = <T>(value: T): T =>
  typeof structuredClone === 'function'
    ? structuredClone(value)
    : (JSON.parse(JSON.stringify(value)) as T);

export function createAnalyticsStore(seed: Partial<AnalyticsSnapshot> = {}): AnalyticsStore {
  const snapshot: AnalyticsSnapshot = { ...emptySnapshot(), ...clone(seed) };
  const savedQueries: SavedQuery[] = [];

  return {
    snapshot() {
      return clone(snapshot);
    },

    addFinding(input) {
      const finding = clone(input);
      const existing = snapshot.findings.findIndex((f) => f.id === finding.id);
      if (existing >= 0) {
        // Corrections append; a deterministic re-sweep must not duplicate rows.
        snapshot.findings[existing] = finding;
      } else {
        snapshot.findings.push(finding);
      }
      return clone(finding);
    },

    listFindings(filters: FindingFilters = {}) {
      let result = snapshot.findings.filter(
        (f) =>
          (filters.type === undefined || f.type === filters.type) &&
          (filters.targetId === undefined || f.targetId === filters.targetId),
      );
      result = result
        .slice()
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
      if (filters.limit !== undefined && filters.limit >= 0) {
        result = result.slice(0, filters.limit);
      }
      return clone(result);
    },

    saveQuery(input: SavedQueryInput) {
      const query: SavedQuery = {
        ...clone(input),
        id: `saved-${randomUUID()}`,
        createdAt: new Date().toISOString(),
      };
      savedQueries.push(query);
      return clone(query);
    },

    listSavedQueries() {
      return clone(savedQueries.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)));
    },

    getSavedQuery(id) {
      const found = savedQueries.find((q) => q.id === id);
      return found ? clone(found) : null;
    },

    deleteSavedQuery(id) {
      const index = savedQueries.findIndex((q) => q.id === id);
      if (index < 0) return false;
      savedQueries.splice(index, 1);
      return true;
    },
  };
}

let activeStore: AnalyticsStore = createAnalyticsStore();

/** Process-wide store used by the default route wiring. */
export function getAnalyticsStore(): AnalyticsStore {
  return activeStore;
}

/** Replace the process-wide store (controller integration hook). */
export function setAnalyticsStore(store: AnalyticsStore): void {
  activeStore = store;
}
