// Deterministic promotion: evidence-backed ingest candidates become canonical
// market observations. No network calls, no model, no price invention. Every
// source-derived value is copied verbatim; only the candidate id is appended
// to lineage so the promotion step is traceable.

import type {
  MarketBasis,
  MarketObservationInput,
  RepositoryBundle,
} from '../contracts/dataProduct.ts';
import type { FreeFeedRecord } from '../contracts/freeFeed.ts';
import type { Repositories } from '../db/repositories/index.ts';
import {
  promoteToCanonical,
  resolveCandidate,
} from '../identity/resolver.ts';
import {
  assessMatch,
  type ExpectedAttributes,
  type MatchAssessment,
} from '../identity/matchGate.ts';
import { reportQuarantine } from '../identity/qaAuthority.ts';
import { sanitizeError } from './runner.ts';
import type {
  CandidateRepository,
  ConfidenceBand,
  IngestCandidate,
  IngestRun,
  StoredEvidenceRecord,
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
  /** Candidate ids withheld from canonical observations by the hard-attribute gate. */
  quarantined: string[];
  /** QA review ids created by the gate for quarantined candidates. */
  qaReviewIds: string[];
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
 * Listing-title candidates pass the same deterministic hard-attribute gate as
 * canonical proposals. Candidates without a title are legacy facts and are
 * deliberately left on the existing promotion path.
 */
export function candidateMatchAssessment(candidate: IngestCandidate): MatchAssessment | null {
  const components = candidate.priceComponents ?? {};
  const title = (candidate as { title?: unknown }).title ?? components.title;
  if (typeof title !== 'string' || title.trim() === '') return null;
  const expected = (candidate as { expectedAttributes?: unknown }).expectedAttributes
    ?? components.expectedAttributes;
  const floor = (candidate as { confidenceFloor?: unknown }).confidenceFloor
    ?? components.confidenceFloor;
  return assessMatch({
    title,
    expected: (expected ?? null) as ExpectedAttributes | null,
    floor: typeof floor === 'number' ? floor : undefined,
  });
}

/** Preserve every source-derived field the ledger candidate already carries. */
export function candidateToProposal(candidate: IngestCandidate): FreeFeedRecord {
  const components = candidate.priceComponents ?? {};
  const title = typeof components.title === 'string' ? components.title : '';
  return {
    sourceId: candidate.sourceId || 'UNKNOWN',
    externalId: candidate.evidenceId,
    vertical: (components.vertical ?? 'UNKNOWN') as FreeFeedRecord['vertical'],
    property: String(components.property ?? 'UNKNOWN'),
    set: String(components.set ?? 'UNKNOWN'),
    name: String(components.name ?? (title || 'UNKNOWN')),
    number: String(components.number ?? 'UNKNOWN'),
    finish: String(components.finish ?? 'UNKNOWN'),
    currency: candidate.currency || 'UNKNOWN',
    amount: candidate.amount ?? 'UNKNOWN',
    basis: candidate.basis,
    observedAt: candidate.observedAt,
    sourceUrl: String(components.sourceUrl ?? ''),
    license: String(components.license ?? 'UNKNOWN'),
    attribution: String(components.attribution ?? 'UNKNOWN'),
    capturedAt: candidate.capturedAt,
    lineage: [...candidate.lineage],
    confidence: candidate.confidence,
    ...(title ? { title } : {}),
    ...(components.expectedAttributes ? { expectedAttributes: components.expectedAttributes } : {}),
    ...(typeof components.confidenceFloor === 'number'
      ? { confidenceFloor: components.confidenceFloor }
      : {}),
  } as FreeFeedRecord;
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
    quarantined: [],
    qaReviewIds: [],
  };

  const [candidates, existing] = await Promise.all([
    repos.candidates.list(),
    repos.marketObservations.list(),
  ]);
  const keys = new Set<string>();
  const failedKeys = new Set<string>();
  const quarantinedIds = new Set<string>();
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
    const assessment = candidateMatchAssessment(candidate);
    if (assessment?.decision === 'QUARANTINE') {
      const id = candidateIdOf(candidate);
      quarantinedIds.add(id);
      result.quarantined.push(id);
      const queued = await reportQuarantine({
        proposal: candidateToProposal(candidate),
        assessment,
      });
      if (queued.reviewId) result.qaReviewIds.push(queued.reviewId);
      if (queued.error) result.errors.push(`QA enqueue failed for ${id}: ${queued.error}`);
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
      priceComponents: {
        ...candidate.priceComponents,
        ...(assessment ? {
          hardAttributeDisposition: assessment.decision,
          hardAttributeScore: assessment.score,
          hardAttributeConflicts: assessment.conflicts,
        } : {}),
      },
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
    if (quarantinedIds.has(candidateIdOf(candidate))) continue;
    const key = promotionKey(candidate);
    if (keys.has(key)) continue;
    result.unpromotedPriced.push(candidateIdOf(candidate));
  }
  const unattempted = candidates.filter((candidate) =>
    isPricedCandidate(candidate)
    && isParsedOrPending(candidate)
    && !quarantinedIds.has(candidateIdOf(candidate))
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

// --- Free-feed harvest -> canonical promotion shim ------------------------
// The adapter's FreeFeedRecord deliberately has no capturedAt, lineage or
// confidence. Those are rebuilt here from server-owned state only: the run's
// server clock, the ledger's immutable evidence id and the adapter's own
// declared confidence. Nothing here reads an HTTP body, calls a model or
// invents a price; every canonical value is copied from the harvested record.

const VALID_CONFIDENCE: ReadonlySet<string> = new Set(['UNKNOWN', 'LOW', 'MEDIUM', 'HIGH']);

/** Confidence is a server-side fact: take the adapter's declared value (or
 * the ledger trust tier) and never anything supplied by a caller. */
function confidenceOf(evidence: StoredEvidenceRecord): ConfidenceBand {
  const payload = evidence.parsedPayload ?? {};
  for (const value of [payload.confidence, evidence.trustTier]) {
    if (typeof value === 'string' && VALID_CONFIDENCE.has(value)) return value as ConfidenceBand;
  }
  return 'UNKNOWN';
}

/** Evidence ids already in the ledger before this harvest. A duplicate
 * harvest returns the pre-existing record, so comparing ids (not timestamps,
 * which may be injected identically across runs) is the reliable way to
 * promote each ledger row exactly once. */
function isNewEvidence(evidence: StoredEvidenceRecord, known: ReadonlySet<string>): boolean {
  return !known.has(evidence.id);
}

function freeFeedRecordOf(evidence: StoredEvidenceRecord): FreeFeedRecord | null {
  const record = evidence.parsedPayload?.record;
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return null;
  return record as FreeFeedRecord;
}

/**
 * Project one immutable ledger evidence row into canonical evidence_records
 * before promotion. Upsert is keyed on the exact triple (sourceId,
 * sourceRecordId, checksum): reruns reuse the same canonical id and no raw
 * evidence payload is rewritten.
 */
async function canonicalEvidenceIdOf(
  repositories: Repositories,
  evidence: StoredEvidenceRecord,
): Promise<string> {
  const canonical = await repositories.evidence.upsert({
    sourceId: evidence.sourceId,
    sourceRecordId: evidence.sourceRecordId,
    sourceUri: evidence.sourceUri ?? null,
    capturedAt: evidence.capturedAt,
    observedAt: evidence.observedAt,
    checksum: evidence.checksum,
    mimeType: evidence.mimeType,
    license: evidence.license ?? null,
    rawRef: evidence.rawRef,
    parsedPayload: evidence.parsedPayload ?? null,
    trustTier: evidence.trustTier ?? 'UNKNOWN',
  } as Parameters<Repositories['evidence']['upsert']>[0]);
  return canonical.id;
}

export interface FreeFeedHarvestPromotionInput {
  /** Configured feed id; used only to select this harvest's ledger rows. */
  sourceId: string;
  run: IngestRun;
  evidence: StoredEvidenceRecord[];
  /** Server-generated capture timestamp from the harvest's own clock. */
  capturedAt: string;
  /** Ids present in the ledger before the harvest; used to skip duplicates. */
  knownEvidenceIds: ReadonlySet<string>;
  /** First-party canonical repositories, injected by the caller. */
  repositories: Repositories;
}

export interface FreeFeedProposalReport {
  /** Canonical source-scoped id (`sourceId:externalId`). */
  evidenceId: string;
  ledgerEvidenceId: string;
  accepted: boolean;
  basis: MarketBasis;
  amount: number | 'UNKNOWN';
  rule: string | null;
  cardId: string | null;
  observationId: string | null;
  reasons: string[];
  errors: string[];
}

export interface FreeFeedPromotionReport {
  /** True only when every attempted canonical write fully committed. */
  accepted: boolean;
  attempted: number;
  promoted: number;
  rejected: number;
  reasons: string[];
  errors: string[];
  results: FreeFeedProposalReport[];
}

/** Convert a successful free-feed harvest's newly created records into
 * provenance-complete canonical proposals and commit each one atomically.
 * `accepted` is false if any proposal was rejected or any write failed, so a
 * partial commit can never be surfaced as a successful harvest. */
export async function promoteFreeFeedHarvest(
  input: FreeFeedHarvestPromotionInput,
): Promise<FreeFeedPromotionReport> {
  const report: FreeFeedPromotionReport = {
    accepted: true,
    attempted: 0,
    promoted: 0,
    rejected: 0,
    reasons: [],
    errors: [],
    results: [],
  };
  const fresh = input.evidence.filter(
    (evidence) => evidence.sourceId === input.sourceId
      && isNewEvidence(evidence, input.knownEvidenceIds),
  );

  for (const evidence of fresh) {
    report.attempted += 1;
    const record = freeFeedRecordOf(evidence);
    if (!record) {
      report.rejected += 1;
      report.reasons.push(`ledger evidence ${evidence.id} has no free-feed record to promote`);
      continue;
    }
    try {
      // Canonical evidence must exist before the observation can cite it.
      // Fail closed (reported below) if the exact-provenance upsert fails.
      const canonicalEvidenceId = await canonicalEvidenceIdOf(input.repositories, evidence);
      const proposal = {
        ...record,
        capturedAt: input.capturedAt,
        lineage: [
          `source:${input.sourceId}`,
          `run:${input.run.id}`,
          `evidence:${evidence.id}`,
        ],
        confidence: confidenceOf(evidence),
        now: () => new Date(input.capturedAt),
        repositories: input.repositories,
        canonicalEvidenceId,
      } as FreeFeedRecord;
      // Read-only decision for the audit report; the committing path resolves
      // again inside its own transaction against the same repository.
      const decision = await resolveCandidate(proposal);
      const canonical = await promoteToCanonical(proposal);
      report.results.push({
        evidenceId: `${record.sourceId}:${record.externalId}`,
        ledgerEvidenceId: evidence.id,
        accepted: canonical.accepted,
        basis: record.basis,
        amount: record.amount,
        rule: decision.rule,
        cardId: canonical.card?.id ?? null,
        observationId: canonical.observation?.id ?? null,
        reasons: [...canonical.reasons],
        errors: [...canonical.errors],
      });
      report.reasons.push(...canonical.reasons);
      report.errors.push(...canonical.errors);
      if (canonical.accepted) report.promoted += 1;
      else report.rejected += 1;
    } catch (error) {
      const message = sanitizeError(error);
      report.rejected += 1;
      report.errors.push(message);
      report.reasons.push(`promotion failed for ledger evidence ${evidence.id}`);
      report.results.push({
        evidenceId: `${record.sourceId}:${record.externalId}`,
        ledgerEvidenceId: evidence.id,
        accepted: false,
        basis: record.basis,
        amount: record.amount,
        rule: null,
        cardId: null,
        observationId: null,
        reasons: [`promotion failed for ledger evidence ${evidence.id}`],
        errors: [message],
      });
    }
  }
  report.accepted = report.rejected === 0 && report.errors.length === 0;
  return report;
}
