/**
 * Operator review queue for harvested web candidates.
 *
 * Nothing here fetches the web and nothing here invents facts. Candidates are
 * immutable proposals from the adapter/swarm lanes; this store keeps their
 * provenance verbatim and is the only place that turns an approved proposal
 * into canonical rows. Canonical writes go through the shared repositories so
 * raw evidence stays immutable and basis/UNKNOWN rules are enforced at the
 * repository boundary.
 */

import type { MarketBasis, MarketObservation } from '../contracts/dataProduct.ts';
import type {
  ReviewCandidate,
  ReviewStatus,
  WebHarvestCandidate,
  WebSourceConfig,
} from '../contracts/webHarvest.ts';
import type { Card, CardRepository } from '../db/repositories/card.ts';
import type { MarketObservationRepository } from '../db/repositories/marketObservation.ts';
import { createRepositories } from '../db/repositories/index.ts';
import { createDefaultStore } from '../db/store.ts';
import { UNKNOWN, type ServingProvenance } from '../serving/catalog.ts';

export type ReviewAction = 'APPROVE' | 'REJECT';

export interface WebHarvestRepositories {
  cards: Pick<CardRepository, 'upsert' | 'list'>;
  marketObservations: Pick<MarketObservationRepository, 'create' | 'list'>;
}

export interface WebHarvestStoreOptions {
  /** Operator-configured allowlist; never secrets and never fetched here. */
  sources?: WebSourceConfig[];
  /** Canonical write ports. Defaults to the shared SQL-backed repositories. */
  repositories?: WebHarvestRepositories;
  /** Deterministic clock for review timestamps. */
  now?: () => Date;
}

export interface ReviewResult {
  candidate: ReviewCandidate;
  card: Card | null;
  observation: MarketObservation | null;
  provenance: ServingProvenance;
}

export interface EnqueueResult {
  candidates: ReviewCandidate[];
  enqueued: number;
  duplicates: number;
}

export class ReviewError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly httpStatus: number = 400,
  ) {
    super(message);
    this.name = 'ReviewError';
  }
}

const REVIEW_STATUSES: ReadonlySet<string> = new Set<ReviewStatus>([
  'PENDING', 'APPROVED', 'REJECTED',
]);

function clone<T>(value: T): T {
  return structuredClone(value);
}

function text(value: unknown): string {
  return typeof value === 'string' && value.trim() !== '' ? value : UNKNOWN;
}

function hasAmount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Provenance is copied from the candidate; confidence is never upgraded. */
export function candidateProvenance(candidate: WebHarvestCandidate): ServingProvenance {
  const source = text(candidate.sourceId);
  const observedAt = text(candidate.observedAt);
  const capturedAt = text(candidate.capturedAt);
  return {
    source,
    basis: candidate.basis,
    currency: text(candidate.currency),
    observedAt,
    capturedAt,
    observed_at: observedAt,
    captured_at: capturedAt,
    lineage: [
      'web-harvest',
      `source:${source}`,
      `evidence:${text(candidate.evidenceId)}`,
    ],
    confidence: 'LOW',
  };
}

function cardInput(candidate: WebHarvestCandidate, provenance: ServingProvenance) {
  return {
    name: candidate.name,
    setId: candidate.set === UNKNOWN ? null : candidate.set,
    cardNumber: candidate.number === UNKNOWN ? null : candidate.number,
    variant: null,
    // Deterministic identity from the candidate's own facets; no random facts.
    identityKey: [
      'web',
      text(candidate.sourceId),
      text(candidate.game),
      text(candidate.set),
      candidate.name,
      text(candidate.number),
    ].join(':'),
    facets: {
      source: provenance.source,
      basis: candidate.basis,
      currency: candidate.currency,
      game: candidate.game,
      set: candidate.set,
      number: candidate.number,
      observed_at: provenance.observedAt,
      captured_at: provenance.capturedAt,
      lineage: provenance.lineage,
      confidence: 'LOW',
      reportedConfidence: candidate.confidence,
      license: candidate.license,
    },
    rawPayload: {
      evidenceId: candidate.evidenceId,
      sourceId: candidate.sourceId,
      observedAt: candidate.observedAt,
      capturedAt: candidate.capturedAt,
      license: candidate.license,
      warnings: [...candidate.warnings],
      reportedConfidence: candidate.confidence,
    },
  };
}

function assertApprovable(candidate: WebHarvestCandidate): void {
  if (typeof candidate.name !== 'string' || candidate.name.trim() === '') {
    throw new ReviewError('Candidate is missing a name; nothing was written.', 'invalid_candidate');
  }
  if (text(candidate.sourceId) === UNKNOWN || text(candidate.evidenceId) === UNKNOWN) {
    throw new ReviewError(
      'Candidate is missing source or evidence provenance; nothing was written.',
      'invalid_candidate',
    );
  }
}

export function createWebHarvestStore(options: WebHarvestStoreOptions = {}) {
  const sources: WebSourceConfig[] = clone(options.sources ?? []);
  const candidates = new Map<string, ReviewCandidate>();
  const repositories: WebHarvestRepositories = options.repositories ??
    createRepositories(createDefaultStore());
  const now = options.now ?? (() => new Date());

  async function listSources(): Promise<WebSourceConfig[]> {
    return clone(sources);
  }

  async function setSources(next: WebSourceConfig[]): Promise<WebSourceConfig[]> {
    sources.splice(0, sources.length, ...clone(next));
    return listSources();
  }

  async function listCandidates(filters: { status?: ReviewStatus } = {}): Promise<ReviewCandidate[]> {
    if (filters.status !== undefined && !REVIEW_STATUSES.has(filters.status)) {
      throw new ReviewError('status must be PENDING, APPROVED or REJECTED.', 'validation_error');
    }
    return [...candidates.values()]
      .filter((row) => filters.status === undefined || row.status === filters.status)
      .map(clone)
      .sort((a, b) =>
        a.observedAt.localeCompare(b.observedAt) || a.id.localeCompare(b.id));
  }

  async function getCandidate(id: string): Promise<ReviewCandidate | null> {
    const found = candidates.get(id);
    return found ? clone(found) : null;
  }

  async function enqueue(candidate: WebHarvestCandidate): Promise<ReviewCandidate> {
    const existing = candidates.get(candidate.id);
    if (existing) return clone(existing);
    const queued: ReviewCandidate = { ...clone(candidate), status: 'PENDING' };
    candidates.set(candidate.id, clone(queued));
    return clone(queued);
  }

  async function enqueueMany(incoming: WebHarvestCandidate[]): Promise<EnqueueResult> {
    const rows: ReviewCandidate[] = [];
    let duplicates = 0;
    for (const candidate of incoming) {
      const existed = candidates.has(candidate.id);
      if (existed) duplicates += 1;
      rows.push(await enqueue(candidate));
    }
    return {
      candidates: rows,
      enqueued: rows.length - duplicates,
      duplicates,
    };
  }

  async function review(
    id: string,
    action: ReviewAction,
    note?: string,
  ): Promise<ReviewResult | null> {
    if (action !== 'APPROVE' && action !== 'REJECT') {
      throw new ReviewError('action must be APPROVE or REJECT.', 'validation_error');
    }
    const current = candidates.get(id);
    if (!current) return null;
    if (current.status !== 'PENDING') {
      throw new ReviewError('Candidate has already been reviewed.', 'already_reviewed', 409);
    }

    const provenance = candidateProvenance(current);
    let card: Card | null = null;
    let observation: MarketObservation | null = null;

    if (action === 'APPROVE') {
      assertApprovable(current);
      // Canonical writes happen before the queue state flips: a failed write
      // leaves the candidate PENDING so an operator can retry, and approval is
      // the only path that can reach these repositories.
      card = await repositories.cards.upsert(cardInput(current, provenance));
      const basisExplicit = current.basis !== UNKNOWN;
      if (basisExplicit && hasAmount(current.amount)) {
        observation = await repositories.marketObservations.create({
          evidenceId: current.evidenceId,
          sourceRecordId: current.evidenceId,
          targetIdentityRef: card.id,
          basis: current.basis as MarketBasis,
          amount: current.amount,
          currency: text(current.currency),
          marketplace: provenance.source,
          observedAt: current.observedAt,
          status: 'RAW',
          priceComponents: {
            ...provenance,
            reportedConfidence: current.confidence,
            license: current.license,
            warnings: [...current.warnings],
          },
        } as Parameters<MarketObservationRepository['create']>[0] & Record<string, unknown>);
      }
    }

    const decided: ReviewCandidate = {
      ...clone(current),
      status: action === 'APPROVE' ? 'APPROVED' : 'REJECTED',
      reviewedAt: now().toISOString(),
      ...(typeof note === 'string' && note.trim() !== '' ? { reviewNote: note } : {}),
    };
    candidates.set(id, decided);
    return { candidate: clone(decided), card, observation, provenance };
  }

  return {
    listSources,
    setSources,
    listCandidates,
    getCandidate,
    enqueue,
    enqueueMany,
    review,
  };
}

export type WebHarvestStore = ReturnType<typeof createWebHarvestStore>;
