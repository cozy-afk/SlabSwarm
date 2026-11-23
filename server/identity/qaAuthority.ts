// Server-side QA host seam for Task 16.
//
// Gate producers (canonical promotion and ledger promotion) never import the
// review queue. They report a quarantine through this host-owned registry,
// which server.ts binds to the internal QA store. Release authority is issued
// only by the human review path and is checked here — never read from a
// proposal, an evidence payload or a model-shaped object.

import type { FreeFeedRecord } from '../contracts/freeFeed.ts';
import type { MatchAssessment } from './matchGate.ts';

export interface QuarantineEvent {
  /** The original proposal, before any host seam is added. */
  proposal: FreeFeedRecord;
  /** The deterministic assessment that produced the quarantine. */
  assessment: MatchAssessment;
}

export interface QuarantineEnqueueResult {
  reviewId: string | null;
  error: string | null;
}

export interface QaHost {
  enqueueQuarantine(event: QuarantineEvent): Promise<string | null>;
  /** True only for a server-recorded APPROVE correction with a committed canonical write. */
  isApprovedCorrection(correctionId: string): Promise<boolean>;
}

export interface IssuedAuthority {
  correctionId: string;
  candidateId: string;
  reviewer: string;
  note: string | null;
  decidedAt: string;
}

const CORRECTION_ID = /^qa-cor-[0-9a-f]{16}$/;
let host: QaHost | null = null;
const issued = new Map<string, IssuedAuthority>();

/** Bind the gate to the internal queue. Attaching replaces any prior binding. */
export function attachQaHost(next: QaHost): void {
  issued.clear();
  host = next;
}

export function detachQaHost(): void {
  host = null;
  issued.clear();
}

/** Called only by the internal review store just before a human APPROVE commits. */
export function issueApprovalAuthority(authority: IssuedAuthority): void {
  if (!CORRECTION_ID.test(authority.correctionId)) {
    throw new Error('approval authority requires a real correction id');
  }
  issued.set(authority.correctionId, { ...authority });
}

export function revokeApprovalAuthority(correctionId: string): void {
  issued.delete(correctionId);
}

/**
 * A release id is valid only while the review path has an outstanding human
 * APPROVE, or when the server's append-only correction log records an APPROVE
 * that actually committed canonical rows. Shape alone is never authority.
 */
export async function hasApprovedCorrectionAuthority(correctionId: string): Promise<boolean> {
  if (typeof correctionId !== 'string' || !CORRECTION_ID.test(correctionId)) return false;
  if (issued.has(correctionId)) return true;
  return host ? host.isApprovedCorrection(correctionId) : false;
}

/** Report a quarantine to the bound QA store; never block the gate on QA failure. */
export async function reportQuarantine(event: QuarantineEvent): Promise<QuarantineEnqueueResult> {
  if (!host) return { reviewId: null, error: null };
  try {
    const reviewId = await host.enqueueQuarantine(event);
    return { reviewId, error: null };
  } catch (error) {
    return {
      reviewId: null,
      error: error instanceof Error ? error.message : 'QA enqueue failed.',
    };
  }
}
