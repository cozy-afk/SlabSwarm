// Deterministic promotion: evidence-backed ingest candidates become canonical
// market observations. No network calls, no model, no price invention. Every
// source-derived value is copied verbatim; only the candidate id is appended
// to lineage so the promotion step is traceable.

import type {
  MarketBasis,
  MarketObservationInput,
  RepositoryBundle,
} from '../contracts/dataProduct.ts';
import { sanitizeError } from './runner.ts';
import type {
  CandidateRepository,
  ConfidenceBand,
  IngestCandidate,
} from './types.ts';

/**
 * Minimal repository surface promotion needs. Both the JSON ingest ledger and
 * the canonical Postgres repository bundle satisfy it, so the same
 * deterministic promotion logic can write either store without ad hoc SQL.
 */
export interface PromotionRepositories {
  candidates: Pick<CandidateRepository, 'list'>;
  marketObservations: RepositoryBundle['marketObservations'];
}

export interface PromotionResult {
  candidatesSeen: number;
  promoted: number;
  skipped: number;
  duplicates: number;
  errors: string[];
  /**
   * Guard output: candidate ids with a finite amount, explicit basis and
   * PARSED/PENDING status that still have no observation after this run.
   * Empty means the priced-candidate coverage invariant holds.
   */
  unpromotedPriced: string[];
}

export interface PromoteOptions {
  /** Reserved for deterministic replay diagnostics; never rewrites source timestamps. */
  now?: Date;
}

type AdmissibleCandidate = IngestCandidate & {
  amount: number;
  basis: Exclude<MarketBasis, 'UNKNOWN'>;
};

/** Extra provenance fields carried by the ingest ledger's observation store. */
interface PromotedObservationInput extends MarketObservationInput {
  sourceId: string;
  capturedAt: string;
  lineage: string[];
  confidence: ConfidenceBand;
}

const VALID_BASES = new Set<MarketBasis>([
  'SOLD', 'ASKING', 'OFFER', 'GUIDE', 'CLAIM', 'POPULATION', 'UNKNOWN',
]);

function observationKey(
  evidenceId: string,
  targetIdentityRef: string,
  basis: MarketBasis,
): string {
  return `${evidenceId}\u0000${targetIdentityRef}\u0000${basis}`;
}

/** Shared with the coverage report so both use the same duplicate definition. */
export function promotionKey(
  row: Pick<IngestCandidate, 'evidenceId' | 'targetIdentityRef' | 'basis'>,
): string {
  return observationKey(row.evidenceId, row.targetIdentityRef, row.basis);
}

/**
 * Priced means a finite, non-negative amount and an explicit, valid basis.
 * A null amount is UNKNOWN (catalog-only), never zero, and is not priced.
 */
export function isPricedCandidate(candidate: IngestCandidate): boolean {
  return typeof candidate.amount === 'number'
    && Number.isFinite(candidate.amount)
    && candidate.amount >= 0
    && typeof candidate.basis === 'string'
    && VALID_BASES.has(candidate.basis)
    && candidate.basis !== 'UNKNOWN';
}

/** PENDING evidence can still be priced; promotion never rewrites parse status. */
export function isParsedOrPending(candidate: IngestCandidate): boolean {
  return candidate.parseStatus === 'PARSED' || candidate.parseStatus === 'PENDING';
}

/** Only a finite, explicitly based, successfully parsed candidate can be promoted. */
function isAdmissible(candidate: IngestCandidate): candidate is AdmissibleCandidate {
  return isPricedCandidate(candidate)
    && candidate.parseStatus !== 'FAILED'
    && typeof candidate.evidenceId === 'string'
    && candidate.evidenceId !== ''
    && typeof candidate.targetIdentityRef === 'string'
    && candidate.targetIdentityRef !== ''
    && typeof candidate.observedAt === 'string'
    && candidate.observedAt !== '';
}

function hasProvenance(candidate: IngestCandidate): boolean {
  return typeof candidate.sourceId === 'string'
    && candidate.sourceId.trim() !== ''
    && typeof candidate.observedAt === 'string'
    && candidate.observedAt.trim() !== ''
    && typeof candidate.capturedAt === 'string'
    && candidate.capturedAt.trim() !== ''
    && Array.isArray(candidate.lineage)
    && candidate.lineage.length > 0
    && typeof candidate.confidence === 'string'
    && typeof candidate.currency === 'string'
    && candidate.currency.trim() !== '';
}

function candidateIdOf(candidate: IngestCandidate): string {
  const stored = (candidate as { id?: unknown }).id;
  if (typeof stored === 'string' && stored !== '') return stored;
  // Mirrors LedgerCandidateRepository's fallback id so lineage stays stable
  // for candidates injected without an explicit id.
  return `cand-${candidate.evidenceId}:${candidate.targetIdentityRef}:${candidate.basis}:${String(candidate.amount)}`;
}

/**
 * Promote all admissible candidates once. Idempotency is keyed on
 * evidenceId + targetIdentityRef + basis across the existing observation set
 * and within the current batch. Errors are sanitised so credentials in an
 * underlying error message can never reach the result or the HTTP response.
 */
export async function promoteCandidates(
  repos: PromotionRepositories,
  options: PromoteOptions = {},
): Promise<PromotionResult> {
  void options.now;
  const result: PromotionResult = {
    candidatesSeen: 0,
    promoted: 0,
    skipped: 0,
    duplicates: 0,
    errors: [],
    unpromotedPriced: [],
  };

  const [candidates, existing] = await Promise.all([
    repos.candidates.list(),
    repos.marketObservations.list(),
  ]);
  const keys = new Set<string>();
  const failedKeys = new Set<string>();
  for (const observation of existing) {
    // Canonical rows persist the ref in `target_identity_id`; the JSON ledger
    // keeps `targetIdentityRef`. Accept both so idempotency works on either.
    const targetRef = (observation as unknown as Record<string, unknown>).targetIdentityRef
      ?? (observation as unknown as Record<string, unknown>).targetIdentityId;
    if (
      typeof observation.evidenceId === 'string' &&
      typeof targetRef === 'string' &&
      typeof observation.basis === 'string'
    ) {
      keys.add(observationKey(observation.evidenceId, targetRef, observation.basis));
    }
  }

  result.candidatesSeen = candidates.length;
  for (const candidate of candidates) {
    if (!isAdmissible(candidate)) {
      result.skipped += 1;
      continue;
    }
    const key = observationKey(candidate.evidenceId, candidate.targetIdentityRef, candidate.basis);
    if (keys.has(key)) {
      result.duplicates += 1;
      continue;
    }

    // A variable (not a fresh object literal) keeps the ledger's extra
    // provenance fields while satisfying the canonical input contract.
    const input: PromotedObservationInput = {
      evidenceId: candidate.evidenceId,
      targetIdentityRef: candidate.targetIdentityRef,
      basis: candidate.basis,
      amount: candidate.amount,
      currency: candidate.currency,
      marketplace: candidate.marketplace ?? null,
      observedAt: candidate.observedAt,
      status: hasProvenance(candidate) ? 'NORMALIZED' : 'RAW',
      priceComponents: candidate.priceComponents,
      sourceId: candidate.sourceId,
      capturedAt: candidate.capturedAt,
      lineage: [...candidate.lineage, candidateIdOf(candidate)],
      confidence: candidate.confidence,
    };

    try {
      await repos.marketObservations.create(input);
      keys.add(key);
      result.promoted += 1;
    } catch (error) {
      failedKeys.add(key);
      result.errors.push(sanitizeError(error));
    }
  }

  // Guard: every priced candidate with a finite amount, an explicit basis and
  // PARSED/PENDING raw parse status must end up with an observation. Write
  // failures are already in `errors`; anything else left over is a silent gap
  // and is reported as an explicit guard error instead.
  for (const candidate of candidates) {
    if (!isPricedCandidate(candidate) || !isParsedOrPending(candidate)) continue;
    const key = promotionKey(candidate);
    if (keys.has(key)) continue;
    result.unpromotedPriced.push(candidateIdOf(candidate));
  }
  const unattempted = candidates.filter((candidate) =>
    isPricedCandidate(candidate)
    && isParsedOrPending(candidate)
    && !keys.has(promotionKey(candidate))
    && !failedKeys.has(promotionKey(candidate)),
  );
  if (unattempted.length > 0) {
    result.errors.push(
      `promotion guard: ${unattempted.length} priced PARSED/PENDING candidate(s) left without an observation`,
    );
  }

  return result;
}

export default promoteCandidates;
