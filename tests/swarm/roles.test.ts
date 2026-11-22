import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildEvidencePacket, type EvidenceItem } from '../../server/swarm/tools.ts';
import {
  ROLES,
  RoleEvidenceError,
  reviewProposals,
  runRole,
} from '../../server/swarm/roles.ts';
import {
  runSwarmResearch,
  swarmRunStore,
  type SwarmRunRecord,
} from '../../server/swarm/run.ts';

const EVIDENCE: EvidenceItem[] = [
  {
    id: 'ev-a',
    source: 'sold-feed',
    observedAt: '2026-02-01T00:00:00.000Z',
    capturedAt: '2026-02-01T01:00:00.000Z',
    basis: 'SOLD',
    kind: 'observation',
    summary: 'SOLD 120 USD for card X',
    amount: 120,
    confidence: 'HIGH',
  },
  {
    id: 'ev-b',
    source: 'social-feed',
    observedAt: '2026-02-02T00:00:00.000Z',
    capturedAt: '2026-02-02T01:00:00.000Z',
    basis: 'CLAIM',
    kind: 'event',
    summary: 'Rumour of reprint announcement',
    confidence: 'LOW',
  },
];

const packet = () => buildEvidencePacket({ items: EVIDENCE });

interface RoleOutputLike {
  role: string;
  claims: Array<{ text: string; evidenceIds: string[]; confidence: string }>;
  evidenceIds: string[];
  proposal?: { status?: string; evidenceIds?: string[] };
}

test('all eight swarm roles emit structured JSON with in-packet citations', () => {
  assert.deepEqual([...ROLES], [
    'ingest_triage',
    'identity_detective',
    'evidence_scout',
    'market_modeler',
    'social_signal_analyst',
    'skeptic',
    'judge',
    'report_agent',
  ]);
  for (const role of ROLES) {
    const out = runRole(role, packet()) as RoleOutputLike;
    assert.equal(out.role, role);
    assert.ok(Array.isArray(out.claims), `${role} must return claims`);
    assert.ok(out.claims.length > 0, `${role} must cite real evidence`);
    for (const claim of out.claims) {
      assert.ok(typeof claim.text === 'string' && claim.text.length > 0);
      assert.ok(claim.evidenceIds.length > 0, `${role} claim must carry evidence IDs`);
      assert.ok(claim.evidenceIds.every((id) => packet().evidenceIds.includes(id)));
      assert.ok(['LOW', 'MEDIUM', 'HIGH'].includes(claim.confidence));
    }
    assert.deepEqual(out.evidenceIds, [...new Set(out.claims.flatMap((c) => c.evidenceIds))].sort());
  }
});

test('role claims cannot cite evidence outside the bounded packet', () => {
  const partial = buildEvidencePacket({ items: EVIDENCE, maxItems: 1, maxCharsPerItem: 4000 });
  assert.equal(partial.items.length, 1);
  assert.throws(
    () => runRole('evidence_scout', partial, { forceEvidenceIds: ['ev-a', 'ev-b'] }),
    RoleEvidenceError,
  );
});

test('roles are deterministic for the same bounded evidence packet', () => {
  for (const role of ROLES) {
    assert.deepEqual(runRole(role, packet()), runRole(role, packet()));
  }
});

test('skeptic and judge reject proposals that lack evidence or cite unknown ids', () => {
  const good = { id: 'p-good', evidenceIds: ['ev-a'] };
  const unbacked = { id: 'p-empty', evidenceIds: [] };
  const foreign = { id: 'p-foreign', evidenceIds: ['ev-nope'] };

  const reviewed = reviewProposals({ packet: packet(), proposals: [good, unbacked, foreign] });
  assert.equal(reviewed.decision, 'PARTIAL');
  assert.deepEqual(reviewed.accepted.map((p) => (p as { id: string }).id), ['p-good']);
  assert.deepEqual(reviewed.rejected.map((r) => r.proposal.id), ['p-empty', 'p-foreign']);
  assert.ok(reviewed.rejected.every((r) => r.reason.length > 0));
  assert.ok(reviewed.rejected.every((r) => r.evidenceIds.length === 0 || r.evidenceIds.every((id) => packet().evidenceIds.includes(id))));
});

test('report agent proposals stay HYPOTHESIS and never write canonical facts', () => {
  const report = runRole('report_agent', packet()) as RoleOutputLike;
  assert.ok(report.proposal, 'report agent must emit a proposal');
  assert.equal(report.proposal?.status, 'HYPOTHESIS');
  assert.deepEqual(report.proposal?.evidenceIds, ['ev-a', 'ev-b']);
});

test('swarm run records are deterministic, retrievable and fully traced', () => {
  swarmRunStore.clear();
  const input = { targetId: 'card-x', evidence: EVIDENCE, asOf: '2026-02-03T00:00:00.000Z' };
  const a = runSwarmResearch(input);
  const b = runSwarmResearch(input);
  assert.deepEqual(a, b, 'same seed evidence gives the same run');

  const run: SwarmRunRecord = a;
  assert.match(run.id, /^swarm-[a-f0-9]{16}$/);
  assert.equal(run.createdAt, '2026-02-03T00:00:00.000Z');
  assert.equal(run.targetId, 'card-x');
  assert.equal(run.packetDigest, packet().digest);
  assert.deepEqual(run.roles.map((r) => r.role), [...ROLES]);
  assert.ok(run.proposals.length > 0);
  assert.ok(run.proposals.every((p) => p.status === 'PROPOSED' || p.status === 'HYPOTHESIS'));
  assert.deepEqual(run.evidenceIds, ['ev-a', 'ev-b']);
  assert.equal(run.status, 'COMPLETED');
  assert.deepEqual(swarmRunStore.get(run.id), run);
  assert.equal(swarmRunStore.get('missing'), null);
  assert.equal(swarmRunStore.list().length, 1);
});

test('swarm run deflects with a REJECT decision when no evidence is supplied', () => {
  const run = runSwarmResearch({ targetId: 'card-empty', evidence: [], asOf: '2026-02-03T00:00:00.000Z' });
  assert.equal(run.decision, 'REJECT');
  assert.deepEqual(run.evidenceIds, []);
  assert.deepEqual(run.proposals, []);
});
