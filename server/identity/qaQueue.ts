// Internal QA queue for low-confidence listing-title matches.
//
// The queue never invents identity: it stores the deterministic assessment and
// the immutable proposal verbatim. Only a human APPROVE releases the proposal
// to the existing canonical promotion path, carrying the correction id into
// the identity decision's provenance. Every decision appends a correction row;
// nothing here mutates or deletes a previously recorded decision. There is no
// listener, no model call and no public surface in this module.

import { createHash } from 'node:crypto';
import type { FreeFeedRecord } from '../contracts/freeFeed.ts';
import {
  createDefaultRepositories,
  type Repositories,
} from '../db/repositories/index.ts';
import {
  assessMatch,
  resolveConfidenceFloor,
  type ExpectedAttributes,
  type MatchAssessment,
} from './matchGate.ts';
import {
  promoteToCanonical,
  type CanonicalWriteReport,
} from './resolver.ts';

export type QaStatus = 'PENDING' | 'APPROVED' | 'REJECTED';
export type QaAction = 'APPROVE' | 'REJECT';

export interface QaProvenance {
  evidenceId: string;
  source: string;
  basis: string;
  currency: string;
  observedAt: string;
  capturedAt: string;
  lineage: string[];
  confidence: string;
  license: string;
  attribution: string;
}

export interface QaCandidate {
  id: string;
  evidenceId: string;
  title: string;
  status: QaStatus;
  enqueuedAt: string;
  reviewedAt?: string;
  reviewNote?: string;
  assessment: MatchAssessment;
  provenance: QaProvenance;
  /** The immutable proposal with its host-only seams removed. */
  proposal: FreeFeedRecord;
}

export interface QaCorrection {
  id: string;
  candidateId: string;
  evidenceId: string;
  action: QaAction;
  reviewer: string;
  note: string | null;
  decidedAt: string;
  previousCorrectionId: string | null;
  provenance: QaProvenance;
  assessment: {
    decision: string;
    score: number;
    floor: number;
    conflicts: string[];
    reasons: string[];
  };
  canonical: CanonicalWriteReport | null;
}

export interface QaReviewResult {
  candidate: QaCandidate;
  correction: QaCorrection;
  canonical: CanonicalWriteReport | null;
}

export interface QaReviewInput {
  reviewer: string;
  note?: string;
}

export interface MatchReviewQueueOptions {
  repositories?: Repositories;
  now?: () => Date;
  /** Numeric confidence floor; defaults to the configured env/default. */
  floor?: number;
}

export class QaError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly httpStatus: number = 400,
  ) {
    super(message);
    this.name = 'QaError';
  }
}

const STATUSES: ReadonlySet<string> = new Set<QaStatus>(['PENDING', 'APPROVED', 'REJECTED']);

function clone<T>(value: T): T {
  return structuredClone(value);
}

function text(value: unknown): string {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : 'UNKNOWN';
}

function evidenceIdOf(proposal: FreeFeedRecord): string {
  return `${text(proposal.sourceId)}:${text(proposal.externalId)}`;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function provenanceOf(proposal: FreeFeedRecord): QaProvenance {
  const extra = proposal as FreeFeedRecord & Record<string, unknown>;
  const rawLineage = extra.lineage;
  return {
    evidenceId: evidenceIdOf(proposal),
    source: text(proposal.sourceId),
    basis: text(proposal.basis),
    currency: text(proposal.currency),
    observedAt: text(proposal.observedAt),
    capturedAt: text((proposal as { capturedAt?: unknown }).capturedAt),
    lineage: Array.isArray(rawLineage)
      ? rawLineage.filter((item): item is string => typeof item === 'string')
      : [],
    confidence: text((proposal as { confidence?: unknown }).confidence),
    license: text(proposal.license),
    attribution: text(proposal.attribution),
  };
}

function storedProposal(proposal: FreeFeedRecord): FreeFeedRecord {
  // Repositories and clocks are host seams, never persisted facts.
  const { repositories: _repositories, now: _now, qaOverride: _override, ...rest } =
    proposal as FreeFeedRecord & Record<string, unknown>;
  return clone(rest) as FreeFeedRecord;
}

function assessProposal(
  proposal: FreeFeedRecord,
  floor: number,
): MatchAssessment {
  const extra = proposal as FreeFeedRecord & Record<string, unknown>;
  return assessMatch({
    title: extra.title,
    expected: (extra.expectedAttributes ?? null) as ExpectedAttributes | null,
    floor: typeof extra.confidenceFloor === 'number' ? extra.confidenceFloor : floor,
  });
}

export function createMatchReviewQueue(options: MatchReviewQueueOptions = {}) {
  const repositories = options.repositories ?? createDefaultRepositories();
  const now = options.now ?? (() => new Date());
  const floor = resolveConfidenceFloor(options.floor);
  const candidates = new Map<string, QaCandidate>();
  const corrections: QaCorrection[] = [];

  async function list(filters: { status?: QaStatus } = {}): Promise<QaCandidate[]> {
    if (filters.status !== undefined && !STATUSES.has(filters.status)) {
      throw new QaError('status must be PENDING, APPROVED or REJECTED.', 'validation_error');
    }
    return [...candidates.values()]
      .filter((row) => filters.status === undefined || row.status === filters.status)
      .map(clone)
      .sort((a, b) => a.enqueuedAt.localeCompare(b.enqueuedAt) || a.id.localeCompare(b.id));
  }

  async function get(id: string): Promise<QaCandidate | null> {
    const found = candidates.get(id);
    return found ? clone(found) : null;
  }

  async function enqueue(proposal: FreeFeedRecord): Promise<QaCandidate> {
    const assessment = assessProposal(proposal, floor);
    if (assessment.decision !== 'QUARANTINE') {
      throw new QaError(
        'Only below-floor matches belong in the QA queue.',
        'not_quarantinable',
        409,
      );
    }
    const evidenceId = evidenceIdOf(proposal);
    const id = `qa-${digest(evidenceId)}`;
    const existing = candidates.get(id);
    if (existing) return clone(existing);

    const title = typeof (proposal as { title?: unknown }).title === 'string'
      ? String((proposal as { title?: unknown }).title)
      : 'UNKNOWN';
    const queued: QaCandidate = {
      id,
      evidenceId,
      title,
      status: 'PENDING',
      enqueuedAt: now().toISOString(),
      assessment: clone(assessment),
      provenance: provenanceOf(proposal),
      proposal: storedProposal(proposal),
    };
    candidates.set(id, clone(queued));
    return clone(queued);
  }

  async function listCorrections(
    filters: { candidateId?: string } = {},
  ): Promise<QaCorrection[]> {
    return corrections
      .filter((row) => filters.candidateId === undefined || row.candidateId === filters.candidateId)
      .map(clone);
  }

  async function review(
    id: string,
    action: QaAction,
    input: QaReviewInput,
  ): Promise<QaReviewResult | null> {
    if (action !== 'APPROVE' && action !== 'REJECT') {
      throw new QaError('action must be APPROVE or REJECT.', 'validation_error');
    }
    if (typeof input.reviewer !== 'string' || input.reviewer.trim() === '') {
      throw new QaError('reviewer is required.', 'validation_error');
    }
    const current = candidates.get(id);
    if (!current) return null;
    if (current.status !== 'PENDING') {
      throw new QaError('This match has already been reviewed.', 'already_reviewed', 409);
    }

    const decidedAt = now().toISOString();
    const correctionId = `qa-cor-${digest(`${id}:${decidedAt}:${action}`)}`;
    let canonical: CanonicalWriteReport | null = null;
    if (action === 'APPROVE') {
      // The only release path: the correction id is injected as a host seam on
      // the immutable proposal so the identity decision can name its authority.
      canonical = await promoteToCanonical({
        ...clone(current.proposal),
        repositories,
        now: () => new Date(decidedAt),
        qaOverride: correctionId,
      } as FreeFeedRecord);
      if (!canonical.accepted) {
        const detail = [...canonical.reasons, ...canonical.errors].join('; ');
        throw new QaError(
          `Canonical commit failed; the match stays pending: ${detail}`,
          'canonical_failed',
          409,
        );
      }
    }

    const correction: QaCorrection = {
      id: correctionId,
      candidateId: id,
      evidenceId: current.evidenceId,
      action,
      reviewer: input.reviewer,
      note: typeof input.note === 'string' && input.note.trim() !== '' ? input.note : null,
      decidedAt,
      previousCorrectionId: null,
      provenance: clone(current.provenance),
      assessment: {
        decision: current.assessment.decision,
        score: current.assessment.score,
        floor: current.assessment.floor,
        conflicts: [...current.assessment.conflicts],
        reasons: [...current.assessment.reasons],
      },
      canonical,
    };
    corrections.push(clone(correction));

    const decided: QaCandidate = {
      ...clone(current),
      status: action === 'APPROVE' ? 'APPROVED' : 'REJECTED',
      reviewedAt: decidedAt,
      reviewNote: correction.note ?? undefined,
    };
    candidates.set(id, clone(decided));
    return { candidate: clone(decided), correction: clone(correction), canonical };
  }

  return { list, get, enqueue, listCorrections, review };
}

export type MatchReviewQueue = ReturnType<typeof createMatchReviewQueue>;

export default createMatchReviewQueue;
