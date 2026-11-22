/** Repository assembly. Shared contract types are imported verbatim. */

import type { RepositoryBundle } from '../../contracts/dataProduct.ts';
import { createDefaultStore, type DbStore } from '../store.ts';
import { createCardRepository, type CardRepository } from './card.ts';
import { createEvidenceRepository, type EvidenceRepository } from './evidence.ts';
import { createForecastRepository, type ForecastRepository } from './forecast.ts';
import { createJobsRepository, type JobsRepository } from './jobs.ts';
import { createLearningRepository, type LearningRepository } from './learning.ts';
import { createMarketObservationRepository, type MarketObservationRepository } from './marketObservation.ts';

export interface Repositories extends RepositoryBundle {
  evidence: EvidenceRepository;
  marketObservations: MarketObservationRepository;
  cards: CardRepository;
  forecasts: ForecastRepository;
  learning: LearningRepository;
  jobs: JobsRepository;
}

export function createRepositories(store: DbStore): Repositories {
  return {
    evidence: createEvidenceRepository(store),
    marketObservations: createMarketObservationRepository(store),
    cards: createCardRepository(store),
    forecasts: createForecastRepository(store),
    learning: createLearningRepository(store),
    jobs: createJobsRepository(store),
  };
}

export function createDefaultRepositories(): Repositories {
  return createRepositories(createDefaultStore());
}

export type {
  Card, CardInput, CardRepository,
} from './card.ts';
export type { EvidenceRepository } from './evidence.ts';
export type { Forecast, ForecastInput, ForecastRepository } from './forecast.ts';
export type { Job, JobInput, JobStatus, JobsRepository } from './jobs.ts';
export type { LearningEvent, LearningEventInput, LearningRepository } from './learning.ts';
export type { MarketObservationRepository } from './marketObservation.ts';
