import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  REGISTERED_TOOLS,
  buildEvidencePacket,
  invokeTool,
  isRegisteredTool,
  type EvidenceItem,
} from '../../server/swarm/tools.ts';

const ITEMS: EvidenceItem[] = [
  {
    id: 'ev-1',
    source: 'ebay-sold',
    observedAt: '2026-01-01T00:00:00.000Z',
    capturedAt: '2026-01-02T00:00:00.000Z',
    basis: 'SOLD',
    summary: 'Charizard sold for 100 USD',
    confidence: 'HIGH',
  },
  {
    id: 'ev-2',
    source: 'ebay-asking',
    observedAt: '2026-01-03T00:00:00.000Z',
    capturedAt: '2026-01-04T00:00:00.000Z',
    basis: 'ASKING',
    summary: 'Charizard listed for 150 USD',
    confidence: 'MEDIUM',
  },
  {
    id: 'ev-3',
    source: 'forum',
    observedAt: '2026-01-05T00:00:00.000Z',
    capturedAt: '2026-01-06T00:00:00.000Z',
    basis: 'CLAIM',
    summary: 'Rumour of a reprint announcement',
    confidence: 'LOW',
  },
];

function packet() {
  return buildEvidencePacket({ items: ITEMS });
}

test('tool registry exposes exactly the twelve phase-4 tool names', () => {
  assert.deepEqual([...REGISTERED_TOOLS], [
    'query_graph',
    'get_market_observations',
    'get_comps',
    'get_event_history',
    'get_factor_scores',
    'search_sources',
    'run_deterministic_baseline',
    'run_simulation',
    'backtest_forecast',
    'propose_alias',
    'propose_factor',
    'propose_forecast',
  ]);
  assert.equal(isRegisteredTool('run_simulation'), true);
  assert.equal(isRegisteredTool('write_canonical_fact'), false);
});

test('evidence packet is bounded, deterministic and carries only real ids', () => {
  const p = buildEvidencePacket({ items: ITEMS, maxItems: 2, maxCharsPerItem: 12 });
  assert.equal(p.items.length, 2);
  assert.equal(p.totalAvailable, 3);
  assert.equal(p.truncated, true);
  assert.deepEqual(p.evidenceIds, ['ev-1', 'ev-2']);
  assert.ok(p.items.every((i) => i.summary.length <= 12));
  assert.deepEqual(
    buildEvidencePacket({ items: ITEMS, maxItems: 2, maxCharsPerItem: 12 }).digest,
    p.digest,
  );
  assert.notEqual(
    buildEvidencePacket({ items: ITEMS.slice(1), maxItems: 2, maxCharsPerItem: 12 }).digest,
    p.digest,
  );
});

test('unregistered tools are rejected and never execute', () => {
  const result = invokeTool({ tool: 'drop_database', args: { evidenceIds: ['ev-1'] } }, {
    packet: packet(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'TOOL_NOT_REGISTERED');
  assert.deepEqual(result.evidenceIds, []);
});

test('all tools require non-empty evidence ids that resolve in the bounded packet', () => {
  for (const tool of REGISTERED_TOOLS) {
    const missing = invokeTool({ tool, args: {} }, { packet: packet() });
    assert.equal(missing.ok, false, `${tool} must require evidenceIds`);
    assert.equal(missing.error, 'EVIDENCE_IDS_REQUIRED');

    const foreign = invokeTool(
      { tool, args: { evidenceIds: ['ev-1', 'ev-999'] } },
      { packet: packet() },
    );
    assert.equal(foreign.ok, false, `${tool} must reject unknown evidence ids`);
    assert.equal(foreign.error, 'EVIDENCE_ID_NOT_IN_PACKET');
  }
});

test('tool results echo only packet evidence ids and carry a structured envelope', () => {
  for (const tool of REGISTERED_TOOLS) {
    const result = invokeTool({ tool, args: { evidenceIds: ['ev-2', 'ev-1'] } }, { packet: packet() });
    assert.equal(result.ok, true, `${tool} should succeed`);
    assert.equal(result.tool, tool);
    assert.deepEqual([...result.evidenceIds].sort(), ['ev-1', 'ev-2']);
    assert.ok(result.data && typeof result.data === 'object');
  }
});

test('get_comps admits SOLD evidence only; basis is never inferred', () => {
  const result = invokeTool(
    { tool: 'get_comps', args: { evidenceIds: ['ev-1', 'ev-2', 'ev-3'] } },
    { packet: packet() },
  );
  const comps = result.data as { items: Array<{ id: string; basis: string }> };
  assert.deepEqual(comps.items.map((i) => i.id), ['ev-1']);
  assert.equal(comps.items[0].basis, 'SOLD');

  const none = invokeTool(
    { tool: 'get_comps', args: { evidenceIds: ['ev-2', 'ev-3'] } },
    { packet: packet() },
  );
  assert.deepEqual((none.data as { items: unknown[] }).items, []);
  assert.equal((none.data as { reason: string }).reason, 'NO_SOLD_EVIDENCE');
});

test('deterministic baseline is computed from evidence, not from a model', () => {
  const a = invokeTool(
    { tool: 'run_deterministic_baseline', args: { evidenceIds: ['ev-1', 'ev-2'] } },
    { packet: packet() },
  );
  const b = invokeTool(
    { tool: 'run_deterministic_baseline', args: { evidenceIds: ['ev-1', 'ev-2'] } },
    { packet: packet() },
  );
  assert.deepEqual(a.data, b.data);
  const data = a.data as { baseline: number | null; basis: string };
  assert.equal(data.baseline, 100, 'only the SOLD observation sets the baseline');
  assert.equal(data.basis, 'SOLD');
});

test('proposals are proposals: they carry citations and never a canonical status', () => {
  const result = invokeTool(
    { tool: 'propose_forecast', args: { evidenceIds: ['ev-1'], targetId: 'card-1' } },
    { packet: packet() },
  );
  const proposal = result.data as {
    type: string;
    status: string;
    evidenceIds: string[];
  };
  assert.equal(proposal.type, 'FORECAST');
  assert.equal(proposal.status, 'PROPOSED');
  assert.deepEqual(proposal.evidenceIds, ['ev-1']);
});
