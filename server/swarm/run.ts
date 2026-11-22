/**
 * Phase 4 — INTELLIGENCE lane, Task 2: swarm run orchestration + run store.
 * Proposals are collected, challenged and judged; nothing here writes to
 * canonical storage. Run IDs are content-addressed for replay/determinism.
 */

import { createHash } from 'node:crypto';
import { buildEvidencePacket, type EvidenceItem, type EvidencePacket } from './tools.ts';
import {
  ROLES,
  reviewProposals,
  runRole,
  type Proposal,
  type ReviewResult,
  type RoleName,
  type RoleOutput,
} from './roles.ts';

export interface SwarmRunInput {
  targetId: string;
  evidence: EvidenceItem[];
  maxItems?: number;
  maxCharsPerItem?: number;
  asOf?: string;
}

export interface SwarmRunRecord {
  id: string;
  createdAt: string;
  targetId: string;
  packetDigest: string;
  evidenceIds: string[];
  roles: RoleOutput[];
  proposals: Proposal[];
  review: ReviewResult;
  decision: 'ACCEPT' | 'PARTIAL' | 'REJECT';
  status: 'COMPLETED';
}

/** In-process run store; deterministic, isolated, no ambient persistence. */
class SwarmRunStore {
  private readonly runs = new Map<string, SwarmRunRecord>();

  get(id: string): SwarmRunRecord | null {
    return this.runs.get(id) ?? null;
  }

  list(): SwarmRunRecord[] {
    return [...this.runs.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  put(run: SwarmRunRecord): SwarmRunRecord {
    this.runs.set(run.id, run);
    return run;
  }

  clear(): void {
    this.runs.clear();
  }
}

export const swarmRunStore = new SwarmRunStore();

/** Run the bounded role pipeline over a fixed evidence packet. */
export function runSwarmResearch(input: SwarmRunInput): SwarmRunRecord {
  const packet: EvidencePacket = buildEvidencePacket({
    items: input.evidence,
    maxItems: input.maxItems,
    maxCharsPerItem: input.maxCharsPerItem,
  });
  const roles: RoleOutput[] = ROLES.map((role: RoleName) => runRole(role, packet));
  const proposals: Proposal[] = roles
    .map((r) => r.proposal)
    .filter((p): p is Proposal => Boolean(p));
  const review = reviewProposals({ packet, proposals });
  const judge = roles.find((r) => r.role === 'judge');
  const decision: SwarmRunRecord['decision'] = packet.evidenceIds.length === 0
    ? 'REJECT'
    : review.decision === 'REJECT'
      ? 'REJECT'
      : judge?.decision === 'REJECT'
        ? 'REJECT'
        : review.decision;
  const idSource = JSON.stringify([input.targetId, packet.digest, input.asOf ?? null]);
  const run: SwarmRunRecord = {
    id: `swarm-${createHash('sha256').update(idSource).digest('hex').slice(0, 16)}`,
    createdAt: input.asOf ?? new Date().toISOString(),
    targetId: input.targetId,
    packetDigest: packet.digest,
    evidenceIds: packet.evidenceIds,
    roles,
    proposals: review.accepted,
    review,
    decision,
    status: 'COMPLETED',
  };
  return swarmRunStore.put(run);
}
