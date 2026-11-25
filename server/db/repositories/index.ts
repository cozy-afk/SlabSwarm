/** Repository assembly. Shared contract types are imported verbatim. */

import type { RepositoryBundle } from '../../contracts/dataProduct.ts';
import { createDefaultStore, type DbStore } from '../store.ts';
import { createCardRepository, type CardRepository } from './card.ts';
import { createEvidenceRepository, type EvidenceRepository } from './evidence.ts';
import {
  createAliasRepository,
  createIdentityDecisionRepository,
  type AliasRepository,
  type IdentityDecisionRepository,
} from './identity.ts';
import { createForecastRepository, type ForecastRepository } from './forecast.ts';
import { createJobsRepository, type JobsRepository } from './jobs.ts';
import { createLearningRepository, type LearningRepository } from './learning.ts';
import { createMarketObservationRepository, type MarketObservationRepository } from './marketObservation.ts';
import { createResearchNoteRepository, type ResearchNoteRepository } from './researchNote.ts';

export interface Repositories extends RepositoryBundle {
  evidence: EvidenceRepository;
  marketObservations: MarketObservationRepository;
  cards: CardRepository;
  forecasts: ForecastRepository;
  learning: LearningRepository;
  jobs: JobsRepository;
  /** Append-only deterministic identity decisions (one row per resolution). */
  identityDecisions: IdentityDecisionRepository;
  /** Absorbed source ids pointing at a surviving canonical card id. */
  aliases: AliasRepository;
  /** Durable evidence-first research traces. */
  researchNotes: ResearchNoteRepository;
  /**
   * Run canonical reads and writes in one atomic unit. The callback receives
   * repositories bound to the transaction; a throw rolls back every write.
   */
  transaction<T>(fn: (tx: Repositories) => Promise<T>): Promise<T>;
}

export function createRepositories(store: DbStore): Repositories {
  const repos: Repositories = {
    evidence: createEvidenceRepository(store),
    marketObservations: createMarketObservationRepository(store),
    cards: createCardRepository(store),
    forecasts: createForecastRepository(store),
    learning: createLearningRepository(store),
    jobs: createJobsRepository(store),
    identityDecisions: createIdentityDecisionRepository(store),
    aliases: createAliasRepository(store),
    researchNotes: createResearchNoteRepository(store),
    transaction<T>(fn: (tx: Repositories) => Promise<T>): Promise<T> {
      return store.transaction((txStore) => fn(createRepositories(txStore)));
    },
  };
  return repos;
}

export function createDefaultRepositories(): Repositories {
  return createRepositories(createDefaultStore());
}

export type {
  Card,
  CardInput,
  CardRepository,
  CatalogFacetKey,
  CatalogFacetView,
  CatalogSearchOptions,
} from './card.ts';
export { CATALOG_FACET_KEYS, extractCatalogFacets, searchCatalogCards } from './card.ts';
export type { EvidenceRepository } from './evidence.ts';
export type {
  AliasInput, AliasRepository, AliasRow,
  IdentityDecisionInput, IdentityDecisionRepository, IdentityDecisionRow,
} from './identity.ts';
export type { Forecast, ForecastInput, ForecastRepository } from './forecast.ts';
export type { Job, JobInput, JobStatus, JobsRepository } from './jobs.ts';
export type { LearningEvent, LearningEventInput, LearningRepository } from './learning.ts';
export type { MarketObservationRepository } from './marketObservation.ts';
export type {
  ResearchNoteInput,
  ResearchNoteRecord,
  ResearchNoteRepository,
} from './researchNote.ts';
