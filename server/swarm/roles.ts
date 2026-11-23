/**
 * Phase 4 — INTELLIGENCE lane, Task 2: bounded swarm roles.
 *
 * Roles are deterministic functions over a bounded evidence packet. They emit
 * structured JSON with citations and proposals only; no role can write a
 * canonical fact. The skeptic and judge can reject unbacked proposals.
 */

import { createHash } from 'node:crypto';
import type { EvidenceItem, EvidencePacket } from './tools.ts';

export const ROLES = [
  'ingest_triage',
  'identity_detective',
  'evidence_scout',
  'market_modeler',
  'social_signal_analyst',
  'skeptic',
  'judge',
  'report_agent',
] as const;

export type RoleName = (typeof ROLES)[number];

export class RoleEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoleEvidenceError';
  }
}

export type Confidence = 'LOW' | 'MEDIUM' | 'HIGH';

export interface RoleClaim {
  text: string;
  evidenceIds: string[];
  confidence: Confidence;
}

/** Structured claim emitted for a web-derived evidence item. Always a proposal. */
export interface WebScoutClaim extends RoleClaim {
  provenance: 'WEB';
  webDerived: true;
  source: string;
  observed_at: string;
  basis: string;
  citations: string[];
  status: 'PROPOSAL';
}

export interface Proposal {
  id: string;
  type: 'ALIAS' | 'FACTOR' | 'FORECAST' | 'WEB_CANDIDATE';
  status: 'PROPOSED' | 'HYPOTHESIS';
  targetId: string;
  evidenceIds: string[];
  [key: string]: unknown;
}

export interface RoleOutput {
  role: RoleName;
  claims: RoleClaim[];
  evidenceIds: string[];
  decision?: 'ACCEPT' | 'PARTIAL' | 'REJECT';
  reasons?: string[];
  proposal?: Proposal;
}

export interface RoleOptions {
  /** Test/adversarial hook: claim these IDs even if outside the packet. */
  forceEvidenceIds?: string[];
}

function assertCited(packet: EvidencePacket, ids: string[]): void {
  for (const id of ids) {
    if (!packet.evidenceIds.includes(id)) {
      throw new RoleEvidenceError(`Role cited evidence ID outside the bounded packet: ${id}`);
    }
  }
}

function claim(text: string, ids: string[], confidence: Confidence): RoleClaim {
  return { text, evidenceIds: [...ids].sort(), confidence };
}

/** Web packets are tagged by the deterministic tool layer; never guess from price. */
export function isWebDerived(item: EvidenceItem): boolean {
  const kind = String(item.kind ?? '').toLowerCase();
  const source = String(item.source ?? '').toLowerCase();
  return kind === 'web' || kind === 'web-candidate' || kind === 'web_candidate' ||
    source.startsWith('web:') || source.startsWith('web-') || source.startsWith('web_');
}

function webClaim(item: EvidenceItem): WebScoutClaim {
  const basis = String(item.basis ?? 'UNKNOWN');
  return {
    text: `Web PROPOSAL (hypothesis, not a fact) ${item.id}: source=${item.source} observed_at=${item.observedAt} basis=${basis}`,
    evidenceIds: [item.id],
    confidence: item.confidence,
    provenance: 'WEB',
    webDerived: true,
    source: String(item.source ?? 'UNKNOWN'),
    observed_at: String(item.observedAt ?? 'UNKNOWN'),
    basis,
    citations: [item.id],
    status: 'PROPOSAL',
  };
}

/** Deterministic role execution — no network, no model, no canonical writes. */
export function runRole(role: RoleName, packet: EvidencePacket, options: RoleOptions = {}): RoleOutput {
  const items = packet.items;
  const allIds = packet.evidenceIds;
  if (options.forceEvidenceIds) assertCited(packet, options.forceEvidenceIds);
  const ids = options.forceEvidenceIds ?? allIds;
  const cite = (text: string, evidenceIds: string[], confidence: Confidence): RoleClaim =>
    claim(text, evidenceIds, confidence);

  let claims: RoleClaim[] = [];
  let decision: RoleOutput['decision'];
  let reasons: string[] | undefined;
  let proposal: Proposal | undefined;

  switch (role) {
    case 'ingest_triage':
      claims = items.map((i) =>
        cite(`Triage ${i.id}: basis=${i.basis ?? 'UNKNOWN'} source=${i.source}`, [i.id], i.basis === 'SOLD' ? 'HIGH' : 'MEDIUM'),
      );
      break;
    case 'identity_detective':
      claims = items.map((i) =>
        cite(`Identity candidate for ${i.source}: ${i.id} (unresolved until adjudicated)`, [i.id], 'MEDIUM'),
      );
      if (items[0]) {
        proposal = {
          id: `proposal-alias-${items[0].id}`,
          type: 'ALIAS',
          status: 'PROPOSED',
          targetId: items[0].id,
          evidenceIds: [items[0].id],
        };
      }
      break;
    case 'evidence_scout': {
      const webItems = items.filter(isWebDerived);
      claims = items.map((i) => isWebDerived(i)
        ? webClaim(i)
        : cite(`Evidence ${i.id} from ${i.source} observed ${i.observedAt}`, [i.id], i.confidence));
      const web = webItems[0];
      if (web) {
        proposal = {
          id: `proposal-web-${web.id}`,
          type: 'WEB_CANDIDATE',
          status: 'HYPOTHESIS',
          targetId: web.id,
          evidenceIds: [web.id],
          source: String(web.source ?? 'UNKNOWN'),
          observed_at: String(web.observedAt ?? 'UNKNOWN'),
          basis: String(web.basis ?? 'UNKNOWN'),
          confidence: web.confidence,
          citations: [web.id],
          provenance: 'WEB',
        };
      } else if (items[0]) {
        proposal = {
          id: `proposal-factor-${items[0].id}`,
          type: 'FACTOR',
          status: 'PROPOSED',
          targetId: items[0].id,
          evidenceIds: [items[0].id],
          factor: 'momentum',
        };
      }
      break;
    }
    case 'market_modeler': {
      const sold = items.filter((i) => i.basis === 'SOLD');
      claims = sold.length
        ? [cite(`Deterministic baseline from ${sold.length} SOLD observation(s)`, sold.map((i) => i.id), 'HIGH')]
        : [cite('No SOLD evidence: baseline is UNKNOWN, not zero', allIds.slice(0, 1), 'LOW')];
      if (allIds.length) {
        proposal = {
          id: `proposal-forecast-modeler-${allIds[0]}`,
          type: 'FORECAST',
          status: 'HYPOTHESIS',
          targetId: allIds[0],
          evidenceIds: [...allIds],
        };
      }
      break;
    }
    case 'social_signal_analyst': {
      const signals = items.filter((i) => i.kind === 'event' || i.basis === 'CLAIM' || /reprint|announc/i.test(i.summary));
      claims = signals.length
        ? signals.map((i) => cite(`Social signal ${i.id}: ${i.summary}`, [i.id], 'LOW'))
        : [cite('No social signal in bounded evidence', allIds.slice(0, 1), 'LOW')];
      break;
    }
    case 'skeptic': {
      const low = items.filter((i) => i.confidence === 'LOW');
      claims = items.map((i) =>
        cite(`Challenge ${i.id}: ${i.basis ?? 'UNKNOWN'} basis, confidence ${i.confidence}`, [i.id], i.confidence),
      );
      const strong = items.filter((i) => i.confidence !== 'LOW').length;
      decision = items.length === 0 || strong === 0 ? 'REJECT' : low.length ? 'PARTIAL' : 'ACCEPT';
      reasons = decision === 'REJECT' ? ['INSUFFICIENT_CREDIBLE_EVIDENCE'] : ['CITATIONS_PRESENT'];
      break;
    }
    case 'judge': {
      claims = items.map((i) =>
        cite(`Adjudicate ${i.id}: evidence admitted; canonical write withheld`, [i.id], i.confidence),
      );
      const strong = items.filter((i) => i.confidence !== 'LOW').length;
      decision = strong > 0 ? 'ACCEPT' : 'REJECT';
      reasons = decision === 'REJECT' ? ['NO_BACKED_CLAIMS'] : ['EVIDENCE_BACKED'];
      break;
    }
    case 'report_agent': {
      const digest = createHash('sha256').update(`${packet.digest}|${allIds.join(',')}`).digest('hex').slice(0, 12);
      claims = items.length
        ? [cite(`Report ${digest} summarizes ${items.length} cited fact(s)`, allIds, 'MEDIUM')]
        : [];
      if (allIds.length) {
        proposal = {
          id: `proposal-report-${digest}`,
          type: 'FORECAST',
          status: 'HYPOTHESIS',
          targetId: allIds[0],
          evidenceIds: [...allIds],
        };
      }
      break;
    }
  }

  if (ids !== allIds) {
    // Adversarial/forced citations are only ever used to prove the guardrail.
    claims = claims.map((c) => ({ ...c, evidenceIds: [...ids].sort() }));
  }
  const evidenceIds = [...new Set(claims.flatMap((c) => c.evidenceIds))].sort();
  const output: RoleOutput = { role, claims, evidenceIds };
  if (decision) output.decision = decision;
  if (reasons) output.reasons = reasons;
  if (proposal) output.proposal = proposal;
  return output;
}

export interface ReviewableProposal {
  id?: string;
  evidenceIds: string[];
  [key: string]: unknown;
}

export interface ReviewInput<P extends ReviewableProposal = Proposal> {
  packet: EvidencePacket;
  proposals: P[];
}

export interface Rejection {
  proposal: { id: string };
  reason: string;
  evidenceIds: string[];
}

export interface ReviewResult<P extends ReviewableProposal = Proposal> {
  accepted: P[];
  rejected: Rejection[];
  decision: 'ACCEPT' | 'PARTIAL' | 'REJECT';
}

/** Skeptic/judge gate: a proposal lives only if all of its citations resolve. */
export function reviewProposals<P extends ReviewableProposal>(
  input: ReviewInput<P>,
): ReviewResult<P> {
  const accepted: P[] = [];
  const rejected: Rejection[] = [];
  for (const proposal of input.proposals) {
    const ids = Array.isArray(proposal.evidenceIds) ? proposal.evidenceIds : [];
    const reason = ids.length === 0
      ? 'NO_EVIDENCE_IDS'
      : ids.some((id) => !input.packet.evidenceIds.includes(id))
        ? 'EVIDENCE_ID_NOT_IN_PACKET'
        : null;
    if (reason) {
      rejected.push({
        proposal: { id: String(proposal.id ?? 'unknown') },
        reason,
        evidenceIds: ids.filter((id) => input.packet.evidenceIds.includes(id)),
      });
    } else {
      accepted.push(proposal);
    }
  }
  const decision = rejected.length === 0 && accepted.length > 0
    ? 'ACCEPT'
    : rejected.length > 0 && accepted.length > 0
      ? 'PARTIAL'
      : 'REJECT';
  return { accepted, rejected, decision };
}
